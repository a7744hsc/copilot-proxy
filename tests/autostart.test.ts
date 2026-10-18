import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('..', import.meta.url));

async function availablePort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test('headless CLI exits with a persisted actionable error instead of starting device login', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-headless-'));
  try {
    const port = await availablePort();
    const config = path.join(directory, 'config.json');
    fs.writeFileSync(config, '{}');
    const result = spawnSync(process.execPath, [
      path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(root, 'src', 'index.ts'),
    ], {
      cwd: directory, encoding: 'utf-8', timeout: 15000,
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), LOG_LEVEL: 'info', CONFIG_PATH: config, COPILOT_PROXY_NON_INTERACTIVE: '1', COPILOT_PROXY_SUPERVISED: '0' },
    });
    assert.equal(result.status, 1, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Non-interactive authentication failed/);
    assert.doesNotMatch(result.stdout, /Starting GitHub device flow/);
    assert.match(fs.readFileSync(path.join(directory, 'proxy.log'), 'utf-8'), /Run npm start in a terminal/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

for (const authenticated of [false, true]) {
  test(authenticated ? 'supervised CLI exits when its parent pipe closes' : 'supervision does not keep failed authentication alive', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-supervised-'));
    let child: ReturnType<typeof spawn> | undefined;
    let exited: Promise<number | null> | undefined;
    try {
      const port = await availablePort();
      const config = path.join(directory, 'config.json');
      fs.writeFileSync(config, '{}');
      if (authenticated) {
        fs.mkdirSync(path.join(directory, '.tokens'));
        fs.writeFileSync(path.join(directory, '.tokens', 'api-key.json'), JSON.stringify({
          token: 'fake-test-token', expires_at: Math.floor(Date.now() / 1000) + 3600,
          endpoints: { api: 'http://127.0.0.1:1' },
        }));
      }
      const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      const launched = spawn(process.execPath, ['--import', loader, path.join(root, 'src', 'index.ts')], {
        cwd: directory, stdio: 'pipe',
        env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), LOG_LEVEL: 'info', CONFIG_PATH: config, COPILOT_PROXY_NON_INTERACTIVE: '1', COPILOT_PROXY_SUPERVISED: '1' },
      });
      child = launched;
      let output = '';
      child.stdout?.on('data', (chunk) => { output += chunk; });
      child.stderr?.on('data', (chunk) => { output += chunk; });
      exited = new Promise((resolve, reject) => {
        launched.once('exit', resolve);
        launched.once('error', reject);
      });
      if (authenticated) {
        const deadline = Date.now() + 15000;
        while (!output.includes('Copilot proxy listening on') && child.exitCode === null && Date.now() < deadline) {
          await delay(25);
        }
        assert.match(output, /Copilot proxy listening on/);
        const response = await fetch(`http://127.0.0.1:${port}/health/live`);
        assert.equal(response.status, 200);
        child.stdin?.end();
      }
      const code = await Promise.race([
        exited, delay(10000, undefined, { ref: false }).then(() => { throw new Error(`Supervised CLI did not exit: ${output}`); }),
      ]);
      assert.equal(code, authenticated ? 0 : 1, output);
      if (!authenticated) assert.match(fs.readFileSync(path.join(directory, 'proxy.log'), 'utf-8'), /Non-interactive authentication failed/);
    } finally {
      if (child) {
        child.stdin?.destroy();
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await exited;
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('Windows startup definition and management lifecycle are isolated from installed tasks', {
  skip: process.platform !== 'win32',
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "copilot autostart's test-"));
  try {
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-File', path.join(root, 'tests', 'autostart.test.ps1'),
      '-ScriptPath', path.join(root, 'scripts', 'autostart.ps1'),
      '-FixtureDirectory', directory, '-NodeExecutable', process.execPath,
    ], { encoding: 'utf-8', timeout: 45000 });
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Autostart checks passed/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
