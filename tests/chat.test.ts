import assert from "node:assert/strict";
import { test } from "bun:test";
import { tool, type UIMessage } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { InMemoryCodeModeRunLimiter } from "../src/codemode/executor";
import { CHAT_PATH, normalizeChatRequestBody } from "../src/chat/request";
import { createMetisChatResponse, isInternalToolUiChunk, mergeSessionMessages, sanitizeMessagesForPersistence } from "../src/chat/runtime";
import { durableObjectNameForSession, extractSessionIdFromBody, loadSessionTtlMs } from "../src/chat/session";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

test("chat endpoint constant exposes the single sample route", () => {
  assert.equal(CHAT_PATH, "/v1/chat");
});

test("normalizeChatRequestBody accepts AI SDK UI messages", () => {
  const result = normalizeChatRequestBody({
    session_id: "session-1",
    messages: [{ id: "msg-1", role: "user", parts: [{ type: "text", text: "Hello" }] }],
    top_p: 0.5,
    max_output_tokens: 128,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.request.sessionId, "session-1");
  assert.equal(result.request.generationOptions.topP, 0.5);
  assert.equal(result.request.generationOptions.maxOutputTokens, 128);
});

test("normalizeChatRequestBody rejects request model selection", () => {
  const result = normalizeChatRequestBody({
    session_id: "session-1",
    model: "example/legacy-model",
    messages: [{ id: "msg-1", role: "user", parts: [{ type: "text", text: "Hello" }] }],
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.param, "model");
});

test("normalizeChatRequestBody rejects legacy completion controls", () => {
  const result = normalizeChatRequestBody({
    session_id: "session-1",
    messages: [{ id: "msg-1", role: "user", parts: [{ type: "text", text: "Hello" }] }],
    stream: true,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.param, "stream");
});

test("normalizeChatRequestBody rejects public tool parts", () => {
  const result = normalizeChatRequestBody({
    session_id: "session-1",
    messages: [
      {
        id: "msg-1",
        role: "assistant",
        parts: [{ type: "tool-codemode", toolCallId: "call-1", state: "input-available", input: {} }],
      },
    ],
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error.message, /not allowed/);
});

test("session helpers validate ttl and hash durable object names", async () => {
  assert.deepEqual(loadSessionTtlMs({}), { ok: true, ttlMs: 60 * 60 * 1000 });
  assert.equal(loadSessionTtlMs({ SESSION_TTL_MS: "0" }).ok, false);

  assert.deepEqual(extractSessionIdFromBody({ session_id: " user-session " }), {
    ok: true,
    sessionId: "user-session",
  });

  const name = await durableObjectNameForSession("user-session");
  assert.match(name, /^session:[a-f0-9]{64}$/);
  assert.equal(name.includes("user-session"), false);
});

test("createMetisChatResponse emits AI SDK UI stream chunks", async () => {
  const request = normalizeChatRequestBody({
    session_id: "session-1",
    messages: [{ id: "msg-1", role: "user", parts: [{ type: "text", text: "Hello" }] }],
  });
  assert.equal(request.ok, true);
  if (!request.ok) return;

  const model = new MockLanguageModelV3({
    provider: "mock",
    modelId: "mock-model",
    doStream: {
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "response-metadata", id: "response-1", modelId: "mock-model", timestamp: new Date(0) },
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", delta: "Hello" },
          { type: "text-end", id: "text-1" },
          { type: "finish", finishReason: "stop", usage },
        ],
      }),
    },
  });

  const response = await createMetisChatResponse(
    { CODE_MODE_ENABLED: "false" },
    request.request,
    new InMemoryCodeModeRunLimiter(),
    { languageModel: model },
  );

  assert.equal(response.ok, true);
  if (!response.ok) return;
  assert.equal(response.response.headers.get("x-vercel-ai-ui-message-stream"), "v1");

  const text = await response.response.text();
  const events = text
    .trim()
    .split("\n\n")
    .map((event) => event.replace(/^data: /, ""));

  assert.equal(events.some((event) => event.includes("chat.completion.chunk")), false);
  assert.ok(events.some((event) => event.includes('"type":"text-delta"') && event.includes('"delta":"Hello"')));
  assert.equal(events.at(-1), "[DONE]");
});

test("createMetisChatResponse accepts endpoint-local tools without Code Mode or MCP config", async () => {
  const request = normalizeChatRequestBody({
    session_id: "session-1",
    messages: [{ id: "msg-1", role: "user", parts: [{ type: "text", text: "Hello" }] }],
  });
  assert.equal(request.ok, true);
  if (!request.ok) return;

  const response = await createMetisChatResponse(
    { CODE_MODE_ENABLED: "true" },
    request.request,
    new InMemoryCodeModeRunLimiter(),
    {
      languageModel: new MockLanguageModelV3({
        provider: "mock",
        modelId: "mock-model",
        doStream: {
          stream: simulateReadableStream({
            chunks: [
              { type: "stream-start", warnings: [] },
              { type: "response-metadata", id: "response-1", modelId: "mock-model", timestamp: new Date(0) },
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "Hello" },
              { type: "text-end", id: "text-1" },
              { type: "finish", finishReason: "stop", usage },
            ],
          }),
        },
      }),
      tools: {
        demo_lookup: tool({
          description: "Return demo data.",
          inputSchema: z.object({}),
          execute: async () => ({ ok: true }),
        }),
      },
    },
  );

  assert.equal(response.ok, true);
});

test("createMetisChatResponse relays local visual tool results and hides payloads from the model", async () => {
  const request = normalizeChatRequestBody({
    session_id: "session-1",
    messages: [{ id: "msg-1", role: "user", parts: [{ type: "text", text: "Show the chart" }] }],
  });
  assert.equal(request.ok, true);
  if (!request.ok) return;

  let modelCallCount = 0;
  const model = new MockLanguageModelV3({
    provider: "mock",
    modelId: "mock-model",
    doStream: () => {
      modelCallCount += 1;
      return modelCallCount === 1
        ? {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "response-metadata", id: "response-1", modelId: "mock-model", timestamp: new Date(0) },
                { type: "tool-call", toolCallId: "call-1", toolName: "show_chart", input: "{}" },
                { type: "finish", finishReason: "tool-calls", usage },
              ],
            }),
          }
        : {
            stream: simulateReadableStream({
              chunks: [
                { type: "stream-start", warnings: [] },
                { type: "response-metadata", id: "response-2", modelId: "mock-model", timestamp: new Date(0) },
                { type: "text-start", id: "text-1" },
                { type: "text-delta", id: "text-1", delta: "Here is the chart." },
                { type: "text-end", id: "text-1" },
                { type: "finish", finishReason: "stop", usage },
              ],
            }),
          };
    },
  });
  let persistedMessages: UIMessage[] = [];

  const response = await createMetisChatResponse(
    { CODE_MODE_ENABLED: "false" },
    request.request,
    new InMemoryCodeModeRunLimiter(),
    {
      languageModel: model,
      uiFinish: async ({ messages }) => {
        persistedMessages = messages;
      },
      tools: {
        show_chart: tool({
          description: "Show a visual chart.",
          inputSchema: z.object({}),
          execute: async () => [
            {
              type: "data-image" as const,
              id: "chart-1",
              data: { url: "https://cdn.example.com/charts/revenue.png", displayMode: "sbs" as const },
            },
            {
              type: "file" as const,
              url: "https://cdn.example.com/videos/demo.mp4",
              mediaType: "video/mp4",
            },
          ],
        }),
      },
    },
  );

  assert.equal(response.ok, true);
  if (!response.ok) return;

  const chunks = uiStreamJsonChunks(await response.response.text());
  assert.deepEqual(
    chunks.find((chunk) => chunk.type === "data-image"),
    {
      type: "data-image",
      id: "chart-1",
      data: { url: "https://cdn.example.com/charts/revenue.png", displayMode: "sbs" },
    },
  );
  assert.deepEqual(
    chunks.find((chunk) => chunk.type === "file"),
    { type: "file", url: "https://cdn.example.com/videos/demo.mp4", mediaType: "video/mp4" },
  );
  assert.deepEqual(
    chunks.find((chunk) => chunk.type === "tool-output-available")?.output,
    { ok: true, message: "Tool executed successfully." },
  );

  const secondPrompt = model.doStreamCalls[1]?.prompt;
  const toolMessage = secondPrompt?.find((message) => message.role === "tool");
  assert.ok(toolMessage && toolMessage.role === "tool");
  if (!toolMessage || toolMessage.role !== "tool") return;
  assert.deepEqual(toolMessage.content[0]?.output, { type: "text", value: "Tool executed successfully." });

  const persistedAssistant = persistedMessages.at(-1);
  assert.ok(persistedAssistant?.parts.some((part) => part.type === "data-image" && part.id === "chart-1"));
  assert.ok(persistedAssistant?.parts.some((part) => part.type === "file" && part.url === "https://cdn.example.com/videos/demo.mp4"));
});

test("createMetisChatResponse rejects MCP servers without allowlist", async () => {
  const request = normalizeChatRequestBody({
    session_id: "session-1",
    messages: [{ id: "msg-1", role: "user", parts: [{ type: "text", text: "Hello" }] }],
  });
  assert.equal(request.ok, true);
  if (!request.ok) return;

  const response = await createMetisChatResponse(
    { CODE_MODE_ENABLED: "false", MCP_SERVER_ALLOWLIST: "" },
    request.request,
    new InMemoryCodeModeRunLimiter(),
    { languageModel: new MockLanguageModelV3(), mcpServers: [{ name: "tools", url: "https://mcp.example.com" }] },
  );

  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.status, 400);
  assert.match(response.error.message, /MCP_SERVER_ALLOWLIST/);
});

test("createMetisChatResponse rejects non-loopback http MCP servers by default", async () => {
  const request = normalizeChatRequestBody({
    session_id: "session-1",
    messages: [{ id: "msg-1", role: "user", parts: [{ type: "text", text: "Hello" }] }],
  });
  assert.equal(request.ok, true);
  if (!request.ok) return;

  const response = await createMetisChatResponse(
    { CODE_MODE_ENABLED: "false", MCP_SERVER_ALLOWLIST: "mcp.example.com" },
    request.request,
    new InMemoryCodeModeRunLimiter(),
    { languageModel: new MockLanguageModelV3(), mcpServers: [{ name: "tools", url: "http://mcp.example.com" }] },
  );

  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.status, 400);
  assert.match(response.error.message, /must use https/i);
});

test("createMetisChatResponse allows non-loopback http MCP servers when enabled by env", async () => {
  const request = normalizeChatRequestBody({
    session_id: "session-1",
    messages: [{ id: "msg-1", role: "user", parts: [{ type: "text", text: "Hello" }] }],
  });
  assert.equal(request.ok, true);
  if (!request.ok) return;

  const response = await createMetisChatResponse(
    {
      CODE_MODE_ENABLED: "false",
      MCP_SERVER_ALLOWLIST: "mcp.example.com",
      MCP_ALLOW_INSECURE_HTTP: "true",
    },
    request.request,
    new InMemoryCodeModeRunLimiter(),
    { languageModel: new MockLanguageModelV3(), mcpServers: [{ name: "tools", url: "http://mcp.example.com" }] },
  );

  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.status, 502);
  assert.match(response.error.message, /failed/i);
});

test("normalizeChatRequestBody rejects request-supplied MCP servers", () => {
  const result = normalizeChatRequestBody({
    session_id: "session-1",
    messages: [{ id: "msg-1", role: "user", parts: [{ type: "text", text: "Hello" }] }],
    mcp_servers: [{ name: "tools", url: "https://mcp.example.com", authToken: "secret-token" }],
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.param, "mcp_servers");
});

test("mergeSessionMessages preserves prior session history and appends incoming messages", () => {
  const existing = [
    { id: "msg-1", role: "user" as const, parts: [{ type: "text" as const, text: "first" }] },
    { id: "msg-2", role: "assistant" as const, parts: [{ type: "text" as const, text: "answer" }] },
  ];
  const incoming = [{ id: "msg-3", role: "user" as const, parts: [{ type: "text" as const, text: "next" }] }];

  assert.deepEqual(
    mergeSessionMessages(existing, incoming).map((message) => message.id),
    ["msg-1", "msg-2", "msg-3"],
  );
});

test("tool chunks and persisted tool parts are treated as internal", () => {
  assert.equal(
    isInternalToolUiChunk({ type: "tool-input-available", toolCallId: "call-1", toolName: "codemode", input: {} }),
    true,
  );
  assert.equal(
    isInternalToolUiChunk({ type: "tool-input-available", toolCallId: "call-2", toolName: "kettybot_start_navigation", input: {} }),
    false,
  );
  assert.equal(isInternalToolUiChunk({ type: "text-delta", id: "text-1", delta: "ok" }), false);

  const sanitized = sanitizeMessagesForPersistence([
    {
      id: "msg-1",
      role: "assistant",
      parts: [
        { type: "text", text: "done" },
        { type: "tool-codemode", toolCallId: "call-1", state: "input-available", input: { code: "secret" } } as any,
      ],
    },
  ]);

  assert.deepEqual(sanitized[0].parts, [{ type: "text", text: "done" }]);
});

function uiStreamJsonChunks(text: string): Array<Record<string, any>> {
  return text
    .trim()
    .split("\n\n")
    .map((event) => event.replace(/^data: /, ""))
    .filter((event) => event.length > 0 && event !== "[DONE]")
    .map((event) => JSON.parse(event) as Record<string, any>);
}
