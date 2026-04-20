import { AuthManager } from './auth.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { logger } from './logger.js';
import { loadStats } from './stats.js';

const PORT = parseInt(process.env.PORT || '5000', 10);

async function main() {
  // Load config
  loadConfig(process.env.CONFIG_PATH);
  loadStats();
  const auth = new AuthManager();

  // Authenticate (loads tokens or starts device flow)
  const ok = await auth.ensureAuthenticated();
  if (!ok) {
    logger.error('Authentication failed. Exiting.');
    process.exit(1);
  }

  // Start server
  const app = createServer(auth);
  const server = app.listen(PORT);

  server.on('listening', () => {
    logger.info(`Copilot proxy listening on http://localhost:${PORT}`);
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
