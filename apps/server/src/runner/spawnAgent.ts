import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { RUN_CONTEXT_ENV } from '@wca/shared';
import type { AgentRunHooks, AgentRunOutcome, AgentRunRequest, ParsedItem } from './types.ts';

/** Env ngữ cảnh lượt chạy cho MCP: tool dùng làm mặc định khi agent bỏ sót analysisId / symbol. */
export function runContextEnv(req: Pick<AgentRunRequest, 'analysisId' | 'symbol' | 'primaryTf'>): Record<string, string> {
  return {
    [RUN_CONTEXT_ENV.analysisId]: req.analysisId,
    [RUN_CONTEXT_ENV.symbol]: req.symbol,
    [RUN_CONTEXT_ENV.primaryTf]: req.primaryTf,
  };
}

export interface SpawnAgentOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Ghi vào stdin rồi đóng (prompt); không có thì đóng stdin ngay. */
  stdin?: string;
  parseLine: (line: string) => ParsedItem[];
  /** Tên hiển thị trong thông báo lỗi. */
  name: string;
}

/**
 * Chạy một CLI agent headless: parse stdout từng dòng thành sự kiện tiến trình,
 * hỗ trợ timeout và hủy (SIGTERM, sau 3s SIGKILL).
 */
export function spawnAgent(opts: SpawnAgentOptions, hooks: AgentRunHooks): Promise<AgentRunOutcome> {
  return new Promise(resolve => {
    const child = spawn(opts.bin, opts.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let outcome: AgentRunOutcome | null = null;
    let stderr = '';
    let settled = false;
    const finish = (o: AgentRunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      hooks.signal.removeEventListener('abort', onAbort);
      resolve(o);
    };

    const kill = (reason: string) => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 3000).unref();
      }
      finish({ ok: false, error: reason });
    };
    const onAbort = () => kill('Đã hủy');
    if (hooks.signal.aborted) {
      kill('Đã hủy');
      return;
    }
    hooks.signal.addEventListener('abort', onAbort);
    const timer = setTimeout(() => kill(`Quá thời gian ${Math.round(opts.timeoutMs / 1000)}s`), opts.timeoutMs);

    readline.createInterface({ input: child.stdout }).on('line', line => {
      for (const item of opts.parseLine(line)) {
        if (item.kind === 'step') hooks.onStep(item.message);
        else if (item.kind === 'text') hooks.onText(item.text);
        else if (item.kind === 'model') hooks.onModel?.(item.model);
        else outcome = { ok: item.ok, resultText: item.text, error: item.error, costUsd: item.costUsd, durationMs: item.durationMs };
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    child.on('error', err => finish({ ok: false, error: `Không chạy được ${opts.bin}: ${err.message}` }));
    child.on('close', code => {
      if (outcome) finish(outcome);
      else finish({ ok: false, error: `${opts.name} thoát với mã ${code}${stderr ? `: ${stderr.trim().slice(-500)}` : ''}` });
    });

    child.stdin.on('error', () => {});
    child.stdin.end(opts.stdin ?? '');
  });
}

/** Kiểm tra binary chạy được (`<bin> --version`). */
export function checkBinary(bin: string): { available: boolean; reason?: string } {
  try {
    const r = spawnSync(bin, ['--version'], { timeout: 10_000, encoding: 'utf8' });
    if (r.error) return { available: false, reason: `Không tìm thấy ${bin}: ${r.error.message}` };
    if (r.status !== 0) return { available: false, reason: `${bin} --version thoát với mã ${r.status}` };
    return { available: true };
  } catch (err) {
    return { available: false, reason: (err as Error).message };
  }
}
