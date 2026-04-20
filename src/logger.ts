type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

class Logger {
  private level: number;

  constructor() {
    const env = (process.env.LOG_LEVEL || 'info').toLowerCase() as LogLevel;
    this.level = LEVELS[env] ?? LEVELS.info;
  }

  debug(msg: string, meta?: object) { this.log('debug', msg, meta); }
  info(msg: string, meta?: object) { this.log('info', msg, meta); }
  warn(msg: string, meta?: object) { this.log('warn', msg, meta); }
  error(msg: string, meta?: object) { this.log('error', msg, meta); }

  private log(level: LogLevel, msg: string, meta?: object) {
    if (LEVELS[level] < this.level) return;
    const ts = new Date().toISOString();
    const prefix = `[${ts}] [${level.toUpperCase()}]`;
    if (meta) {
      console.log(`${prefix} ${msg}`, JSON.stringify(meta, null, 2));
    } else {
      console.log(`${prefix} ${msg}`);
    }
  }
}

export const logger = new Logger();
