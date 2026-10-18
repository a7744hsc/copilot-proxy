# copilot-proxy

Standalone proxy server that bridges Claude Code (or any Anthropic API client) with GitHub Copilot's API.

Replicates the core functionality of the MAI LLM Proxy VS Code extension as a CLI tool — no VS Code dependency.

## Features

- **GitHub Copilot OAuth Device Flow** — authenticate via browser
- **Automatic token refresh** — refreshes 5 minutes before expiry
- **Anthropic API passthrough** — `/v1/messages` forwarded directly to Copilot API
- **OpenAI API passthrough** — `/v1/chat/completions` forwarded to Copilot API
- **Codex support** — an opt-in Codex-to-Copilot request adapter, native Responses forwarding, and a Codex-compatible model catalog
- **Health and rate-limit feedback** — token expiry, observed upstream status, active readiness checks, and upstream rate-limit headers
- **Usage detail** — cache reads/writes, reasoning tokens, and HTTP/429 response counts
- **Thinking mode support** — extended thinking works out of the box
- **Optional model aliases** — compatibility mapping for clients that use alternate model IDs

## Quick Start

```bash
npm install
npm start          # PORT=5000 by default

# First run opens GitHub device flow in terminal
# After auth, tokens are cached in .tokens/ under the working directory
```

## Usage

**Bash:**
```bash
# Set port and log level
PORT=5000 LOG_LEVEL=info npm start

# Test
curl http://localhost:5000/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-opus-4.7","max_tokens":50,"messages":[{"role":"user","content":"hi"}]}'
```

**PowerShell:**
```powershell
# Set port and log level
$env:PORT = "5000"; $env:LOG_LEVEL = "info"; npm start

# Test
Invoke-RestMethod http://localhost:5000/v1/messages -Method POST `
  -ContentType "application/json" `
  -Headers @{ "anthropic-version" = "2023-06-01" } `
  -Body '{"model":"claude-opus-4.7","max_tokens":50,"messages":[{"role":"user","content":"hi"}]}'
```

## Use with Claude Code

For a quick one-off session:

**Bash:**
```bash
export ANTHROPIC_BASE_URL=http://localhost:5000
export ANTHROPIC_AUTH_TOKEN=dummy
claude
```

**PowerShell:**
```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:5000"
$env:ANTHROPIC_AUTH_TOKEN = "dummy"
claude
```

See [Claude Code integration](docs/claude-code.md) for persistent settings, model ID overrides, 1M context configuration, validation, and troubleshooting.

## Use with Pi Agent

See [Pi Agent integration](docs/pi-agent.md) for the validated custom provider configuration, supported Claude models, thinking settings, and troubleshooting steps.

## Use with Codex CLI

Codex 0.160.0 or newer can read a remote model catalog. Its catalog also carries
model-specific instructions and tool settings, not just model IDs. From this
repository, first synchronize the official templates for your installed version
(requires the GitHub CLI, `gh`):

```powershell
codex --version
npm run sync:codex -- 0.162.0
```

Replace `0.162.0` with your installed version. This downloads the matching
Apache-2.0-licensed OpenAI Codex catalog and fallback instructions into the
gitignored `codex-model-templates.json`. Repeat after upgrading Codex. It does
not copy credentials or change client configuration.

Merge these settings into `$HOME\.codex\config.toml` (or the config in
`CODEX_HOME`). Keep top-level settings above table headers:

```toml
model = "gpt-6-astra"
model_provider = "copilot_proxy"

[features]
api_key_model_discovery = true

[model_providers.copilot_proxy]
name = "Copilot Proxy"
base_url = "http://127.0.0.1:5000/codex/v1"
model_catalog_url = "http://127.0.0.1:5000/codex/models"
experimental_bearer_token = "local-proxy"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
```

Merge the discovery flag into an existing `[features]` table rather than adding
a duplicate table. This Codex version requires the API-key discovery path for
custom remote catalogs. The inline `local-proxy` value is a **non-secret
placeholder**, not an OpenAI or GitHub key. It avoids depending on environment
variables inherited by terminals or desktop apps. Never put a real credential
here; this setup is only for the unauthenticated loopback proxy.

The proxy does not authenticate this placeholder; it still authenticates with
its own Copilot token. No client authentication environment variable or OpenAI
login is needed. Save the config, keep the proxy running, and start or restart
Codex:

```powershell
Invoke-RestMethod http://127.0.0.1:5000/health/ready
codex
# Inside Codex, use /model to switch models.
# Alternatively, select a model when starting a new session:
codex -m gpt-5-mini
```

The catalog fetches current Copilot metadata, includes models advertising HTTP Responses, streaming and tool
calls, and excludes policy-disabled models. It uses actual reasoning levels and
input modalities, and caps context at the smaller of the advertised prompt and
total context limits. It preserves matching Codex instruction/tool templates;
unknown models use that Codex version's generic fallback instructions. It does
not invent `ultra` support or offer OpenAI-only speed tiers. Catalog inclusion
does not imply every optional Codex tool is supported by that model.

The existing `/v1/models` response remains unchanged. Models requiring Messages
or Chat Completions conversion, and WS-only models, are not added to the Codex
catalog. Missing templates, invalid upstream metadata, or a catalog larger than
Codex's 1 MiB limit produce an explicit error rather than an incomplete catalog.

The `/codex/v1/responses` route enables the Codex-to-Copilot compatibility adapter.
It removes the unsupported top-level `service_tier` field, including when set by
Codex's fast/priority mode or by proxy request overrides. Copilot uses its normal
service tier instead; this does **not** provide priority service. Keeping Codex's
`service_tier` unset is still recommended.

## Request compatibility adapters

Compatibility rules are independent of authentication, model discovery, transport,
and usage accounting. The current adapter targets Codex's native Responses
requests, not Responses-to-Messages or Chat Completions protocol translation.
It does not make Messages-only Claude models available to Codex.

| Route | Behavior |
| --- | --- |
| `POST /codex/v1/responses` | Codex adapter, then the existing Copilot `/responses` forwarder. |
| `POST /v1/responses`, `POST /responses` | Existing Responses passthrough, with no adapter. |
| `GET /codex/models` | Existing native Codex catalog; independent of request adaptation. |

The only current rewrite is `remove-service-tier`. All other fields are preserved,
including tools and their schemas, function/custom-tool call IDs and outputs,
reasoning effort and encrypted content, message phases, input images and their
detail settings, internal Codex message metadata, cache keys, and unknown future
fields. Unsupported inputs still produce the upstream error; the adapter does
not silently delete tools, lower reasoning levels, or replace image content.

Adapted responses carry `x-copilot-proxy-adapter: codex-copilot`. When a rewrite
occurs, `x-copilot-proxy-adjustments: remove-service-tier` and an info-level log
record identify the rule, without logging the removed value or request content.
Status codes, JSON and SSE bodies, tool events, and upstream rate-limit headers
are unchanged. WebSocket, cancellation, timeout, and retry behavior are unchanged.

### Adding or replacing an adapter

- `src/compatibility/types.ts` defines the small request-only `CompatibilityAdapter`
  contract: ID, explicit local route, upstream path, config override format, and a
  pure `adaptRequest` function returning a body plus stable change IDs.
- `src/compatibility/codex-copilot.ts` owns the Codex rules. Model aliases and
  `requestOverrides` are applied **before** adaptation so config cannot reintroduce
  a removed field afterward. Adapters must not mutate their input or handle tokens,
  network calls, retries, statistics, or response streaming.
- `src/compatibility/index.ts` registers the defaults. Add a separate module and
  register it here for a future client adapter, then restart the proxy. Tests or
  embedders can use `createServer(auth, [adapter])` to replace the registry, or
  `createServer(auth, [])` to disable all adapters; raw routes remain available.

Use unique, non-conflicting routes for adapters. There is no User-Agent guessing,
dynamic plugin loading, or per-request state. A future Claude client adapter can
reuse this request boundary for native Messages requests; actual cross-protocol
conversion would also require a response/event translator and is not implemented
by this request-only interface.

## Health, usage and rate limits

| Endpoint | Meaning |
| --- | --- |
| `GET /health/live` | Local process responsiveness only; no upstream request. |
| `GET /health` | Passive snapshot: token validity/expiry and the last observed upstream response or connection failure, with its timestamp. |
| `GET /health/ready` | Actively fetches the Copilot model list, then reports health. This does not generate tokens. |
| `GET /stats` | Persistent daily per-model token usage and final generation HTTP response counts. |
| `GET /rate-limits` | In-memory rate-limit observations, grouped by model (or `/models` for discovery), since process startup. |

`/health` and `/health/ready` return 200 only for `status: "ok"` and `ready: true`;
otherwise they return 503. States include `unknown` (no upstream observation
yet), `unauthenticated` (missing, invalid or expired local token),
`upstream_rejected` (401/403), `upstream_unavailable` (network failure/5xx or an invalid readiness response), and
`rate_limited` (429). A passive snapshot is not a fresh connectivity or quota
guarantee; use `/health/ready` when you need a current check. Health never returns
tokens.

`/stats` keeps the existing date/model shape and `requests` counter (responses
with reported usage). New counters are `reasoning_tokens`, `http_responses`,
`http_error_responses`, and `rate_limited_responses`. Older saved statistics
remain readable; new counters start at zero and cannot reconstruct historical
errors. Cache/reasoning counts use reported provider fields. For OpenAI/Responses,
cached input and reasoning output are subsets of input/output tokens, not extra
tokens to add to the totals. Anthropic cache counts retain Anthropic's separate
accounting. Missing detail fields are reported as zero, not estimated.

Upstream `Retry-After`, `x-ratelimit-*`, `x-rate-limit-*`, and `ratelimit-*`
headers are passed through with the original status and body. `/rate-limits`
exposes these headers, observation time, HTTP status, accumulated 429 responses
and a `retry_at` derived only from a valid `Retry-After`. No missing reset time
or remaining quota is guessed; absent headers on a subsequent response clear
the old header snapshot. A 429 is logged but is not automatically retried or
queued. These observations and token totals are not a GitHub billing estimate.

```powershell
Invoke-RestMethod http://127.0.0.1:5000/health/ready
Invoke-RestMethod http://127.0.0.1:5000/stats
Invoke-RestMethod http://127.0.0.1:5000/rate-limits
```

Development checks: `npm test` and `npm run build`. Tests use fake upstream
responses and isolated temporary files, not your cached credentials or usage.

## Security and local data

- Keep the proxy bound to its default `127.0.0.1`. It does **not** authenticate incoming requests; `ANTHROPIC_AUTH_TOKEN=dummy` is only a client placeholder. Do not expose it directly to a network or public tunnel.
- GitHub and Copilot credentials are stored as plaintext in `.tokens/` under the working directory. Keep this directory private and never commit or share it.
- `LOG_LEVEL=info` is the default. Enable `debug` only for local troubleshooting: it records complete request and response bodies, including prompts, code, tool results, and model output. Authorization headers are redacted, but bodies and other headers may still contain secrets. Error responses can be logged even at `info`.
- Keep all `proxy.log*` files, `stats.json`, `models.json`, browser artifacts, and temporary output local. Client flags such as `--no-session-persistence` do not disable proxy logging. Never upload raw logs or a copy of the entire working directory or `.git` directory.
- `.gitignore` excludes runtime data, `.env` files, local Claude Code settings, personal editor settings, and `tmp/`. Only sanitized `.env.example` templates are eligible for tracking. Ignore rules do not remove files that were already committed.
- `config.json` is shared configuration: keep it free of credentials, private request content, and secret header overrides. Run the proxy from this repository so its runtime files stay under these ignore rules.

## Architecture

```
Claude Code → copilot-proxy (127.0.0.1:5000) → Copilot API endpoint from authentication
              ├── /v1/messages     → Anthropic native passthrough
              ├── /v1/chat/completions → OpenAI format passthrough
              ├── /v1/responses    → Responses passthrough
              ├── /codex/v1/responses → Codex adapter → Responses
              └── /codex/models    → Codex catalog from Copilot capabilities
```
