# Claude Code integration

This guide configures Claude Code to use this proxy as an Anthropic-compatible local LLM gateway.

Validated with:

- Claude Code `2.1.283`
- Proxy endpoint `http://127.0.0.1:5000`
- Claude Opus 5.5 with adaptive thinking, tool calls, streaming, a 1M context window, and 128K maximum output
- Claude Haiku 4.5 for background tasks

Claude Code supports custom Anthropic-format gateways through `ANTHROPIC_BASE_URL`. The proxy exposes the required `POST /v1/messages` route.

### Claude Code version requirement for Opus 5.5

Opus 5.5 requires Claude Code `2.1.280` or newer. Older clients return HTTP 400 with `claude_code_version_too_old`. The setup below was validated with Claude Code `2.1.283` from Homebrew's `claude-code@latest` cask.

The stable Homebrew `claude-code` cask can lag behind this requirement. If necessary, switch to `claude-code@latest` or use Anthropic's native installer before selecting Opus 5.5.

## 1. Start the proxy

From this repository:

```bash
npm install
PORT=5000 npm start
```

Complete the GitHub device authorization flow on first use. Keep the proxy process running while Claude Code is in use.

Check its health:

```bash
curl http://127.0.0.1:5000/health
```

Expected response:

```json
{"status":"ok"}
```

## 2. Test with temporary environment variables

Before saving anything, test one Claude Code invocation:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:5000 \
ANTHROPIC_AUTH_TOKEN=dummy \
claude --model claude-opus-4.7
```

`dummy` is a non-secret placeholder. The proxy does not validate the incoming credential; it authenticates upstream with the GitHub token stored in this repository's `.tokens/` directory.

The base URL must be the server root. Do **not** append `/v1`; Claude Code appends `/v1/messages` itself.

## 3. Persist the configuration

Claude Code's user settings apply to every local project and are also inherited by background agents. Create or merge this configuration into `~/.claude/settings.json`:

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "model": "claude-opus-5-5[1m]",
  "modelOverrides": {
    "claude-opus-5-5": "claude-opus-5.5",
    "claude-opus-4-7": "claude-opus-4.7",
    "claude-opus-4-8": "claude-opus-4.8",
    "claude-haiku-4-5": "claude-haiku-4.5"
  },
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:5000",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5-5[1m]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-haiku-4-5"
  }
}
```

If the file already contains settings, merge the `model`, `modelOverrides`, and `env` values instead of replacing unrelated configuration.

### Why `modelOverrides` is needed

Claude Code uses hyphenated Anthropic model IDs such as `claude-opus-5-5`, while the current Copilot catalog exposes some IDs with dots, such as `claude-opus-5.5`.

`modelOverrides` lets Claude Code retain its built-in knowledge of the model's capabilities while sending the actual Copilot model ID to the proxy:

| Claude Code model ID | Copilot model ID |
| --- | --- |
| `claude-opus-5-5` | `claude-opus-5.5` |
| `claude-opus-4-7` | `claude-opus-4.7` |
| `claude-opus-4-8` | `claude-opus-4.8` |
| `claude-haiku-4-5` | `claude-haiku-4.5` |
| `claude-sonnet-5` | `claude-sonnet-5` |

Using `claude-opus-5.5` directly works at the API level, but Claude Code may treat the unfamiliar spelling as a different or unknown model. That can produce an incorrect context window, output cap, or thinking mode. Use the recognized hyphenated ID plus the override.

### Why `[1m]` is included

When `ANTHROPIC_BASE_URL` points at a gateway, Claude Code cannot independently verify that the gateway supports a 1M context window. The `[1m]` suffix tells Claude Code to budget the session for one million tokens. Claude Code strips the suffix before the model request and then applies `modelOverrides`, so the proxy receives `claude-opus-5.5`.

Without `[1m]`, Claude Code may budget Opus 5.5 at 200K even though the Copilot model advertises a 1M context window.

### Alias behavior

The pinned variables make Claude Code aliases resolve through the proxy:

- `opus` → `claude-opus-5-5[1m]` → upstream `claude-opus-5.5`
- `sonnet` → upstream `claude-sonnet-5`
- `haiku` → `claude-haiku-4-5` → upstream `claude-haiku-4.5`

Haiku is important even when Opus is the main model because Claude Code uses it for background work such as session-title generation.

## 4. Validate the saved configuration

Check the settings and installation:

```bash
claude doctor
```

A custom endpoint causes expected notices that managed settings and Remote Control are unavailable. It should still end with `No installation issues found.`

Run a request without passing endpoint or model variables:

```bash
claude -p \
  --effort high \
  --tools '' \
  --no-session-persistence \
  "Reply with exactly: persistent-config-ok"
```

Expected output:

```text
persistent-config-ok
```

Test a tool round trip:

```bash
claude -p \
  --effort low \
  --tools Read \
  --no-session-persistence \
  "Use the Read tool to read package.json, then reply with exactly its package name and nothing else."
```

Expected result for this repository:

```text
copilot-proxy
```

Test the Haiku alias:

```bash
claude -p \
  --model haiku \
  --tools '' \
  --no-session-persistence \
  "Reply with exactly: haiku-alias-ok"
```

## 5. Normal usage

Start an interactive session with the configured default:

```bash
claude
```

Select a model for one launch:

```bash
claude --model opus
claude --model sonnet
claude --model haiku
claude --model claude-opus-4-8
```

Control adaptive reasoning:

```bash
claude --effort low
claude --effort high
claude --effort xhigh
claude --effort max
```

Inside Claude Code, use `/model`, `/effort`, and `/status` to inspect or change the active values. `/status` should show the local Anthropic base URL and `ANTHROPIC_AUTH_TOKEN` as the credential source.

## 6. Project-only configuration

To apply the gateway only to this repository, put the same values in `.claude/settings.local.json` instead of the user settings file.

Do not commit credentials in `.claude/settings.json`. Although `dummy` is harmless for this local proxy, a real gateway token must remain in user or local settings, a shell environment, or an `apiKeyHelper`.

For this proxy, user settings are preferable because they also reach Claude Code background agents reliably.

## 7. Restore the official Anthropic API

Remove these entries from `~/.claude/settings.json`:

- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_AUTH_TOKEN`
- the local `modelOverrides`
- local model pins if they are no longer wanted

Also remove or change the top-level `model` value if it points at a gateway-specific selection. Then restart Claude Code and authenticate normally.

For a one-off official session without editing the file, use a separate settings file or temporarily move the local settings file out of `~/.claude/`.

## Limitations

When Claude Code uses a non-Anthropic `ANTHROPIC_BASE_URL`:

- Remote Control is unavailable.
- Voice dictation and other features requiring a claude.ai identity may be unavailable.
- Server-managed Anthropic organization settings are not fetched through this local endpoint.
- Model inference still works, including streaming, adaptive thinking, prompt caching, image input, and tool calls supported by the selected model.
- Claude Code officially supports Claude models through Anthropic-format gateways; use Pi or another OpenAI-compatible client for GPT models exposed by this proxy.

## Troubleshooting

### Claude Code asks for login

Ensure `ANTHROPIC_AUTH_TOKEN` is set together with `ANTHROPIC_BASE_URL`. A base URL alone does not replace Claude Code authentication.

User settings in `~/.claude/settings.json` are read before the first-run project trust flow and are the most reliable persistent location.

### Connection refused

The proxy is not running or is listening on another port. Start it and retry the health check.

### Request path becomes `/v1/v1/messages`

The configured base URL incorrectly includes `/v1`. Set it to exactly `http://127.0.0.1:5000`.

### `model_not_supported`

The Copilot model catalog changed or the override target is wrong. Refresh the catalog:

```bash
npx tsx scripts/fetch-models.ts
```

Then update the right-hand values in `modelOverrides` to exact model IDs returned by Copilot.

### `thinking.type.enabled` is not supported

Current Opus models use adaptive thinking. Use a Claude Code-recognized model ID and `modelOverrides` so Claude Code sends `thinking.type=adaptive` with `output_config.effort`. Avoid passing the dotted Copilot ID directly as the primary Claude Code model.

### Haiku rejects `output_config.effort`

Use the recognized `claude-haiku-4-5` ID and map it to `claude-haiku-4.5`. Claude Code then knows not to send adaptive effort to Haiku 4.5.

### Claude Code reports an unrecognized model

Use the hyphenated Claude Code ID on the left side of `modelOverrides`, and the exact Copilot ID on the right. Select the left-side ID or its alias in Claude Code.

### Context window shows 200K instead of 1M

Select `claude-opus-5-5[1m]` or the pinned `opus` alias. Keep the `[1m]` suffix in `ANTHROPIC_DEFAULT_OPUS_MODEL` and the top-level `model` setting.
