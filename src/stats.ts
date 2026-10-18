import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from './logger.js';
import { asRecord, tokenCount } from './data.js';

interface ModelStats {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  requests: number;
  reasoning_tokens: number;
  http_responses: number;
  http_error_responses: number;
  rate_limited_responses: number;
}

export interface Usage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  reasoning_tokens?: number;
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
  reasoning_tokens: 0,
  http_responses: 0,
  http_error_responses: 0,
  rate_limited_responses: 0,
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
  const entry = currentModelStats(model);
  entry.input_tokens += usage.input_tokens;
  entry.cache_creation_input_tokens += usage.cache_creation_input_tokens;
  entry.cache_read_input_tokens += usage.cache_read_input_tokens;
  entry.output_tokens += usage.output_tokens;
  entry.reasoning_tokens += usage.reasoning_tokens ?? 0;
  entry.requests += 1;

  saveStats();
}

function currentModelStats(model: string): ModelStats {
  const day = today();
  if (!stats[day]) stats[day] = {};
  stats[day][model] = { ...EMPTY_STATS, ...stats[day][model] };
  return stats[day][model];
}

export function recordHttpResponse(model: string, status: number): void {
  const entry = currentModelStats(model);
  entry.http_responses += 1;
  if (status >= 400) entry.http_error_responses += 1;
  if (status === 429) entry.rate_limited_responses += 1;
  saveStats();
}

export function formatUsage(usage: Usage): string {
  const parts = [`in=${usage.input_tokens}`, `out=${usage.output_tokens}`];
  if (usage.cache_read_input_tokens > 0) parts.push(`cache_read=${usage.cache_read_input_tokens}`);
  if (usage.cache_creation_input_tokens > 0) parts.push(`cache_create=${usage.cache_creation_input_tokens}`);
  if (usage.reasoning_tokens) parts.push(`reasoning=${usage.reasoning_tokens}`);
  if (usage.thinking_blocks && usage.thinking_blocks > 0) {
    const chars = usage.thinking_chars || 0;
    parts.push(chars > 0 ? `thinking=${chars}` : 'thinking=hidden');
  }
  return parts.join(' ');
}

export function getStats(): DailyStats {
  return Object.fromEntries(Object.entries(stats).map(([day, models]) => [
    day,
    Object.fromEntries(Object.entries(models).map(([model, entry]) => [model, { ...EMPTY_STATS, ...entry }])),
  ]));
}

function extractTokenUsage(value: unknown): Usage | null {
  const usage = asRecord(value);
  if (!usage) return null;
  const input = tokenCount(usage.input_tokens) ?? tokenCount(usage.prompt_tokens);
  if (input === undefined) return null;
  const inputDetails = asRecord(usage.input_tokens_details) ?? asRecord(usage.prompt_tokens_details);
  const outputDetails = asRecord(usage.output_tokens_details) ?? asRecord(usage.completion_tokens_details);
  return {
    input_tokens: input,
    cache_creation_input_tokens: tokenCount(usage.cache_creation_input_tokens)
      ?? tokenCount(usage.cache_write_input_tokens)
      ?? tokenCount(inputDetails?.cache_write_tokens) ?? 0,
    cache_read_input_tokens: tokenCount(usage.cache_read_input_tokens)
      ?? tokenCount(inputDetails?.cached_tokens) ?? 0,
    output_tokens: tokenCount(usage.output_tokens) ?? tokenCount(usage.completion_tokens) ?? 0,
    reasoning_tokens: tokenCount(outputDetails?.reasoning_tokens) ?? 0,
  };
}

export function extractUsageFromResponse(body: string): Usage | null {
  try {
    const json = asRecord(JSON.parse(body));
    if (!json) return null;
    const usage = extractTokenUsage(json.usage);
    if (usage) {
      if (Array.isArray(json.content)) {
        let thinkChars = 0;
        let thinkBlocks = 0;
        for (const value of json.content) {
          const block = asRecord(value);
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
  } catch { /* ignore parse errors */ }
  return null;
}

export function extractUsageFromStream(chunks: string): Usage | null {
  const acc = new StreamUsageAccumulator();
  acc.addChunk(chunks);
  acc.flush();
  return acc.getUsage();
}

export class StreamUsageAccumulator {
  private buffer = '';
  private usage: Usage = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
  private found = false;
  private thinkChars = 0;
  private thinkBlocks = 0;

  addChunk(chunk: string): void {
    this.buffer += chunk;
    let separator: RegExpExecArray | null;
    while ((separator = /\r?\n\r?\n/.exec(this.buffer)) !== null) {
      const block = this.buffer.slice(0, separator.index);
      this.buffer = this.buffer.slice(separator.index + separator[0].length);
      this.processBlock(block);
    }
  }

  // Process whatever is left in the buffer (in case the stream ended without a trailing blank line)
  flush(): void {
    if (this.buffer.length > 0) {
      this.processBlock(this.buffer);
      this.buffer = '';
    }
  }

  getUsage(): Usage | null {
    if (this.thinkBlocks > 0) this.usage.thinking_blocks = this.thinkBlocks;
    if (this.thinkChars > 0) this.usage.thinking_chars = this.thinkChars;
    return this.found ? this.usage : null;
  }

  private processBlock(block: string): void {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart()).join('\n').trim();
    if (!data || data === '[DONE]') return;
    let json: Record<string, unknown> | undefined;
    try {
      json = asRecord(JSON.parse(data));
    } catch {
      return;
    }
    if (!json) return;

    // Anthropic: message_start has input usage; message_delta has output usage.
    const messageUsage = extractTokenUsage(asRecord(json.message)?.usage);
    if (json.type === 'message_start' && messageUsage) {
      this.usage = { ...messageUsage };
      this.found = true;
    }
    const outputTokens = tokenCount(asRecord(json.usage)?.output_tokens);
    if (json.type === 'message_delta' && outputTokens !== undefined) {
      this.usage.output_tokens = outputTokens;
      this.found = true;
    }
    if (json.type === 'content_block_start' && asRecord(json.content_block)?.type === 'thinking') {
      this.thinkBlocks += 1;
    }
    const delta = asRecord(json.delta);
    if (json.type === 'content_block_delta' && delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      this.thinkChars += delta.thinking.length;
    }
    const openAIUsage = extractTokenUsage(json.usage);
    if (json.type !== 'message_delta' && openAIUsage) {
      this.usage = openAIUsage;
      this.found = true;
    }
    const responseUsage = extractTokenUsage(asRecord(json.response)?.usage);
    if (['response.completed', 'response.incomplete', 'response.failed'].includes(String(json.type)) && responseUsage) {
      this.usage = responseUsage;
      this.found = true;
    }
  }
}
