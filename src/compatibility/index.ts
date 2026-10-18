import { codexCopilotAdapter } from './codex-copilot.js';
import type { CompatibilityAdapter } from './types.js';

export type { AdaptedRequest, CompatibilityAdapter } from './types.js';

export const defaultAdapters: readonly CompatibilityAdapter[] = [codexCopilotAdapter];
