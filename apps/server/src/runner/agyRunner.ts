import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RunnerModel } from '@wca/shared';
import { buildAgyPromptSuffix, SUBMIT_FORMAT_APPENDIX } from './agyFormat.ts';

export { buildAgyPromptSuffix, SUBMIT_FORMAT_APPENDIX };
import { fromRoot } from '../paths.ts';
import { createAgyParser } from './agyStreamParser.ts';
import { buildUserPrompt, loadSystemPrompt } from './prompt.ts';
import { checkBinary, runContextEnv, spawnAgent } from './spawnAgent.ts';
import type { AgentRunHooks, AgentRunOutcome, AgentRunRequest, AgentRunner } from './types.ts';

// Antigravity CLI (`agy -p`). Ba lớp khoá quyền, vì setting toàn cục của agy có thể là `always-proceed`:
//  1. Custom agent `wyckoff-analyst` với `excludeDefaultComponents` + `tools: [view_file]` → chỉ còn tool MCP
//     và xem file (cần để đọc schema tool MCP mà agy nạp lười trong ~/.gemini/antigravity-cli/mcp/<server>/).
//  2. Chạy trong workspace rỗng `data/agy-workspace` + `allowNonWorkspaceAccess: false` → mọi file ngoài
//     workspace (project, home, setting/token của agy) bị từ chối; đã kiểm chứng với agy 1.4.12.
//  3. `--settings` của phiên: chỉ allow `mcp(wyckoff/*)`, deny shell / ghi file / MCP khác.

export const AGY_AGENT_NAME = 'wyckoff-analyst';

const execFileAsync = promisify(execFile);

export interface AgyRunnerOptions {
  agyBin: string;
  model?: string;
  timeoutMs: number;
  env: Record<string, string>;
  /** Thư mục workspace riêng cho agy (mặc định data/agy-workspace). */
  workspaceDir?: string;
  /** Root project chứa apps/mcp và node_modules/tsx. */
  root: string;
  serverUrl: string;
}

/** JSON `--settings` cho phiên agy: chỉ cho phép MCP wyckoff. `otherMcp` = tên các MCP khác đã cấu hình. */
export function buildAgySettings(otherMcp: readonly string[]): string {
  return JSON.stringify({
    toolPermission: 'request-review',
    allowNonWorkspaceAccess: false,
    permissions: {
      allow: ['mcp(wyckoff/*)'],
      // Không dùng `mcp(*)`: deny thắng allow nên sẽ chặn luôn wyckoff.
      deny: ['command(*)', 'write_file(*)', ...otherMcp.filter(n => n !== 'wyckoff').map(n => `mcp(${n}/*)`)],
    },
  });
}

/** Cấu hình MCP `wyckoff` cho agy (đường dẫn tuyệt đối vì agy chạy trong workspace riêng). */
export function buildAgyMcpConfig(root: string, serverUrl: string, context: Record<string, string> = {}): object {
  const loader = pathToFileURL(path.join(root, 'node_modules/tsx/dist/loader.mjs')).href;
  return {
    mcpServers: {
      wyckoff: {
        command: process.execPath,
        args: ['--import', loader, path.join(root, 'apps/mcp/src/index.ts')],
        env: { WCA_SERVER_URL: serverUrl, ...context },
      },
    },
  };
}

/** File custom agent: không tool mặc định, chỉ MCP; system prompt = prompts/wyckoff.md (hạ cấp heading). */
export function buildAgyAgentMarkdown(systemPrompt: string): string {
  const body = systemPrompt.replace(/^(#{1,5}) /gm, '#$1 ');
  return [
    '---',
    `name: ${AGY_AGENT_NAME}`,
    'description: Phân tích Wyckoff top-down qua MCP wyckoff (Wyckoff Chart Agent)',
    'mainAgent: true',
    'subagent: false',
    'excludeDefaultComponents: true',
    'inheritMcp: true',
    'tools: [view_file]',
    '---',
    '# Wyckoff analyst',
    '',
    'Bạn chỉ có tool MCP của server `wyckoff` (gọi qua call_mcp_tool) và tool xem file **chỉ để đọc schema tool MCP** trước khi gọi lần đầu. Không có quyền ghi file, chạy lệnh hay truy cập web; không cố đọc file nào khác.',
    'Tham số của `submit_analysis` gồm `analysisId` và `analysis` (object chứa toàn bộ kết quả theo schema) — không đặt các trường kết quả ở cấp ngoài cùng.',
    '',
    body,
    '',
    SUBMIT_FORMAT_APPENDIX,
    '',
  ].join('\n');
}

export function buildAgyArgs(opts: { prompt: string; model?: string; settings: string }): string[] {
  const args = [
    '-p', opts.prompt,
    '--agent', AGY_AGENT_NAME,
    '--output-format', 'stream-json',
    '--settings', opts.settings,
    '--disable-slash-commands',
  ];
  if (opts.model) args.push('--model', opts.model);
  return args;
}

/** Parse `agy models` (mỗi dòng `id<TAB>tên`). */
export function parseAgyModels(stdout: string): RunnerModel[] {
  return stdout
    .split('\n')
    .map(l => l.split('\t'))
    .filter(p => p.length >= 2 && /^[\w.-]+$/.test(p[0]!.trim()))
    .map(([id, label]) => ({ id: id!.trim(), label: label!.trim() }));
}

/** Parse `agy mcp list` → tên các MCP server (bỏ dòng tiêu đề). */
export function parseAgyMcpList(stdout: string): string[] {
  return stdout
    .split('\n')
    .slice(1)
    .map(l => l.trim().split(/\s+/)[0] ?? '')
    .filter(n => /^[\w.-]+$/.test(n));
}

export class AgyRunner implements AgentRunner {
  readonly id = 'agy' as const;
  readonly label = 'Antigravity';
  readonly supportsScreenshot = true;
  readonly supportsBookmap = true;
  private avail: { available: boolean; reason?: string } | null = null;
  private modelsCache: { at: number; models: RunnerModel[] } | null = null;

  constructor(private readonly opts: AgyRunnerOptions) {}

  get defaultModel(): string | undefined {
    return this.opts.model;
  }

  private get workspace(): string {
    return this.opts.workspaceDir ?? fromRoot('data/agy-workspace');
  }

  availability() {
    this.avail ??= checkBinary(this.opts.agyBin);
    return this.avail;
  }

  async listModels(): Promise<RunnerModel[]> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < 10 * 60_000) return this.modelsCache.models;
    const models = await execFileAsync(this.opts.agyBin, ['models'], { timeout: 30_000 })
      .then(r => parseAgyModels(r.stdout))
      .catch(() => [] as RunnerModel[]);
    if (models.length) this.modelsCache = { at: Date.now(), models };
    return models;
  }

  private otherMcpServers(): Promise<string[]> {
    return execFileAsync(this.opts.agyBin, ['mcp', 'list'], { cwd: this.workspace, timeout: 15_000 })
      .then(r => parseAgyMcpList(r.stdout))
      .catch(() => []);
  }

  /** Ghi lại workspace mỗi lần chạy để nhận thay đổi của prompt. */
  prepareWorkspace(context: Record<string, string> = {}): void {
    const agents = path.join(this.workspace, '.agents');
    fs.mkdirSync(path.join(agents, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(agents, 'mcp_config.json'), JSON.stringify(buildAgyMcpConfig(this.opts.root, this.opts.serverUrl, context), null, 2));
    fs.writeFileSync(path.join(agents, 'agents', `${AGY_AGENT_NAME}.md`), buildAgyAgentMarkdown(loadSystemPrompt()));
  }

  async run(req: AgentRunRequest, hooks: AgentRunHooks): Promise<AgentRunOutcome> {
    const context = runContextEnv(req);
    this.prepareWorkspace(context);
    const otherMcp = await this.otherMcpServers();
    return spawnAgent(
      {
        bin: this.opts.agyBin,
        args: buildAgyArgs({
          prompt: buildUserPrompt(req) + buildAgyPromptSuffix(req),
          model: req.model ?? this.opts.model,
          settings: buildAgySettings(otherMcp),
        }),
        cwd: this.workspace,
        env: { ...this.opts.env, ...context },
        timeoutMs: this.opts.timeoutMs,
        parseLine: createAgyParser(),
        name: 'agy',
      },
      hooks,
    );
  }
}
