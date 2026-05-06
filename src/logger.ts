import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_LOG_FILES = 5;

class Logger {
  private level: number;
  private logStream: fs.WriteStream | null = null;
  private logFile: string;
  private bytesWritten = 0;

  constructor() {
    const env = (process.env.LOG_LEVEL || 'info').toLowerCase() as LogLevel;
    this.level = LEVELS[env] ?? LEVELS.info;

    this.logFile = path.join(process.cwd(), 'proxy.log');
    this.rotateFiles();
    this.logStream = fs.createWriteStream(this.logFile, { flags: 'w' });
  }

  debug(msg: string, meta?: object) { this.log('debug', msg, meta); }
  info(msg: string, meta?: object) { this.log('info', msg, meta); }
  warn(msg: string, meta?: object) { this.log('warn', msg, meta); }
  error(msg: string, meta?: object) { this.log('error', msg, meta); }

  isDebugEnabled(): boolean {
    return this.level <= LEVELS.debug;
  }

  private log(level: LogLevel, msg: string, meta?: object) {
    if (LEVELS[level] < this.level) return;
    const ts = new Date().toISOString();
    const prefix = `[${ts}] [${level.toUpperCase()}]`;
    const line = meta ? `${prefix} ${msg} ${JSON.stringify(meta)}` : `${prefix} ${msg}`;

    console.log(line);
    if (this.logStream) {
      const data = line + '\n';
      this.logStream.write(data);
      this.bytesWritten += Buffer.byteLength(data, 'utf-8');
      if (this.bytesWritten >= MAX_LOG_BYTES) {
        this.rotate();
      }
    }
  }

  private rotate(): void {
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
    this.rotateFiles();
    this.logStream = fs.createWriteStream(this.logFile, { flags: 'w' });
    this.bytesWritten = 0;
  }

  // Shift proxy.log.{N-1} → .N, drop oldest, then move current proxy.log → .1
  private rotateFiles(): void {
    try {
      const oldest = `${this.logFile}.${MAX_LOG_FILES}`;
      if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
      for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
        const src = `${this.logFile}.${i}`;
        const dst = `${this.logFile}.${i + 1}`;
        if (fs.existsSync(src)) fs.renameSync(src, dst);
      }
      if (fs.existsSync(this.logFile)) {
        fs.renameSync(this.logFile, `${this.logFile}.1`);
      }
    } catch (e: any) {
      console.error(`Log rotation failed: ${e.message}`);
    }
  }
}

export const logger = new Logger();

export function generateRequestId(): string {
  return crypto.randomBytes(4).toString('hex');
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
