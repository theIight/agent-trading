import type { RunnerModel } from '@wca/shared';
import { fromRoot, ROOT } from '../paths.ts';
import { buildUserPrompt, loadSystemPrompt } from './prompt.ts';
import { checkBinary, runContextEnv, spawnAgent } from './spawnAgent.ts';
import { parseStreamLine } from './streamParser.ts';
import type { AgentRunHooks, AgentRunOutcome, AgentRunRequest, AgentRunner } from './types.ts';

export interface ClaudeCodeRunnerOptions {
  claudeBin: string;
  model?: string;
  timeoutMs: number;
  /** Biến môi trường truyền cho MCP server (URL server, token nội bộ). */
  env: Record<string, string>;
}

const CLAUDE_MODELS: RunnerModel[] = [
  { id: 'opus', label: 'Opus (mới nhất)' },
  { id: 'sonnet', label: 'Sonnet (mới nhất)' },
  { id: 'haiku', label: 'Haiku (mới nhất)' },
];

/** Tham số dòng lệnh: chỉ cho phép tool MCP wyckoff, tắt toàn bộ tool có sẵn (file/shell/web). */
export function buildClaudeArgs(opts: { model?: string; systemPrompt: string }): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--mcp-config', fromRoot('.mcp.json'),
    '--strict-mcp-config',
    '--tools', '',
    '--allowedTools', 'mcp__wyckoff__*',
    '--no-session-persistence',
    '--append-system-prompt', opts.systemPrompt,
  ];
  if (opts.model) args.push('--model', opts.model);
  return args;
}

/** Chạy Claude Code headless (`claude -p`) gắn MCP server của project. */
export class ClaudeCodeRunner implements AgentRunner {
  readonly id = 'claude-code' as const;
  readonly label = 'Claude Code';
  readonly supportsScreenshot = true;
  readonly supportsBookmap = true;
  private avail: { available: boolean; reason?: string } | null = null;

  constructor(private readonly opts: ClaudeCodeRunnerOptions) {}

  get defaultModel(): string | undefined {
    return this.opts.model;
  }

  availability() {
    this.avail ??= checkBinary(this.opts.claudeBin);
    return this.avail;
  }

  async listModels(): Promise<RunnerModel[]> {
    return CLAUDE_MODELS;
  }

  run(req: AgentRunRequest, hooks: AgentRunHooks): Promise<AgentRunOutcome> {
    return spawnAgent(
      {
        bin: this.opts.claudeBin,
        args: buildClaudeArgs({ model: req.model ?? this.opts.model, systemPrompt: loadSystemPrompt() }),
        cwd: ROOT,
        env: { ...this.opts.env, ...runContextEnv(req) },
        timeoutMs: this.opts.timeoutMs,
        stdin: buildUserPrompt(req),
        parseLine: parseStreamLine,
        name: 'claude',
      },
      hooks,
    );
  }
}
