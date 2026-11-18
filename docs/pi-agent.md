# Use Copilot Proxy with Pi

Pi reads custom providers from `~/.pi/agent/models.json`. Use this repository's sync command to create or refresh the `copilot-proxy` provider from the running proxy's model catalog. Pi's built-in catalog update does not refresh this custom provider.

## Start the proxy

From the repository, install dependencies and start the proxy. The commands below use port **5001** throughout, since macOS AirPlay Receiver can occupy port 5000.

```bash
npm install
PORT=5001 npm start
```

In PowerShell, use `$env:PORT = '5001'; npm start` instead. Complete GitHub device authorization if prompted, and leave the proxy running. If you already use `npm start` on the default port or the Windows autostart task, use **5000** instead of **5001** in the commands below.

## Set up or refresh Pi

In another terminal, from the repository:

```bash
npm run sync:pi -- --port 5001 --dry-run  # preview the resulting list
npm run sync:pi -- --port 5001            # write Pi's models.json
pi --offline --list-models copilot-proxy
```

Run the same sync command whenever Copilot adds or removes models. The list depends on the account and proxy configuration. If the catalog request fails or has no eligible models, the sync exits without changing your configuration. It does not read OAuth credentials or contact GitHub directly.

The script replaces the `copilot-proxy` model list and base URL, but preserves other providers and fields such as `modelOverrides`. Put model-specific customizations in `providers.copilot-proxy.modelOverrides`, keyed by model ID; direct edits to the generated `models` array are replaced on the next sync. The script does not change `settings.json`. If you need to roll back, restore the `models.json.bak-…` file printed by the command over the updated file.

| Option | Default / effect |
| --- | --- |
| `--port <n>` | `PI_PORT` or `5000`; match the port used to start the proxy |
| `--pi-dir <path>` | `PI_CODING_AGENT_DIR`, then `PI_AGENT_DIR`, then `~/.pi/agent` |
| `--out <path>` | Target a different file instead of `<pi-dir>/models.json` |
| `--dry-run` | Preview without writing files or creating a backup |

## Select and test a model

Open Pi's `/model` picker to reload the list, then select a `copilot-proxy` model. Press `Ctrl+S` in the picker to save it as the default for new sessions. If a sync removes your previous default, choose a new one. To make a test request without changing the default, replace `MODEL_ID` with an ID from the sync output:

```bash
pi --offline --model copilot-proxy/MODEL_ID --no-tools --no-session -p "Reply with OK."
```

The test uses your Copilot account. Pi's local cost display does not reflect Copilot billing.

## Endpoint and troubleshooting notes

The script maps advertised endpoints in this order: `/v1/messages` → `anthropic-messages` (base URL at the proxy root), `/responses` → `openai-responses` (base URL ending in `/v1`), then `/chat/completions` → `openai-completions` (also ending in `/v1`). It skips disabled models and entries without advertised streaming or tool calls. When both token limits are present it uses the lower of the context and prompt limits. A new provider gets `apiKey: "dummy"`; the proxy handles upstream authentication.

- **Connection refused or unexpected HTTP status:** confirm the port and visit `http://127.0.0.1:5001/health/ready`. If authentication is failing, check the proxy log and start it in a terminal to complete sign-in if needed.
- **A listed model rejects requests:** the catalog is not an inference test. Re-sync, check account and organization policy, or choose another model. To adjust verified request compatibility for a model, use `modelOverrides`.
