# Playground

The playground is a lightweight local HTML tester for the sample agent's `/v1/chat` endpoint. It uses the AI SDK UI message stream protocol and is useful for checking streaming text, visual tool results, and tool-call activity during development.

## Run It

Start the Worker locally in one terminal:

```bash
bun run dev
```

Start the playground server in another terminal:

```bash
bun run playground
```

Open the URL printed by the playground server, usually:

```text
http://127.0.0.1:8788
```

## Fields

| Field | Purpose |
| --- | --- |
| Chat endpoint | The Worker chat endpoint. Defaults to `http://127.0.0.1:8787/v1/chat`. |
| API key | Optional bearer token sent as `Authorization: Bearer <value>`. Set this to your local `API_KEY`. |
| Session ID | The persisted chat session key. Use `New session` to start fresh state. |
| User message | The latest user turn to send. |

The playground sends only the latest user message. The Worker keeps prior turns by `session_id` in the Durable Object.

## Response Display

The transcript shows:

- User messages.
- Streaming assistant text.
- Response timing when the stream finishes.
- Visual tool results returned as `file`, `data-image`, or `data-video` parts.
- Tool-call indicators for public tool stream events.

Tool input can be large, so it is collapsed by default. Expand `Show tool input` only when you need to inspect the arguments sent to a tool.

## Local Secrets

The playground calls your local Worker, so configure `.dev.vars` before testing:

```text
API_KEY="dev-placeholder"
GOOGLE_API_KEY="replace-with-local-google-key"
```

If you leave `API_KEY` empty in the playground but your Worker has `API_KEY` configured, requests will fail with an auth error.

## Notes

- The playground is for local development only; it is not part of the Worker deployment.
- It does not let you override the system prompt. Configure the prompt in `src/agent-config.ts`.
- It does not send `model`, `mcp_servers`, or client-side tools. Those are intentionally repo-configured.
