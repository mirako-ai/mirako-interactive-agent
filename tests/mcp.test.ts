import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { tool } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { createMetisChatResponse } from "../src/chat/runtime";
import { normalizeChatRequestBody } from "../src/chat/request";
import { InMemoryCodeModeRunLimiter } from "../src/codemode/executor";
import { createMcpTools, executeMcpToolCall, loadMcpToolRegistry, mcpToolResultToModelOutput } from "../src/mcp";

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("loadMcpToolRegistry sends streamable HTTP accept header and reuses MCP session id", async () => {
  const requests: Array<{ headers: Headers; body: string }> = [];

  globalThis.fetch = (async (input, init) => {
    const headers = new Headers(init?.headers);
    const body = String(init?.body ?? "");
    requests.push({ headers, body });

    const payload = JSON.parse(body) as { method: string; id?: string };
    if (payload.method === "initialize") {
      return Response.json(
        {
          jsonrpc: "2.0",
          id: payload.id,
          result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "demo", version: "1.0.0" } },
        },
        {
          headers: {
            "mcp-session-id": "session-123",
          },
        },
      );
    }

    if (payload.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    if (payload.method === "tools/list") {
      return Response.json({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          tools: [{ name: "lookup", description: "Lookup records", inputSchema: { type: "object" } }],
        },
      });
    }

    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  const result = await loadMcpToolRegistry([{ name: "demo", url: "https://mcp.example.com" }]);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.registry.tools.length, 1);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].headers.get("accept"), "application/json, text/event-stream");
  assert.equal(requests[0].headers.get("mcp-session-id"), null);
  assert.equal(requests[1].headers.get("mcp-session-id"), "session-123");
  assert.equal(requests[2].headers.get("mcp-session-id"), "session-123");
});

test("loadMcpToolRegistry accepts SSE JSON-RPC responses", async () => {
  globalThis.fetch = (async (_input, init) => {
    const payload = JSON.parse(String(init?.body ?? "")) as { method: string; id?: string };
    if (payload.method === "initialize") {
      return Response.json(
        {
          jsonrpc: "2.0",
          id: payload.id,
          result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "demo", version: "1.0.0" } },
        },
        {
          headers: {
            "mcp-session-id": "session-abc",
          },
        },
      );
    }

    if (payload.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    if (payload.method === "tools/list") {
      return new Response(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: { tools: [{ name: "lookup", inputSchema: { type: "object" } }] },
        })}\n\n`,
        {
          headers: {
            "content-type": "text/event-stream",
          },
        },
      );
    }

    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  const result = await loadMcpToolRegistry([{ name: "demo", url: "https://mcp.example.com" }]);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.registry.tools[0]?.originalName, "lookup");
});

test("createMetisChatResponse rejects duplicate local and MCP tool names", async () => {
  globalThis.fetch = (async (_input, init) => {
    const payload = JSON.parse(String(init?.body ?? "")) as { method: string; id?: string };
    if (payload.method === "initialize") {
      return Response.json(
        {
          jsonrpc: "2.0",
          id: payload.id,
          result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "demo", version: "1.0.0" } },
        },
        {
          headers: {
            "mcp-session-id": "session-duplicate",
          },
        },
      );
    }

    if (payload.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    if (payload.method === "tools/list") {
      return Response.json({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          tools: [{ name: "lookup", inputSchema: { type: "object" } }],
        },
      });
    }

    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

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
    {
      languageModel: new MockLanguageModelV3(),
      tools: {
        lookup: tool({
          description: "Local lookup.",
          inputSchema: z.object({}),
          execute: async () => ({ ok: true }),
        }),
      },
      mcpServers: [{ name: "demo", url: "https://mcp.example.com" }],
    },
  );

  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.status, 500);
  assert.match(response.error.message, /Duplicate tool name configured: lookup/);
});

test("executeMcpToolCall reuses MCP session id from registry tool", async () => {
  const requests: Array<{ headers: Headers; body: string }> = [];

  globalThis.fetch = (async (_input, init) => {
    const headers = new Headers(init?.headers);
    const body = String(init?.body ?? "");
    requests.push({ headers, body });

    const payload = JSON.parse(body) as { method: string; id?: string };
    if (payload.method === "initialize") {
      return Response.json(
        {
          jsonrpc: "2.0",
          id: payload.id,
          result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "demo", version: "1.0.0" } },
        },
        {
          headers: {
            "mcp-session-id": "session-999",
          },
        },
      );
    }

    if (payload.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    if (payload.method === "tools/list") {
      return Response.json({
        jsonrpc: "2.0",
        id: payload.id,
        result: { tools: [{ name: "lookup", inputSchema: { type: "object" } }] },
      });
    }

    if (payload.method === "tools/call") {
      return Response.json({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          structuredContent: { ok: true },
          content: [{ type: "text", text: "done" }],
        },
      });
    }

    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  const registry = await loadMcpToolRegistry([{ name: "demo", url: "https://mcp.example.com" }]);
  assert.equal(registry.ok, true);
  if (!registry.ok) return;

  const call = await executeMcpToolCall(registry.registry, registry.registry.tools[0].providerName, { q: "hello" });

  assert.equal(call.ok, true);
  assert.equal(requests.at(-1)?.headers.get("mcp-session-id"), "session-999");
});

test("loadMcpToolRegistry and executeMcpToolCall send bearer auth from mcp server entry", async () => {
  const requests: Array<{ headers: Headers; body: string }> = [];

  globalThis.fetch = (async (_input, init) => {
    const headers = new Headers(init?.headers);
    const body = String(init?.body ?? "");
    requests.push({ headers, body });

    const payload = JSON.parse(body) as { method: string; id?: string };
    if (payload.method === "initialize") {
      return Response.json(
        {
          jsonrpc: "2.0",
          id: payload.id,
          result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "demo", version: "1.0.0" } },
        },
        {
          headers: {
            "mcp-session-id": "session-auth",
          },
        },
      );
    }

    if (payload.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    if (payload.method === "tools/list") {
      return Response.json({
        jsonrpc: "2.0",
        id: payload.id,
        result: { tools: [{ name: "lookup", inputSchema: { type: "object" } }] },
      });
    }

    if (payload.method === "tools/call") {
      return Response.json({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          structuredContent: { ok: true },
          content: [{ type: "text", text: "done" }],
        },
      });
    }

    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  const registry = await loadMcpToolRegistry([{ name: "demo", url: "https://mcp.example.com", authToken: "secret-token" }]);
  assert.equal(registry.ok, true);
  if (!registry.ok) return;

  const call = await executeMcpToolCall(registry.registry, registry.registry.tools[0].providerName, { q: "hello" });

  assert.equal(call.ok, true);
  assert.equal(requests[0].headers.get("authorization"), "Bearer secret-token");
  assert.equal(requests[1].headers.get("authorization"), "Bearer secret-token");
  assert.equal(requests[2].headers.get("authorization"), "Bearer secret-token");
  assert.equal(requests[3].headers.get("authorization"), "Bearer secret-token");
});

test("mcpToolResultToModelOutput unwraps structured MCP results for the model", () => {
  const modelOutput = mcpToolResultToModelOutput({
    ok: true,
    tool: "lookup",
    structured: { drinks: [{ id: "tea-1", name: "Iced Tea" }] },
    text: "Iced Tea",
    is_error: false,
  });

  assert.deepEqual(modelOutput, {
    type: "json",
    value: { drinks: [{ id: "tea-1", name: "Iced Tea" }] },
  });
});

test("createMetisChatResponse passes unwrapped MCP structured results into the next model step", async () => {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];

  globalThis.fetch = (async (_input, init) => {
    const payload = JSON.parse(String(init?.body ?? "")) as {
      method: string;
      id?: string;
      params?: Record<string, unknown>;
    };
    requests.push({ method: payload.method, params: payload.params ?? {} });

    if (payload.method === "initialize") {
      return Response.json(
        {
          jsonrpc: "2.0",
          id: payload.id,
          result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "demo", version: "1.0.0" } },
        },
        {
          headers: {
            "mcp-session-id": "session-chain",
          },
        },
      );
    }

    if (payload.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    if (payload.method === "tools/list") {
      return Response.json({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          tools: [{ name: "get_drinks", description: "Return drinks", inputSchema: { type: "object" } }],
        },
      });
    }

    if (payload.method === "tools/call") {
      return Response.json({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          structuredContent: {
            drinks: [
              { id: "drink-1", name: "Negroni" },
              { id: "drink-2", name: "Spritz" },
            ],
          },
          content: [{ type: "text", text: "Found 2 drinks" }],
        },
      });
    }

    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  const request = normalizeChatRequestBody({
    session_id: "session-1",
    messages: [{ id: "msg-1", role: "user", parts: [{ type: "text", text: "Suggest a drink" }] }],
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
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "get_drinks",
              input: "{}",
            },
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
            { type: "text-delta", id: "text-1", delta: "Try the Negroni." },
            { type: "text-end", id: "text-1" },
            { type: "finish", finishReason: "stop", usage },
          ],
        }),
      };
    },
  });

  const response = await createMetisChatResponse(
    {
      CODE_MODE_ENABLED: "false",
      MCP_SERVER_ALLOWLIST: "mcp.example.com",
    },
    request.request,
    new InMemoryCodeModeRunLimiter(),
    { languageModel: model, mcpServers: [{ name: "demo", url: "https://mcp.example.com" }] },
  );

  assert.equal(response.ok, true);
  if (!response.ok) return;

  await response.response.text();

  assert.equal(model.doStreamCalls.length, 2);
  const secondPrompt = model.doStreamCalls[1]?.prompt;
  assert.ok(secondPrompt);

  const toolMessage = secondPrompt?.find((message) => message.role === "tool");
  assert.ok(toolMessage && toolMessage.role === "tool");
  if (!toolMessage || toolMessage.role !== "tool") return;

  assert.equal(toolMessage.content.length, 1);
  assert.deepEqual(toolMessage.content[0]?.type, "tool-result");
  assert.deepEqual(toolMessage.content[0]?.toolCallId, "call-1");
  assert.deepEqual(toolMessage.content[0]?.toolName, "get_drinks");
  assert.deepEqual(toolMessage.content[0]?.output, {
    type: "json",
    value: {
      drinks: [
        { id: "drink-1", name: "Negroni" },
        { id: "drink-2", name: "Spritz" },
      ],
    },
  });

  const registry = await loadMcpToolRegistry([{ name: "demo", url: "https://mcp.example.com" }]);
  assert.equal(registry.ok, true);
  if (!registry.ok) return;

  const tools = createMcpTools(registry.registry) as Record<string, { toModelOutput?: (options: { toolCallId: string; input: unknown; output: unknown }) => unknown }>;
  const modelOutput = await tools.get_drinks.toModelOutput?.({
    toolCallId: "call-1",
    input: {},
    output: {
      ok: true,
      tool: "get_drinks",
      structured: {
        drinks: [
          { id: "drink-1", name: "Negroni" },
          { id: "drink-2", name: "Spritz" },
        ],
      },
      text: "Found 2 drinks",
      is_error: false,
    },
  });

  assert.deepEqual(modelOutput, {
    type: "json",
    value: {
      drinks: [
        { id: "drink-1", name: "Negroni" },
        { id: "drink-2", name: "Spritz" },
      ],
    },
  });

  const toolCallRequest = requests.find((request) => request.method === "tools/call");
  assert.deepEqual(toolCallRequest?.params, {
    name: "get_drinks",
    arguments: {},
  });
});

test("createMetisChatResponse relays MCP visual tool results and hides payloads from the model", async () => {
  globalThis.fetch = (async (_input, init) => {
    const payload = JSON.parse(String(init?.body ?? "{}")) as { method: string; id?: string };
    if (payload.method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id: payload.id,
        result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "demo", version: "1.0.0" } },
      });
    }

    if (payload.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    if (payload.method === "tools/list") {
      return Response.json({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          tools: [{ name: "show_image", description: "Show image", inputSchema: { type: "object" } }],
        },
      });
    }

    if (payload.method === "tools/call") {
      return Response.json({
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          type: "data-image",
          id: "mcp-image",
          data: { url: "https://cdn.example.com/mcp/image.png", displayMode: "pip" },
        },
      });
    }

    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;

  const request = normalizeChatRequestBody({
    session_id: "session-1",
    messages: [{ id: "msg-1", role: "user", parts: [{ type: "text", text: "Show image" }] }],
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
                { type: "tool-call", toolCallId: "call-1", toolName: "show_image", input: "{}" },
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
                { type: "text-delta", id: "text-1", delta: "Displayed." },
                { type: "text-end", id: "text-1" },
                { type: "finish", finishReason: "stop", usage },
              ],
            }),
          };
    },
  });

  const response = await createMetisChatResponse(
    { CODE_MODE_ENABLED: "false", MCP_SERVER_ALLOWLIST: "mcp.example.com" },
    request.request,
    new InMemoryCodeModeRunLimiter(),
    { languageModel: model, mcpServers: [{ name: "demo", url: "https://mcp.example.com" }] },
  );

  assert.equal(response.ok, true);
  if (!response.ok) return;

  const chunks = uiStreamJsonChunks(await response.response.text());
  assert.deepEqual(
    chunks.find((chunk) => chunk.type === "data-image"),
    {
      type: "data-image",
      id: "mcp-image",
      data: { url: "https://cdn.example.com/mcp/image.png", displayMode: "pip" },
    },
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
});

function uiStreamJsonChunks(text: string): Array<Record<string, any>> {
  return text
    .trim()
    .split("\n\n")
    .map((event) => event.replace(/^data: /, ""))
    .filter((event) => event.length > 0 && event !== "[DONE]")
    .map((event) => JSON.parse(event) as Record<string, any>);
}
