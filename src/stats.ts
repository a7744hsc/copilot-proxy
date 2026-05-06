import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from './logger.js';

interface ModelStats {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  requests: number;
}

export interface Usage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  thinking_chars?: number;
  thinking_blocks?: number;
}

type DailyStats = Record<string, Record<string, ModelStats>>;

const statsFile = path.join(process.cwd(), 'stats.json');
let stats: DailyStats = {};

const EMPTY_STATS: ModelStats = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
  requests: 0,
};

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
  if (!stats[day][model]) stats[day][model] = { ...EMPTY_STATS };

  stats[day][model].input_tokens += usage.input_tokens;
  stats[day][model].cache_creation_input_tokens += usage.cache_creation_input_tokens;
  stats[day][model].cache_read_input_tokens += usage.cache_read_input_tokens;
  stats[day][model].output_tokens += usage.output_tokens;
  stats[day][model].requests += 1;

  saveStats();
}

export function formatUsage(usage: Usage): string {
  const parts = [`in=${usage.input_tokens}`, `out=${usage.output_tokens}`];
  if (usage.cache_read_input_tokens > 0) parts.push(`cache_read=${usage.cache_read_input_tokens}`);
  if (usage.cache_creation_input_tokens > 0) parts.push(`cache_create=${usage.cache_creation_input_tokens}`);
  if (usage.thinking_blocks && usage.thinking_blocks > 0) {
    const chars = usage.thinking_chars || 0;
    parts.push(chars > 0 ? `thinking=${chars}` : 'thinking=hidden');
  }
  return parts.join(' ');
}

export function getStats(): DailyStats {
  return stats;
}

function extractAnthropicUsage(usage: any): Usage {
  return {
    input_tokens: usage.input_tokens || 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
    cache_read_input_tokens: usage.cache_read_input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
  };
}

export function extractUsageFromResponse(body: string): Usage | null {
  try {
    const json = JSON.parse(body);
    // Anthropic format
    if (json.usage?.input_tokens != null) {
      const usage = extractAnthropicUsage(json.usage);
      if (Array.isArray(json.content)) {
        let thinkChars = 0;
        let thinkBlocks = 0;
        for (const block of json.content) {
          if (block?.type === 'thinking') {
            thinkBlocks += 1;
            if (typeof block.thinking === 'string') {
              thinkChars += block.thinking.length;
            }
          }
        }
        if (thinkBlocks > 0) usage.thinking_blocks = thinkBlocks;
        if (thinkChars > 0) usage.thinking_chars = thinkChars;
      }
      return usage;
    }
    // OpenAI format
    if (json.usage?.prompt_tokens != null) {
      return {
        input_tokens: json.usage.prompt_tokens || 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: json.usage.completion_tokens || 0,
      };
    }
  } catch { /* ignore parse errors */ }
  return null;
}

export function extractUsageFromStream(chunks: string): Usage | null {
  const usage: Usage = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
  let found = false;
  let thinkChars = 0;
  let thinkBlocks = 0;

  for (const line of chunks.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') continue;

    try {
      const json = JSON.parse(data);

      // Anthropic: message_start has input usage
      if (json.type === 'message_start' && json.message?.usage != null) {
        const u = extractAnthropicUsage(json.message.usage);
        usage.input_tokens = u.input_tokens;
        usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
        usage.cache_read_input_tokens = u.cache_read_input_tokens;
        found = true;
      }
      // Anthropic: message_delta has output_tokens
      if (json.type === 'message_delta' && json.usage?.output_tokens != null) {
        usage.output_tokens = json.usage.output_tokens;
        found = true;
      }
      // Anthropic: count thinking content blocks
      if (json.type === 'content_block_start' && json.content_block?.type === 'thinking') {
        thinkBlocks += 1;
      }
      // Anthropic: thinking_delta carries the streamed thinking text
      if (json.type === 'content_block_delta' && json.delta?.type === 'thinking_delta' && typeof json.delta.thinking === 'string') {
        thinkChars += json.delta.thinking.length;
      }
      // OpenAI: last chunk may have usage
      if (json.usage?.prompt_tokens != null) {
        usage.input_tokens = json.usage.prompt_tokens || 0;
        usage.output_tokens = json.usage.completion_tokens || 0;
        found = true;
      }
      // Responses API: response.completed event has response.usage
      if (json.type === 'response.completed' && json.response?.usage != null) {
        usage.input_tokens = json.response.usage.input_tokens || 0;
        usage.output_tokens = json.response.usage.output_tokens || 0;
        found = true;
      }
    } catch { /* ignore individual parse errors */ }
  }

  if (thinkBlocks > 0) usage.thinking_blocks = thinkBlocks;
  if (thinkChars > 0) usage.thinking_chars = thinkChars;
  return found ? usage : null;
}
