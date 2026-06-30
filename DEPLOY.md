# Deploy And Register The Agent

This sample runs as a Cloudflare Worker AI agent using the AI SDK protocol, with a Durable Object for per-session chat history. After deploying the Worker, create a Mirako custom agent that points to your deployed `/v1/chat` endpoint.

Code Mode is disabled by default and the default `wrangler.toml` does not require Worker Loader/Dynamic Worker bindings.

## Step 1: Deploy To Cloudflare Workers

### Prerequisites

- A Cloudflare account with Workers enabled.
- Bun installed locally.
- A Google Generative AI API key for the default Gemini model.
- A random shared API key for Mirako to call your Worker `/v1/chat` endpoint.
- The repo pushed to GitHub if you want Cloudflare to deploy from GitHub.

### Configure Worker Name

Edit `wrangler.toml` and set a unique Worker name before connecting the repo:

```toml
name = "your-agent-worker-name"
```

The default Durable Object binding and migration are already configured:

```toml
[[durable_objects.bindings]]
name = "MetisAgentCore"
class_name = "MetisAgentCore"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["MetisAgentCore"]
```

Do not change those unless you are intentionally renaming the Durable Object class and updating the code.

### Verify Locally

```bash
bun install
bun run typecheck
bun test
bun run deploy:dry-run
```

The dry run should list the Durable Object binding and environment variables. In the default configuration it should not list `env.LOADER`; that binding is only needed if you opt into Code Mode.

### Deploy From GitHub In Cloudflare

Use Cloudflare's GitHub integration when you want the Worker to deploy from this repository:

1. Open the Cloudflare dashboard.
2. Go to `Workers and Pages`.
3. Click `Create application`.
4. Click `Connect GitHub`.
5. Authorize the repo in the GitHub popup.
6. Select this repository.
7. Leave `Build command` blank.
8. Use the suggested deploy command: `npx wrangler deploy`.
9. Click `Deploy`.

After deployment, add runtime secrets in the Cloudflare dashboard:

1. Open the deployed Worker.
2. Go to `Settings`.
3. Open `Variables and secrets`.
4. Click `+ Add`.
5. Add `API_KEY` with `Type = Secret`.
6. Add `GOOGLE_API_KEY` with `Type = Secret`.
7. Save or deploy the changes if Cloudflare prompts you to do so.

If you add MCP servers in `src/agent-config.ts` that need tokens, add matching optional fields to `worker-configuration.d.ts` and add those values as Worker secrets too.

### Configure MCP Allowlist

If `createAgentMcpServers()` returns MCP servers, add their hostnames or origins to `MCP_SERVER_ALLOWLIST` in `wrangler.toml`:

```toml
[vars]
MCP_SERVER_ALLOWLIST = "mcp.example.com"
```

Use comma-separated values for multiple servers:

```toml
MCP_SERVER_ALLOWLIST = "mcp.example.com,https://tools.example.org"
```

Leave it empty if you are not using MCP.

### Alternate: Deploy With Wrangler CLI

You can also deploy manually from your terminal.

Log in to Cloudflare:

```bash
bunx wrangler login
```

Confirm Wrangler can see your account:

```bash
bunx wrangler whoami
```

Set the shared API key:

```bash
bunx wrangler secret put API_KEY
```

Set the Google API key:

```bash
bunx wrangler secret put GOOGLE_API_KEY
```

```bash
bun run deploy
```

Wrangler prints the deployed Worker URL when deployment succeeds. Your chat endpoint is that URL plus `/v1/chat`, for example:

```text
https://your-agent-worker-name.your-subdomain.workers.dev/v1/chat
```

### Test The Deployment

Health check:

```bash
curl https://your-agent-worker-name.your-subdomain.workers.dev/health
```

Chat request:

```bash
curl -N https://your-agent-worker-name.your-subdomain.workers.dev/v1/chat \
  -H 'Authorization: Bearer your-api-key' \
  -H 'Content-Type: application/json' \
  -d '{
    "session_id": "deploy-test-session",
    "messages": [
      {
        "id": "msg_1",
        "role": "user",
        "parts": [{ "type": "text", "text": "Hello" }]
      }
    ]
  }'
```

The response is an SSE stream using the AI SDK UI message stream protocol. It should include the `x-vercel-ai-ui-message-stream: v1` response header.

## Step 2: Create The Mirako Agent

After the Cloudflare Worker is deployed and tested, create a Mirako custom agent that uses the deployed Worker endpoint.

### Install And Log In To Mirako CLI

Install `mirako-cli` and authenticate by following the official repository instructions:

<https://github.com/mirako-ai/mirako-cli>

### Create Or Choose An Avatar

Create an avatar using the CLI instructions in the Mirako CLI repo. For example:

```bash
mirako avatar generate --prompt "A friendly interactive assistant"
```

You can also list existing avatars:

```bash
mirako avatar list
```

### Run Interactive Agent Setup

Start the Mirako agent creation flow:

```bash
mirako agent create
```

When prompted:

- Choose `custom agent`.
- Enter the agent name.
- Enter the agent description.
- Select the avatar.
- Select the voice profile.
- Enter your Cloudflare endpoint URL up to and including `/v1/chat`.
- Enter the API key you configured as the Worker `API_KEY` secret.

Example endpoint value:

```text
https://your-agent-worker-name.your-subdomain.workers.dev/v1/chat
```

The API key value should match the secret you set with:

```bash
bunx wrangler secret put API_KEY
```

## Local Development

For local development, copy the sample env file and fill in secrets:

```bash
cp .dev.vars.sample .dev.vars
bun run dev
```

Do not commit `.dev.vars`.

## Code Mode

Code Mode is disabled by default. It requires Worker Loader/Dynamic Worker support and may require a Cloudflare Workers subscription beyond the default free-plan path. See [Code Mode](./CODEMODE.md) before enabling it.
