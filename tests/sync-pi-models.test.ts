import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const script = path.join(root, 'scripts', 'sync-pi-models.ts');

function model(id: string, endpoints: string[], supports: Record<string, unknown> = {}) {
  return {
    id,
    supported_endpoints: endpoints,
    capabilities: {
      supports: { tool_calls: true, streaming: true, ...supports },
      limits: { max_context_window_tokens: 200_000, max_prompt_tokens: 150_000, max_output_tokens: 32_000 },
    },
  };
}

async function withCatalog(status: number, response: unknown, run: (port: number, dir: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-pi-'));
  const requests: string[] = [];
  const server = createServer((request, res) => {
    requests.push(`${request.method} ${request.url}`);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert(address && typeof address === 'object');
    await run(address.port, dir);
    assert.deepEqual(requests, ['GET /v1/models']);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function sync(port: number, dir: string, ...args: string[]) {
  return exec(process.execPath, [tsx, script, '--port', String(port), ...args], {
    cwd: dir,
    env: { ...process.env, PI_CODING_AGENT_DIR: dir },
    timeout: 15_000,
  });
}

test('Pi sync maps eligible models and replaces only the proxy URL and catalog', async () => {
  const gpt = model('test-gpt', ['/chat/completions', '/responses'], { vision: true, reasoning_effort: ['none', 'low', 'high'] });
  const data = [
    gpt, gpt,
    model('claude-opus-4.7', ['/chat/completions', '/v1/messages']),
    model('budget-claude', ['/v1/messages'], { max_thinking_budget: 16_000 }),
    model('test-chat', ['/chat/completions']),
    { ...model('disabled', ['/responses']), policy: { state: 'disabled' } },
    model('not-streaming', ['/responses'], { streaming: false }),
    model('not-tool-capable', ['/responses'], { tool_calls: false }),
    model('embedding', ['/embeddings']),
  ];
  await withCatalog(200, { data }, async (port, dir) => {
    const file = path.join(dir, 'models.json');
    const overrides = { 'test-chat': { compat: { supportsStore: false } } };
    const original = JSON.stringify({
      $schema: 'https://example.test/schema.json',
      providers: {
        separate: { baseUrl: 'http://localhost:9000', models: [{ id: 'keep' }] },
        'copilot-proxy': {
          name: 'My proxy', apiKey: '$PROXY_KEY', baseUrl: 'http://127.0.0.1:5000',
          headers: { 'x-sample': 'keep' }, compat: { supportsStore: false }, modelOverrides: overrides,
          models: [{ id: 'obsolete' }],
        },
      },
    });
    await fs.writeFile(file, original);
    const { stdout } = await sync(port, dir);
    assert.match(stdout, /Models: 4/);
    const updated = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(updated.$schema, JSON.parse(original).$schema);
    assert.deepEqual(updated.providers.separate, JSON.parse(original).providers.separate);
    const { models, ...proxy } = updated.providers['copilot-proxy'];
    const { models: _old, ...originalProxy } = JSON.parse(original).providers['copilot-proxy'];
    const baseUrl = `http://127.0.0.1:${port}`;
    assert.deepEqual(proxy, { ...originalProxy, baseUrl });
    assert.deepEqual(models.map((entry: { id: string }) => entry.id), ['budget-claude', 'claude-opus-4.7', 'test-chat', 'test-gpt']);
    const [budgetClaude, adaptiveClaude, chat, responses] = models;
    assert.equal(budgetClaude.api, 'anthropic-messages');
    assert.equal(budgetClaude.baseUrl, baseUrl);
    assert.equal(budgetClaude.reasoning, true);
    assert.equal(adaptiveClaude.api, 'anthropic-messages');
    assert.deepEqual(adaptiveClaude.compat, { forceAdaptiveThinking: true });
    assert.equal(adaptiveClaude.thinkingLevelMap.off, undefined);
    assert.equal(chat.api, 'openai-completions');
    assert.equal(chat.baseUrl, `${baseUrl}/v1`);
    assert.equal(chat.reasoning, false);
    assert.equal(chat.thinkingLevelMap, undefined);
    assert.equal(responses.api, 'openai-responses');
    assert.equal(responses.baseUrl, `${baseUrl}/v1`);
    assert.equal(responses.contextWindow, 150_000);
    assert.equal(responses.maxTokens, 32_000);
    assert.deepEqual(responses.input, ['text', 'image']);
    assert.deepEqual(responses.thinkingLevelMap, { off: 'none', minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null });
    const backups = (await fs.readdir(dir)).filter((name) => name.startsWith('models.json.bak-'));
    assert.equal(backups.length, 1);
    assert.equal(await fs.readFile(path.join(dir, backups[0]), 'utf8'), original);
  });
});

test('Pi sync dry-run leaves even a new output directory unwritten', async () => {
  await withCatalog(200, { data: [model('test-chat', ['/chat/completions'])] }, async (port, dir) => {
    const target = path.join(dir, 'nested', 'models.json');
    const { stdout } = await sync(port, dir, '--out', target, '--dry-run');
    assert.match(stdout, /test-chat/);
    assert.match(stdout, /Dry run: no files changed/);
    assert.deepEqual(await fs.readdir(dir), []);
  });
});

for (const { status, response, error } of [
  { status: 403, response: {}, error: /\/v1\/models: HTTP 403/ },
  { status: 200, response: { data: [null] }, error: /Invalid model list/ },
  { status: 200, response: { data: [] }, error: /No Pi-compatible chat models/ },
]) {
  test(`Pi sync leaves existing config intact on ${error.source}`, async () => {
    await withCatalog(status, response, async (port, dir) => {
      const file = path.join(dir, 'models.json');
      const original = '{"providers":{"copilot-proxy":{"models":[{"id":"keep"}]}}}';
      await fs.writeFile(file, original);
      await assert.rejects(sync(port, dir), error);
      assert.equal(await fs.readFile(file, 'utf8'), original);
      assert.deepEqual(await fs.readdir(dir), ['models.json']);
    });
  });
}
