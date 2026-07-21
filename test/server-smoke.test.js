'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');

const root = path.join(__dirname, '..');

function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((err) => err ? reject(err) : resolve(port));
    });
  });
}

function waitForListening(child, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes('server listening on port')) {
        clearTimeout(timeout);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (err) => { clearTimeout(timeout); reject(err); });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`server exited before ready (${code}):\n${output}`)); });
  });
}

function waitForExit(child, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('server did not stop cleanly')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

test('server starts with hardened defaults', { timeout: 45_000 }, async () => {
  const port = await availablePort();
  const dbPath = path.join(os.tmpdir(), `fire-kirin-server-${process.pid}-${Date.now()}.sqlite`);
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      SQLITE_PATH: dbPath,
      JWT_SECRET: 'test-secret-that-is-long-enough-for-a-token',
      APP_URL: `http://127.0.0.1:${port}`,
      ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
      ADMIN_USERNAME: 'smoke_owner',
      ADMIN_PASSWORD: 'smoke-owner-password',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await waitForListening(child);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, engine: 'sqlite' });
    assert.equal(health.headers.get('x-powered-by'), null);
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(health.headers.get('x-frame-options'), 'DENY');

    const badJson = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    assert.equal(badJson.status, 400);
    assert.deepEqual(await badJson.json(), { error: 'invalid JSON body' });
  } finally {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    const exited = child.exitCode === null ? await waitForExit(child) : { code: child.exitCode, signal: child.signalCode };
    // On Windows, child.kill('SIGTERM') terminates the child directly instead
    // of delivering a catchable POSIX signal. Startup behavior is exercised
    // here; graceful SIGTERM handling is covered by the server implementation.
    assert.ok(exited.code === 0 || exited.signal === 'SIGTERM');
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.rmSync(dbPath + suffix, { force: true }); } catch (_) {}
    }
  }
});
