import express from 'express';
import { AuthManager } from './auth.js';
import { resolveModel, applyRequestOverrides, getHeaderOverrides } from './config.js';
import { logger, generateRequestId, formatDuration } from './logger.js';
import { recordUsage, recordHttpResponse, getStats, extractUsageFromResponse, StreamUsageAccumulator, formatUsage } from './stats.js';
import { buildCodexCatalog, loadCodexTemplates } from './catalog.js';
import { UpstreamFeedback, isRateLimitHeader } from './feedback.js';
import { asRecord } from './data.js';
import { defaultAdapters, type CompatibilityAdapter } from './compatibility/index.js';

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

function describeRequestThinking(body: any): string | null {
  const t = body?.thinking;
  if (!t || typeof t !== 'object') return null;
  const effort = body?.output_config?.effort;
  if (t.type === 'enabled') {
    const budget = t.budget_tokens;
    return budget != null ? `enabled/budget=${budget}` : 'enabled';
  }
  if (t.type === 'adaptive') {
    return effort ? `adaptive/${effort}` : 'adaptive';
  }
  if (t.type === 'disabled') return 'disabled';
  return t.type ? String(t.type) : null;
}

async function forwardRequest(
  auth: AuthManager,
  targetPath: string,
  body: any,
  headers: Record<string, string>,
  isStreaming: boolean,
  res: express.Response,
  model: string,
  reqId: string,
  feedback: UpstreamFeedback,
): Promise<void> {
  const apiBase = auth.getCopilotApiBase();
  const url = `${apiBase}${targetPath}`;
  const timeout = isStreaming ? STREAMING_TIMEOUT : NON_STREAMING_TIMEOUT;
  const startTime = Date.now();

  const requestBody = JSON.stringify(body);
  const reqChars = requestBody.length;
  const reqMeta: Record<string, any> = { streaming: isStreaming, req_chars: reqChars };
  const thinkingDesc = describeRequestThinking(body);
  if (thinkingDesc) reqMeta.thinking = thinkingDesc;
  logger.info(`[${reqId}] → ${body.model} ${targetPath}`, reqMeta);
  logger.debug(`[${reqId}] Request headers`, Object.fromEntries(Object.entries(headers).map(([k, v]) =>
    k.toLowerCase() === 'authorization' ? [k, '[REDACTED]'] : [k, v]
  )));
  logger.debug(`[${reqId}] Request body`, body);

  const upstream = await feedback.fetch(url, {
    method: 'POST',
    headers,
    body: requestBody,
    signal: AbortSignal.timeout(timeout),
  }, targetPath, model);

  // 401 → refresh and retry once
  if (upstream.status === 401) {
    logger.warn(`[${reqId}] Copilot returned 401, refreshing token and retrying...`);
    await auth.forceRefresh();
    const newHeaders = { ...headers, Authorization: `Bearer ${auth.getCopilotToken()}` };
    const retry = await feedback.fetch(url, {
      method: 'POST',
      headers: newHeaders,
      body: requestBody,
      signal: AbortSignal.timeout(timeout),
    }, targetPath, model);
    return handleUpstreamResponse(retry, res, isStreaming, model, reqId, reqChars, startTime);
  }

  return handleUpstreamResponse(upstream, res, isStreaming, model, reqId, reqChars, startTime);
}

async function handleUpstreamResponse(
  upstream: Response,
  res: express.Response,
  isStreaming: boolean,
  model: string,
  reqId: string,
  reqChars: number,
  startTime: number,
): Promise<void> {
  res.status(upstream.status);
  recordHttpResponse(model, upstream.status);
  const forwardHeaders = ['content-type', 'x-request-id'];
  for (const h of forwardHeaders) {
    const val = upstream.headers.get(h);
    if (val) res.setHeader(h, val);
  }
  upstream.headers.forEach((value, name) => {
    if (isRateLimitHeader(name)) res.setHeader(name, value);
  });

  if (!upstream.body) {
    const text = await upstream.text();
    const usage = extractUsageFromResponse(text);
    const tokenInfo = usage ? ` ${formatUsage(usage)}` : '';
    const sizeInfo = ` req=${reqChars} resp=${text.length} dur=${formatDuration(Date.now() - startTime)}`;
    if (upstream.ok) {
      logger.info(`[${reqId}] ← ${upstream.status} (no body)${tokenInfo}${sizeInfo}`);
    } else {
      logger.error(`[${reqId}] ← ${upstream.status} (no body)${tokenInfo}${sizeInfo}`, { body: text });
    }
    logger.debug(`[${reqId}] Response body`, { text });
    if (usage) recordUsage(model, usage);
    res.send(text);
    return;
  }

  if (isStreaming && upstream.ok) {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const reader = upstream.body.getReader();
    const accumulator = new StreamUsageAccumulator();
    const debugChunks: string[] | null = logger.isDebugEnabled() ? [] : null;
    let respBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        respBytes += value.byteLength;
        const chunk = Buffer.from(value).toString('utf-8');
        accumulator.addChunk(chunk);
        if (debugChunks) debugChunks.push(chunk);
        res.write(value);
      }
    } catch (e: any) {
      logger.error(`[${reqId}] Stream error: ${e.message}`);
    } finally {
      res.end();
      accumulator.flush();
      const usage = accumulator.getUsage();
      const tokenInfo = usage ? ` ${formatUsage(usage)}` : '';
      const sizeInfo = ` req=${reqChars} resp=${respBytes} dur=${formatDuration(Date.now() - startTime)}`;
      logger.info(`[${reqId}] ← ${upstream.status} (streamed)${tokenInfo}${sizeInfo}`);
      if (debugChunks) logger.debug(`[${reqId}] Response body`, { body: debugChunks.join('') });
      if (usage) recordUsage(model, usage);
    }
  } else {
    const data = await upstream.text();
    const usage = extractUsageFromResponse(data);
    const tokenInfo = usage ? ` ${formatUsage(usage)}` : '';
    const sizeInfo = ` req=${reqChars} resp=${data.length} dur=${formatDuration(Date.now() - startTime)}`;
    if (upstream.ok) {
      logger.info(`[${reqId}] ← ${upstream.status}${tokenInfo}${sizeInfo}`);
    } else {
      logger.error(`[${reqId}] ← ${upstream.status}${tokenInfo}${sizeInfo}`, { body: data });
    }
    logger.debug(`[${reqId}] Response body`, { body: data });
    if (usage) recordUsage(model, usage);
    res.send(data);
  }
}

export function createServer(
  auth: AuthManager,
  adapters: readonly CompatibilityAdapter[] = defaultAdapters,
): express.Express {
  const app = express();
  const feedback = new UpstreamFeedback();

  const fetchModels = async (): Promise<Response> => {
    const token = auth.getCopilotToken();
    if (!token) throw new Error('No Copilot token available');
    return feedback.fetch(`${auth.getCopilotApiBase()}/models`, {
      headers: { Authorization: `Bearer ${token}`, ...getHeaderOverrides() },
    }, '/models');
  };

  const sendHealth = (res: express.Response, probeFailed = false) => {
    if (probeFailed) feedback.recordProbeFailure();
    const health = feedback.getHealth(auth);
    res.status(health.ready ? 200 : 503).json(health);
  };

  app.use(express.json({ limit: '50mb' }));

  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok', uptime_seconds: Math.floor(process.uptime()) });
  });
  app.get('/health', (_req, res) => sendHealth(res));
  app.get('/health/ready', async (_req, res) => {
    try {
      const upstream = await fetchModels();
      const body = await upstream.text();
      if (!upstream.ok) {
        sendHealth(res, true);
        return;
      }
      if (!Array.isArray(asRecord(JSON.parse(body))?.data)) {
        throw new Error('Copilot readiness probe returned an invalid model list.');
      }
    } catch (error) {
      logger.error(`Readiness check failed: ${error instanceof Error ? error.message : String(error)}`);
      sendHealth(res, true);
      return;
    }
    sendHealth(res);
  });

  // --- Anthropic routes ---
  const handleAnthropicRequest = async (req: express.Request, res: express.Response) => {
    const reqId = generateRequestId();
    try {
      let body = { ...req.body };

      if (!body.model) {
        logger.error(`[${reqId}] ← 400 Missing required field: model`);
        return res.status(400).json({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Missing required field: model' },
        });
      }

      const originalModel = body.model;
      body.model = resolveModel(body.model);
      if (originalModel !== body.model) {
        logger.debug(`[${reqId}] Model: ${originalModel} → ${body.model}`);
      }

      // Apply config overrides to request body
      body = applyRequestOverrides(body, 'anthropic') as any;

      // Clean non-standard fields before forwarding
      delete body.context_management;
      sanitizeTools(body.tools);
      stripEmptyTextBlocks(body);

      const headers = buildCopilotHeaders(auth, req);
      const isStreaming = body.stream === true;

      await forwardRequest(auth, '/v1/messages', body, headers, isStreaming, res, body.model, reqId, feedback);
    } catch (e: any) {
      logger.error(`[${reqId}] Anthropic handler error: ${e.message}`);
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
    const reqId = generateRequestId();
    try {
      let body = { ...req.body };

      if (body.model) {
        const originalModel = body.model;
        body.model = resolveModel(body.model);
        if (originalModel !== body.model) {
          logger.debug(`[${reqId}] Model: ${originalModel} → ${body.model}`);
        }
      }

      body = applyRequestOverrides(body, 'openai') as any;

      const headers = buildCopilotHeaders(auth, req);
      const isStreaming = body.stream === true;

      await forwardRequest(auth, '/chat/completions', body, headers, isStreaming, res, body.model || 'unknown', reqId, feedback);
    } catch (e: any) {
      logger.error(`[${reqId}] OpenAI handler error: ${e.message}`);
      res.status(500).json({
        error: { message: e.message, type: 'server_error' },
      });
    }
  };

  app.post('/v1/chat/completions', handleOpenAIRequest);
  app.post('/chat/completions', handleOpenAIRequest);

  // --- Responses API routes ---
  const handleResponsesRequest = (adapter?: CompatibilityAdapter) => async (req: express.Request, res: express.Response) => {
    const reqId = generateRequestId();
    try {
      let body: Record<string, unknown> = { ...req.body };

      if (typeof body.model === 'string') {
        const originalModel = body.model;
        body.model = resolveModel(body.model);
        if (originalModel !== body.model) {
          logger.debug(`[${reqId}] Model: ${originalModel} → ${body.model}`);
        }
      }

      body = applyRequestOverrides(body, adapter?.requestFormat ?? 'openai');
      if (adapter) {
        const adapted = adapter.adaptRequest(body);
        body = adapted.body;
        res.setHeader('x-copilot-proxy-adapter', adapter.id);
        if (adapted.changes.length > 0) {
          res.setHeader('x-copilot-proxy-adjustments', adapted.changes.join(','));
          logger.info(`[${reqId}] Compatibility: ${adapter.id}`, { changes: adapted.changes });
        }
      }

      const headers = buildCopilotHeaders(auth, req);
      const isStreaming = body.stream === true;
      const model = typeof body.model === 'string' && body.model ? body.model : 'unknown';

      await forwardRequest(auth, adapter?.upstreamPath ?? '/responses', body, headers, isStreaming, res, model, reqId, feedback);
    } catch (e: any) {
      logger.error(`[${reqId}] Responses handler error: ${e.message}`);
      res.status(500).json({
        error: { message: e.message, type: 'server_error' },
      });
    }
  };

  app.post('/v1/responses', handleResponsesRequest());
  app.post('/responses', handleResponsesRequest());
  for (const adapter of adapters) {
    app.post(adapter.route, handleResponsesRequest(adapter));
  }

  // --- Models route ---
  app.get('/v1/models', async (_req, res) => {
    try {
      logger.info('→ GET /models');
      const upstream = await fetchModels();

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
      upstream.headers.forEach((value, name) => {
        if (isRateLimitHeader(name)) res.setHeader(name, value);
      });
      res.send(data);
    } catch (e: any) {
      logger.error(`Models handler error: ${e.message}`);
      res.status(500).json({ error: { message: e.message, type: 'server_error' } });
    }
  });

  app.get('/codex/models', async (_req, res) => {
    try {
      const templates = loadCodexTemplates();
      const upstream = await fetchModels();
      upstream.headers.forEach((value, name) => {
        if (isRateLimitHeader(name)) res.setHeader(name, value);
      });
      if (!upstream.ok) {
        const contentType = upstream.headers.get('content-type');
        if (contentType) res.setHeader('content-type', contentType);
        res.status(upstream.status).send(await upstream.text());
        return;
      }
      const { catalog, excluded } = buildCodexCatalog(await upstream.json(), templates);
      logger.info(`Codex catalog: ${catalog.models.length} models, ${excluded.length} excluded`);
      logger.debug('Codex catalog exclusions', { excluded });
      res.json(catalog);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Codex catalog error: ${message}`);
      res.status(503).json({ error: { message, type: 'catalog_unavailable' } });
    }
  });

  app.get('/rate-limits', (_req, res) => res.json(feedback.getRateLimits()));

  // --- Stats route ---
  app.get('/stats', (_req, res) => {
    res.json(getStats());
  });

  return app;
}