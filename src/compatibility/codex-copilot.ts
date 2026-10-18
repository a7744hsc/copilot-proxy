import type { CompatibilityAdapter } from './types.js';

export const codexCopilotAdapter: CompatibilityAdapter = {
  id: 'codex-copilot',
  route: '/codex/v1/responses',
  upstreamPath: '/responses',
  requestFormat: 'openai',
  adaptRequest(body) {
    const adapted = { ...body };
    const changes: string[] = [];

    if (Object.hasOwn(adapted, 'service_tier')) {
      delete adapted.service_tier;
      changes.push('remove-service-tier');
    }

    return { body: adapted, changes };
  },
};
