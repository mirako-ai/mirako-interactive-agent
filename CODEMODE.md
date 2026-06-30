# Code Mode

Code Mode is an optional internal tool that lets the agent execute generated JavaScript for API calls, callbacks, webhooks, and other external side effects before it answers the user.

Code Mode is disabled by default in this sample so the default Worker deployment does not require Dynamic Worker or Worker Loader infrastructure.

## Cloudflare Requirement

Code Mode requires Cloudflare Worker Loader/Dynamic Worker support because generated code is executed in an isolated Worker sandbox through the `LOADER` binding.

That capability is not part of the default free-plan deployment path for this sample. Enable Code Mode only on a Cloudflare account and Workers subscription that supports Worker Loader/Dynamic Worker bindings. Check your Cloudflare plan before enabling it in production.

## When To Use It

Use Code Mode when the agent must perform dynamic runtime actions such as:

- Calling an API that is not modeled as a normal local tool.
- Reading an API response before composing the final answer.
- Triggering webhooks or callbacks.
- Performing short, sandboxed JavaScript transformations.

Prefer normal tools in `src/agent-config.ts` for stable, known integrations. They are simpler, safer, easier to test, and work with the default free-plan-friendly configuration.

## Enable Code Mode

Add the Worker Loader binding to `wrangler.toml`:

```toml
[[worker_loaders]]
binding = "LOADER"
```

Set Code Mode on:

```toml
[vars]
CODE_MODE_ENABLED = "true"
```

Optional limits can be configured as Worker variables:

```toml
CODE_MODE_TIMEOUT_MS = "30000"
CODE_MODE_CPU_MS = "1000"
CODE_MODE_MAX_STEPS = "10"
CODE_MODE_MAX_GENERATED_CODE_BYTES = "100000"
CODE_MODE_MAX_RESULT_BYTES = "100000"
CODE_MODE_MAX_LOG_BYTES = "50000"
CODE_MODE_NETWORK_DEFAULT = "allow"
CODE_MODE_EXPOSE_SECRETS = "false"
CODE_MODE_NPM_IMPORTS = "false"
CODE_MODE_REMOTE_IMPORTS = "false"
CODE_MODE_STATE_ENABLED = "false"
CODE_MODE_FILESYSTEM_ENABLED = "false"
CODE_MODE_MCP_ENABLED = "false"
CODE_MODE_CAPABILITIES_ENABLED = "false"
CODE_MODE_RECORD_CODE = "false"
CODE_MODE_RECORD_LOGS = "false"
CODE_MODE_RECORD_RESULT = "false"
CODE_MODE_RUNS_PER_MINUTE = "20"
CODE_MODE_CONCURRENT_RUNS = "3"
```

The MVP intentionally rejects these advanced options when set to `true`:

- `CODE_MODE_EXPOSE_SECRETS`
- `CODE_MODE_NPM_IMPORTS`
- `CODE_MODE_REMOTE_IMPORTS`
- `CODE_MODE_STATE_ENABLED`
- `CODE_MODE_FILESYSTEM_ENABLED`
- `CODE_MODE_MCP_ENABLED`
- `CODE_MODE_CAPABILITIES_ENABLED`

## Runtime Behavior

When enabled and no repo-configured MCP servers or local tools are present, the runtime adds an internal `codemode` tool. The public UI stream filters Code Mode tool chunks so generated code and raw execution details are not sent to clients.

If `CODE_MODE_ENABLED = "true"` but the `LOADER` binding is missing, chat requests fail with a server configuration error.

## Security Notes

- Keep `CODE_MODE_EXPOSE_SECRETS = "false"`.
- Keep generated code, logs, and raw API details private unless you are intentionally debugging.
- Use low timeout, CPU, result-size, and concurrency limits.
- Prefer explicit local tools for actions that mutate external systems.
