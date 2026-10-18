import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexCopilotAdapter } from '../src/compatibility/codex-copilot.js';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const request = deepFreeze({
  model: 'gpt-6-astra',
  stream: true,
  store: false,
  input: [
    {
      type: 'message', role: 'user',
      content: [
        { type: 'input_text', text: 'Keep service_tier in this text.' },
        { type: 'input_image', image_url: 'data:image/png;base64,fixture', detail: 'original' },
      ],
      internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
    },
    { type: 'message', role: 'assistant', phase: 'commentary', content: [] },
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [] },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'shell', arguments: '{"command":"echo OK"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'OK' },
    { type: 'custom_tool_call', call_id: 'call_2', name: 'apply_patch', input: 'patch contents' },
    { type: 'custom_tool_call_output', call_id: 'call_2', output: 'done' },
  ],
  tools: [
    {
      type: 'function', name: 'shell', strict: true,
      parameters: { type: 'object', properties: { service_tier: { type: 'string' } } },
    },
    { type: 'custom', name: 'apply_patch', format: { type: 'grammar', syntax: 'lark', definition: 'fixture' } },
  ],
  tool_choice: 'auto',
  parallel_tool_calls: true,
  reasoning: { effort: 'max', summary: 'auto' },
  include: ['reasoning.encrypted_content'],
  text: { format: { type: 'json_schema', name: 'result', schema: { type: 'object' } } },
  prompt_cache_key: 'thread-1',
  client_metadata: { source: 'test' },
  future_field: { keep: true },
});

test('Codex adapter removes only the top-level service tier without mutating input', () => {
  for (const service_tier of ['priority', 'default', 'auto', 'flex', null]) {
    const original = deepFreeze({ ...request, service_tier });
    const result = codexCopilotAdapter.adaptRequest(original);
    assert.deepEqual(result.body, request);
    assert.deepEqual(result.changes, ['remove-service-tier']);
    assert.equal(original.service_tier, service_tier);
    assert.equal(Object.hasOwn(result.body, 'service_tier'), false);
  }
});

test('compatible requests and future fields remain intact and repeated adaptation is idempotent', () => {
  const result = codexCopilotAdapter.adaptRequest(request);
  assert.deepEqual(result.body, request);
  assert.notEqual(result.body, request);
  assert.deepEqual(result.changes, []);
  const again = codexCopilotAdapter.adaptRequest(result.body);
  assert.deepEqual(again, result);
});

test('adapter does not repair malformed or unknown input by silently discarding it', () => {
  for (const input of ['plain prompt', null, 12, { unexpected: true }, [null, 'invalid item']]) {
    const original = deepFreeze({ model: 'test', input, tools: [{ type: 'future-tool' }], previous_response_id: 'r1' });
    assert.deepEqual(codexCopilotAdapter.adaptRequest(original), { body: original, changes: [] });
  }
});
