import { tool } from "ai";
import { z } from "zod";
import { isRecord } from "../shared/guards";
import type { CodeModeConfig } from "./config";
import type { CodeExecutionResult, CodeExecutor } from "./executor";

export const CODE_MODE_TOOL_NAME = "codemode";

export const CODE_MODE_TOOL_DESCRIPTION = `Execute JavaScript in Code Mode. This tool is required before the final answer when instructions require HTTP/API calls, callbacks, task creation, or any external side effect.
The input may be a JavaScript async arrow function, expression, or statement block. Prefer an async arrow function, for example: async () => { return 2 + 2; }.
Use fetch() for HTTP requests. Return a concise JSON-serializable value. Do not include secrets.`;

export type ParsedCodeModeArguments =
  | { ok: true; code: string }
  | { ok: false; error: string };

export function createCodeModeTool(config: CodeModeConfig, executor: CodeExecutor) {
  return tool({
    description: CODE_MODE_TOOL_DESCRIPTION,
    inputSchema: z.object({
      code: z.string().min(1).describe("JavaScript to execute in the sandbox. Prefer an async arrow function."),
    }),
    execute: async ({ code }) => {
      const parsed = parseCodeModeToolArguments({ code }, config);
      if (!parsed.ok) {
        return codeModeArgumentErrorPayload(parsed.error);
      }

      const result = await executor.execute(parsed.code);
      return codeExecutionResultPayload(result);
    },
  });
}

export function parseCodeModeToolArguments(raw: unknown, config: CodeModeConfig): ParsedCodeModeArguments {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return { ok: false, error: "Code Mode arguments must be valid JSON" };
    }
  }

  if (!isRecord(parsed) || typeof parsed.code !== "string") {
    return { ok: false, error: "Code Mode arguments must include a code string" };
  }

  const code = parsed.code.trim();
  if (code.length === 0) {
    return { ok: false, error: "Code Mode code must not be empty" };
  }

  const byteCount = new TextEncoder().encode(code).byteLength;
  if (byteCount > config.execution.maxGeneratedCodeBytes) {
    return { ok: false, error: `Generated code exceeds ${config.execution.maxGeneratedCodeBytes} bytes` };
  }

  return { ok: true, code };
}

export function codeExecutionResultPayload(result: CodeExecutionResult) {
  if (result.ok) {
    return {
      ok: true,
      result: result.result,
      logs: result.logs,
      usage: result.usage,
    };
  }

  return {
    ok: false,
    error: result.error,
    logs: result.logs,
    usage: result.usage,
  };
}

export function codeModeArgumentErrorPayload(error: string) {
  return {
    ok: false,
    error,
  };
}
