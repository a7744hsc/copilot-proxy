import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CompatibilityAdapter } from '../src/compatibility/index.js';

const originalCwd = process.cwd();
const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-proxy-tests-'));
process.chdir(testDirectory);
process.env.LOG_LEVEL = 'error';

const { AuthManager } = await import('../src/auth.js');
const { createServer } = await import('../src/server.js');
const { buildCodexCatalog, parseCodexTemplates } = await import('../src/catalog.js');
const { UpstreamFeedback, retryAt } = await import('../src/feedback.js');
const { getConfig } = await import('../src/config.js');
const stats = await import('../src/stats.js');
const realFetch = globalThis.fetch;

const templates = {
  version: '0.162.0',
  fallback_instructions: 'Fallback instructions from the matching Codex version.',
  models: [{
    slug: 'gpt-test',
    model_messages: { instructions_template: 'Keep these original model instructions.', tools: { example: true } },
    base_instructions: 'Legacy duplicate',
    shell_type: 'shell_command',
    tool_mode: 'code_mode_only',
    default_reasoning_level: 'high',
    supported_reasoning_levels: [],
    support_verbosity: false,
    truncation_policy: { mode: 'tokens', limit: 10000 },
    experimental_supported_tools: [],
    service_tiers: [{ id: 'priority' }],
  }],
};
fs.writeFileSync('config.json', '{}');
fs.writeFileSync('codex-model-templates.json', JSON.stringify(templates));
fs.writeFileSync('api-key.json', JSON.stringify({
  token: 'fake-test-token',
  expires_at: Math.floor(Date.now() / 1000) + 86400,
  endpoints: { api: 'https://copilot.example' },
}));

function model(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    supported_endpoints: ['/responses'],
    capabilities: {
      limits: { max_prompt_tokens: 128000, max_context_window_tokens: 256000 },
      supports: { streaming: true, tool_calls: true, vision: true, reasoning_effort: ['low', 'high'] },
    },
    ...overrides,
  };
}

function chunkedResponse(body: string, headers: Record<string, string> = {}) {
  const bytes = new TextEncoder().encode(body);
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream', ...headers } });
}

async function withServer(
  run: (base: string, auth: InstanceType<typeof AuthManager>) => Promise<void>,
  adapters?: readonly CompatibilityAdapter[],
) {
  const auth = new AuthManager(testDirectory);
  await auth.ensureAuthenticated();
  const server = createServer(auth, adapters).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  try {
    await run(`http://127.0.0.1:${address.port}`, auth);
  } finally {
    auth.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

after(() => {
  process.chdir(originalCwd);
  fs.rmSync(testDirectory, { recursive: true, force: true });
});

test('catalog filters unsupported models and keeps real capabilities and original instructions', () => {
  const { catalog, excluded } = buildCodexCatalog({ data: [
    model('gpt-test'), model('grok-test'), model('gpt-test'),
    model('messages-only', { supported_endpoints: ['/v1/messages'] }),
    model('ws-only', { supported_endpoints: ['ws:/responses'] }),
    model('disabled', { policy: { state: 'disabled' } }),
    model('no-capabilities', { capabilities: {} }),
    model('no-limits', { capabilities: { supports: { tool_calls: true, streaming: true } } }),
  ] }, templates);
  assert.equal(catalog.models.length, 2);
  assert.equal(excluded.length, 5);
  const known = catalog.models[0];
  assert.deepEqual(known.model_messages, templates.models[0].model_messages);
  assert.equal(known.tool_mode, 'code_mode_only');
  assert.equal(known.base_instructions, undefined);
  assert.equal(known.context_window, 128000);
  assert.equal(known.max_context_window, 128000);
  assert.equal(known.default_reasoning_level, 'high');
  assert.deepEqual(known.supported_reasoning_levels, [
    { effort: 'low', description: 'low reasoning effort' },
    { effort: 'high', description: 'high reasoning effort' },
  ]);
  assert.deepEqual(known.service_tiers, []);
  assert.equal(known.default_service_tier, null);
  assert.deepEqual(catalog.models[1].model_messages, { instructions_template: templates.fallback_instructions });
  assert.equal(catalog.models[1].shell_type, 'unified_exec');
});

test('catalog rejects malformed inputs and oversized output rather than truncating models', () => {
  assert.throws(() => buildCodexCatalog({}, templates), /invalid model list/);
  assert.throws(() => buildCodexCatalog({ data: [{}] }, templates), /missing its ID/);
  assert.throws(() => parseCodexTemplates({ ...templates, fallback_instructions: '' }), /Invalid Codex/);
  assert.throws(() => buildCodexCatalog({ data: [model('new')] }, {
    ...templates, fallback_instructions: 'x'.repeat(1024 * 1024),
  }), /1 MiB/);
});

test('Responses, Chat Completions and Anthropic usage keep cache and reasoning accounting separate', () => {
  const usage = stats.extractUsageFromResponse(JSON.stringify({ usage: {
    input_tokens: 100, output_tokens: 20, cache_write_input_tokens: 10,
    input_tokens_details: { cached_tokens: 70 },
    output_tokens_details: { reasoning_tokens: 12 },
  } }));
  assert.deepEqual(usage, {
    input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 10,
    cache_read_input_tokens: 70, reasoning_tokens: 12,
  });
  assert.equal(stats.extractUsageFromResponse(JSON.stringify({ usage: {
    prompt_tokens: 100, completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 30 },
    completion_tokens_details: { reasoning_tokens: 8 },
  } }))?.cache_read_input_tokens, 30);
  assert.equal(stats.extractUsageFromResponse(JSON.stringify({ usage: {
    input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 5,
  } }))?.cache_creation_input_tokens, 20);
});

test('SSE accounting accepts split CRLF frames, terminal usage and partial Anthropic updates', () => {
  const event = `event: response.completed\r\ndata:${JSON.stringify({
    type: 'response.completed',
    response: { usage: {
      input_tokens: 100, output_tokens: 20,
      input_tokens_details: { cached_tokens: 70 },
      output_tokens_details: { reasoning_tokens: 12 },
    } },
  })}\r\n\r\n`;
  const accumulator = new stats.StreamUsageAccumulator();
  for (const character of event) accumulator.addChunk(character);
  accumulator.flush();
  assert.equal(accumulator.getUsage()?.cache_read_input_tokens, 70);
  assert.equal(accumulator.getUsage()?.reasoning_tokens, 12);
  for (const type of ['response.incomplete', 'response.failed']) {
    assert.equal(stats.extractUsageFromStream(`data: ${JSON.stringify({
      type, response: { usage: { input_tokens: 4, output_tokens: 3 } },
    })}\n\n`)?.output_tokens, 3);
  }
  const anthropic = [
    { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 8, output_tokens: 0 } } },
    { type: 'message_delta', usage: { output_tokens: 7 } },
  ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join('');
  assert.equal(stats.extractUsageFromStream(anthropic)?.input_tokens, 10);
  assert.equal(stats.extractUsageFromStream(anthropic)?.output_tokens, 7);
  assert.equal(stats.extractUsageFromStream(anthropic)?.cache_read_input_tokens, 8);
});

test('older stats load without resetting usage; new HTTP outcomes include requests without usage', () => {
  const day = new Date().toISOString().slice(0, 10);
  fs.writeFileSync('stats.json', JSON.stringify({ [day]: { legacy: {
    input_tokens: 9, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, requests: 1,
  } } }));
  stats.loadStats();
  stats.recordHttpResponse('legacy', 429);
  stats.recordUsage('legacy', {
    input_tokens: 3, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 2, reasoning_tokens: 1,
  });
  const result = stats.getStats()[day].legacy;
  assert.equal(result.input_tokens, 12);
  assert.equal(result.requests, 2);
  assert.equal(result.http_responses, 1);
  assert.equal(result.rate_limited_responses, 1);
  assert.equal(result.reasoning_tokens, 1);
  assert.equal(JSON.parse(fs.readFileSync('stats.json', 'utf-8'))[day].legacy.reasoning_tokens, 1);
});

test('health separates liveness, unknown upstream, expired auth, rejection and network failure', async (t) => {
  let upstream: () => Response = () => Response.json({ data: [model('gpt-test')] });
  t.mock.method(globalThis, 'fetch', async () => upstream());
  await withServer(async (base, auth) => {
    assert.equal((await realFetch(`${base}/health/live`)).status, 200);
    const unknown = await realFetch(`${base}/health`);
    assert.equal(unknown.status, 503);
    assert.equal((await unknown.json()).status, 'unknown');
    const ready = await realFetch(`${base}/health/ready`);
    assert.equal(ready.status, 200);
    const health = await ready.json();
    assert.equal(health.authentication.state, 'valid');
    assert.equal(JSON.stringify(health).includes('fake-test-token'), false);
    assert.equal(health.upstream.http_status, 200);

    upstream = () => Response.json({ error: 'invalid request' }, { status: 400 });
    assert.equal((await realFetch(`${base}/health/ready`)).status, 503);
    upstream = () => Response.json({ error: 'not a model list' });
    assert.equal((await realFetch(`${base}/health/ready`)).status, 503);
    assert.equal((await realFetch(`${base}/health`)).status, 503);
    upstream = () => new Response('rejected', { status: 401 });
    assert.equal((await realFetch(`${base}/health/ready`)).status, 503);
    assert.equal((await (await realFetch(`${base}/health`)).json()).status, 'upstream_rejected');
    upstream = () => { throw new Error('fake network failure'); };
    assert.equal((await realFetch(`${base}/health/ready`)).status, 503);
    assert.equal((await (await realFetch(`${base}/health`)).json()).upstream.reachable, false);

    const now = Date.now();
    t.mock.method(Date, 'now', () => now + 86400000 * 2);
    assert.equal(auth.getAuthStatus().state, 'expired');
    assert.equal((await (await realFetch(`${base}/health`)).json()).status, 'unauthenticated');
  });
});

test('rate-limit feedback forwards headers and body unchanged without retrying 429', async (t) => {
  let calls = 0;
  let incoming: unknown;
  const body = '{"error":{"message":"Quota temporarily exhausted"}}';
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    calls++;
    incoming = JSON.parse(String(init.body));
    return new Response(body, { status: 429, headers: {
      'content-type': 'application/json', 'retry-after': '17',
      'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '17s',
      'set-cookie': 'must-not-be-forwarded',
    } });
  });
  await withServer(async (base) => {
    const request = { model: 'rate-test', input: 'test', service_tier: 'priority' };
    const response = await realFetch(`${base}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '17');
    assert.equal(response.headers.get('x-ratelimit-remaining-requests'), '0');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(await response.text(), body);
    assert.deepEqual(incoming, request);
    assert.equal(calls, 1);
    const feedback = await (await realFetch(`${base}/rate-limits`)).json();
    assert.equal(feedback.models['rate-test'].responses_429, 1);
    assert(feedback.models['rate-test'].retry_at);
    const daily = await (await realFetch(`${base}/stats`)).json();
    assert.equal(daily[new Date().toISOString().slice(0, 10)]['rate-test'].rate_limited_responses, 1);
  });
});

test('Retry-After parsing supports seconds and dates without inventing a cooldown', () => {
  assert.equal(retryAt('2', 0), '1970-01-01T00:00:02.000Z');
  assert.equal(retryAt('Wed, 21 Oct 2015 07:28:00 GMT'), '2015-10-21T07:28:00.000Z');
  assert.equal(retryAt(null), null);
  assert.equal(retryAt('-1'), null);
  assert.equal(retryAt('not-a-date'), null);
});

test('catalog route is Codex-shaped while existing model list remains unchanged', async (t) => {
  const data = { data: [model('gpt-test'), model('grok-test')], object: 'list' };
  t.mock.method(globalThis, 'fetch', async () => Response.json(data));
  await withServer(async (base) => {
    assert.deepEqual(await (await realFetch(`${base}/v1/models`)).json(), data);
    const response = await realFetch(`${base}/codex/models`);
    assert.equal(response.status, 200);
    const catalog = await response.json();
    assert.deepEqual(catalog.models.map((entry: { slug: string }) => entry.slug), ['gpt-test', 'grok-test']);
  });
});

test('rate feedback drops stale headers when the next response omits them', async (t) => {
  let response = new Response('', { status: 429, headers: { 'retry-after': '10' } });
  t.mock.method(globalThis, 'fetch', async () => response);
  const feedback = new UpstreamFeedback();
  await feedback.fetch('https://copilot.example/responses', {}, '/responses', 'test');
  response = new Response('', { status: 200 });
  await feedback.fetch('https://copilot.example/responses', {}, '/responses', 'test');
  const result = feedback.getRateLimits().models.test;
  assert.equal(result.responses_429, 1);
  assert.deepEqual(result.headers, {});
  assert.equal(result.retry_at, null);
});

test('Codex compatibility is opt-in and runs after aliases and config overrides', async (t) => {
  const incoming: Array<{ url: string; body: unknown }> = [];
  const output = { id: 'resp_test', object: 'response', output: [] };
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    incoming.push({ url, body: JSON.parse(String(init.body)) });
    return Response.json(output);
  });
  const config = getConfig();
  const oldModels = config.models;
  const oldOverrides = config.requestOverrides.openai;
  config.models = { 'codex-alias': 'gpt-test' };
  config.requestOverrides.openai = { service_tier: 'priority' };
  try {
    await withServer(async (base) => {
      const request = { model: 'codex-alias', input: 'test', store: false };
      for (const route of ['/codex/v1/responses', '/v1/responses', '/responses']) {
        const response = await realFetch(`${base}${route}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), output);
        const adapted = route.startsWith('/codex/');
        assert.equal(response.headers.get('x-copilot-proxy-adapter'), adapted ? 'codex-copilot' : null);
        assert.equal(response.headers.get('x-copilot-proxy-adjustments'), adapted ? 'remove-service-tier' : null);
        assert.deepEqual(incoming.at(-1), {
          url: 'https://copilot.example/responses',
          body: { ...request, model: 'gpt-test', ...(adapted ? {} : { service_tier: 'priority' }) },
        });
      }
      assert.equal(incoming.length, 3);
    });
  } finally {
    config.models = oldModels;
    config.requestOverrides.openai = oldOverrides;
  }
});

test('Codex adapter preserves tool roundtrips, SSE bytes and usage accounting', async (t) => {
  const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'shell', arguments: '{"command":"echo OK"}' };
  const toolEvents = [
    { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_1', delta: call.arguments },
    { type: 'response.output_item.done', output_index: 0, item: call },
    { type: 'response.completed', response: { id: 'resp_1', output: [call], usage: { input_tokens: 8, output_tokens: 3 } } },
  ].map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join('');
  const finalEvents = [
    { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Done \u2713' },
    { type: 'response.completed', response: { id: 'resp_2', output: [], usage: { input_tokens: 12, output_tokens: 2 } } },
  ].map((event) => `data:${JSON.stringify(event)}\n\n`).join('');
  const incoming: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    incoming.push(JSON.parse(String(init.body)));
    return chunkedResponse(incoming.length === 1 ? toolEvents : finalEvents, { 'x-request-id': 'upstream-test' });
  });
  await withServer(async (base) => {
    const first = { model: 'compat-stream-test', stream: true, input: [{ role: 'user', content: 'Run echo OK' }] };
    const second = {
      ...first, service_tier: 'priority',
      input: [...first.input, call, { type: 'function_call_output', call_id: 'call_1', output: 'OK' }],
    };
    for (const [request, events] of [[first, toolEvents], [second, finalEvents]] as const) {
      const response = await realFetch(`${base}/codex/v1/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-request-id'), 'upstream-test');
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
      assert.equal(await response.text(), events);
    }
    assert.deepEqual(incoming[0], first);
    assert.deepEqual(incoming[1], { ...first, input: second.input });
    const daily = await (await realFetch(`${base}/stats`)).json();
    const usage = daily[new Date().toISOString().slice(0, 10)]['compat-stream-test'];
    assert.equal(usage.http_responses, 2);
    assert.equal(usage.requests, 2);
    assert.equal(usage.input_tokens, 20);
    assert.equal(usage.output_tokens, 5);
  });
});

test('adapter registration can be replaced or disabled without touching raw routes', async (t) => {
  let incoming: unknown;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    incoming = JSON.parse(String(init.body));
    return Response.json({ output: [] });
  });
  const plugin: CompatibilityAdapter = {
    id: 'test-plugin', route: '/test/responses', upstreamPath: '/responses', requestFormat: 'openai',
    adaptRequest: (body) => ({ body: { ...body, plugin_marker: true }, changes: ['test-rule'] }),
  };
  await withServer(async (base) => {
    const options = {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'test', input: 'hi' }),
    };
    const response = await realFetch(`${base}/test/responses`, options);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-copilot-proxy-adapter'), 'test-plugin');
    assert.deepEqual(incoming, { model: 'test', input: 'hi', plugin_marker: true });
    assert.equal((await realFetch(`${base}/codex/v1/responses`, options)).status, 404);
  }, [plugin]);
  await withServer(async (base) => {
    const options = {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', input: 'hi', service_tier: 'priority' }),
    };
    assert.equal((await realFetch(`${base}/codex/v1/responses`, options)).status, 404);
    assert.equal((await realFetch(`${base}/v1/responses`, options)).status, 200);
    assert.deepEqual(incoming, { model: 'test', input: 'hi', service_tier: 'priority' });
  }, []);
});

test('adapted requests retain upstream errors, rate-limit headers and no-retry behavior', async (t) => {
  let calls = 0;
  const error = '{"error":{"message":"Please retry later","code":"rate_limited"}}';
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    calls++;
    assert.deepEqual(JSON.parse(String(init.body)), { model: 'compat-rate-test', input: 'hi' });
    return new Response(error, { status: 429, headers: {
      'content-type': 'application/json', 'retry-after': '5', 'x-ratelimit-remaining': '0',
    } });
  });
  await withServer(async (base) => {
    const response = await realFetch(`${base}/codex/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'compat-rate-test', input: 'hi', service_tier: 'priority' }),
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get('retry-after'), '5');
    assert.equal(response.headers.get('x-ratelimit-remaining'), '0');
    assert.equal(response.headers.get('x-copilot-proxy-adjustments'), 'remove-service-tier');
    assert.equal(await response.text(), error);
    assert.equal(calls, 1);
    const feedback = await (await realFetch(`${base}/rate-limits`)).json();
    assert.equal(feedback.models['compat-rate-test'].responses_429, 1);
  });
});

for (const format of ['anthropic', 'openai'] as const) {
  for (const stream of [false, true]) {
    test(`${format} native routes preserve ${stream ? 'SSE' : 'JSON'}, request normalization and usage`, async (t) => {
      const anthropic = format === 'anthropic';
      const modelId = `native-${format}-${stream}`;
      const messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
      const tools = [{ name: 'probe', input_schema: { type: 'object', properties: {} } }];
      const request = anthropic ? {
        model: 'native-alias', stream, max_tokens: 32, context_management: { edits: [] },
        messages: [{ role: 'user', content: [{ type: 'text', text: '' }, ...messages[0].content] }],
        tools: [{ ...tools[0], input_schema: { type: 'custom', properties: {} }, custom: { defer_loading: true } }],
      } : {
        model: 'native-alias', stream, messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'probe', parameters: { type: 'object', properties: {} } } }],
        temperature: 1, service_tier: 'priority',
      };
      const expected = anthropic
        ? { model: modelId, stream, max_tokens: 64, messages, tools }
        : { ...request, model: modelId, temperature: 0.25 };
      const usage = anthropic
        ? { input_tokens: 10, output_tokens: 3, cache_creation_input_tokens: 4, cache_read_input_tokens: 6 }
        : { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 6 }, completion_tokens_details: { reasoning_tokens: 1 } };
      const output = anthropic
        ? { type: 'message', content: [{ type: 'text', text: 'native \u2713' }], usage }
        : { choices: [{ message: { role: 'assistant', content: 'native \u2713' }, finish_reason: 'stop' }], usage };
      const events = anthropic ? [
        { type: 'message_start', message: { usage: { ...usage, output_tokens: 0 } } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'native \u2713' } },
        { type: 'message_delta', usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      ] : [
        { choices: [{ delta: { content: 'native \u2713' } }] },
        { choices: [], usage },
      ];
      const responseBody = stream
        ? events.map((event) => `data:${JSON.stringify(event)}\r\n\r\n`).join('') + (anthropic ? '' : 'data: [DONE]\r\n\r\n')
        : JSON.stringify(output, null, 2);
      let calls = 0;
      t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
        calls++;
        assert.equal(url, `https://copilot.example${anthropic ? '/v1/messages' : '/chat/completions'}`);
        assert.equal(init.method, 'POST');
        assert.deepEqual(JSON.parse(String(init.body)), expected);
        const headers = new Headers(init.headers);
        assert.equal(headers.get('authorization'), 'Bearer fake-test-token');
        assert.equal(headers.get('anthropic-version'), '2023-06-01');
        assert.equal(headers.get('anthropic-beta'), null);
        const responseHeaders = { 'x-request-id': 'native-test', 'x-ratelimit-remaining': '7' };
        return stream ? chunkedResponse(responseBody, responseHeaders)
          : new Response(responseBody, { headers: { 'content-type': 'application/json', ...responseHeaders } });
      });
      const config = getConfig();
      const oldModels = config.models;
      const oldOverrides = config.requestOverrides[format];
      config.models = { ...oldModels, 'native-alias': modelId };
      config.requestOverrides[format] = anthropic ? { max_tokens: 64 } : { temperature: 0.25 };
      try {
        await withServer(async (base) => {
          for (const route of anthropic ? ['/v1/messages', '/messages'] : ['/v1/chat/completions', '/chat/completions']) {
            const response = await realFetch(`${base}${route}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: 'Bearer client-placeholder', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'unsupported-test-beta' },
              body: JSON.stringify(request),
            });
            assert.equal(response.status, 200);
            assert.match(response.headers.get('content-type') ?? '', stream ? /text\/event-stream/ : /application\/json/);
            assert.equal(response.headers.get('x-request-id'), 'native-test');
            assert.equal(response.headers.get('x-ratelimit-remaining'), '7');
            assert.equal(response.headers.get('x-copilot-proxy-adapter'), null);
            assert.equal(await response.text(), responseBody);
          }
          assert.equal(calls, 2);
          const daily = await (await realFetch(`${base}/stats`)).json();
          assert.deepEqual(daily[new Date().toISOString().slice(0, 10)][modelId], {
            input_tokens: 20, output_tokens: 6, cache_creation_input_tokens: anthropic ? 8 : 0,
            cache_read_input_tokens: 12, reasoning_tokens: anthropic ? 0 : 2,
            requests: 2, http_responses: 2, http_error_responses: 0, rate_limited_responses: 0,
          });
        });
      } finally {
        config.models = oldModels;
        config.requestOverrides[format] = oldOverrides;
      }
    });
  }
}

for (const finalStatus of [200, 401]) {
  test(`adapted 401 retry uses the refreshed token and records only the final ${finalStatus}`, async (t) => {
    const incoming: Array<{ body: string; token: string | null }> = [];
    const responseBody = finalStatus === 200
      ? `data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 11, output_tokens: 2 } } })}\n\n`
      : '{"error":{"message":"Still unauthorized"}}';
    t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      assert.equal(url, 'https://copilot.example/responses');
      incoming.push({ body: String(init.body), token: new Headers(init.headers).get('authorization') });
      if (incoming.length === 1) {
        return Response.json({ error: 'expired token', usage: { input_tokens: 999, output_tokens: 999 } }, {
          status: 401, headers: { 'x-request-id': 'first-attempt', 'retry-after': '99' },
        });
      }
      assert.equal(incoming.length, 2, 'A second 401 must not cause a third attempt');
      return finalStatus === 200 ? chunkedResponse(responseBody, { 'x-request-id': 'final-attempt' })
        : new Response(responseBody, { status: finalStatus, headers: { 'content-type': 'application/json', 'x-request-id': 'final-attempt' } });
    });
    await withServer(async (base, auth) => {
      let refreshed = false;
      const refresh = t.mock.method(auth, 'forceRefresh', async () => { refreshed = true; });
      t.mock.method(auth, 'getCopilotToken', () => refreshed ? 'fake-refreshed-token' : 'fake-test-token');
      const modelId = `retry-${finalStatus}`;
      const request = { model: modelId, stream: true, input: 'hi' };
      const response = await realFetch(`${base}/codex/v1/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...request, service_tier: 'priority' }),
      });
      assert.equal(response.status, finalStatus);
      assert.equal(response.headers.get('x-request-id'), 'final-attempt');
      assert.equal(response.headers.get('retry-after'), null);
      assert.equal(response.headers.get('x-copilot-proxy-adjustments'), 'remove-service-tier');
      assert.equal(await response.text(), responseBody);
      assert.equal(refresh.mock.callCount(), 1);
      assert.deepEqual(incoming, [
        { body: JSON.stringify(request), token: 'Bearer fake-test-token' },
        { body: JSON.stringify(request), token: 'Bearer fake-refreshed-token' },
      ]);
      const daily = await (await realFetch(`${base}/stats`)).json();
      assert.deepEqual(daily[new Date().toISOString().slice(0, 10)][modelId], {
        input_tokens: finalStatus === 200 ? 11 : 0, output_tokens: finalStatus === 200 ? 2 : 0,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0, reasoning_tokens: 0,
        requests: finalStatus === 200 ? 1 : 0, http_responses: 1,
        http_error_responses: finalStatus === 200 ? 0 : 1, rate_limited_responses: 0,
      });
      const health = await realFetch(`${base}/health`);
      assert.equal(health.status, finalStatus === 200 ? 200 : 503);
      assert.equal((await health.json()).upstream.http_status, finalStatus);
    });
  });
}

test('missing or corrupt catalog templates fail before upstream access and recover after repair', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ data: [model('gpt-test')] });
  });
  const original = fs.readFileSync('codex-model-templates.json', 'utf-8');
  try {
    await withServer(async (base) => {
      for (const content of [null, '{invalid json', JSON.stringify({ version: '0.162.0', models: [] })]) {
        if (content === null) fs.unlinkSync('codex-model-templates.json');
        else fs.writeFileSync('codex-model-templates.json', content);
        const response = await realFetch(`${base}/codex/models`);
        assert.equal(response.status, 503);
        const body = await response.json();
        assert.deepEqual(Object.keys(body), ['error']);
        assert.equal(body.error.type, 'catalog_unavailable');
        assert(body.error.message.length > 0);
      }
      assert.equal(calls, 0);
      fs.writeFileSync('codex-model-templates.json', original);
      const repaired = await realFetch(`${base}/codex/models`);
      assert.equal(repaired.status, 200);
      assert.equal((await repaired.json()).models[0].slug, 'gpt-test');
      assert.equal(calls, 1);
    });
  } finally {
    fs.writeFileSync('codex-model-templates.json', original);
  }
});

test('invalid upstream metadata and oversized catalogs return explicit 503 errors', async (t) => {
  let payload = '';
  t.mock.method(globalThis, 'fetch', async () => new Response(payload, { headers: { 'content-type': 'application/json' } }));
  const original = fs.readFileSync('codex-model-templates.json', 'utf-8');
  try {
    await withServer(async (base) => {
      for (const value of ['{invalid json', '{}', '{"data":[{}]}']) {
        payload = value;
        const response = await realFetch(`${base}/codex/models`);
        assert.equal(response.status, 503);
        const body = await response.json();
        assert.deepEqual(Object.keys(body), ['error']);
        assert.equal(body.error.type, 'catalog_unavailable');
        assert(body.error.message.length > 0);
      }
      payload = JSON.stringify({ data: [model('no-template')] });
      fs.writeFileSync('codex-model-templates.json', JSON.stringify({
        ...templates, fallback_instructions: 'x'.repeat(1024 * 1024),
      }));
      const oversized = await realFetch(`${base}/codex/models`);
      assert.equal(oversized.status, 503);
      const body = await oversized.json();
      assert.deepEqual(Object.keys(body), ['error']);
      assert.equal(body.error.type, 'catalog_unavailable');
      assert.match(body.error.message, /1 MiB/);
    });
  } finally {
    fs.writeFileSync('codex-model-templates.json', original);
  }
});

test('catalog errors preserve upstream status, body and rate headers without retries or empty fallback', async (t) => {
  let calls = 0;
  let upstream: () => Response;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return upstream();
  });
  await withServer(async (base) => {
    for (const status of [401, 403, 429, 503]) {
      const text = JSON.stringify({ error: { message: `Upstream ${status}` } });
      upstream = () => new Response(text, { status, headers: {
        'content-type': 'application/json', 'retry-after': '7', 'x-ratelimit-remaining': '0',
      } });
      const before = calls;
      const response = await realFetch(`${base}/codex/models`);
      assert.equal(response.status, status);
      assert.match(response.headers.get('content-type') ?? '', /application\/json/);
      assert.equal(response.headers.get('retry-after'), '7');
      assert.equal(response.headers.get('x-ratelimit-remaining'), '0');
      assert.equal(await response.text(), text);
      assert.equal(calls, before + 1);
    }
    upstream = () => { throw new Error('Catalog network unavailable'); };
    const before = calls;
    const response = await realFetch(`${base}/codex/models`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: { type: 'catalog_unavailable', message: 'Catalog network unavailable' },
    });
    assert.equal(calls, before + 1);
  });
});

test('noninteractive authentication rejects missing, corrupt and expired caches without device flow', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('Unexpected authentication request', { status: 500 });
  });
  for (const [name, content] of [
    ['missing', null], ['corrupt', '{invalid json'],
    ['expired', JSON.stringify({ token: 'fake-expired-token', expires_at: 1 })],
  ] as const) {
    const directory = path.join(testDirectory, `headless-${name}`);
    fs.mkdirSync(directory);
    if (content !== null) fs.writeFileSync(path.join(directory, 'api-key.json'), content);
    const auth = new AuthManager(directory);
    try { assert.equal(await auth.ensureAuthenticated({ interactive: false }), false); }
    finally { auth.dispose(); }
  }
  assert.equal(calls, 0);
});

test('noninteractive authentication reuses a valid cached token without a network call', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async () => new Response('Unexpected request', { status: 500 }));
  const auth = new AuthManager(testDirectory);
  try {
    assert.equal(await auth.ensureAuthenticated({ interactive: false }), true);
    assert.equal(auth.getCopilotToken(), 'fake-test-token');
    assert.equal(request.mock.callCount(), 0);
  } finally { auth.dispose(); }
});

for (const status of [200, 401]) {
  test(`noninteractive expired-token refresh handles ${status} without starting device flow`, async (t) => {
    const directory = path.join(testDirectory, `headless-refresh-${status}`);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'access-token'), 'fake-access-token');
    fs.writeFileSync(path.join(directory, 'api-key.json'), JSON.stringify({ token: 'fake-expired-token', expires_at: 1 }));
    const urls: string[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string) => {
      urls.push(url);
      return status === 200 ? Response.json({
        token: 'fake-refreshed-token', expires_at: Math.floor(Date.now() / 1000) + 86400,
        endpoints: { api: 'https://copilot.example' },
      }) : new Response('Token rejected', { status });
    });
    const auth = new AuthManager(directory);
    try {
      assert.equal(await auth.ensureAuthenticated({ interactive: false }), status === 200);
      assert.deepEqual(urls, ['https://api.github.com/copilot_internal/v2/token']);
      if (status === 200) {
        assert.equal(auth.getCopilotToken(), 'fake-refreshed-token');
        assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'api-key.json'), 'utf-8')).token, 'fake-refreshed-token');
      }
    } finally { auth.dispose(); }
  });
}

test('default authentication still starts device flow when no credentials are cached', async (t) => {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    urls.push(url);
    return new Response('Synthetic device-flow rejection', { status: 400 });
  });
  const auth = new AuthManager(path.join(testDirectory, 'interactive-empty'));
  try {
    assert.equal(await auth.ensureAuthenticated(), false);
    assert.deepEqual(urls, ['https://github.com/login/device/code']);
  } finally { auth.dispose(); }
});
