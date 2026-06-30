import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import type { StreamTextOnFinishCallback, ToolSet, UIMessage } from "ai";
import { AGENT_MODEL, AGENT_SYSTEM_PROMPT, createAgentMcpServers, createAgentTools } from "./agent-config";
import { InMemoryCodeModeRunLimiter } from "./codemode/executor";
import { chatEndpoint } from "./chat/default";
import { CHAT_PATH, normalizeChatOptionsBody } from "./chat/request";
import { createMetisChatResponse, sanitizeMessagesForPersistence } from "./chat/runtime";
import { loadSessionTtlMs } from "./chat/session";
import type { ChatEndpointContext } from "./chat/endpoint";
import { corsPreflightResponse, jsonError, jsonResponse, requestError, streamHeaders } from "./http";

const ROOT_PATH = "/";
const HEALTH_PATH = "/health";
const CHAT_ENDPOINTS = [chatEndpoint] as const;

export class MetisAgentCore extends AIChatAgent<Env> {
  maxPersistedMessages = 200;
  private readonly codeModeLimiter = new InMemoryCodeModeRunLimiter();

  async onRequest(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return corsPreflightResponse();
    }

    const url = new URL(request.url);
    if (request.method !== "POST") {
      return jsonError("Not found", 404, "not_found");
    }

    const endpoint = chatEndpointFor(url.pathname);
    if (endpoint) {
      return endpoint.handleAgentRequest(request, this.chatEndpointContext());
    }

    return jsonError("Not found", 404, "not_found");
  }

  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions,
  ): Promise<Response | undefined> {
    const ttl = loadSessionTtlMs(this.env);
    if (ttl.ok) {
      await this.touchSession(ttl.ttlMs);
    }

    const normalized = normalizeChatOptionsBody(options?.body, this.messages);
    if (!normalized.ok) {
      return requestError(normalized.error);
    }

    const result = await createMetisChatResponse(this.env, normalized.request, this.codeModeLimiter, {
      abortSignal: options?.abortSignal,
      modelFinish: onFinish,
      headers: streamHeaders(),
      model: AGENT_MODEL,
      systemPrompt: AGENT_SYSTEM_PROMPT,
      tools: createAgentTools(this.env),
      mcpServers: createAgentMcpServers(this.env),
    });

    return result.ok ? result.response : requestError(result.error);
  }

  protected sanitizeMessageForPersistence(message: UIMessage): UIMessage {
    return sanitizeMessagesForPersistence([message])[0];
  }

  async alarm(): Promise<void> {
    const ttl = loadSessionTtlMs(this.env);
    if (!ttl.ok) {
      console.error(`[mirako-interactive-agent] invalid session ttl: ${ttl.error}`);
      await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000);
      return;
    }

    const lastAccessAt = (await this.ctx.storage.get<number>("lastAccessAt")) ?? 0;
    const expiresAt = lastAccessAt + ttl.ttlMs;
    if (Date.now() < expiresAt) {
      await this.ctx.storage.setAlarm(expiresAt);
      return;
    }

    if (this._activeStreamId || this.hasPendingInteraction() || !(await this.waitUntilStable({ timeout: 1 }))) {
      await this.ctx.storage.setAlarm(Date.now() + ttl.ttlMs);
      return;
    }

    await this.destroy();
  }

  private async touchSession(ttlMs: number) {
    const now = Date.now();
    await this.ctx.storage.put("lastAccessAt", now);
    await this.ctx.storage.setAlarm(now + ttlMs);
  }

  private chatEndpointContext(): ChatEndpointContext {
    return {
      env: this.env,
      messages: this.messages,
      limiter: this.codeModeLimiter,
      touchSession: (ttlMs) => this.touchSession(ttlMs),
      persistMessages: (messages) => this.persistMessages(messages),
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return corsPreflightResponse();
    }

    if (request.method === "GET" && url.pathname === ROOT_PATH) {
      return serviceInfoResponse();
    }

    if (request.method === "GET" && url.pathname === HEALTH_PATH) {
      return healthResponse();
    }

    const endpoint = chatEndpointFor(url.pathname);
    if (endpoint) {
      return endpoint.forwardToAgent(request, env);
    }

    return jsonError("Not found", 404, "not_found");
  },
} satisfies ExportedHandler<Env>;

function serviceInfoResponse() {
  return jsonResponse({
    service: "mirako-interactive-agent",
    runtime: "cloudflare-workers",
    role: "agent",
    agent: "MetisAgentCore",
    protocol: "AI SDK UI message stream",
    model: AGENT_MODEL.id,
    endpoints: {
      chat: CHAT_PATH,
      health: HEALTH_PATH,
    },
    state: "Conversation state is isolated by session_id and expires after the configured idle TTL.",
    configuration: "Edit src/agent-config.ts to change the model, system prompt, local tools, and MCP servers.",
  });
}

function healthResponse() {
  return jsonResponse({ ok: true, service: "mirako-interactive-agent" });
}

function chatEndpointFor(pathname: string) {
  return CHAT_ENDPOINTS.find((endpoint) => endpoint.path === pathname) ?? null;
}
