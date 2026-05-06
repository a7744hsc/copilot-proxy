// Usage: npx tsx scripts/test-thinking.ts
//   Probes upstream Copilot Anthropic API with different thinking configs
//   to see when thinking content is actually returned.

import * as fs from 'node:fs';
import * as path from 'node:path';

const TOKEN_DIR = path.join(process.cwd(), '.tokens');

const PROMPT = `Solve this step by step, considering multiple approaches before committing:

Find the smallest positive integer N (N > 1) such that:
1. N has exactly 6 distinct positive divisors
2. The sum of those divisors equals 2*N + 1
3. N is NOT divisible by any prime less than 5

Show every step of your reasoning, including dead ends and how you eliminated them. Then verify your answer.`;

interface TestCase {
  label: string;
  model: string;
  thinking?: any;
  output_config?: any;
  max_tokens?: number;
}

const TESTS: TestCase[] = [
  { label: '4.6-1m + thinking=enabled(2k)',     model: 'claude-opus-4.6-1m',          thinking: { type: 'enabled', budget_tokens: 2000 }, max_tokens: 8000 },
  { label: '4.7-1m + adaptive + effort=high',   model: 'claude-opus-4.7-1m-internal', thinking: { type: 'adaptive' }, output_config: { effort: 'high' },  max_tokens: 8000 },
  { label: '4.7-1m + adaptive + effort=xhigh',  model: 'claude-opus-4.7-1m-internal', thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' }, max_tokens: 8000 },
  { label: '4.7-1m + thinking=disabled',        model: 'claude-opus-4.7-1m-internal', thinking: { type: 'disabled' }, max_tokens: 8000 },
];

function loadToken(): { token: string; apiBase: string } {
  const apiKeyPath = path.join(TOKEN_DIR, 'api-key.json');
  const data = JSON.parse(fs.readFileSync(apiKeyPath, 'utf-8'));
  return {
    token: data.token,
    apiBase: data.endpoints?.api || 'https://api.githubcopilot.com',
  };
}

async function runTest(t: TestCase, token: string, apiBase: string) {
  const body: any = {
    model: t.model,
    max_tokens: t.max_tokens ?? 4000,
    messages: [{ role: 'user', content: PROMPT }],
  };
  if (t.thinking) body.thinking = t.thinking;
  if (t.output_config) body.output_config = t.output_config;

  const start = Date.now();
  let res: globalThis.Response;
  try {
    res = await fetch(`${apiBase}/v1/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'editor-version': 'vscode/1.103.1',
        'Copilot-Integration-Id': 'vscode-chat',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e: any) {
    console.log(`  ❌ network error: ${e.message}`);
    return;
  }

  const text = await res.text();
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (!res.ok) {
    console.log(`  status=${res.status}  ${elapsed}s`);
    console.log(`  error: ${text.slice(0, 400)}`);
    return;
  }

  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    console.log(`  ⚠ non-JSON response: ${text.slice(0, 200)}`);
    return;
  }

  const blocks = Array.isArray(data.content) ? data.content : [];
  const thinkingBlocks = blocks.filter((b: any) => b.type === 'thinking');
  const textBlocks = blocks.filter((b: any) => b.type === 'text');
  const thinkChars = thinkingBlocks.reduce((s: number, b: any) => s + (b.thinking?.length || 0), 0);
  const textChars = textBlocks.reduce((s: number, b: any) => s + (b.text?.length || 0), 0);
  const blockTypes = blocks.map((b: any) => b.type).join(',');

  const u = data.usage || {};
  const tokenInfo = `in=${u.input_tokens || 0} out=${u.output_tokens || 0}`;

  console.log(`  status=${res.status}  ${elapsed}s  ${tokenInfo}`);
  console.log(`  usage: ${JSON.stringify(u)}`);
  console.log(`  blocks=[${blockTypes}]  think_chars=${thinkChars}  text_chars=${textChars}`);
  if (thinkChars > 0) {
    const preview = thinkingBlocks[0].thinking.replace(/\n/g, ' ').slice(0, 120);
    console.log(`  thinking preview: ${preview}...`);
  }
  if (textChars > 0) {
    const preview = textBlocks[0].text.replace(/\n/g, ' ').slice(0, 120);
    console.log(`  text preview:     ${preview}...`);
  }
}

async function main() {
  const { token, apiBase } = loadToken();
  console.log(`API base: ${apiBase}\n`);

  for (const t of TESTS) {
    console.log(`▶ ${t.label}`);
    await runTest(t, token, apiBase);
    console.log('');
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
