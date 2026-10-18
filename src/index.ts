import * as net from 'node:net';
import { AuthManager } from './auth.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { logger } from './logger.js';
import { loadStats } from './stats.js';

const PORT = parseInt(process.env.PORT || '5000', 10);
const HOST = process.env.HOST || '127.0.0.1';

if (process.env.COPILOT_PROXY_SUPERVISED === '1') {
  const input = process.stdin;
  if (!(input instanceof net.Socket)) throw new Error('Supervised startup requires a supervisor-owned stdin pipe.');
  // Task Scheduler can kill PowerShell without terminating its Node child.
  input.once('end', () => process.exit());
  input.resume();
  input.unref();
}

function checkPort(port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tester = net.createServer()
      .once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Port ${port} is already in use. Stop the existing process or set a different PORT environment variable.`));
        } else {
          reject(err);
        }
      })
      .once('listening', () => {
        tester.close(() => resolve());
      })
      .listen(port, host);
  });
}

async function main() {
  // Check port availability before doing anything else
  await checkPort(PORT, HOST);

  // Load config
  loadConfig(process.env.CONFIG_PATH);
  loadStats();
  const auth = new AuthManager();

  // Authenticate (loads tokens or starts device flow)
  const ok = await auth.ensureAuthenticated({ interactive: process.env.COPILOT_PROXY_NON_INTERACTIVE !== '1' });
  if (!ok) {
    logger.error('Authentication failed. Exiting.');
    auth.dispose();
    process.exitCode = 1;
    return;
  }

  // Start server
  const app = createServer(auth);
  const server = app.listen(PORT, HOST);

  server.on('listening', () => {
    logger.info(`Copilot proxy listening on http://${HOST}:${PORT}`);
    logger.info(`API base: ${auth.getCopilotApiBase()}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(
        `Port ${PORT} is already in use. Stop the existing process or set a different PORT environment variable.`,
      );
    } else {
      logger.error(`Server failed to start: ${err.message}`);
    }
    auth.dispose();
    process.exit(1);
  });

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...');
    auth.dispose();
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  logger.error(`Fatal: ${e.message}`);
  process.exit(1);
});
