import { isRecord } from "../shared/guards";
import type { CodeModeConfig } from "./config";

export type CodeExecutionUsage = {
  durationMs: number;
};

export type CodeExecutionResult =
  | {
      ok: true;
      result: unknown;
      logs: string[];
      usage: CodeExecutionUsage;
    }
  | {
      ok: false;
      error: string;
      logs: string[];
      usage: CodeExecutionUsage;
    };

export type RawCodeExecutionResult = {
  result?: unknown;
  error?: unknown;
  logs?: unknown;
};

export interface CodeExecutor {
  execute(code: string): Promise<CodeExecutionResult>;
}

export interface CodeModeRunLimiter {
  tryAcquire(config: CodeModeConfig, nowMs?: number): string | null;
  release(): void;
}

export class InMemoryCodeModeRunLimiter implements CodeModeRunLimiter {
  private windowStartMs: number | null = null;
  private runsInWindow = 0;
  private concurrentRuns = 0;

  tryAcquire(config: CodeModeConfig, nowMs = Date.now()): string | null {
    if (this.windowStartMs === null || nowMs - this.windowStartMs >= 60000) {
      this.windowStartMs = nowMs;
      this.runsInWindow = 0;
    }

    if (this.concurrentRuns >= config.rateLimits.concurrentCodeModeRuns) {
      return "Code Mode concurrency limit exceeded";
    }
    if (this.runsInWindow >= config.rateLimits.codeModeRunsPerMinute) {
      return "Code Mode rate limit exceeded";
    }

    this.runsInWindow += 1;
    this.concurrentRuns += 1;
    return null;
  }

  release(): void {
    this.concurrentRuns = Math.max(0, this.concurrentRuns - 1);
  }
}

export class RateLimitedCodeExecutor implements CodeExecutor {
  constructor(
    private readonly inner: CodeExecutor,
    private readonly config: CodeModeConfig,
    private readonly limiter: CodeModeRunLimiter,
  ) {}

  async execute(code: string): Promise<CodeExecutionResult> {
    const blocked = this.limiter.tryAcquire(this.config);
    if (blocked) {
      return {
        ok: false,
        error: blocked,
        logs: [],
        usage: { durationMs: 0 },
      };
    }

    try {
      return await this.inner.execute(code);
    } finally {
      this.limiter.release();
    }
  }
}

export class DynamicWorkerCodeExecutor implements CodeExecutor {
  constructor(
    private readonly loader: WorkerLoader,
    private readonly config: CodeModeConfig,
  ) {}

  async execute(code: string): Promise<CodeExecutionResult> {
    const start = Date.now();
    const codeValidation = validateGeneratedCode(code, this.config);
    if (codeValidation) {
      return failure(codeValidation, [], start);
    }

    try {
      const workerCode: WorkerLoaderWorkerCode = {
        compatibilityDate: "2026-05-04",
        compatibilityFlags: ["nodejs_compat"],
        limits: { cpuMs: this.config.execution.cpuMs },
        mainModule: "executor.js",
        modules: {
          "executor.js": buildDynamicWorkerModule(code, this.config.execution.timeoutMs),
        },
      };

      if (this.config.network.default === "deny") {
        workerCode.globalOutbound = null;
      }

      const worker = this.loader.load(workerCode);
      const entrypoint = worker.getEntrypoint(undefined, {
        limits: { cpuMs: this.config.execution.cpuMs },
      }) as unknown as { evaluate(): Promise<RawCodeExecutionResult> };

      const raw = await entrypoint.evaluate();
      return normalizeRawCodeExecutionResult(raw, this.config, Date.now() - start);
    } catch (error) {
      return failure(error instanceof Error ? error.message : "Code Mode execution failed", [], start);
    }
  }
}

export function validateGeneratedCode(code: string, config: CodeModeConfig): string | null {
  if (code.trim().length === 0) {
    return "Code Mode input must not be empty";
  }

  const byteCount = byteLength(code);
  if (byteCount > config.execution.maxGeneratedCodeBytes) {
    return `Generated code exceeds ${config.execution.maxGeneratedCodeBytes} bytes`;
  }

  return null;
}

export function normalizeRawCodeExecutionResult(
  raw: unknown,
  config: CodeModeConfig,
  durationMs: number,
): CodeExecutionResult {
  if (!isRecord(raw)) {
    return {
      ok: false,
      error: "Code Mode returned an invalid execution response",
      logs: [],
      usage: { durationMs },
    };
  }

  const logs = normalizeLogs(raw.logs, config.execution.maxLogBytes);
  if (typeof raw.error === "string" && raw.error.length > 0) {
    return {
      ok: false,
      error: raw.error,
      logs,
      usage: { durationMs },
    };
  }

  const resultSize = jsonByteLength(raw.result);
  if (typeof resultSize === "string") {
    return {
      ok: false,
      error: resultSize,
      logs,
      usage: { durationMs },
    };
  }
  if (resultSize > config.execution.maxResultBytes) {
    return {
      ok: false,
      error: `Code Mode result exceeds ${config.execution.maxResultBytes} bytes`,
      logs,
      usage: { durationMs },
    };
  }

  return {
    ok: true,
    result: raw.result,
    logs,
    usage: { durationMs },
  };
}

export function buildDynamicWorkerModule(code: string, timeoutMs: number) {
  const runnableCode = toRunnableCode(code);

  return `import { WorkerEntrypoint } from "cloudflare:workers";

export default class CodeModeWorker extends WorkerEntrypoint {
  async evaluate() {
    const __logs = [];
    const __stringify = (value) => {
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };
    const __pushLog = (level, values) => {
      const prefix = level === "log" ? "" : "[" + level + "] ";
      __logs.push(prefix + values.map(__stringify).join(" "));
    };
    console.log = (...values) => __pushLog("log", values);
    console.warn = (...values) => __pushLog("warn", values);
    console.error = (...values) => __pushLog("error", values);

    try {
      const __run = (${runnableCode});
      if (typeof __run !== "function") {
        throw new Error("Code Mode input must evaluate to a function");
      }
      const result = await Promise.race([
        Promise.resolve(__run()),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Code Mode execution timed out")), ${timeoutMs}))
      ]);
      return { result, logs: __logs };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error), logs: __logs };
    }
  }
}
`;
}

export function toRunnableCode(code: string) {
  const trimmed = code.trim();
  if (looksLikeFunctionExpression(trimmed)) {
    return trimmed;
  }

  if (looksLikeStatementBlock(trimmed)) {
    return `async () => {\n${trimmed}\n}`;
  }

  return `async () => (${trimmed})`;
}

function looksLikeFunctionExpression(code: string) {
  return /^(async\s+)?function\b/.test(code) || /^(async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(code);
}

function looksLikeStatementBlock(code: string) {
  return /(^|\s)(const|let|var|return|if|for|while|try|switch)\b/.test(code) || /;\s*\S/.test(code) || code.endsWith(";");
}

function normalizeLogs(rawLogs: unknown, maxBytes: number) {
  if (!Array.isArray(rawLogs)) {
    return [];
  }

  const logs: string[] = [];
  let totalBytes = 0;
  let truncated = false;

  for (const raw of rawLogs) {
    const line = typeof raw === "string" ? raw : String(raw);
    const lineBytes = byteLength(line);
    if (totalBytes + lineBytes > maxBytes) {
      truncated = true;
      break;
    }
    logs.push(line);
    totalBytes += lineBytes;
  }

  if (truncated) {
    logs.push("[logs truncated]");
  }

  return logs;
}

function failure(error: string, logs: string[], start: number): CodeExecutionResult {
  return {
    ok: false,
    error,
    logs,
    usage: { durationMs: Date.now() - start },
  };
}

function jsonByteLength(value: unknown): number | string {
  try {
    const json = JSON.stringify(value ?? null);
    return byteLength(json);
  } catch (error) {
    return `Code Mode result is not JSON serializable: ${error instanceof Error ? error.message : "unknown error"}`;
  }
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}
