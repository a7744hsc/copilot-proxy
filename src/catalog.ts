import * as fs from 'node:fs';
import * as path from 'node:path';
import { asRecord, tokenCount } from './data.js';

const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export interface CodexTemplates {
  version: string;
  models: Record<string, unknown>[];
  fallback_instructions: string;
}

export function parseCodexTemplates(value: unknown): CodexTemplates {
  const data = asRecord(value);
  if (!data || typeof data.version !== 'string' || !Array.isArray(data.models)
    || typeof data.fallback_instructions !== 'string' || !data.fallback_instructions.trim()) {
    throw new Error('Invalid Codex templates. Run npm run sync:codex -- <codex-version>.');
  }
  const models = data.models.map((value) => {
    const model = asRecord(value);
    const messages = asRecord(model?.model_messages);
    if (!model || typeof model.slug !== 'string'
      || typeof messages?.instructions_template !== 'string' || !messages.instructions_template.trim()) {
      throw new Error('Codex template is missing its model ID or original instructions.');
    }
    return model;
  });
  return { version: data.version, models, fallback_instructions: data.fallback_instructions };
}

export function loadCodexTemplates(): CodexTemplates {
  const filename = path.join(process.cwd(), 'codex-model-templates.json');
  if (!fs.existsSync(filename)) {
    throw new Error('Codex templates are not installed. Run npm run sync:codex -- <codex-version>.');
  }
  return parseCodexTemplates(JSON.parse(fs.readFileSync(filename, 'utf-8')));
}

export function buildCodexCatalog(value: unknown, templates: CodexTemplates) {
  const data = asRecord(value);
  if (!Array.isArray(data?.data)) throw new Error('Copilot returned an invalid model list.');

  const models: Record<string, unknown>[] = [];
  const excluded: { id: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const value of data.data) {
    const model = asRecord(value);
    if (!model || typeof model.id !== 'string' || !model.id) {
      throw new Error('Copilot model is missing its ID.');
    }
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    const capabilities = asRecord(model.capabilities);
    const supports = asRecord(capabilities?.supports);
    const limits = asRecord(capabilities?.limits);
    const promptLimit = tokenCount(limits?.max_prompt_tokens) ?? 0;
    const contextLimit = tokenCount(limits?.max_context_window_tokens);
    let reason: string | undefined;
    if (!Array.isArray(model.supported_endpoints) || !model.supported_endpoints.includes('/responses')) {
      reason = 'No advertised HTTP Responses endpoint';
    } else if (asRecord(model.policy)?.state === 'disabled') {
      reason = 'Disabled by Copilot policy';
    } else if (supports?.tool_calls !== true || supports.streaming !== true) {
      reason = 'Streaming tool calls are not advertised';
    } else if (!promptLimit) {
      reason = 'No advertised prompt token limit';
    }
    if (reason) {
      excluded.push({ id: model.id, reason });
      continue;
    }

    const template = templates.models.find((entry) => entry.slug === model.id)
      ?? templates.models.find((entry) => entry.slug === capabilities?.family)
      ?? {
        shell_type: 'unified_exec',
        model_messages: { instructions_template: templates.fallback_instructions },
        support_verbosity: false,
        supports_reasoning_summary_parameter: false,
        default_reasoning_summary: 'none',
        apply_patch_tool_type: null,
        truncation_policy: { mode: 'bytes', limit: 10000 },
        experimental_supported_tools: [],
        include_apps_usage_instructions: false,
      };
    const efforts = Array.isArray(supports?.reasoning_effort)
      ? [...new Set(supports.reasoning_effort.filter(
        (effort): effort is string => typeof effort === 'string' && REASONING_EFFORTS.has(effort),
      ))]
      : [];
    const preferred = template.default_reasoning_level;
    const defaultEffort = typeof preferred === 'string' && efforts.includes(preferred)
      ? preferred
      : efforts.includes('medium') ? 'medium' : efforts[0] ?? null;
    // Copilot's prompt limit can be lower than its total context window.
    const contextWindow = Math.min(promptLimit, contextLimit || promptLimit);
    const entry: Record<string, unknown> = {
      ...template,
      slug: model.id,
      display_name: typeof model.name === 'string' ? model.name : model.id,
      description: typeof model.name === 'string' ? model.name : model.id,
      visibility: 'list',
      supported_in_api: true,
      priority: models.length,
      supported_reasoning_levels: efforts.map((effort) => ({ effort, description: `${effort} reasoning effort` })),
      default_reasoning_level: defaultEffort,
      context_window: contextWindow,
      max_context_window: contextWindow,
      auto_compact_token_limit: null,
      input_modalities: supports?.vision === true ? ['text', 'image'] : ['text'],
      additional_speed_tiers: [],
      service_tiers: [],
      default_service_tier: null,
      upgrade: null,
      availability_nux: null,
      available_access_programs: null,
      prefer_websockets: false,
    };
    // The canonical template is enough; duplicating it exceeds Codex's 1 MiB catalog limit.
    delete entry.base_instructions;
    models.push(entry);
  }
  const catalog = { models };
  if (Buffer.byteLength(JSON.stringify(catalog), 'utf-8') > 1024 * 1024) {
    throw new Error('Codex model catalog exceeds the 1 MiB remote catalog limit.');
  }
  return { catalog, excluded };
}
