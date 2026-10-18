export interface AdaptedRequest {
  body: Record<string, unknown>;
  /** Stable rule IDs, never request content or credentials. */
  changes: readonly string[];
}

/** Request-only adapter; responses use the existing transport unchanged. */
export interface CompatibilityAdapter {
  readonly id: string;
  readonly route: string;
  readonly upstreamPath: string;
  readonly requestFormat: 'openai' | 'anthropic';
  /** Runs after model aliases and config overrides; must not mutate the input. */
  adaptRequest(body: Readonly<Record<string, unknown>>): AdaptedRequest;
}
