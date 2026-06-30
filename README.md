# Mirako Interactive Agent

This is a minimal Cloudflare Workers AI agent sample that uses the AI SDK protocol. It exposes one session-aware chat API backed by the AI SDK UI message stream protocol.

## What It Provides

- `POST /v1/chat` for AI SDK `UIMessage[]` requests.
- `GET /` for service metadata.
- `GET /health` for a basic health check.
- Per-session Durable Object state keyed by `session_id`.
- A repo-configured model, system prompt, local tools, and MCP server list.
- AI SDK UI stream responses, not OpenAI chat completion chunks.

There are no `/demo/*` endpoints and no `/models` endpoint. The model is selected in code, not by the request body.

Code Mode is disabled by default so the sample can be deployed without Worker Loader/Dynamic Worker bindings. See [Code Mode](./CODEMODE.md) for opt-in usage and Cloudflare subscription requirements.

## Configure The Agent

Edit `src/agent-config.ts`:

- `AGENT_MODEL` selects the provider model.
- `AGENT_SYSTEM_PROMPT` defines the agent behavior.
- `createAgentTools()` defines local AI SDK tools. The sample includes `get_current_time`.
- `createAgentMcpServers()` defines MCP servers for every `/v1/chat` request. It contains a commented placeholder.

Tool calling follows AI SDK Core tools. Reference: <https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling>.

Example MCP config:

```ts
export function createAgentMcpServers(env: Env): McpServerConfig[] {
  return [
    {
      name: "example",
      url: "https://mcp.example.com",
      authToken: env.MCP_SERVER_TOKEN,
    },
  ];
}
```

When MCP servers are configured, add their hostname or origin to `MCP_SERVER_ALLOWLIST` in `wrangler.toml` or `.dev.vars`.

## Chat Request

`/v1/chat` requires the shared API key and a JSON body:

```json
{
  "session_id": "user-or-thread-session-id",
  "messages": [
    {
      "id": "msg_1",
      "role": "user",
      "parts": [{ "type": "text", "text": "Hello" }]
    }
  ],
  "thinking": "None",
  "temperature": 0.7,
  "top_p": 0.9,
  "max_output_tokens": 1024
}
```

Rules:

- `session_id` is required and identifies the persisted session.
- `messages` must be a non-empty AI SDK `UIMessage[]` array with at least one user message.
- Public message parts are limited to `text` and `file`.
- `model`, `mcp_servers`, `tools`, `functions`, `tool_choice`, `stream`, and `n` are rejected.
- Streaming is always enabled.

## Chat Response

The response is an SSE stream using the AI SDK UI stream protocol. It includes:

```text
x-vercel-ai-ui-message-stream: v1
```

Example chunks:

```text
data: {"type":"start","messageId":"msg_..."}

data: {"type":"text-start","id":"..."}

data: {"type":"text-delta","id":"...","delta":"Hello"}

data: {"type":"text-end","id":"..."}

data: {"type":"finish"}

data: [DONE]
```

## Visual Tool Results

Local tools and MCP tools can return visual client parts directly. Matching visual parts are streamed to the client, while the model only receives a generic successful-tool acknowledgement.

Supported shapes:

```ts
type MetisToolClientPart =
  | { type: "file"; url: string; mediaType: string; filename?: string }
  | { type: "data-image"; id?: string; data: { url: string; displayMode?: "pip" | "sbs" } }
  | { type: "data-video"; id?: string; data: { url: string; displayMode?: "pip" | "sbs" } };
```

Rules:

- `url` must be an absolute `http` or `https` URL reachable by the browser.
- `file.mediaType` must start with `image/` or `video/`.
- `displayMode` may be `pip`(picture-in-picture) or `sbs`(side-by-side).
- Local file paths, `data:` URLs, inline binary, and base64 media are ignored.

## Local Development

```bash
bun install
cp .dev.vars.sample .dev.vars
bun run typecheck
bun test
bun run dev
```

Set local secrets in `.dev.vars` before calling `/v1/chat`:

```text
API_KEY="replace-with-a-random-local-value"
GOOGLE_API_KEY="replace-with-local-google-key"
SESSION_TTL_MS="3600000"
MCP_SERVER_ALLOWLIST=""
MCP_SERVER_TOKEN="optional-mcp-token"
MCP_TIMEOUT_MS="15000"
MCP_ALLOW_INSECURE_HTTP="false"
```

Set deployment secrets with Wrangler:

```bash
bunx wrangler secret put API_KEY
bunx wrangler secret put GOOGLE_API_KEY
```

If you enable an MCP server that needs a token, add the token to `worker-configuration.d.ts`, read it from `createAgentMcpServers()`, and store it as a Worker secret.

## Deployment

See [Deploy To Cloudflare Workers](./DEPLOY.md) for Worker setup, secrets, verification, deployment, and post-deploy testing.

## Playground

See [Playground](./PLAYGROUND.md) for running the local tester and inspecting streaming text, visual tool results, and tool-call indicators.

## Configuration

See [Model Configuration](./MODELS.md) for changing the Gemini model, switching cloud providers, or using a local/OpenAI-compatible LLM.

| Name | Type | Purpose |
| --- | --- | --- |
| `API_KEY` | Secret or `.dev.vars` | Shared API key required for `/v1/chat`. |
| `GOOGLE_API_KEY` | Secret or `.dev.vars` | Google Generative AI API key for the configured Gemini model. |
| `SESSION_TTL_MS` | Variable | Idle session TTL in milliseconds. Defaults to one hour. |
| `MCP_SERVER_ALLOWLIST` | Variable | Comma-separated MCP hostnames or origins allowed by repo-configured MCP servers. Empty disables MCP. |
| `MCP_TIMEOUT_MS` | Variable | MCP request timeout in milliseconds. Defaults to `15000`. |
| `MCP_ALLOW_INSECURE_HTTP` | Variable | Allow non-loopback `http` MCP URLs when set to `true`. Defaults to `false`. |

Code Mode is optional and disabled by default. See [Code Mode](./CODEMODE.md) before enabling it.
