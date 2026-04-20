import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from './logger.js';

export interface ProxyConfig {
  /** Exact model name mappings: input → copilot model */
  models: Record<string, string>;
  /** Regex-based patterns, evaluated in order. First match wins. */
  modelPatterns: Array<{ match: string; replace: string }>;
  /** Fields merged into every Anthropic request body */
  requestOverrides: {
    anthropic: Record<string, unknown>;
    openai: Record<string, unknown>;
  };
  /** Extra headers merged into every Copilot API call */
  headerOverrides: Record<string, string>;
}

const DEFAULT_CONFIG: ProxyConfig = {
  models: {},
  modelPatterns: [],
  requestOverrides: { anthropic: {}, openai: {} },
  headerOverrides: {
    'editor-version': 'vscode/1.103.1',
    'Copilot-Integration-Id': 'vscode-chat',
  },
};

let _config: ProxyConfig | null = null;

export function loadConfig(configPath?: string): ProxyConfig {
  const filePath = configPath || path.join(process.cwd(), 'config.json');

  if (!fs.existsSync(filePath)) {
    logger.warn(`Config file not found: ${filePath}, using defaults`);
    _config = { ...DEFAULT_CONFIG };
    return _config;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    _config = {
      models: raw.models || {},
      modelPatterns: (raw.modelPatterns || []).map((p: any) => ({
        match: p.match,
        replace: p.replace,
      })),
      requestOverrides: {
        anthropic: raw.requestOverrides?.anthropic || {},
        openai: raw.requestOverrides?.openai || {},
      },
      headerOverrides: {
        ...DEFAULT_CONFIG.headerOverrides,
        ...(raw.headerOverrides || {}),
      },
    };
    logger.info(`Config loaded: ${Object.keys(_config.models).length} model aliases, ${_config.modelPatterns.length} patterns, ${Object.keys(_config.headerOverrides).length} header overrides`);
    return _config;
  } catch (e: any) {
    logger.error(`Failed to load config: ${e.message}`);
    _config = { ...DEFAULT_CONFIG };
    return _config;
  }
}

export function getConfig(): ProxyConfig {
  if (!_config) return loadConfig();
  return _config;
}

/**
 * Resolve model name using config:
 * 1. Exact match in models map
 * 2. First matching regex pattern
 * 3. Pass through unchanged
 */
export function resolveModel(model: string): string {
  const config = getConfig();

  // 1. Exact match
  if (config.models[model]) {
    return config.models[model];
  }

  // 2. Pattern match (first wins)
  for (const pattern of config.modelPatterns) {
    const regex = new RegExp(pattern.match);
    if (regex.test(model)) {
      return pattern.replace;
    }
  }

  // 3. Pass through
  return model;
}

/**
 * Apply request overrides from config.
 * Config fields are merged into the request body (request fields take precedence
 * unless explicitly overridden in config).
 */
export function applyRequestOverrides(body: Record<string, unknown>, type: 'anthropic' | 'openai'): Record<string, unknown> {
  const overrides = getConfig().requestOverrides[type];
  if (!overrides || Object.keys(overrides).length === 0) return body;
  return { ...body, ...overrides };
}

/**
 * Get header overrides from config, merged with defaults.
 */
export function getHeaderOverrides(): Record<string, string> {
  return getConfig().headerOverrides;
}
