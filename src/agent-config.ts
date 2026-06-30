import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { McpServerConfig } from "./mcp";
import type { SupportedModel } from "./chat/models";

export const AGENT_MODEL: SupportedModel = {
  id: "google/gemini-3.1-flash-lite",
  provider: "google",
  upstreamModel: "gemini-3.1-flash-lite",
};

export const AGENT_SYSTEM_PROMPT = `You are a helpful sample AI agent.
Answer clearly and concisely. Use tools when they provide fresher or more precise information than your own knowledge.`;

export function createAgentTools(env: Env): ToolSet {
  void env;
  return {
    get_current_time: tool({
      description: "Return the current server time in ISO 8601 format.",
      inputSchema: z.object({}),
      execute: async () => ({ now: new Date().toISOString() }),
    }),

    // Implementation reference: https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling

    // Add your own tools here. Tool outputs may also return visual client parts:
    // { type: "data-image", id: "chart", data: { url: "https://example.com/chart.png", displayMode: "sbs" } }
    // { type: "data-video", id: "chart", data: { url: "https://example.com/showcase.mp4", displayMode: "pip" } }
  };
}

export function createAgentMcpServers(env: Env): McpServerConfig[] {
  void env;
  return [
    // Uncomment and edit to attach an MCP server to every /v1/chat request.
    // Store tokens as Worker secrets, then read them from env here.
    // {
    //   name: "example",
    //   url: "https://mcp.example.com",
    //   authToken: env.EXAMPLE_MCP_TOKEN,
    // },
  ];
}
