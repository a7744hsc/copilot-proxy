import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { asRecord, tokenCount } from '../src/data.js';

const PROVIDER_ID = 'copilot-proxy';
const DEFAULT_PORT = 5000;
const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
// These Claude models were validated with Pi's adaptive thinking format. Do not
// guess it for new models: a manual modelOverride can opt in if needed.
const ADAPTIVE_CLAUDE = new Set([
  'claude-opus-4.7', 'claude-opus-4.8', 'claude-opus-5', 'claude-opus-5.5', 'claude-sonnet-5',
]);

interface Options {
  port: number;
  target: string;
  dryRun: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  let port = Number(process.env.PI_PORT ?? DEFAULT_PORT);
  let piDir = process.env.PI_CODING_AGENT_DIR ?? process.env.PI_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent');
  let out: string | undefined;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return value;
    };
    if (arg === '--port') port = Number(next());
    else if (arg === '--pi-dir') piDir = next();
    else if (arg === '--out') out = next();
    else if (arg === '--dry-run') dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${port}`);
  return { port, target: path.resolve(out ?? path.join(piDir, 'models.json')), dryRun };
}

async function fetchCatalog(baseUrl: string): Promise<unknown[]> {
  const url = `${baseUrl}/v1/models`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const models = asRecord(await response.json())?.data;
    if (!Array.isArray(models)) throw new Error('Invalid model list: expected a data array');
    return models;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read ${url}: ${message}. Check that copilot-proxy is running on this port and authenticated.`);
  }
}

function thinkingLevelMap(effort: Set<unknown>, anthropic: boolean): Record<string, string | null> {
  const map: Record<string, string | null> = {};
  // Omitting off for Anthropic lets Pi send thinking.type=disabled.
  if (!anthropic) map.off = effort.has('none') ? 'none' : null;
  for (const level of THINKING_LEVELS) map[level] = effort.has(level) ? level : null;
  return map;
}

function buildModels(catalog: unknown[], baseUrl: string) {
  const seen = new Set<string>();
  const models = [];
  for (const value of catalog) {
    const model = asRecord(value);
    if (!model || typeof model.id !== 'string' || !model.id.trim()) {
      throw new Error('Invalid model list: an entry has no model ID');
    }
    const { id } = model;
    const endpoints = model.supported_endpoints;
    if (seen.has(id) || asRecord(model.policy)?.state === 'disabled' || !Array.isArray(endpoints)) continue;
    const api = endpoints.includes('/v1/messages') ? 'anthropic-messages'
      : endpoints.includes('/responses') ? 'openai-responses'
        : endpoints.includes('/chat/completions') ? 'openai-completions' : undefined;
    const capabilities = asRecord(model.capabilities);
    const supports = asRecord(capabilities?.supports);
    if (!api || supports?.tool_calls !== true || supports.streaming !== true) continue;
    const limits = asRecord(capabilities?.limits);
    const total = tokenCount(limits?.max_context_window_tokens) || undefined;
    const prompt = tokenCount(limits?.max_prompt_tokens) || undefined;
    const contextWindow = total && prompt ? Math.min(total, prompt) : total ?? prompt;
    if (!contextWindow) continue;

    const anthropic = api === 'anthropic-messages';
    const adaptive = anthropic && ADAPTIVE_CLAUDE.has(id);
    const effort = new Set(Array.isArray(supports.reasoning_effort) ? supports.reasoning_effort : []);
    if (adaptive && !THINKING_LEVELS.some((level) => effort.has(level))) {
      for (const level of ['low', 'medium', 'high', 'max']) effort.add(level);
    }
    const reasoning = anthropic
      ? adaptive || Boolean(tokenCount(supports.max_thinking_budget))
      : THINKING_LEVELS.some((level) => effort.has(level));
    const maxTokens = tokenCount(limits?.max_output_tokens) || undefined;
    seen.add(id);
    models.push({
      id,
      name: `${typeof model.name === 'string' && model.name.trim() ? model.name : id} (Copilot Proxy)`,
      api,
      baseUrl: anthropic ? baseUrl : `${baseUrl}/v1`,
      reasoning,
      ...(adaptive || (!anthropic && reasoning) ? { thinkingLevelMap: thinkingLevelMap(effort, anthropic) } : {}),
      input: supports.vision === true ? ['text', 'image'] : ['text'],
      contextWindow,
      ...(maxTokens ? { maxTokens } : {}),
      ...(adaptive ? { compat: { forceAdaptiveThinking: true } } : {}),
    });
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

function readDocument(target: string): Record<string, unknown> {
  if (!fs.existsSync(target)) return {};
  const document = asRecord(JSON.parse(fs.readFileSync(target, 'utf8')));
  if (!document) throw new Error(`Expected a JSON object in ${target}`);
  return document;
}

function objectField(object: Record<string, unknown>, key: string): Record<string, unknown> {
  if (object[key] === undefined) return {};
  const value = asRecord(object[key]);
  if (!value) throw new Error(`Expected a JSON object for ${key} in models.json`);
  return value;
}

function writeWithBackup(target: string, contents: string): string | undefined {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const oldMode = fs.existsSync(target) ? fs.statSync(target).mode & 0o777 : undefined;
  const temporary = fs.mkdtempSync(path.join(directory, '.sync-pi-'));
  try {
    const staged = path.join(temporary, 'models.json');
    fs.writeFileSync(staged, contents, { mode: oldMode ?? 0o600 });
    let backup: string | undefined;
    if (oldMode !== undefined) {
      backup = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.copyFileSync(target, backup, fs.constants.COPYFILE_EXCL);
    }
    fs.renameSync(staged, target);
    return backup;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function printHelp(): void {
  console.log(`Usage: npm run sync:pi -- [options]

Refreshes Pi's copilot-proxy models from the running proxy's /v1/models.

Options:
  --port <n>       Proxy port (PI_PORT or ${DEFAULT_PORT})
  --pi-dir <path>  Pi agent directory (PI_CODING_AGENT_DIR, PI_AGENT_DIR, or ~/.pi/agent)
  --out <path>     Target file instead of <pi-dir>/models.json
  --dry-run        Preview the model list without writing anything
  --help, -h       Show this help`);
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }
  const { port, target, dryRun } = parseArgs(argv);
  const baseUrl = `http://127.0.0.1:${port}`;
  const models = buildModels(await fetchCatalog(baseUrl), baseUrl);
  if (!models.length) throw new Error(`No Pi-compatible chat models found at ${baseUrl}/v1/models. Configuration unchanged.`);

  // Update the actual file without replacing a dotfile manager's symlink.
  const file = fs.existsSync(target) ? fs.realpathSync(target) : target;
  const document = readDocument(file);
  const providers = objectField(document, 'providers');
  const existing = objectField(providers, PROVIDER_ID);
  const updated = {
    ...document,
    $schema: document.$schema ?? 'https://pi.dev/schemas/models.schema.json',
    providers: {
      ...providers,
      [PROVIDER_ID]: {
        name: 'Local Copilot Proxy',
        apiKey: 'dummy',
        ...existing,
        baseUrl,
        models,
      },
    },
  };

  console.log(`Catalog: ${baseUrl}/v1/models\nPi models file: ${file}\nModels: ${models.length}`);
  for (const model of models) console.log(`  ${model.id} (${model.api}, context ${model.contextWindow})`);
  if (dryRun) {
    console.log('Dry run: no files changed.');
    return;
  }
  const backup = writeWithBackup(file, `${JSON.stringify(updated, null, 2)}\n`);
  console.log(`Wrote ${file}`);
  if (backup) console.log(`Backup: ${backup}`);
  console.log('Open /model in Pi to reload the list. If the default model was removed, select a new one.');
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
