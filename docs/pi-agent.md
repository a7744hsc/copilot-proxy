# Pi Agent integration

This guide configures Pi Coding Agent to use this proxy through its Anthropic Messages and OpenAI Responses endpoints.

Validated with:

- Pi Coding Agent `0.84.3` (`@earendil-works/pi-coding-agent`)
- Proxy endpoint `http://127.0.0.1:5000`
- Pi API adapters `anthropic-messages` and `openai-responses`

## 1. Start the proxy

From this repository:

```bash
npm install
PORT=5000 npm start
```

On first use, complete the GitHub device authorization flow. Confirm that the proxy is ready:

```bash
curl http://127.0.0.1:5000/health
```

Expected response:

```json
{"status":"ok"}
```

Pi requires the proxy process to remain running while it is in use.

## 2. Add the Pi provider

Pi loads user-defined providers from `~/.pi/agent/models.json`. Do not edit `models-store.json`; that file is Pi's generated remote catalog cache.

Create or merge the following configuration into `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "copilot-proxy": {
      "name": "Local Copilot Proxy",
      "baseUrl": "http://127.0.0.1:5000",
      "api": "anthropic-messages",
      "apiKey": "dummy",
      "models": [
        {
          "id": "claude-opus-4.7",
          "name": "Claude Opus 4.7 (Copilot Proxy)",
          "reasoning": true,
          "thinkingLevelMap": {
            "minimal": null,
            "low": "low",
            "medium": "medium",
            "high": "high",
            "xhigh": "xhigh",
            "max": "max"
          },
          "input": ["text", "image"],
          "contextWindow": 1000000,
          "maxTokens": 64000,
          "compat": {
            "forceAdaptiveThinking": true
          }
        },
        {
          "id": "gpt-5.4",
          "name": "GPT-5.4 (Copilot Proxy)",
          "api": "openai-responses",
          "baseUrl": "http://127.0.0.1:5000/v1",
          "reasoning": true,
          "thinkingLevelMap": {
            "minimal": null,
            "low": "low",
            "medium": "medium",
            "high": "high",
            "xhigh": "xhigh"
          },
          "input": ["text", "image"],
          "contextWindow": 1050000,
          "maxTokens": 128000
        }
      ]
    }
  }
}
```

Important details:

- For `anthropic-messages`, keep `baseUrl` at the server root. Do **not** append `/v1`; Pi's Anthropic SDK appends `/v1/messages` itself.
- For `openai-responses`, use `http://127.0.0.1:5000/v1`; Pi's OpenAI SDK appends `/responses`.
- `dummy` is a non-secret placeholder. This proxy authenticates upstream with its cached GitHub token and does not validate the incoming Pi API key.
- For the current adaptive Claude models, do not set `thinkingLevelMap.off` to `null`. In Pi, `null` means that a thinking level is unsupported, so an `off` request would be clamped to another level. Omitting `off` allows `--thinking off` to send `thinking.type=disabled`.
- `forceAdaptiveThinking` makes Pi send adaptive thinking with the selected effort for current Claude models.
- For GPT models that do not support `none` reasoning effort, set `thinkingLevelMap.off` to `null`. Pi will then clamp an `off` request to the nearest supported effort.

## 3. Select it as Pi's default

Merge these fields into `~/.pi/agent/settings.json`, preserving any other settings:

```json
{
  "defaultProvider": "copilot-proxy",
  "defaultModel": "claude-opus-4.7",
  "defaultThinkingLevel": "high"
}
```

Pi can also select the provider per invocation without changing its defaults:

```bash
pi --provider copilot-proxy --model claude-opus-4.7
```

Or use the provider-qualified model name:

```bash
pi --model copilot-proxy/claude-opus-4.7
```

## 4. Validate the integration

List the custom models:

```bash
pi --offline --list-models copilot-proxy
```

Check provider readiness:

```bash
pi auth check --provider copilot-proxy
```

Expected result: `ready`.

Run an end-to-end request with thinking disabled:

```bash
pi --offline \
  --provider copilot-proxy \
  --model claude-opus-4.7 \
  --thinking off \
  --no-tools \
  --no-session \
  -p "Reply with exactly: pi-proxy-ok"
```

Test adaptive thinking:

```bash
pi --offline \
  --provider copilot-proxy \
  --model claude-opus-4.7 \
  --thinking high \
  --no-tools \
  --no-session \
  -p "Reply with exactly: thinking-high-ok"
```

With debug logging enabled on the proxy, the first request should show `thinking=disabled`; the second should show `thinking=adaptive/high`.

Test a GPT model through the Responses API:

```bash
pi --offline \
  --provider copilot-proxy \
  --model gpt-5.4 \
  --thinking off \
  --no-tools \
  --no-session \
  -p "Reply with exactly: gpt-pi-ok"
```

The proxy log should show `gpt-5.4 /responses` and a streamed HTTP 200 response.

`--offline` only disables Pi's startup catalog network operations. It does not disable inference requests to the configured local endpoint.

## Additional Claude models

As of 2026-09-25, the Copilot account used during validation exposed these Anthropic models:

| Model ID | Context | Maximum output |
| --- | ---: | ---: |
| `claude-haiku-4.5` | 200K | 64K |
| `claude-opus-4.7` | 1M | 64K |
| `claude-opus-4.8` | 1M | 64K |
| `claude-opus-5` | 1M | 64K |
| `claude-opus-5.5` | 1M | 128K |
| `claude-sonnet-5` | 1M | 64K |

## GPT models

GPT models use a model-level `api` of `openai-responses` and a model-level `baseUrl` of `http://127.0.0.1:5000/v1`. As of 2026-09-25, these enabled GPT models were available:

| Model ID | Context | Maximum output | Reasoning efforts |
| --- | ---: | ---: | --- |
| `gpt-5-mini` | 264K | 64K | low, medium, high |
| `gpt-5.3-codex` | 400K | 128K | low, medium, high, xhigh |
| `gpt-5.4` | 1.05M | 128K | none, low, medium, high, xhigh |
| `gpt-5.4-mini` | 400K | 128K | none, low, medium, high, xhigh |
| `gpt-5.5` | 1.05M | 128K | none, low, medium, high, xhigh |
| `gpt-5.6-luna` | 1.05M | 128K | none, low, medium, high, xhigh, max |
| `gpt-5.6-sol` | 1.05M | 128K | none, low, medium, high, xhigh, max |
| `gpt-5.6-sol-fast` | 1.05M | 128K | none, low, medium, high, xhigh, max |
| `gpt-5.6-terra` | 1.05M | 128K | none, low, medium, high, xhigh, max |
| `gpt-6-astra` | 1.05M | 128K | low, medium, high, xhigh, max |
| `gpt-6-luna` | 1M | 128K | none, low, medium, high, xhigh, max |
| `gpt-6-sol` | 1M | 128K | none, low, medium, high, xhigh, max |

Select one directly:

```bash
pi --model copilot-proxy/gpt-5.6-sol-fast --thinking high
```

Models without the `none` effort (`gpt-5-mini`, `gpt-5.3-codex`, and `gpt-6-astra`) cannot fully disable reasoning. Their Pi definitions should contain `"off": null`.

Add another object to the provider's `models` array using its exact upstream model ID. Model availability can change and can differ by account. Refresh the proxy's model snapshot before updating Pi:

```bash
npx tsx scripts/fetch-models.ts
```

The generated `models.json` in this repository records the current upstream catalog and is intentionally ignored by Git.

## Troubleshooting

### Pi reports that the provider or model is unavailable

Validate the JSON and confirm that Pi loaded the provider:

```bash
pi --offline --list-models copilot-proxy
pi auth check --provider copilot-proxy
```

The Pi configuration file must have a top-level `providers` object. The provider ID in settings must exactly match `copilot-proxy`.

### Connection refused

Start the proxy and recheck its health endpoint. Pi does not start the proxy automatically.

### HTTP 400 `model_not_supported`

The configured model ID is no longer exposed by Copilot. Refresh the model snapshot and replace the Pi model ID with one returned by the current `/v1/models` endpoint. Avoid obsolete internal IDs such as `claude-opus-4.7-1m-internal`.

### Pi sends the wrong thinking level

Check `thinkingLevelMap` and `forceAdaptiveThinking`. In particular, omit the `off` entry rather than assigning it `null`.

### Endpoint path becomes `/v1/v1/messages`

The Pi provider's Anthropic `baseUrl` incorrectly includes `/v1`. Use only `http://127.0.0.1:5000`.

### GPT request goes to the wrong path

Each GPT model must override the provider defaults with `"api": "openai-responses"` and `"baseUrl": "http://127.0.0.1:5000/v1"`. The resulting proxy route is `/v1/responses`, which forwards upstream to `/responses`.
