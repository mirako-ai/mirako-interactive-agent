# AGENTS.md

## Workflow
- Use Bun for everything. Start with `bun install`; both `bun run typecheck` and `bun test` fail on a fresh checkout until dependencies are installed.
- Primary verification is `bun run typecheck`, `bun test`, then `bun run deploy:dry-run` when a change could affect bundling, Wrangler bindings, or Cloudflare runtime behavior.
- Focused test commands:
  - `bun test tests/chat.test.ts`
  - `bun test --test-name-pattern "createMetisChatResponse emits AI SDK UI stream chunks"`
- There is no lint or formatter script in this repo. Do not invent one in task summaries.

## Architecture
- This is the Mirako Interactive Agent sample, a single-package Cloudflare Worker repo. `wrangler.toml` points `main` at `src/index.ts`.
- Public HTTP surface is `GET /`, `GET /health`, and `POST /v1/chat`. There is no `/models`, `/demo/*`, or OpenAI chat-completions endpoint.
- `POST /v1/chat` requires the shared API key. `GET /` and `GET /health` do not.
- `/v1/chat` is session-aware: the root worker authenticates, extracts `session_id`, hashes it to `session:<sha256>` in `src/chat/session.ts`, and forwards to a per-session `MetisAgentCore` Durable Object.
- The fork-facing agent configuration lives in `src/agent-config.ts`: model, system prompt, local tools, and MCP servers.
- `MetisAgentCore` lives in `src/index.ts`, extends `AIChatAgent`, and merges incoming `UIMessage[]` with persisted session history before calling the chat runtime.
- Session expiry is enforced by Durable Object alarms via `SESSION_TTL_MS` in `src/chat/session.ts`; default idle TTL is 1 hour.

## Request/Response Contract
- `/v1/chat` accepts AI SDK `UIMessage[]` requests and returns the AI SDK UI message stream SSE protocol. Preserve this; tests assert the stream does not emit OpenAI `chat.completion.chunk` payloads.
- `src/chat/request.ts` is the source of truth for public request validation: `model` and `mcp_servers` are rejected because they are repo-configured, `session_id` is required, messages must include a user message, and public message parts are limited to `text` and `file`.
- Tools may return protocol-native visual client parts: `file`, `data-image`, or `data-video`. `src/chat/visual-parts.ts` validates these for both endpoint-local and MCP tools; matching visual payloads are streamed to the client while the model only receives a generic execution acknowledgement.
- Legacy OpenAI chat-completion fields (`stream`, `n`, `tools`, `functions`, `tool_choice`) are intentionally rejected.

## Important Files
- `README.md`: high-level sample overview and links to focused docs.
- `DEPLOY.md`: two-step deployment flow: deploy Worker to Cloudflare, then create a Mirako custom agent with `mirako agent create`.
- `MODELS.md`: how to change Gemini models, switch AI SDK cloud providers, or use local/OpenAI-compatible LLMs.
- `PLAYGROUND.md`: how to run the local playground and inspect streaming text, visual parts, and tool-call indicators.
- `CODEMODE.md`: optional Code Mode usage and Cloudflare Worker Loader/Dynamic Worker requirements.
- `src/chat/request.ts`: public request normalization and validation.
- `src/chat/runtime.ts`: `streamText()` wiring, Code Mode/MCP tool registration, UI stream creation, and stream/persistence sanitization.
- `src/chat/visual-parts.ts`: visual tool result protocol validation and conversion to AI SDK UI stream chunks.
- `src/agent-config.ts`: sample model, system prompt, endpoint-local tools, and MCP server placeholders.
- `src/chat/models.ts`: model resolver and provider-specific thinking options. There is no public model registry.
- `src/codemode/*`: deployment-level Code Mode config, execution limits, and sandbox tool.
- `src/mcp.ts`: MCP discovery and tool execution.

## Repo Gotchas
- `tsconfig.json` only includes `src/**/*.ts` plus `worker-configuration.d.ts`; test files are not covered by `bun run typecheck`.
- `DEFAULT_CODE_MODE_CONFIG` in `src/codemode/config.ts` defaults Code Mode to disabled, and `wrangler.toml` keeps `CODE_MODE_ENABLED = "false"` for this sample. The default `wrangler.toml` intentionally omits the Worker Loader `LOADER` binding so the sample can deploy without Code Mode infrastructure.
- Runtime unit tests usually pass `CODE_MODE_ENABLED: "false"` unless they intentionally exercise Code Mode; otherwise `createMetisChatResponse()` expects `env.LOADER`.
- The default Worker name in `wrangler.toml` is `mirako-interactive-agent`; if changed, keep examples/docs aligned when relevant.
- MCP servers are disabled unless `MCP_SERVER_ALLOWLIST` is non-empty. Allowlist entries can be hostnames or full origins. MCP URLs must use `https:` unless they are loopback `http:` or `MCP_ALLOW_INSECURE_HTTP` is enabled.
- MCP server entries configured in `src/agent-config.ts` may include optional `authToken`; `src/mcp.ts` sends it as a bearer token per server entry, and also preserves `Mcp-Session-Id` plus Streamable HTTP `Accept: application/json, text/event-stream` behavior.
- If you change Worker bindings or env vars in `wrangler.toml`, keep `worker-configuration.d.ts` in sync.
- Preserve tool privacy behavior in `src/chat/runtime.ts`: public requests reject tool parts, persisted messages strip all `tool-*`/`dynamic-tool` parts, the public UI stream filters internal `codemode` chunks, and matching visual tool payloads are sanitized before model feedback.
- The playground lives in `playground/`; it sends only the latest user turn because session history is persisted by `session_id`. It shows public tool-call indicators and collapses long tool inputs by default.

## Local Dev
- `bun run dev` runs Wrangler locally.
- Copy `.dev.vars.sample` to `.dev.vars` and set `API_KEY` plus `GOOGLE_API_KEY` before calling `/v1/chat` locally.
