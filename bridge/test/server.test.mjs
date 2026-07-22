import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('health is public while MCP requires a bearer token', async () => {
  const bridge = await startBridge();
  try {
    const health = await waitForHealth(bridge.url('/health'));
    assert.equal(health.status, 'degraded');
    assert.equal(health.bridgeVersion, '0.1.1');
    assert.equal((await fetch(bridge.url('/mcp'), { method: 'POST' })).status, 401);
    assert.equal((await fetch(bridge.url('/mcp'), {
      method: 'POST', headers: { authorization: 'Bearer wrong' },
    })).status, 401);
    assert.equal((await fetch(bridge.url('/extension/update.xml'))).status, 404);
  } finally {
    await bridge.close();
  }
});

test('extension relay is prewarmed on its dedicated port and validates the token', async () => {
  const bridge = await startBridge();
  try {
    const denied = await connectWebSocket(`${bridge.relayURL}/extension?token=wrong`);
    assert.equal((await waitForWebSocketClose(denied)).code, 4001);
    const wrongPath = await connectWebSocket(`${bridge.relayURL}/wrong?token=extension-secret`);
    assert.equal((await waitForWebSocketClose(wrongPath)).code, 4004);
    const accepted = await connectWebSocket(`${bridge.relayURL}/extension?token=extension-secret`);
    accepted.send(JSON.stringify({ method: 'extension.initialized', params: [] }));
    assert.equal(accepted.readyState, WebSocket.OPEN);
    const acceptedClose = waitForWebSocketClose(accepted);
    accepted.close();
    await acceptedClose;
    const reconnected = await connectWebSocket(`${bridge.relayURL}/extension?token=extension-secret`);
    reconnected.send(JSON.stringify({ method: 'extension.initialized', params: [] }));
    assert.equal(reconnected.readyState, WebSocket.OPEN);
    reconnected.close();
  } finally {
    await bridge.close();
  }
});

test('extension status requires loopback token and drives health state', async () => {
  const bridge = await startBridge();
  try {
    const denied = await fetch(bridge.url('/extension-status'), {
      method: 'POST', headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(denied.status, 401);
    const accepted = await fetch(bridge.url('/extension-status'), {
      method: 'POST',
      headers: { authorization: 'Bearer extension-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ connected: true, profile: 'current', tabCount: 7,
        extensionVersion: '0.1.0', chromeVersion: 'Chrome/150', connectedAt: '2026-07-22T00:00:00Z' }),
    });
    assert.equal(accepted.status, 204);
    const health = await waitForHealth(bridge.url('/health'), 'ready');
    assert.equal(health.connected, true);
    assert.equal(health.tabCount, 7);
    assert.equal(health.chromeVersion, 'Chrome/150');
  } finally {
    await bridge.close();
  }
});

test('extension release endpoints validate and serve locked artifacts', async () => {
  const bridge = await startBridge({ release: true });
  try {
    const manifest = await fetch(bridge.url('/extension/update.xml?os=linux&x=installedby%3Dpolicy'));
    assert.equal(manifest.status, 200);
    const xml = await manifest.text();
    assert.match(xml, /appid="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"/);
    assert.match(xml, /version="0.1.0"/);
    const crx = await fetch(bridge.url('/extension/tyrs-browser.crx?uc'));
    assert.equal(crx.status, 200);
    assert.equal(crx.headers.get('content-type'), 'application/x-chrome-extension');
    assert.deepEqual(Buffer.from(await crx.arrayBuffer()), Buffer.from('test-crx'));
    assert.equal((await fetch(bridge.url('/mcp?session=test'), { method: 'POST' })).status, 401);
  } finally {
    await bridge.close();
  }
});

test('startup rejects overlapping ports and empty token files', async () => {
  const duplicate = await startInvalidBridge({ duplicatePorts: true });
  assert.notEqual(duplicate.code, 0);
  assert.match(duplicate.stderr, /ports must be different/);
  const emptyToken = await startInvalidBridge({ emptyMCPToken: true });
  assert.notEqual(emptyToken.code, 0);
  assert.match(emptyToken.stderr, /TYRS_BROWSER_MCP_TOKEN_FILE is empty/);
});

async function startBridge(options = {}) {
  const fixture = await createFixture(options);
  const child = spawn(process.execPath, ['bridge/src/server.mjs'], {
    cwd: new URL('../..', import.meta.url), stdio: 'ignore', env: fixture.env,
  });
  await waitForHealth(`http://127.0.0.1:${fixture.publicPort}/health`);
  return {
    url: path => `http://127.0.0.1:${fixture.publicPort}${path}`,
    relayURL: `ws://127.0.0.1:${fixture.relayPort}`,
    close: async () => {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
      await rm(fixture.directory, { recursive: true, force: true });
    },
  };
}

async function startInvalidBridge(options) {
  const fixture = await createFixture(options);
  const child = spawn(process.execPath, ['bridge/src/server.mjs'], {
    cwd: new URL('../..', import.meta.url), stdio: ['ignore', 'ignore', 'pipe'], env: fixture.env,
  });
  let stderr = '';
  child.stderr.on('data', chunk => stderr += chunk);
  const code = await new Promise(resolve => child.once('exit', resolve));
  await rm(fixture.directory, { recursive: true, force: true });
  return { code, stderr };
}

async function createFixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tyrs-browser-bridge-'));
  const mcpTokenFile = join(directory, 'mcp-token');
  const extensionTokenFile = join(directory, 'extension-token');
  await writeFile(mcpTokenFile, options.emptyMCPToken ? '' : 'mcp-secret\n', { mode: 0o600 });
  await writeFile(extensionTokenFile, 'extension-secret\n', { mode: 0o600 });
  const publicPort = await freePort();
  const relayPort = options.duplicatePorts ? publicPort : await freePort();
  const internalPort = await freePort();
  const releaseRoot = join(directory, 'release');
  if (options.release) {
    await mkdir(releaseRoot);
    await writeFile(join(releaseRoot, 'browser-artifacts.lock.json'), JSON.stringify({
      extensionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', playwright: { extensionVersion: '0.1.0' },
    }));
    await writeFile(join(releaseRoot, 'tyrs-browser-extension.crx'), 'test-crx');
  }
  return {
    directory, publicPort, relayPort,
    env: { ...process.env, TYRS_BROWSER_MCP_HOST: '127.0.0.1',
      TYRS_BROWSER_MCP_PORT: String(publicPort), TYRS_BROWSER_RELAY_PORT: String(relayPort),
      TYRS_BROWSER_INTERNAL_MCP_PORT: String(internalPort),
      TYRS_BROWSER_MCP_TOKEN_FILE: mcpTokenFile,
      TYRS_BROWSER_EXTENSION_TOKEN_FILE: extensionTokenFile,
      TYRS_BROWSER_EXTENSION_ID: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      TYRS_BROWSER_RELEASE_DIR: options.release ? releaseRoot : '' },
  };
}

async function connectWebSocket(url) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        socket.addEventListener('open', () => resolve(socket), { once: true });
        socket.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true });
      });
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  throw lastError ?? new Error('extension relay did not accept WebSocket connections');
}

async function waitForWebSocketClose(socket) {
  return await new Promise(resolve => socket.addEventListener('close', resolve, { once: true }));
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForHealth(url, expectedStatus) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const value = await response.json();
        if (!expectedStatus || value.status === expectedStatus)
          return value;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error('bridge did not become healthy');
}
