# copilot-proxy

Standalone proxy server that bridges Claude Code (or any Anthropic API client) with GitHub Copilot's API.

Replicates the core functionality of the MAI LLM Proxy VS Code extension as a CLI tool — no VS Code dependency.

## Features

- **GitHub Copilot OAuth Device Flow** — authenticate via browser
- **Automatic token refresh** — refreshes 5 minutes before expiry
- **Anthropic API passthrough** — `/v1/messages` forwarded directly to Copilot API
- **OpenAI API passthrough** — `/v1/chat/completions` forwarded to Copilot API
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
              └── /v1/chat/completions → OpenAI format passthrough
```
