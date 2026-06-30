# Model Configuration

The agent model is configured in the repo, not by the `/v1/chat` request. Public requests that include `model` are rejected.

The main files are:

- `src/agent-config.ts`: selects the model used by the agent.
- `src/chat/models.ts`: resolves the configured model into an AI SDK `LanguageModel`.
- `worker-configuration.d.ts`: declares provider API keys and environment bindings.
- `.dev.vars.sample` and `wrangler.toml`: document local/deployment variables.

## Change Google Model

For another Google Gemini model, edit `AGENT_MODEL` in `src/agent-config.ts`:

```ts
export const AGENT_MODEL: SupportedModel = {
  id: "google/gemini-3.1-flash-lite",
  provider: "google",
  upstreamModel: "gemini-3.1-flash-lite",
};
```

Keep `provider: "google"` and set `upstreamModel` to the model name expected by `@ai-sdk/google`.

The default resolver in `src/chat/models.ts` uses `GOOGLE_API_KEY`, so no other code changes are needed for Google-to-Google model changes.

## Change Cloud Provider

This repo uses the AI SDK model provider pattern. To change cloud providers:

1. Install the AI SDK provider package.
2. Add the provider to `src/chat/models.ts`.
3. Update `AGENT_MODEL` in `src/agent-config.ts`.
4. Add provider secrets to `worker-configuration.d.ts` and set them with Wrangler.

AI SDK provider documentation: <https://ai-sdk.dev/providers/ai-sdk-providers>

### OpenAI Example

Install the provider:

```bash
bun add @ai-sdk/openai
```

Update `src/chat/models.ts`:

```ts
import { createOpenAI } from "@ai-sdk/openai";

export type Provider = "google" | "openai";

type ProviderEnv = {
  GOOGLE_API_KEY?: string;
  OPENAI_API_KEY?: string;
};

export function resolveLanguageModel(env: ProviderEnv, model: SupportedModel): LanguageModelResult {
  if (model.provider === "openai") {
    const apiKey = env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      return { ok: false, error: "OPENAI_API_KEY is not configured" };
    }
    return { ok: true, model: createOpenAI({ apiKey }).chat(model.upstreamModel) };
  }

  const apiKey = env.GOOGLE_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, error: "GOOGLE_API_KEY is not configured" };
  }
  return { ok: true, model: createGoogleGenerativeAI({ apiKey }).chat(model.upstreamModel) };
}
```

Update `src/agent-config.ts`:

```ts
export const AGENT_MODEL: SupportedModel = {
  id: "openai/gpt-4.1-mini",
  provider: "openai",
  upstreamModel: "gpt-4.1-mini",
};
```

Update `worker-configuration.d.ts`:

```ts
OPENAI_API_KEY?: string;
```

Set the secret:

```bash
bunx wrangler secret put OPENAI_API_KEY
```

### Other Cloud Providers

Use the same pattern for providers such as Anthropic, Groq, Mistral, or xAI:

- Install the provider package.
- Import its `create...` factory in `src/chat/models.ts`.
- Extend the `Provider` union.
- Add the required API key to `ProviderEnv` and `worker-configuration.d.ts`.
- Add a resolver branch for that provider.
- Update `AGENT_MODEL`.

Some providers need provider-specific options. Keep those in `providerOptionsFor()` in `src/chat/models.ts` so model/provider quirks stay isolated from request handling.

## Use Cloudflare Workers AI

If you want Cloudflare-hosted models, use the AI SDK Cloudflare provider or a compatible Workers AI integration. You will typically need a Cloudflare AI binding in `wrangler.toml` and a resolver branch that returns the provider's AI SDK language model.

The exact binding and package depend on the AI SDK provider you choose. Keep the public `/v1/chat` request unchanged; only `src/chat/models.ts`, `src/agent-config.ts`, `wrangler.toml`, and `worker-configuration.d.ts` should need updates.

## Use A Local LLM

Local LLMs are usually exposed through an OpenAI-compatible HTTP API, such as Ollama or LM Studio. This works well for local development, but it is usually not suitable for deployed Cloudflare Workers unless the endpoint is publicly reachable over HTTPS.

### Local OpenAI-Compatible Example

Install the OpenAI provider if it is not already installed:

```bash
bun add @ai-sdk/openai
```

Add an OpenAI-compatible provider branch in `src/chat/models.ts`:

```ts
import { createOpenAI } from "@ai-sdk/openai";

export type Provider = "google" | "local-openai";

type ProviderEnv = {
  GOOGLE_API_KEY?: string;
  LOCAL_LLM_BASE_URL?: string;
  LOCAL_LLM_API_KEY?: string;
};

export function resolveLanguageModel(env: ProviderEnv, model: SupportedModel): LanguageModelResult {
  if (model.provider === "local-openai") {
    const baseURL = env.LOCAL_LLM_BASE_URL?.trim() || "http://127.0.0.1:11434/v1";
    return {
      ok: true,
      model: createOpenAI({
        baseURL,
        apiKey: env.LOCAL_LLM_API_KEY?.trim() || "local",
      }).chat(model.upstreamModel),
    };
  }

  // Keep or replace the existing Google branch.
}
```

Update `src/agent-config.ts`:

```ts
export const AGENT_MODEL: SupportedModel = {
  id: "local/llama3.1",
  provider: "local-openai",
  upstreamModel: "llama3.1",
};
```

Add local variables to `.dev.vars`:

```text
LOCAL_LLM_BASE_URL="http://127.0.0.1:11434/v1"
LOCAL_LLM_API_KEY="local"
```

For a deployed Worker, `127.0.0.1` points to the Worker isolate, not your laptop. Use a public HTTPS endpoint if you want a deployed Worker to call a self-hosted model.

## Verify Changes

After changing model configuration:

```bash
bun run typecheck
bun test
bun run deploy:dry-run
```

For local testing:

```bash
bun run dev
bun run playground
```

Then call `/v1/chat` from the playground.
