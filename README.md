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
PORT=5000 LOG_LEVEL=debug npm start

# Test
curl http://localhost:5000/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-opus-4.7","max_tokens":50,"messages":[{"role":"user","content":"hi"}]}'
```

**PowerShell:**
```powershell
# Set port and log level
$env:PORT = "5000"; $env:LOG_LEVEL = "debug"; npm start

# Test
Invoke-RestMethod http://localhost:5000/v1/messages -Method POST `
  -ContentType "application/json" `
  -Headers @{ "anthropic-version" = "2023-06-01" } `
  -Body '{"model":"claude-opus-4.7","max_tokens":50,"messages":[{"role":"user","content":"hi"}]}'
```

## Use with Claude Code

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

## Use with Pi Agent

See [Pi Agent integration](docs/pi-agent.md) for the validated custom provider configuration, supported Claude models, thinking settings, and troubleshooting steps.

## Architecture

```
Claude Code → copilot-proxy (localhost:5000) → api.enterprise.githubcopilot.com
              ├── /v1/messages     → Anthropic native passthrough
              └── /chat/completions → OpenAI format passthrough
```
