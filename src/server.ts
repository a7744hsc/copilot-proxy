import express from 'express';
import { AuthManager } from './auth.js';
import { resolveModel, applyRequestOverrides, getHeaderOverrides } from './config.js';
import { logger } from './logger.js';
import { recordUsage, getStats, extractUsageFromResponse, extractUsageFromStream } from './stats.js';

const STREAMING_TIMEOUT = 600_000;  // 10 min
const NON_STREAMING_TIMEOUT = 300_000;  // 5 min

const ALLOWED_TOOL_KEYS = new Set(['name', 'description', 'input_schema', 'cache_control', 'type']);

function sanitizeTools(tools: any[] | undefined): void {
  if (!Array.isArray(tools)) return;
  for (const tool of tools) {
    if (typeof tool !== 'object' || tool === null) continue;
    // Strip non-standard top-level keys (e.g. "custom" with defer_loading)
    for (const key of Object.keys(tool)) {
      if (!ALLOWED_TOOL_KEYS.has(key)) {
        delete tool[key];
      }
    }
    // Fix input_schema type: "custom" → "object"
    if (tool.input_schema?.type === 'custom') {
      tool.input_schema.type = 'object';
    }
  }
}

function stripEmptyTextBlocks(body: any): void {
  if (!Array.isArray(body?.messages)) return;
  for (const message of body.messages) {
    if (!Array.isArray(message?.content)) continue;
    message.content = message.content.filter(
      (block: any) => !(block?.type === 'text' && typeof block.text === 'string' && block.text.length === 0),
    );
    if (message.content.length === 0) {
      message.content = [{ type: 'text', text: ' ' }];
    }
  }
}

function buildCopilotHeaders(auth: AuthManager, req: express.Request): Record<string, string> {
  const token = auth.getCopilotToken();
  if (!token) throw new Error('No Copilot token available');

  const overrides = getHeaderOverrides();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...overrides,
  };

  // Forward anthropic-version only (Copilot rejects unsupported beta headers)
  const anthropicVersion = req.headers['anthropic-version'];
  if (typeof anthropicVersion === 'string') {
    headers['anthropic-version'] = anthropicVersion;
  } else {
    headers['anthropic-version'] = '2023-06-01';
  }

  return headers;
}

async function forwardRequest(
  auth: AuthManager,
  targetPath: string,
  body: any,
  headers: Record<string, string>,
  isStreaming: boolean,
  res: express.Response,
  model: string,
): Promise<void> {
  const apiBase = auth.getCopilotApiBase();
  const url = `${apiBase}${targetPath}`;
  const timeout = isStreaming ? STREAMING_TIMEOUT : NON_STREAMING_TIMEOUT;

  logger.info(`→ ${body.model} ${targetPath}`, { streaming: isStreaming });
  logger.debug('Request headers', Object.fromEntries(Object.entries(headers).map(([k, v]) =>
    k.toLowerCase() === 'authorization' ? [k, v.slice(0, 20) + '...'] : [k, v]
  )));
  logger.debug('Request body', body);

  const upstream = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });

  // 401 → refresh and retry once
  if (upstream.status === 401) {
    logger.warn('Copilot returned 401, refreshing token and retrying...');
    await auth.forceRefresh();
    const newHeaders = { ...headers, Authorization: `Bearer ${auth.getCopilotToken()}` };
    const retry = await fetch(url, {
      method: 'POST',
      headers: newHeaders,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    return handleUpstreamResponse(retry, res, isStreaming, model);
  }

  return handleUpstreamResponse(upstream, res, isStreaming, model);
}

async function handleUpstreamResponse(
  upstream: Response,
  res: express.Response,
  isStreaming: boolean,
  model: string,
): Promise<void> {
  res.status(upstream.status);
  const forwardHeaders = ['content-type', 'x-request-id'];
  for (const h of forwardHeaders) {
    const val = upstream.headers.get(h);
    if (val) res.setHeader(h, val);
  }

  if (!upstream.body) {
    const text = await upstream.text();
    if (upstream.ok) {
      logger.info(`← ${upstream.status} (no body)`);
    } else {
      logger.error(`← ${upstream.status} (no body)`, { body: text });
    }
    logger.debug('Response body', { text });
    const usage = extractUsageFromResponse(text);
    if (usage) recordUsage(model, usage.input, usage.output);
    res.send(text);
    return;
  }

  if (isStreaming && upstream.ok) {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const reader = upstream.body.getReader();
    const chunks: string[] = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value).toString('utf-8');
        chunks.push(chunk);
        res.write(value);
      }
    } catch (e: any) {
      logger.error(`Stream error: ${e.message}`);
    } finally {
      res.end();
      logger.info(`← ${upstream.status} (streamed)`);
      logger.debug('Response body', { body: chunks.join('') });
      const usage = extractUsageFromStream(chunks.join(''));
      if (usage) recordUsage(model, usage.input, usage.output);
    }
  } else {
    const data = await upstream.text();
    if (upstream.ok) {
      logger.info(`← ${upstream.status}`);
    } else {
      logger.error(`← ${upstream.status}`, { body: data });
    }
    logger.debug('Response body', { body: data });
    const usage = extractUsageFromResponse(data);
    if (usage) recordUsage(model, usage.input, usage.output);
    res.send(data);
  }
}

export function createServer(auth: AuthManager): express.Express {
  const app = express();

  app.use(express.json({ limit: '50mb' }));

  // Health check
  app.get('/health', (_req, res) => {
    const token = auth.getCopilotToken();
    res.json({ status: token ? 'ok' : 'unauthenticated' });
  });

  // --- Anthropic routes ---
  const handleAnthropicRequest = async (req: express.Request, res: express.Response) => {
    try {
      let body = { ...req.body };

      if (!body.model) {
        logger.error('← 400 Missing required field: model');
        return res.status(400).json({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Missing required field: model' },
        });
      }

      const originalModel = body.model;
      body.model = resolveModel(body.model);
      if (originalModel !== body.model) {
        logger.debug(`Model: ${originalModel} → ${body.model}`);
      }

      // Apply config overrides to request body
      body = applyRequestOverrides(body, 'anthropic') as any;

      // Clean non-standard fields before forwarding
      delete body.context_management;
      sanitizeTools(body.tools);
      stripEmptyTextBlocks(body);

      const headers = buildCopilotHeaders(auth, req);
      const isStreaming = body.stream === true;

      await forwardRequest(auth, '/v1/messages', body, headers, isStreaming, res, body.model);
    } catch (e: any) {
      logger.error(`Anthropic handler error: ${e.message}`);
      res.status(500).json({
        type: 'error',
        error: { type: 'server_error', message: e.message },
      });
    }
  };

  app.post('/v1/messages', handleAnthropicRequest);
  app.post('/messages', handleAnthropicRequest);

  // --- OpenAI routes ---
  const handleOpenAIRequest = async (req: express.Request, res: express.Response) => {
    try {
      let body = { ...req.body };

      if (body.model) {
        const originalModel = body.model;
        body.model = resolveModel(body.model);
        if (originalModel !== body.model) {
          logger.debug(`Model: ${originalModel} → ${body.model}`);
        }
      }

      body = applyRequestOverrides(body, 'openai') as any;

      const headers = buildCopilotHeaders(auth, req);
      const isStreaming = body.stream === true;

      await forwardRequest(auth, '/chat/completions', body, headers, isStreaming, res, body.model || 'unknown');
    } catch (e: any) {
      logger.error(`OpenAI handler error: ${e.message}`);
      res.status(500).json({
        error: { message: e.message, type: 'server_error' },
      });
    }
  };

  app.post('/v1/chat/completions', handleOpenAIRequest);
  app.post('/chat/completions', handleOpenAIRequest);

  // --- Models route ---
  app.get('/v1/models', async (_req, res) => {
    try {
      const apiBase = auth.getCopilotApiBase();
      const token = auth.getCopilotToken();
      if (!token) throw new Error('No Copilot token available');

      const overrides = getHeaderOverrides();
      logger.info('→ GET /models');
      const upstream = await fetch(`${apiBase}/models`, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...overrides,
        },
      });

      const data = await upstream.text();
      if (upstream.ok) {
        logger.info(`← ${upstream.status}`);
      } else {
        logger.error(`← ${upstream.status}`, { body: data });
      }
      logger.debug('Response body', { body: data });

      res.status(upstream.status);
      const ct = upstream.headers.get('content-type');
      if (ct) res.setHeader('content-type', ct);
      res.send(data);
    } catch (e: any) {
      logger.error(`Models handler error: ${e.message}`);
      res.status(500).json({ error: { message: e.message, type: 'server_error' } });
    }
  });

  // --- Stats route ---
  app.get('/stats', (_req, res) => {
    res.json(getStats());
  });

  return app;
}