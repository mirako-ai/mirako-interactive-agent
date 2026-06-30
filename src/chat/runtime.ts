import {
  consumeStream,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateId,
  stepCountIs,
  streamText,
  type StreamTextOnFinishCallback,
  type LanguageModel,
  type ToolSet,
  type UIMessage,
  type UIMessageChunk,
  type UIMessageStreamOnFinishCallback,
} from "ai";
import type { JSONValue } from "@ai-sdk/provider";
import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import { loadCodeModeConfig, type CodeModeConfig } from "../codemode/config";
import {
  DynamicWorkerCodeExecutor,
  RateLimitedCodeExecutor,
  type CodeExecutor,
  type CodeModeRunLimiter,
} from "../codemode/executor";
import { CODE_MODE_TOOL_NAME, createCodeModeTool } from "../codemode/tool";
import { createMcpTools, loadMcpToolRegistry, type McpServerConfig } from "../mcp";
import { isRecord } from "../shared/guards";
import { generationSettings, providerOptionsFor, resolveLanguageModel, type SupportedModel } from "./models";
import type { ChatRequestError, NormalizedChatRequest } from "./request";
import {
  METIS_TOOL_CLIENT_ACKNOWLEDGEMENT,
  METIS_TOOL_RESULT_ACKNOWLEDGEMENT,
  extractMetisToolClientParts,
  metisToolClientPartChunks,
} from "./visual-parts";

export const AGENT_INSTRUCTION = `You are mirako-interactive-agent, a Cloudflare Workers AI agent.
Act as the agent role in the pipeline: interpret the full conversation, produce a concise assistant response, and ask a short clarifying question when the request is ambiguous.`;

const CODE_MODE_SYSTEM_INSTRUCTION = `Code Mode is available as an internal execution tool named codemode.
When the conversation instructions require API calls, HTTP requests, webhooks, callbacks, task creation, external side effects, or reading an API response before answering, you MUST use the codemode tool before your final answer.
Write a JavaScript async arrow function that uses fetch() for the required HTTP calls and returns a short JSON-serializable execution summary.
Do not claim that an API-backed action started or succeeded unless the codemode execution result shows the required calls completed successfully.
Keep code, URLs, request IDs, and raw API details internal unless the user asks for debug information.
If codemode is invoked but no API-backed action is required, return a JSON object such as {"action_required":false,"reason":"no API call needed"} without calling fetch().`;

type ChatRuntimeEnv = {
  GOOGLE_API_KEY?: string;
  LOADER?: WorkerLoader;
  CODE_MODE_ENABLED?: string;
  CODE_MODE_TIMEOUT_MS?: string;
  CODE_MODE_CPU_MS?: string;
  CODE_MODE_MAX_STEPS?: string;
  CODE_MODE_MAX_GENERATED_CODE_BYTES?: string;
  CODE_MODE_MAX_RESULT_BYTES?: string;
  CODE_MODE_MAX_LOG_BYTES?: string;
  CODE_MODE_NETWORK_DEFAULT?: string;
  CODE_MODE_EXPOSE_SECRETS?: string;
  CODE_MODE_NPM_IMPORTS?: string;
  CODE_MODE_REMOTE_IMPORTS?: string;
  CODE_MODE_STATE_ENABLED?: string;
  CODE_MODE_FILESYSTEM_ENABLED?: string;
  CODE_MODE_MCP_ENABLED?: string;
  CODE_MODE_CAPABILITIES_ENABLED?: string;
  CODE_MODE_RECORD_CODE?: string;
  CODE_MODE_RECORD_LOGS?: string;
  CODE_MODE_RECORD_RESULT?: string;
  CODE_MODE_RUNS_PER_MINUTE?: string;
  CODE_MODE_CONCURRENT_RUNS?: string;
  MCP_SERVER_ALLOWLIST?: string;
  MCP_TIMEOUT_MS?: string;
  MCP_ALLOW_INSECURE_HTTP?: string;
};

type ToolToModelOutputOptions = {
  toolCallId: string;
  input: unknown;
  output: unknown;
};

export type StreamResponseOptions = {
  abortSignal?: AbortSignal;
  languageModel?: LanguageModel;
  model?: SupportedModel;
  systemPrompt?: string;
  modelFinish?: StreamTextOnFinishCallback<ToolSet>;
  uiFinish?: UIMessageStreamOnFinishCallback<UIMessage>;
  headers?: Record<string, string>;
  tools?: ToolSet;
  mcpServers?: McpServerConfig[];
};

export type RuntimeResponseResult =
  | { ok: true; response: Response }
  | { ok: false; error: ChatRequestError };

export async function createMetisChatResponse(
  env: ChatRuntimeEnv,
  request: NormalizedChatRequest,
  limiter: CodeModeRunLimiter,
  options: StreamResponseOptions = {},
): Promise<RuntimeResponseResult> {
  const codeMode = loadCodeModeConfig(env);
  if (!codeMode.ok) {
    return serverError(`Invalid Code Mode config: ${codeMode.error}`, 500);
  }

  const configuredModel = options.model;
  const languageModel = options.languageModel
    ? { ok: true as const, model: options.languageModel }
    : configuredModel
      ? resolveLanguageModel(env, configuredModel)
      : null;
  if (!languageModel) {
    return serverError("Chat model is not configured", 500);
  }
  if (!languageModel.ok) {
    return serverError(languageModel.error, 500);
  }

  const mcpServers = options.mcpServers ?? [];
  const tools = await buildTools(env, mcpServers, codeMode.config, limiter, options.tools, options.abortSignal);
  if (!tools.ok) {
    return { ok: false, error: tools.error };
  }

  const runtimeTools = wrapToolsForMetisClientParts(tools.tools);

  const modelMessages = await convertToModelMessages(request.messages, {
    tools: runtimeTools,
    ignoreIncompleteToolCalls: true,
  });

  const result = streamText({
    model: languageModel.model,
    system: systemInstruction(options.systemPrompt, mcpServers, codeMode.config),
    messages: modelMessages,
    tools: runtimeTools,
    stopWhen: Object.keys(runtimeTools).length > 0 ? stepCountIs(codeMode.config.execution.maxSteps) : undefined,
    providerOptions: configuredModel ? providerOptionsFor(configuredModel, request.thinking) : undefined,
    abortSignal: options.abortSignal,
    onFinish: options.modelFinish,
    ...generationSettings(request.generationOptions),
  });

  const modelStream = result.toUIMessageStream({
    sendReasoning: false,
    messageMetadata: ({ part }) => {
      if (part.type === "start") {
        return { model: configuredModel?.id ?? "test/model", createdAt: Date.now() };
      }
      if (part.type === "finish") {
        return { model: configuredModel?.id ?? "test/model", totalUsage: part.totalUsage };
      }
      return undefined;
    },
    onError: (error) => errorMessage(error),
  });

  const stream = createUIMessageStream<UIMessage>({
    originalMessages: request.messages,
    generateId: () => `msg_${generateId()}`,
    onFinish: options.uiFinish,
    onError: (error) => errorMessage(error),
    execute: ({ writer }) => {
      writer.merge(modelStream.pipeThrough(internalToolChunkFilter()).pipeThrough(metisToolResultChunkTransform()));
    },
  });

  return {
    ok: true,
    response: createUIMessageStreamResponse({
      stream: stream.pipeThrough(internalToolChunkFilter()),
      headers: options.headers,
      consumeSseStream: consumeStream,
    }),
  };
}

export function sanitizeMessagesForPersistence(messages: UIMessage[]) {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.filter((part) => !isInternalToolMessagePart(part)),
  }));
}

export function mergeSessionMessages(existing: readonly UIMessage[], incoming: readonly UIMessage[]) {
  const incomingById = new Map(incoming.map((message) => [message.id, message]));
  const seen = new Set<string>();
  const merged: UIMessage[] = [];

  for (const message of existing) {
    const replacement = incomingById.get(message.id);
    merged.push(replacement ?? message);
    seen.add(message.id);
  }

  for (const message of incoming) {
    if (!seen.has(message.id)) {
      merged.push(message);
    }
  }

  return merged;
}

export function isInternalToolUiChunk(chunk: UIMessageChunk) {
  if (chunk.type === "tool-input-available" || chunk.type === "tool-input-start" || chunk.type === "tool-input-error") {
    return isInternalToolName(chunk.toolName);
  }

  return false;
}

function internalToolChunkFilter() {
  const internalToolCallIds = new Set<string>();

  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      if (isNamedToolChunk(chunk) && isInternalToolName(chunk.toolName)) {
        internalToolCallIds.add(chunk.toolCallId);
        return;
      }

      if (isToolCallIdChunk(chunk) && internalToolCallIds.has(chunk.toolCallId)) {
        return;
      }

      controller.enqueue(chunk);
    },
  });
}

function metisToolResultChunkTransform() {
  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      if (chunk.type !== "tool-output-available") {
        controller.enqueue(chunk);
        return;
      }

      const parts = extractMetisToolClientParts(chunk.output);
      if (parts.length === 0) {
        controller.enqueue(chunk);
        return;
      }

      controller.enqueue({ ...chunk, output: METIS_TOOL_CLIENT_ACKNOWLEDGEMENT });
      for (const partChunk of metisToolClientPartChunks(parts)) {
        controller.enqueue(partChunk);
      }
    },
  });
}

function wrapToolsForMetisClientParts(tools: ToolSet): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, toolDefinition]) => [
      name,
      isInternalToolName(name) ? toolDefinition : wrapToolForMetisClientParts(toolDefinition),
    ]),
  );
}

function wrapToolForMetisClientParts(toolDefinition: ToolSet[string]): ToolSet[string] {
  const originalToModelOutput = toolDefinition.toModelOutput as
    | ((options: ToolToModelOutputOptions) => ToolResultOutput | PromiseLike<ToolResultOutput>)
    | undefined;

  return {
    ...toolDefinition,
    toModelOutput: async (options: ToolToModelOutputOptions) => {
      if (extractMetisToolClientParts(options.output).length > 0) {
        return { type: "text", value: METIS_TOOL_RESULT_ACKNOWLEDGEMENT };
      }

      if (originalToModelOutput) {
        return originalToModelOutput(options);
      }

      return defaultToolResultOutput(options.output);
    },
  } as ToolSet[string];
}

function defaultToolResultOutput(output: unknown): ToolResultOutput {
  if (typeof output === "string") {
    return { type: "text", value: output };
  }

  return { type: "json", value: (output === undefined ? null : output) as JSONValue };
}

async function buildTools(
  env: ChatRuntimeEnv,
  mcpServers: McpServerConfig[],
  codeMode: CodeModeConfig,
  limiter: CodeModeRunLimiter,
  endpointTools?: ToolSet,
  abortSignal?: AbortSignal,
): Promise<{ ok: true; tools: ToolSet } | { ok: false; error: ChatRequestError }> {
  const tools: ToolSet = { ...(endpointTools ?? {}) };
  const hasMcpServers = mcpServers.length > 0;
  const hasEndpointTools = Object.keys(tools).length > 0;

  if (codeMode.codeMode.enabled && !hasMcpServers && !hasEndpointTools) {
    const executor = createCodeExecutor(env, codeMode, limiter);
    if (!executor.ok) {
      return { ok: false, error: executor.error };
    }
    const merged = mergeToolSet(tools, { [CODE_MODE_TOOL_NAME]: createCodeModeTool(codeMode, executor.executor) });
    if (!merged.ok) {
      return { ok: false, error: merged.error };
    }
  }

  if (hasMcpServers) {
    const mcpAccess = validateMcpServers(env, mcpServers);
    if (!mcpAccess.ok) {
      return { ok: false, error: mcpAccess.error };
    }

    const registry = await loadMcpToolRegistry(mcpServers, {
      signal: abortSignal,
      timeoutMs: mcpAccess.timeoutMs,
    });
    if (!registry.ok) {
      return { ok: false, error: { status: 502, code: "mcp_error", message: registry.error } };
    }
    const merged = mergeToolSet(tools, createMcpTools(registry.registry));
    if (!merged.ok) {
      return { ok: false, error: merged.error };
    }
  }

  return { ok: true, tools };
}

function mergeToolSet(target: ToolSet, source: ToolSet): { ok: true } | { ok: false; error: ChatRequestError } {
  for (const [name, toolDefinition] of Object.entries(source)) {
    if (target[name]) {
      return serverError(`Duplicate tool name configured: ${name}`);
    }
    target[name] = toolDefinition;
  }

  return { ok: true };
}

function validateMcpServers(
  env: ChatRuntimeEnv,
  servers: McpServerConfig[],
): { ok: true; timeoutMs: number } | { ok: false; error: ChatRequestError } {
  const allowed = parseMcpAllowlist(env.MCP_SERVER_ALLOWLIST);
  if (allowed.size === 0) {
    return invalidMcpServers("mcp_servers are not enabled; configure MCP_SERVER_ALLOWLIST to allow MCP hosts");
  }

  for (const server of servers) {
    const url = new URL(server.url);
    if (!isAllowedMcpUrlScheme(url, env.MCP_ALLOW_INSECURE_HTTP)) {
      return invalidMcpServers("MCP servers must use https unless they use local loopback http");
    }
    if (!allowed.has(url.hostname) && !allowed.has(url.origin)) {
      return invalidMcpServers(`MCP server ${url.hostname} is not in MCP_SERVER_ALLOWLIST`);
    }
  }

  const timeoutMs = parsePositiveInteger(env.MCP_TIMEOUT_MS, 15000);
  if (timeoutMs === null) {
    return serverError("MCP_TIMEOUT_MS must be a positive integer");
  }

  return { ok: true, timeoutMs };
}

function invalidMcpServers(message: string): { ok: false; error: ChatRequestError } {
  return {
    ok: false,
    error: {
      status: 400,
      code: "invalid_request",
      message,
      param: "mcp_servers",
    },
  };
}

function parseMcpAllowlist(raw: string | undefined) {
  const values = new Set<string>();
  for (const item of raw?.split(",") ?? []) {
    const trimmed = item.trim().toLowerCase();
    if (trimmed.length > 0) {
      values.add(trimmed);
    }
  }
  return values;
}

function parsePositiveInteger(raw: string | undefined, fallback: number) {
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const value = Number(raw.trim());
  return Number.isInteger(value) && value > 0 ? value : null;
}

function createCodeExecutor(
  env: ChatRuntimeEnv,
  codeMode: CodeModeConfig,
  limiter: CodeModeRunLimiter,
): { ok: true; executor: CodeExecutor } | { ok: false; error: ChatRequestError } {
  if (!env.LOADER) {
    return {
      ok: false,
      error: { status: 500, code: "server_error", message: "Code Mode is enabled but LOADER is not configured" },
    };
  }

  return {
    ok: true,
    executor: new RateLimitedCodeExecutor(new DynamicWorkerCodeExecutor(env.LOADER, codeMode), codeMode, limiter),
  };
}

function systemInstruction(systemPrompt: string | undefined, mcpServers: McpServerConfig[], codeMode: CodeModeConfig) {
  const prompt = systemPrompt?.trim() || AGENT_INSTRUCTION;
  const instructions = [prompt];

  if (codeMode.codeMode.enabled && mcpServers.length === 0) {
    instructions.push(CODE_MODE_SYSTEM_INSTRUCTION);
  }

  return instructions.join("\n\n");
}

function isInternalToolMessagePart(part: UIMessage["parts"][number]) {
  if (!isRecord(part) || typeof part.type !== "string") {
    return false;
  }

  return part.type.startsWith("tool-") || part.type === "dynamic-tool";
}

function isInternalToolName(toolName: string) {
  return toolName === CODE_MODE_TOOL_NAME;
}

function isNamedToolChunk(chunk: UIMessageChunk): chunk is UIMessageChunk & { toolCallId: string; toolName: string } {
  return chunk.type === "tool-input-available" || chunk.type === "tool-input-start" || chunk.type === "tool-input-error";
}

function isToolCallIdChunk(chunk: UIMessageChunk): chunk is UIMessageChunk & { toolCallId: string } {
  return (
    chunk.type === "tool-input-delta" ||
    chunk.type === "tool-output-available" ||
    chunk.type === "tool-output-error" ||
    chunk.type === "tool-output-denied" ||
    chunk.type === "tool-approval-request"
  );
}

function isLoopbackHttpUrl(url: URL) {
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

function isAllowedMcpUrlScheme(url: URL, allowInsecureHttp: string | undefined) {
  if (url.protocol === "https:" || isLoopbackHttpUrl(url)) {
    return true;
  }

  return parseBooleanFlag(allowInsecureHttp) === true && url.protocol === "http:";
}

function parseBooleanFlag(raw: string | undefined) {
  if (raw === undefined) {
    return false;
  }

  const normalized = raw.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function serverError(message: string, status = 500): { ok: false; error: ChatRequestError } {
  return { ok: false, error: { status, code: "server_error", message } };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "An error occurred.";
}
