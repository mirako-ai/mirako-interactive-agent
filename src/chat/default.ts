import { AGENT_MODEL, AGENT_SYSTEM_PROMPT, createAgentMcpServers, createAgentTools } from "../agent-config";
import { CHAT_PATH } from "./request";
import { ChatEndpoint } from "./endpoint";

export const chatEndpoint = new ChatEndpoint({
  path: CHAT_PATH,
  model: AGENT_MODEL,
  systemPrompt: AGENT_SYSTEM_PROMPT,
  tools: ({ env }) => createAgentTools(env),
  mcpServers: ({ env }) => createAgentMcpServers(env),
});
