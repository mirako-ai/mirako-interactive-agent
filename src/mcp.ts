import { jsonSchema, tool, type ToolSet } from "ai";
import type { JSONValue } from "@ai-sdk/provider";
import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import { extractMetisToolClientParts } from "./chat/visual-parts";
import { isRecord } from "./shared/guards";

export type McpServerConfig = {
  name: string;
  url: string;
  authToken?: string;
};

export type McpToolDefinition = {
  server: McpServerConfig;
  sessionId?: string;
  originalName: string;
  providerName: string;
  description: string;
  inputSchema: unknown;
};

export type McpToolRegistry = {
  tools: McpToolDefinition[];
  byProviderName: Map<string, McpToolDefinition>;
};

export type McpRegistryResult =
  | { ok: true; registry: McpToolRegistry }
  | { ok: false; error: string };

export type McpRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  sessionId?: string;
  authToken?: string;
};

const DEFAULT_MCP_TIMEOUT_MS = 15000;
const MCP_JSON_HEADERS = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

export async function loadMcpToolRegistry(servers: McpServerConfig[], options: McpRequestOptions = {}): Promise<McpRegistryResult> {
  const tools: McpToolDefinition[] = [];
  const usedProviderNames = new Set<string>();

  for (const server of servers) {
    try {
      const initialized = await initializeMcpServer(server, { ...options, authToken: server.authToken });
      const listed = await mcpRpc(server, "tools/list", {}, { ...options, sessionId: initialized.sessionId, authToken: server.authToken });
      if (!isRecord(listed.result) || !Array.isArray(listed.result.tools)) {
        return { ok: false, error: `MCP server ${server.name} returned an invalid tools/list response` };
      }

      const sessionId = listed.sessionId ?? initialized.sessionId;

      for (const item of listed.result.tools) {
        if (!isRecord(item) || typeof item.name !== "string" || item.name.trim().length === 0) {
          continue;
        }

        const originalName = item.name.trim();
        tools.push({
          server,
          sessionId,
          originalName,
          providerName: uniqueProviderToolName(originalName, usedProviderNames),
          description: typeof item.description === "string" ? item.description : "",
          inputSchema: item.inputSchema ?? item.input_schema ?? { type: "object" },
        });
      }
    } catch (error) {
      return { ok: false, error: `MCP server ${server.name} failed: ${errorMessage(error)}` };
    }
  }

  if (tools.length === 0) {
    return { ok: false, error: "No MCP tools were available" };
  }

  return {
    ok: true,
    registry: {
      tools,
      byProviderName: new Map(tools.map((mcpTool) => [mcpTool.providerName, mcpTool])),
    },
  };
}

export function createMcpTools(registry: McpToolRegistry): ToolSet {
  return Object.fromEntries(
    registry.tools.map((mcpTool) => [
      mcpTool.providerName,
      tool({
        description: mcpToolDescription(mcpTool),
        inputSchema: jsonSchema(toJsonSchemaObject(mcpTool.inputSchema)),
        execute: async (input, options) => executeMcpToolCall(registry, mcpTool.providerName, input, { signal: options.abortSignal }),
        toModelOutput: ({ output }) => mcpToolResultToModelOutput(output),
      }),
    ]),
  );
}

export async function executeMcpToolCall(
  registry: McpToolRegistry,
  providerName: string,
  rawArguments: unknown,
  options: McpRequestOptions = {},
) {
  const mcpTool = registry.byProviderName.get(providerName);
  if (!mcpTool) {
    return { ok: false, error: `Unknown MCP tool: ${providerName}` };
  }

  const parsedArguments = parseMcpToolArguments(rawArguments);
  if (parsedArguments instanceof Error) {
    return {
      ok: false,
      tool: mcpTool.originalName,
      text: parsedArguments.message,
      is_error: true,
    };
  }

  try {
    const result = await mcpRpc(
      mcpTool.server,
      "tools/call",
      {
        name: mcpTool.originalName,
        arguments: parsedArguments,
      },
      { ...options, sessionId: mcpTool.sessionId ?? options.sessionId, authToken: mcpTool.server.authToken },
    );
    mcpTool.sessionId = result.sessionId ?? mcpTool.sessionId;
    if (extractMetisToolClientParts(result.result).length > 0) {
      return result.result;
    }

    const normalized = normalizeMcpToolResult(result.result);
    return {
      ok: normalized.is_error !== true,
      tool: mcpTool.originalName,
      structured: normalized.structured,
      text: normalized.text,
      is_error: normalized.is_error ?? false,
    };
  } catch (error) {
    return {
      ok: false,
      tool: mcpTool.originalName,
      text: errorMessage(error),
      is_error: true,
    };
  }
}

export function uniqueProviderToolName(originalName: string, used: Set<string>) {
  const base = sanitizeProviderToolName(originalName);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    const suffixText = `_${suffix}`;
    candidate = `${base.slice(0, 64 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function mcpToolDescription(mcpTool: McpToolDefinition) {
  const suffix = `MCP tool ${mcpTool.originalName} from server ${mcpTool.server.name}.`;
  return mcpTool.description.trim().length > 0 ? `${mcpTool.description}\n${suffix}` : suffix;
}

async function initializeMcpServer(server: McpServerConfig, options: McpRequestOptions) {
  const initialized = await mcpRpc(
    server,
    "initialize",
    {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "mirako-interactive-agent", version: "1.0.0" },
    },
    options,
  );
  const initializedOptions = initialized.sessionId ? { ...options, sessionId: initialized.sessionId } : options;
  await mcpNotification(server, "notifications/initialized", {}, initializedOptions);
  return { sessionId: initialized.sessionId };
}

async function mcpRpc(server: McpServerConfig, method: string, params: unknown, options: McpRequestOptions) {
  const requestId = crypto.randomUUID();
  const response = await postMcpJsonRpc(server, method, params, options, requestId);

  if (!response.ok) {
    throw new Error(`${method} failed with status ${response.status}`);
  }

  return {
    result: await parseMcpRpcResponse(response, method, requestId),
    sessionId: sessionIdFromHeaders(response.headers) ?? options.sessionId,
  };
}

async function mcpNotification(server: McpServerConfig, method: string, params: unknown, options: McpRequestOptions) {
  const response = await postMcpJsonRpc(server, method, params, options);

  if (!response.ok) {
    throw new Error(`${method} failed with status ${response.status}`);
  }
}

function postMcpJsonRpc(server: McpServerConfig, method: string, params: unknown, options: McpRequestOptions, id?: string) {
  return fetchWithTimeout(
    server.url,
    {
      method: "POST",
      headers: requestHeaders(options),
      body: JSON.stringify(jsonRpcPayload(method, params, id)),
    },
    options,
  );
}

async function parseMcpRpcResponse(response: Response, method: string, requestId: string) {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const text = await response.text();
  if (text.trim().length === 0) {
    return {};
  }

  if (contentType.includes("text/event-stream")) {
    return parseSseJsonRpcResponse(text, method, requestId);
  }

  return parseJsonRpcResponseText(text, method, requestId);
}

function parseJsonRpcResponseText(text: string, method: string, requestId: string) {
  const parsed = JSON.parse(text) as unknown;

  const response = findJsonRpcResult(parsed, requestId);
  if (response.ok) {
    if (response.error) {
      throw new Error(`${method} failed: ${response.error}`);
    }
    return response.result;
  }

  // Accept direct result payloads from less strict MCP servers.
  if (isRecord(parsed) && !("jsonrpc" in parsed) && !("id" in parsed) && !("error" in parsed)) {
    return parsed;
  }

  throw new Error(`${method} returned invalid JSON-RPC`);
}

function parseSseJsonRpcResponse(text: string, method: string, requestId: string) {
  const events = text.split(/\r?\n\r?\n/);

  for (const rawEvent of events) {
    const payload = sseEventData(rawEvent);
    if (!payload || payload === "[DONE]") {
      continue;
    }

    const parsed = JSON.parse(payload) as unknown;
    const response = findJsonRpcResult(parsed, requestId);
    if (!response.ok) {
      continue;
    }
    if (response.error) {
      throw new Error(`${method} failed: ${response.error}`);
    }
    return response.result;
  }

  throw new Error(`${method} response stream ended before JSON-RPC result arrived`);
}

function sseEventData(rawEvent: string) {
  const dataLines = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());

  return dataLines.length > 0 ? dataLines.join("\n") : "";
}

function findJsonRpcResult(
  payload: unknown,
  requestId: string,
): { ok: true; result: unknown; error?: undefined } | { ok: true; result?: undefined; error: string } | { ok: false } {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const match = findJsonRpcResult(item, requestId);
      if (match.ok) {
        return match;
      }
    }
    return { ok: false };
  }

  if (!isRecord(payload) || payload.id !== requestId) {
    return { ok: false };
  }

  if (isRecord(payload.error)) {
    return {
      ok: true,
      error: typeof payload.error.message === "string" ? payload.error.message : "JSON-RPC error",
    };
  }

  if (!("result" in payload)) {
    return { ok: true, error: "JSON-RPC response missing result" };
  }

  return { ok: true, result: payload.result };
}

function requestHeaders(options: McpRequestOptions) {
  const headers: Record<string, string> = { ...MCP_JSON_HEADERS };
  if (options.sessionId) {
    headers["Mcp-Session-Id"] = options.sessionId;
  }
  if (options.authToken) {
    headers.authorization = `Bearer ${options.authToken}`;
  }
  return headers;
}

function sessionIdFromHeaders(headers: Headers) {
  const sessionId = headers.get("mcp-session-id")?.trim();
  return sessionId && sessionId.length > 0 ? sessionId : undefined;
}

function jsonRpcPayload(method: string, params: unknown, id?: string) {
  return id === undefined ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params };
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, options: McpRequestOptions) {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort("MCP request timed out"), timeoutMs);
  const abort = () => controller.abort(options.signal?.reason ?? "MCP request aborted");

  try {
    if (options.signal?.aborted) {
      abort();
    } else {
      options.signal?.addEventListener("abort", abort, { once: true });
    }
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
  }
}

function parseMcpToolArguments(raw: unknown): Record<string, unknown> | Error {
  if (raw === null || raw === undefined) {
    return {};
  }
  if (!isRecord(raw)) {
    return new Error("MCP tool arguments must be a JSON object");
  }

  return raw;
}

function normalizeMcpToolResult(result: unknown) {
  if (!isRecord(result)) {
    return { structured: {}, text: String(result ?? ""), is_error: false };
  }

  return {
    structured: result.structuredContent,
    text: extractMcpResultText(result),
    is_error: result.isError === true,
  };
}

function extractMcpResultText(result: Record<string, unknown>) {
  if (!Array.isArray(result.content)) {
    return undefined;
  }

  const parts = result.content.filter(isMcpTextContent).map((item) => item.text);

  return parts.length > 0 ? parts.join("\n") : undefined;
}

export function mcpToolResultToModelOutput(output: unknown): ToolResultOutput {
  if (!isMcpToolExecutionResult(output)) {
    return typeof output === "string" ? { type: "text", value: output } : { type: "json", value: outputJsonValue(output) };
  }

  if (output.is_error) {
    if (output.structured !== undefined) {
      return { type: "error-json", value: outputJsonValue(output.structured) };
    }
    return { type: "error-text", value: output.text ?? `MCP tool ${output.tool} failed` };
  }

  if (output.structured !== undefined) {
    return { type: "json", value: outputJsonValue(output.structured) };
  }

  return { type: "text", value: output.text ?? "" };
}

function isMcpToolExecutionResult(
  value: unknown,
): value is { tool: string; structured?: unknown; text?: string; is_error?: boolean } {
  return isRecord(value) && typeof value.tool === "string";
}

function outputJsonValue(value: unknown) {
  return (value === undefined ? null : value) as JSONValue;
}

function isMcpTextContent(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function sanitizeProviderToolName(value: string) {
  const normalized = value
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const withPrefix = /^[A-Za-z_]/.test(normalized) ? normalized : `tool_${normalized}`;
  return (withPrefix || "tool").slice(0, 64);
}

function toJsonSchemaObject(schema: unknown) {
  return isRecord(schema) ? schema : { type: "object" };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "unknown error";
}
