import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from './logger.js';

interface ModelStats {
  input_tokens: number;
  output_tokens: number;
  requests: number;
}

export interface Usage {
  input: number;
  output: number;
}

type DailyStats = Record<string, Record<string, ModelStats>>;

const statsFile = path.join(process.cwd(), 'stats.json');
let stats: DailyStats = {};

export function loadStats(): void {
  if (!fs.existsSync(statsFile)) return;
  try {
    stats = JSON.parse(fs.readFileSync(statsFile, 'utf-8'));
  } catch {
    stats = {};
  }
}

function saveStats(): void {
  try {
    fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2));
  } catch (e: any) {
    logger.error(`Failed to save stats: ${e.message}`);
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function recordUsage(model: string, usage: Usage): void {
  const day = today();
  if (!stats[day]) stats[day] = {};
  if (!stats[day][model]) stats[day][model] = { input_tokens: 0, output_tokens: 0, requests: 0 };

  stats[day][model].input_tokens += usage.input;
  stats[day][model].output_tokens += usage.output;
  stats[day][model].requests += 1;

  saveStats();
}

export function formatUsage(usage: Usage): string {
  return `in=${usage.input} out=${usage.output}`;
}

export function getStats(): DailyStats {
  return stats;
}

function sumAnthropicInput(usage: any): number {
  return (usage.input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
}

export function extractUsageFromResponse(body: string): Usage | null {
  try {
    const json = JSON.parse(body);
    // Anthropic format
    if (json.usage?.input_tokens != null) {
      return { input: sumAnthropicInput(json.usage), output: json.usage.output_tokens || 0 };
    }
    // OpenAI format
    if (json.usage?.prompt_tokens != null) {
      return { input: json.usage.prompt_tokens, output: json.usage.completion_tokens || 0 };
    }
  } catch { /* ignore parse errors */ }
  return null;
}

export function extractUsageFromStream(chunks: string): Usage | null {
  let input = 0;
  let output = 0;
  let found = false;

  for (const line of chunks.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') continue;

    try {
      const json = JSON.parse(data);

      // Anthropic: message_start has input_tokens
      if (json.type === 'message_start' && json.message?.usage != null) {
        input = sumAnthropicInput(json.message.usage);
        found = true;
      }
      // Anthropic: message_delta has output_tokens
      if (json.type === 'message_delta' && json.usage?.output_tokens != null) {
        output = json.usage.output_tokens;
        found = true;
      }
      // OpenAI: last chunk may have usage
      if (json.usage?.prompt_tokens != null) {
        input = json.usage.prompt_tokens;
        output = json.usage.completion_tokens || 0;
        found = true;
      }
    } catch { /* ignore individual parse errors */ }
  }

  return found ? { input, output } : null;
}
