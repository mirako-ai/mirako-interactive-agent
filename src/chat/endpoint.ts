import { getAgentByName } from "agents";
import type { ToolSet, UIMessage } from "ai";
import type { CodeModeRunLimiter } from "../codemode/executor";
import { jsonError, requestError, requireApiKey, streamHeaders } from "../http";
import type { McpServerConfig } from "../mcp";
import { normalizeChatRequestBody } from "./request";
import type { SupportedModel } from "./models";
import { createMetisChatResponse, mergeSessionMessages, sanitizeMessagesForPersistence } from "./runtime";
import { durableObjectNameForSession, extractSessionIdFromBody, loadSessionTtlMs } from "./session";

export type ChatEndpointContext = {
  env: Env;
  messages: readonly UIMessage[];
  limiter: CodeModeRunLimiter;
  touchSession: (ttlMs: number) => Promise<void>;
  persistMessages: (messages: UIMessage[]) => Promise<void>;
};

export type ChatEndpointToolFactory = (context: { env: Env }) => ToolSet;
export type ChatEndpointMcpServerFactory = (context: { env: Env }) => McpServerConfig[];

export type ChatEndpointConfig = {
  path: string;
  model: SupportedModel;
  systemPrompt?: string;
  tools?: ToolSet | ChatEndpointToolFactory;
  mcpServers?: McpServerConfig[] | ChatEndpointMcpServerFactory;
};

export class ChatEndpoint {
  readonly path: string;

  constructor(private readonly config: ChatEndpointConfig) {
    this.path = config.path;
  }

  async forwardToAgent(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return jsonError("Method not allowed", 405, "method_not_allowed");
    }

    const authError = requireApiKey(request, env);
    if (authError) {
      return authError;
    }

    const rawBody = await request.clone().json().catch(() => null);
    const session = extractSessionIdFromBody(rawBody);
    if (!session.ok) {
      return jsonError(session.error, 400, "invalid_request", "session_id");
    }

    const agentName = await durableObjectNameForSession(session.sessionId);
    const agent = await getAgentByName(env.MetisAgentCore, agentName);
    return agent.fetch(request);
  }

  async handleAgentRequest(request: Request, context: ChatEndpointContext): Promise<Response> {
    const authError = requireApiKey(request, context.env);
    if (authError) {
      return authError;
    }

    const rawBody = await request.json().catch(() => null);
    const normalized = normalizeChatRequestBody(rawBody);
    if (!normalized.ok) {
      return requestError(normalized.error);
    }

    const ttl = loadSessionTtlMs(context.env);
    if (!ttl.ok) {
      return jsonError(ttl.error, 500, "server_error");
    }
    await context.touchSession(ttl.ttlMs);

    const sessionMessages = mergeSessionMessages(context.messages, normalized.request.messages);
    const sessionRequest = {
      ...normalized.request,
      messages: sessionMessages,
    };
    await context.persistMessages(sessionMessages);

    const result = await createMetisChatResponse(context.env, sessionRequest, context.limiter, {
      abortSignal: request.signal,
      headers: streamHeaders(),
      model: this.config.model,
      systemPrompt: this.config.systemPrompt,
      tools: this.endpointTools(context.env),
      mcpServers: this.endpointMcpServers(context.env),
      uiFinish: async ({ messages }) => {
        await context.persistMessages(sanitizeMessagesForPersistence(messages));
      },
    });

    return result.ok ? result.response : requestError(result.error);
  }

  private endpointTools(env: Env) {
    return typeof this.config.tools === "function" ? this.config.tools({ env }) : this.config.tools;
  }

  private endpointMcpServers(env: Env) {
    if (typeof this.config.mcpServers === "function") {
      return this.config.mcpServers({ env });
    }

    return this.config.mcpServers ? [...this.config.mcpServers] : [];
  }
}
