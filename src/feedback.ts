import type { AuthManager } from './auth.js';
import { logger } from './logger.js';

interface Observation {
  checked_at: string;
  endpoint: string;
  http_status: number | null;
  reachable: boolean;
  readiness_failed?: boolean;
}

interface RateLimitObservation {
  observed_at: string;
  http_status: number;
  headers: Record<string, string>;
  retry_at: string | null;
  responses_429: number;
}

export function isRateLimitHeader(name: string): boolean {
  return /^(retry-after|(?:x-)?ratelimit-.+|x-rate-limit-.+)$/i.test(name);
}

export function retryAt(value: string | null, now = Date.now()): string | null {
  if (!value?.trim()) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds < 0) return null;
  const timestamp = Number.isFinite(seconds) && seconds >= 0
    ? now + seconds * 1000
    : Date.parse(value);
  return Number.isFinite(timestamp) && Math.abs(timestamp) <= 8.64e15
    ? new Date(timestamp).toISOString()
    : null;
}

export class UpstreamFeedback {
  private lastUpstream: Observation | null = null;
  private rateLimits = new Map<string, RateLimitObservation>();
  private startedAt = new Date().toISOString();

  async fetch(url: string, init: RequestInit, endpoint: string, model?: string): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      this.lastUpstream = {
        checked_at: new Date().toISOString(), endpoint, http_status: null, reachable: false,
      };
      throw error;
    }
    this.lastUpstream = {
      checked_at: new Date().toISOString(), endpoint, http_status: response.status, reachable: true,
    };
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (isRateLimitHeader(name)) headers[name] = value;
    });
    const key = model ?? endpoint;
    if (Object.keys(headers).length > 0 || response.status === 429 || this.rateLimits.has(key)) {
      this.rateLimits.set(key, {
        observed_at: this.lastUpstream.checked_at,
        http_status: response.status,
        headers,
        retry_at: retryAt(response.headers.get('retry-after')),
        responses_429: (this.rateLimits.get(key)?.responses_429 ?? 0) + (response.status === 429 ? 1 : 0),
      });
    }
    if (response.status === 429) {
      logger.warn(`Copilot rate limited ${key}`, { status: 429, ...this.rateLimits.get(key) });
    }
    return response;
  }

  getHealth(auth: AuthManager) {
    const authentication = auth.getAuthStatus();
    const upstream = this.lastUpstream;
    let status: string;
    if (authentication.state !== 'valid') status = 'unauthenticated';
    else if (!upstream) status = 'unknown';
    else if (!upstream.reachable || (upstream.http_status ?? 0) >= 500) status = 'upstream_unavailable';
    else if (upstream.http_status === 401 || upstream.http_status === 403) status = 'upstream_rejected';
    else if (upstream.http_status === 429) status = 'rate_limited';
    else if (upstream.readiness_failed) status = 'upstream_unavailable';
    else status = 'ok';
    return { status, ready: status === 'ok', authentication, upstream };
  }

  recordProbeFailure(): void {
    if (this.lastUpstream) this.lastUpstream.readiness_failed = true;
  }

  getRateLimits() {
    return {
      since: this.startedAt,
      scope: 'Observed upstream responses; not a quota or billing estimate',
      models: Object.fromEntries(this.rateLimits),
    };
  }
}
