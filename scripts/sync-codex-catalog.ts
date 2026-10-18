import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { asRecord } from '../src/data.js';
import { parseCodexTemplates } from '../src/catalog.js';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) {
  throw new Error('Usage: npm run sync:codex -- <version from codex --version>');
}

function download(filename: string): string {
  return execFileSync('gh', [
    'api',
    `repos/openai/codex/contents/${filename}?ref=rust-v${version}`,
    '-H', 'Accept: application/vnd.github.raw+json',
  ], { encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024 });
}

const catalog = asRecord(JSON.parse(download('codex-rs/models-manager/models.json')));
const templates = parseCodexTemplates({
  version,
  models: catalog?.models,
  fallback_instructions: download('codex-rs/models-manager/prompt.md'),
});
const filename = 'codex-model-templates.json';
fs.writeFileSync(filename, JSON.stringify({
  source: `https://github.com/openai/codex/tree/rust-v${version}`,
  license: 'Apache-2.0',
  ...templates,
}, null, 2), 'utf-8');
console.log(`Saved Codex ${version} templates to ${filename}; model capabilities will come from Copilot.`);
