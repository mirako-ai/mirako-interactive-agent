import assert from "node:assert/strict";
import { test } from "bun:test";
import { loadCodeModeConfig } from "../src/codemode/config";
import {
  InMemoryCodeModeRunLimiter,
  RateLimitedCodeExecutor,
  normalizeRawCodeExecutionResult,
  toRunnableCode,
  validateGeneratedCode,
  type CodeExecutor,
} from "../src/codemode/executor";
import { createCodeModeTool, parseCodeModeToolArguments } from "../src/codemode/tool";

test("loadCodeModeConfig defaults to disabled with MVP limits", () => {
  const result = loadCodeModeConfig({});

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.config.codeMode.enabled, false);
  assert.equal(result.config.execution.timeoutMs, 30000);
  assert.equal(result.config.execution.cpuMs, 1000);
  assert.equal(result.config.execution.maxSteps, 10);
  assert.equal(result.config.network.default, "allow");
  assert.equal(result.config.secrets.exposeToSandbox, false);
});

test("loadCodeModeConfig parses deployment overrides", () => {
  const result = loadCodeModeConfig({
    CODE_MODE_ENABLED: "true",
    CODE_MODE_TIMEOUT_MS: "15000",
    CODE_MODE_CPU_MS: "250",
    CODE_MODE_MAX_STEPS: "3",
    CODE_MODE_NETWORK_DEFAULT: "deny",
    CODE_MODE_RECORD_LOGS: "off",
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.config.codeMode.enabled, true);
  assert.equal(result.config.execution.timeoutMs, 15000);
  assert.equal(result.config.execution.cpuMs, 250);
  assert.equal(result.config.execution.maxSteps, 3);
  assert.equal(result.config.network.default, "deny");
  assert.equal(result.config.observability.recordLogs, false);
});

test("loadCodeModeConfig rejects unsupported MVP knobs", () => {
  const result = loadCodeModeConfig({ CODE_MODE_MCP_ENABLED: "true" });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /MCP/);
});

test("loadCodeModeConfig rejects excessive limits", () => {
  const result = loadCodeModeConfig({ CODE_MODE_MAX_STEPS: "101" });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /<= 100/);
});

test("parseCodeModeToolArguments validates code payloads", () => {
  const configResult = loadCodeModeConfig({ CODE_MODE_MAX_GENERATED_CODE_BYTES: "20" });
  assert.equal(configResult.ok, true);
  if (!configResult.ok) return;

  const parsed = parseCodeModeToolArguments(JSON.stringify({ code: "async () => 1" }), configResult.config);
  assert.deepEqual(parsed, { ok: true, code: "async () => 1" });

  const missing = parseCodeModeToolArguments({}, configResult.config);
  assert.equal(missing.ok, false);

  const oversized = parseCodeModeToolArguments({ code: "async () => 'this is too large'" }, configResult.config);
  assert.equal(oversized.ok, false);
});

test("executor helpers enforce generated code, result, and log limits", () => {
  const configResult = loadCodeModeConfig({
    CODE_MODE_MAX_GENERATED_CODE_BYTES: "13",
    CODE_MODE_MAX_RESULT_BYTES: "7",
    CODE_MODE_MAX_LOG_BYTES: "5",
  });
  assert.equal(configResult.ok, true);
  if (!configResult.ok) return;

  assert.equal(validateGeneratedCode("async () => 1", configResult.config), null);
  assert.match(validateGeneratedCode("async () => 'large'", configResult.config) ?? "", /Generated code exceeds/);

  const bigResult = normalizeRawCodeExecutionResult({ result: "abcdef" }, configResult.config, 4);
  assert.equal(bigResult.ok, false);
  if (!bigResult.ok) {
    assert.match(bigResult.error, /result exceeds/);
  }

  const logs = normalizeRawCodeExecutionResult({ result: 1, logs: ["abc", "def"] }, configResult.config, 4);
  assert.equal(logs.ok, true);
  assert.deepEqual(logs.logs, ["abc", "[logs truncated]"]);

  const nonSerializable = normalizeRawCodeExecutionResult({ result: 1n }, configResult.config, 4);
  assert.equal(nonSerializable.ok, false);
  if (!nonSerializable.ok) {
    assert.match(nonSerializable.error, /not JSON serializable/);
  }
});

test("toRunnableCode accepts functions, expressions, and statement blocks", () => {
  assert.equal(toRunnableCode("async () => 2 + 2"), "async () => 2 + 2");
  assert.equal(toRunnableCode("2 + 2"), "async () => (2 + 2)");
  assert.equal(toRunnableCode("const value = 2 + 2; return value;"), "async () => {\nconst value = 2 + 2; return value;\n}");
});

test("RateLimitedCodeExecutor enforces run and concurrency limits", async () => {
  const configResult = loadCodeModeConfig({
    CODE_MODE_RUNS_PER_MINUTE: "1",
    CODE_MODE_CONCURRENT_RUNS: "1",
  });
  assert.equal(configResult.ok, true);
  if (!configResult.ok) return;

  let releaseInner: (() => void) | null = null;
  const inner: CodeExecutor = {
    execute: () =>
      new Promise((resolve) => {
        releaseInner = () => resolve({ ok: true, result: 1, logs: [], usage: { durationMs: 1 } });
      }),
  };

  const limiter = new InMemoryCodeModeRunLimiter();
  const executor = new RateLimitedCodeExecutor(inner, configResult.config, limiter);
  const first = executor.execute("async () => 1");
  const concurrent = await executor.execute("async () => 2");

  assert.equal(concurrent.ok, false);
  if (!concurrent.ok) {
    assert.match(concurrent.error, /concurrency/);
  }

  assert.ok(releaseInner);
  releaseInner();
  assert.equal((await first).ok, true);

  const rateLimited = await executor.execute("async () => 3");
  assert.equal(rateLimited.ok, false);
  if (!rateLimited.ok) {
    assert.match(rateLimited.error, /rate limit/);
  }
});

test("createCodeModeTool executes through normalized executor payloads", async () => {
  const configResult = loadCodeModeConfig({ CODE_MODE_ENABLED: "true" });
  assert.equal(configResult.ok, true);
  if (!configResult.ok) return;

  const executor: CodeExecutor = {
    execute: async (code) => ({ ok: true, result: { code }, logs: [], usage: { durationMs: 2 } }),
  };

  const codeModeTool = createCodeModeTool(configResult.config, executor) as any;
  const result = await codeModeTool.execute({ code: "async () => 1" }, { toolCallId: "tool-1" });

  assert.deepEqual(result, {
    ok: true,
    result: { code: "async () => 1" },
    logs: [],
    usage: { durationMs: 2 },
  });
});
