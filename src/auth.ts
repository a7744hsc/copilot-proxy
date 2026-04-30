import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from './logger.js';

const CLIENT_ID = 'Iv1.b507a08c87ecfe98';
const EDITOR_VERSION = 'vscode/1.103.1';
const REFRESH_BUFFER_SECONDS = 300; // refresh 5 min before expiry

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface CopilotToken {
  token: string;
  expires_at: number;
  endpoints: {
    api: string;
    proxy: string;
    telemetry: string;
    'origin-tracker'?: string;
  };
  [key: string]: unknown;
}

export class AuthManager {
  private accessToken: string | null = null;
  private copilotToken: CopilotToken | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private tokenDir: string;

  constructor(tokenDir?: string) {
    this.tokenDir = tokenDir || path.join(process.cwd(), '.tokens');
  }

  // --- Public API ---

  async ensureAuthenticated(): Promise<boolean> {
    // Try loading existing tokens first
    if (await this.loadTokens()) {
      if (this.isCopilotTokenValid()) {
        logger.info('Using existing valid Copilot token');
        this.scheduleRefresh();
        return true;
      }
      // Token expired but we have access token — try refreshing
      if (this.accessToken) {
        logger.info('Copilot token expired, refreshing...');
        try {
          await this.refreshCopilotToken();
          this.scheduleRefresh();
          return true;
        } catch (e: any) {
          logger.warn(`Token refresh failed: ${e.message}, starting device flow`);
        }
      }
    }

    // Fall through to device flow
    logger.info('Starting GitHub device flow authentication...');
    const success = await this.authenticateDeviceFlow();
    if (success) this.scheduleRefresh();
    return success;
  }

  getCopilotToken(): string | null {
    return this.copilotToken?.token || null;
  }

  getCopilotApiBase(): string {
    return this.copilotToken?.endpoints?.api || 'https://api.githubcopilot.com';
  }

  async forceRefresh(): Promise<void> {
    logger.info('Force-refreshing Copilot token...');
    await this.refreshCopilotToken();
    this.scheduleRefresh();
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // --- Device Flow ---

  private async authenticateDeviceFlow(): Promise<boolean> {
    const deviceCode = await this.requestDeviceCode();
    if (!deviceCode) return false;

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║  GitHub Copilot Authentication                   ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║  1. Open: ${deviceCode.verification_uri.padEnd(38)}║`);
    console.log(`║  2. Enter code: ${deviceCode.user_code.padEnd(31)}║`);
    console.log('╚══════════════════════════════════════════════════╝\n');

    const token = await this.pollForAccessToken(deviceCode);
    if (!token) return false;

    this.accessToken = token;
    await this.refreshCopilotToken();
    await this.saveTokens();
    logger.info('GitHub Copilot authentication successful');
    return true;
  }

  private async requestDeviceCode(): Promise<DeviceCodeResponse | null> {
    try {
      const res = await fetch('https://github.com/login/device/code', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID, scope: 'read:user' }),
      });
      if (!res.ok) {
        logger.error(`Device code request failed: ${res.status} ${await res.text()}`);
        return null;
      }
      return (await res.json()) as DeviceCodeResponse;
    } catch (e: any) {
      logger.error(`Device code request error: ${e.message}`);
      return null;
    }
  }

  private async pollForAccessToken(device: DeviceCodeResponse): Promise<string | null> {
    let interval = (device.interval || 5) * 1000;
    const maxAttempts = Math.floor(device.expires_in / (device.interval || 5));
    const deadline = Date.now() + device.expires_in * 1000;

    for (let attempt = 0; attempt < maxAttempts && Date.now() < deadline; attempt++) {
      await this.sleep(interval);

      try {
        const res = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: CLIENT_ID,
            device_code: device.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
        });

        const data = (await res.json()) as any;

        if (data.access_token) {
          return data.access_token;
        }

        switch (data.error) {
          case 'authorization_pending':
            // User hasn't authorized yet, keep polling
            break;
          case 'slow_down':
            interval += 5000;
            logger.debug('Polling slowed down');
            break;
          case 'expired_token':
            logger.error('Device code expired. Please try again.');
            return null;
          case 'access_denied':
            logger.error('Authorization denied by user.');
            return null;
          default:
            logger.error(`Unexpected polling error: ${data.error}`);
            return null;
        }
      } catch (e: any) {
        logger.error(`Polling error: ${e.message}`);
      }
    }

    logger.error('Polling timed out');
    return null;
  }

  // --- Token Exchange ---

  private async refreshCopilotToken(): Promise<void> {
    if (!this.accessToken) {
      logger.warn('No access token in memory, attempting to reload from disk...');
      const reloaded = await this.tryReloadAccessToken();
      if (!reloaded) {
        throw new Error('No access token available (not in memory or on disk)');
      }
    }

    logger.info('Exchanging access token for Copilot token...');
    let res: globalThis.Response;
    try {
      res = await fetch('https://api.github.com/copilot_internal/v2/token', {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `token ${this.accessToken}`,
          'editor-version': EDITOR_VERSION,
          'editor-plugin-version': 'copilot-proxy/1.0',
        },
      });
    } catch (e: any) {
      throw new Error(`Token refresh network error: ${e.message} (${e.cause?.code || e.cause?.message || 'unknown'})`);
    }

    if (!res.ok) {
      const body = await res.text();
      logger.error(`Token refresh failed: ${res.status}`, { body });
      if (res.status === 401) {
        logger.warn('GitHub access token rejected (401). Attempting to reload from disk...');
        const reloaded = await this.tryReloadAccessToken();
        if (!reloaded) {
          logger.error('No valid access token on disk. Re-authentication required (restart proxy).');
        }
        throw new Error('GitHub access token rejected (401).');
      }
      if (res.status === 403) {
        throw new Error('Access denied. Ensure you have an active GitHub Copilot subscription.');
      }
      throw new Error(`Failed to get Copilot token: ${res.status} ${body}`);
    }

    this.copilotToken = (await res.json()) as CopilotToken;
    const expiresAt = new Date(this.copilotToken.expires_at * 1000);
    logger.info(`Copilot token obtained, expires at: ${expiresAt.toISOString()}`);
    this.saveCopilotToken();
  }

  // --- Token Refresh Scheduling ---

  private scheduleRefresh(retryDelay?: number): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (!this.copilotToken) return;

    let delaySeconds: number;
    if (retryDelay != null) {
      delaySeconds = retryDelay;
    } else {
      const now = Math.floor(Date.now() / 1000);
      const refreshAt = this.copilotToken.expires_at - REFRESH_BUFFER_SECONDS;
      delaySeconds = Math.max(0, refreshAt - now);
    }

    if (delaySeconds <= 0) {
      logger.info('Token expired or expiring soon, refreshing immediately');
      this.refreshCopilotToken()
        .then(() => this.scheduleRefresh())
        .catch((e: any) => {
          logger.error(`Auto-refresh failed: ${e.message}`, { cause: e.cause?.message, code: e.cause?.code });
          logger.info('Retrying token refresh in 30 seconds...');
          this.scheduleRefresh(30);
        });
      return;
    }

    logger.info(`Scheduling token refresh in ${delaySeconds} seconds`);
    this.refreshTimer = setTimeout(async () => {
      try {
        logger.info('Auto-refreshing Copilot token...');
        await this.refreshCopilotToken();
        this.scheduleRefresh();
      } catch (e: any) {
        logger.error(`Auto-refresh failed: ${e.message}`, { cause: e.cause?.message, code: e.cause?.code });
        logger.info('Retrying token refresh in 30 seconds...');
        this.scheduleRefresh(30);
      }
    }, delaySeconds * 1000);
  }

  // --- Token Persistence ---

  private async loadTokens(): Promise<boolean> {
    try {
      const accessTokenPath = path.join(this.tokenDir, 'access-token');
      const apiKeyPath = path.join(this.tokenDir, 'api-key.json');

      if (fs.existsSync(accessTokenPath)) {
        this.accessToken = fs.readFileSync(accessTokenPath, 'utf-8').trim();
      }
      if (fs.existsSync(apiKeyPath)) {
        this.copilotToken = JSON.parse(fs.readFileSync(apiKeyPath, 'utf-8'));
      }

      return !!(this.accessToken || this.copilotToken);
    } catch (e: any) {
      logger.error(`Failed to load tokens: ${e.message}`);
      return false;
    }
  }

  private saveCopilotToken(): void {
    try {
      if (!fs.existsSync(this.tokenDir)) {
        fs.mkdirSync(this.tokenDir, { recursive: true, mode: 0o700 });
      }
      if (this.copilotToken) {
        const p = path.join(this.tokenDir, 'api-key.json');
        fs.writeFileSync(p, JSON.stringify(this.copilotToken, null, 2), { encoding: 'utf-8', mode: 0o600 });
        logger.info(`Saved api-key.json to ${this.tokenDir}`);
      }
    } catch (e: any) {
      logger.error(`Failed to save copilot token: ${e.message}`);
      throw e;
    }
  }

  private async saveTokens(): Promise<void> {
    try {
      if (!fs.existsSync(this.tokenDir)) {
        fs.mkdirSync(this.tokenDir, { recursive: true, mode: 0o700 });
      }

      if (this.accessToken) {
        const p = path.join(this.tokenDir, 'access-token');
        fs.writeFileSync(p, this.accessToken, { encoding: 'utf-8', mode: 0o600 });
      }
      if (this.copilotToken) {
        const p = path.join(this.tokenDir, 'api-key.json');
        fs.writeFileSync(p, JSON.stringify(this.copilotToken, null, 2), { encoding: 'utf-8', mode: 0o600 });
      }

      const saved = [this.accessToken ? 'access-token' : '', this.copilotToken ? 'api-key.json' : ''].filter(Boolean).join(', ');
      logger.info(`Saved ${saved} to ${this.tokenDir}`);
    } catch (e: any) {
      logger.error(`Failed to save tokens: ${e.message}`);
      throw e;
    }
  }

  // --- Helpers ---

  private isCopilotTokenValid(): boolean {
    if (!this.copilotToken) return false;
    const now = Math.floor(Date.now() / 1000);
    return this.copilotToken.expires_at > now;
  }

  private async tryReloadAccessToken(): Promise<boolean> {
    try {
      const accessTokenPath = path.join(this.tokenDir, 'access-token');
      if (fs.existsSync(accessTokenPath)) {
        const token = fs.readFileSync(accessTokenPath, 'utf-8').trim();
        if (token) {
          this.accessToken = token;
          logger.info('Access token reloaded from disk');
          return true;
        }
      }
      logger.warn('No access token file found on disk');
      return false;
    } catch (e: any) {
      logger.error(`Failed to reload access token from disk: ${e.message}`);
      return false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
