import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

class Logger {
  private level: number;
  private logStream: fs.WriteStream | null = null;

  constructor() {
    const env = (process.env.LOG_LEVEL || 'info').toLowerCase() as LogLevel;
    this.level = LEVELS[env] ?? LEVELS.info;

    const logFile = path.join(process.cwd(), 'proxy.log');
    const oldLogFile = path.join(process.cwd(), 'proxy.log.old');
    if (fs.existsSync(logFile)) {
      fs.renameSync(logFile, oldLogFile);
    }
    this.logStream = fs.createWriteStream(logFile, { flags: 'w' });
  }

  debug(msg: string, meta?: object) { this.log('debug', msg, meta); }
  info(msg: string, meta?: object) { this.log('info', msg, meta); }
  warn(msg: string, meta?: object) { this.log('warn', msg, meta); }
  error(msg: string, meta?: object) { this.log('error', msg, meta); }

  private log(level: LogLevel, msg: string, meta?: object) {
    if (LEVELS[level] < this.level) return;
    const ts = new Date().toISOString();
    const prefix = `[${ts}] [${level.toUpperCase()}]`;
    const line = meta ? `${prefix} ${msg} ${JSON.stringify(meta)}` : `${prefix} ${msg}`;

    console.log(line);
    if (this.logStream) {
      this.logStream.write(line + '\n');
    }
  }
}

export const logger = new Logger();

export function generateRequestId(): string {
  return crypto.randomBytes(4).toString('hex');
}
