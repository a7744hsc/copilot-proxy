// Usage: npx tsx scripts/fetch-models.ts

import * as fs from 'node:fs';
import * as path from 'node:path';

const TOKEN_DIR = path.join(process.cwd(), '.tokens');
const OUTPUT_FILE = path.join(process.cwd(), 'models.json');

function loadToken(): { token: string; apiBase: string } {
  const apiKeyPath = path.join(TOKEN_DIR, 'api-key.json');
  const data = JSON.parse(fs.readFileSync(apiKeyPath, 'utf-8'));
  return {
    token: data.token,
    apiBase: data.endpoints?.api || 'https://api.githubcopilot.com',
  };
}

async function main() {
  const { token, apiBase } = loadToken();

  const res = await fetch(`${apiBase}/models`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'editor-version': 'vscode/1.103.1',
      'Copilot-Integration-Id': 'vscode-chat',
    },
  });

  if (!res.ok) {
    console.error(`Failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }

  const data = (await res.json()) as any;
  const models = (data.data || []).sort((a: any, b: any) => a.id.localeCompare(b.id));

  const output = {
    fetched_at: new Date().toISOString(),
    count: models.length,
    models,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  console.log(`Saved ${models.length} models to ${OUTPUT_FILE}`);
  console.log('');

  const byVendor: Record<string, any[]> = {};
  for (const m of models) {
    const v = m.vendor || 'Unknown';
    if (!byVendor[v]) byVendor[v] = [];
    byVendor[v].push(m);
  }

  for (const [vendor, list] of Object.entries(byVendor).sort()) {
    console.log(`${vendor} (${list.length}):`);
    for (const m of list) {
      const ctx = m.capabilities?.limits?.max_context_window_tokens;
      const out = m.capabilities?.limits?.max_output_tokens;
      const effort = m.capabilities?.supports?.reasoning_effort;
      const endpoints = (m.supported_endpoints || []).join(', ');
      const parts = [m.id];
      if (ctx) parts.push(`ctx=${ctx >= 1000000 ? (ctx / 1000000) + 'M' : (ctx / 1000) + 'K'}`);
      if (out) parts.push(`out=${out >= 1000 ? (out / 1000) + 'K' : out}`);
      if (effort) parts.push(`effort=[${effort.join(',')}]`);
      if (endpoints) parts.push(`[${endpoints}]`);
      console.log(`  ${parts.join('  ')}`);
    }
    console.log('');
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
