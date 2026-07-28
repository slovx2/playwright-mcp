import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { BrowserExecutor } from './browser-executor.mjs';
import { DownloadRelay } from './download-relay.mjs';
import { SSHSupervisor } from './ssh-supervisor.mjs';
import { ToolArtifactSender } from './tool-artifacts.mjs';

const require = createRequire(import.meta.url);
const { tools } = require('playwright-core/lib/coreBundle');
const { CDPRelayServer } = tools;
const releaseInfo = JSON.parse(await fs.promises.readFile(
    new URL('../browser-agent-release.json', import.meta.url), 'utf8'));
const agentVersion = releaseInfo.agentVersion;
const extensionVersion = releaseInfo.extensionVersion;
const bridgeVersion = releaseInfo.bridgeVersion;
if (!/^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(agentVersion) ||
    !/^\d+(\.\d+){0,3}$/.test(extensionVersion) ||
    !/^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(bridgeVersion))
  throw new Error('Browser Agent release metadata is invalid');

const configPath = process.env.TYRS_BROWSER_AGENT_CONFIG || path.join(os.homedir(),
    'Library', 'Application Support', 'Tyrs Hand', 'browser-agent', 'config.json');
const config = validateConfig(JSON.parse(await fs.promises.readFile(configPath, 'utf8')));
process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = config.extensionToken;
process.env.PLAYWRIGHT_EXTENSION_PROTOCOL = '2';

let remoteStream;
const capabilityVersion = 1;
let extensionStatus = { connected: false, tabCount: 0, extensionVersion: '',
  extensionProtocol: 2, chromeVersion: '', reason: 'Chrome extension 未连接' };
let relaySession;
let restartingRelay;
let relayConnected = false;
let browserExecutor;
let remoteGeneration = '';
let lastRemoteMessageAt = 0;
let remoteControlQueue = Promise.resolve();
const toolArtifacts = new ToolArtifactSender();

const publicServer = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname === '/health')
      return sendJSON(response, 200, { agentVersion, sshConnected: Boolean(remoteStream),
        ...extensionStatus, connected: extensionStatus.connected && relayConnected });
    if (url.pathname === '/browser-bootstrap') {
      const data = '<!doctype html><meta charset="utf-8"><title>Tyrs Browser</title>';
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(data), 'cache-control': 'no-store' });
      return response.end(data);
    }
    if (url.pathname === '/extension/config') {
      const requestedExtensionId = url.searchParams.get('extensionId');
      if (requestedExtensionId && requestedExtensionId !== config.extensionId)
        return sendJSON(response, 403, { error: 'extension id mismatch' });
      return sendJSON(response, 200, {
        relayUrl: `ws://127.0.0.1:${config.relayPort}/extension`,
        statusUrl: `http://127.0.0.1:${config.publicPort}/extension-status`,
        extensionToken: config.extensionToken,
      }, { 'access-control-allow-origin': `chrome-extension://${config.extensionId}` });
    }
    if (url.pathname === '/extension-status' && request.method === 'POST') {
      if (!authorized(request.headers.authorization, config.extensionToken))
        return sendJSON(response, 401, { error: 'unauthorized' });
      const body = await readJSON(request, 64 * 1024);
      const wasConnected = extensionStatus.connected;
      extensionStatus = {
        connected: body.connected === true && Number(body.extensionProtocol) === 2 &&
          String(body.extensionVersion || '') === extensionVersion,
        tabCount: Number(body.tabCount || 0),
        extensionVersion: String(body.extensionVersion || ''),
        extensionProtocol: Number(body.extensionProtocol || 0),
        chromeVersion: String(body.chromeVersion || ''),
        reason: body.connected === true && Number(body.extensionProtocol) !== 2 ?
          'Chrome extension 协议版本不匹配' :
          (body.connected === true && String(body.extensionVersion || '') !== extensionVersion ?
            `Chrome extension 版本不匹配，需要 ${extensionVersion}` :
            (body.connected === true ? '' : 'Chrome extension 未连接')),
      };
      await sendStatus().catch(error => log(error));
      if (!extensionStatus.connected && (wasConnected || relayConnected))
        void restartRelay().catch(error => log(error));
      return sendJSON(response, 204);
    }
    if (url.pathname === '/extension/update.xml') {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0"><app appid="${config.extensionId}">` +
        `<updatecheck codebase="http://127.0.0.1:${config.publicPort}/extension/tyrs-browser.crx" version="${extensionVersion}"/>` +
        `</app></gupdate>`;
      response.writeHead(200, { 'content-type': 'application/xml', 'cache-control': 'no-store' });
      return response.end(xml);
    }
    if (url.pathname === '/extension/tyrs-browser.crx') {
      const stat = await fs.promises.stat(config.extensionCrxPath);
      response.writeHead(200, { 'content-type': 'application/x-chrome-extension', 'content-length': stat.size,
        'cache-control': 'no-store' });
      return fs.createReadStream(config.extensionCrxPath).pipe(response);
    }
    sendJSON(response, 404, { error: 'not found' });
  } catch (error) {
    sendJSON(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

await listen(publicServer, config.publicPort);
await restartRelay();

const supervisor = new SSHSupervisor(config, {
  onConnection: stream => {
    remoteStream = stream;
    remoteControlQueue = Promise.resolve();
    lastRemoteMessageAt = Date.now();
    stream.on('message', message => {
      const ordered = ['welcome', 'session_open', 'session_finalize'].includes(message.type);
      const task = ordered ?
        (remoteControlQueue = remoteControlQueue.then(() => handleRemoteMessage(message, stream))) :
        (message.type === 'tool_call' ?
          remoteControlQueue.then(() => handleRemoteMessage(message, stream)) :
          handleRemoteMessage(message, stream));
      void task.catch(async error => {
        log(error);
        await stream.send({ type: 'error', message: error instanceof Error ? error.message : String(error) }).catch(() => {});
        stream.close();
      });
    });
    stream.on('close', () => disconnectRemote(stream));
    void stream.send({ type: 'hello', protocol: 2, capabilityVersion, agentVersion, bridgeVersion,
      platform: 'darwin', instanceId: config.instanceId,
      capabilities: ['local-tool-execution', 'cancellation', 'sessions', 'artifacts'] })
        .then(() => sendStatus()).catch(error => log(error));
  },
  onDisconnect: details => log(`SSH disconnected: ${JSON.stringify(details)}`),
  onError: error => log(error),
  onLog: message => message && log(message),
});
supervisor.start();

const statusTimer = setInterval(() => void sendStatus().catch(error => log(error)), 30_000);
const heartbeatTimer = setInterval(() => {
  const stream = remoteStream;
  if (!stream)
    return;
  if (Date.now() - lastRemoteMessageAt > 45_000)
    return stream.close();
  void stream.send({ type: 'ping', at: Date.now() }).catch(() => stream.close());
}, 15_000);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => void shutdown());

async function restartRelay() {
  if (restartingRelay)
    return await restartingRelay;
  restartingRelay = (async () => {
    extensionStatus.connected = false;
    extensionStatus.reason = 'Chrome extension 或本地执行器正在连接';
    relayConnected = false;
    await sendStatus().catch(error => log(error));
    const interruptedSessions = browserExecutor?.sessionIds() || [];
    for (const sessionId of interruptedSessions) {
      await remoteStream?.send({
        type: 'session_interrupted',
        sessionId,
        reason: 'Desktop Browser Agent connection was reset',
      }).catch(() => {});
    }
    await browserExecutor?.stop().catch(error => log(error));
    browserExecutor = undefined;
    if (relaySession) {
      relaySession.relay.stop();
      await closeServer(relaySession.server);
    }
    const server = http.createServer();
    await listen(server, config.relayPort);
    const relay = new CDPRelayServer(server, 'chrome');
    let executor;
    const downloads = new DownloadRelay(relay, () => remoteStream, () => executor?.currentSessionId() || '');
    relay.setDelegate({
      onExtensionEvent: (method, params) => {
        downloads.onExtensionEvent(method, params);
        if (String(method) === 'tyrs.takeover')
          void handleTakeover(params).catch(error => log(error));
      },
      onCDPMessage: (message, forward) => downloads.onCDPMessage(message, forward),
      onCDPTiming: (method, durationMs) => executor?.recordCDPTiming(method, durationMs),
    });
    relaySession = { server, relay, downloads };
    void relay.establishExtensionConnection('Tyrs Desktop Browser Agent').then(async () => {
      if (relaySession?.relay !== relay)
        return;
      await relay.extensionCommand('tyrs.sessions.reset', []);
      executor = new BrowserExecutor(relay, tools, {
        bootstrapUrl: `http://127.0.0.1:${config.publicPort}/browser-bootstrap`,
      });
      await executor.start();
      browserExecutor = executor;
      relayConnected = true;
      extensionStatus.connected = true;
      extensionStatus.reason = '';
      await sendStatus().catch(error => log(error));
    }).catch(async error => {
      log(error);
      if (relaySession?.relay === relay) {
        relay.stop();
        await closeServer(server);
        relaySession = undefined;
        setTimeout(() => void restartRelay().catch(retryError => log(retryError)), 2_000);
      }
    });
  })().finally(() => restartingRelay = undefined);
  return await restartingRelay;
}

async function handleRemoteMessage(message, stream) {
  if (remoteStream !== stream)
    return;
  lastRemoteMessageAt = Date.now();
  if (toolArtifacts.handleMessage(message))
    return;
  if (relaySession?.downloads.handleAgentMessage(message))
    return;
  switch (message.type) {
    case 'welcome':
      if (message.protocol !== 2 || message.capabilityVersion !== capabilityVersion ||
          message.bridgeVersion !== bridgeVersion ||
          Number(message.maxFileBytes) !== 25 * 1024 * 1024 ||
          typeof message.generation !== 'string' || !Array.isArray(message.capabilities) ||
          !['local-tool-execution', 'cancellation', 'sessions', 'artifacts']
              .every(value => message.capabilities.includes(value)))
        throw new Error('Worker Browser Agent protocol is incompatible');
      remoteGeneration = message.generation;
      break;
    case 'ping':
      await stream.send({ type: 'pong', at: message.at });
      break;
    case 'pong':
      break;
    case 'session_open':
      assertGeneration(message);
      await ensureExecutor().openSession(message);
      break;
    case 'session_finalize':
      assertGeneration(message);
      await ensureExecutor().finalizeSession(String(message.sessionId || ''));
      break;
    case 'tool_call':
      assertGeneration(message);
      void executeRemoteTool(message, stream);
      break;
    case 'tool_cancel':
      assertGeneration(message);
      ensureExecutor().cancel(message);
      break;
  }
}

async function executeRemoteTool(message, stream) {
  const startedAt = performance.now();
  try {
    const executed = await ensureExecutor().callTool(message);
    if (remoteStream !== stream || message.generation !== remoteGeneration)
      return;
    const result = await toolArtifacts.externalize(stream, message, executed.result);
    if (remoteStream !== stream || message.generation !== remoteGeneration)
      return;
    await stream.send({
      type: 'tool_result',
      sessionId: message.sessionId,
      requestId: message.requestId,
      result,
      timings: { ...executed.timings,
        agentTotalMs: Math.round((performance.now() - startedAt) * 100) / 100 },
    });
  } catch (error) {
    if (remoteStream !== stream)
      return;
    const interrupted = String(error).includes('BROWSER_CONTROL_INTERRUPTED');
    if (interrupted) {
      await stream.send({ type: 'session_interrupted', sessionId: message.sessionId,
        reason: 'Browser use was stopped by the user' }).catch(() => {});
      return;
    }
    await stream.send({
      type: 'tool_result',
      sessionId: message.sessionId,
      requestId: message.requestId,
      result: {
        content: [{ type: 'text', text: `### Error\n${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      },
      timings: { agentTotalMs: Math.round((performance.now() - startedAt) * 100) / 100 },
    }).catch(() => {});
  }
}

async function handleTakeover(params) {
  const [details = {}] = Array.isArray(params) ? params : [];
  const sessionId = String(details.sessionId || browserExecutor?.currentSessionId() || '');
  if (!sessionId)
    return;
  browserExecutor?.interrupt(sessionId, 'Browser use was stopped by the user');
  await remoteStream?.send({ type: 'session_interrupted', sessionId,
    reason: 'Browser use was stopped by the user' }).catch(() => {});
}

function ensureExecutor() {
  if (!browserExecutor || !relayConnected || !extensionStatus.connected)
    throw new Error('Chrome Extension 尚未连接');
  return browserExecutor;
}

function assertGeneration(message) {
  if (!remoteGeneration || message.generation !== remoteGeneration)
    throw new Error('Browser Agent generation is stale');
}

async function sendStatus() {
  await remoteStream?.send({ type: 'status', agentVersion, ...extensionStatus,
    connected: extensionStatus.connected && relayConnected });
}

function disconnectRemote(stream) {
  if (remoteStream !== stream)
    return;
  remoteStream = undefined;
  remoteGeneration = '';
  lastRemoteMessageAt = 0;
  relaySession?.downloads.failPending(new Error('Worker relay disconnected'));
  toolArtifacts.failPending(new Error('Worker relay disconnected'));
  void browserExecutor?.stop().catch(error => log(error));
  browserExecutor = undefined;
  void restartRelay().catch(error => log(error));
}

async function shutdown() {
  clearInterval(statusTimer);
  clearInterval(heartbeatTimer);
  supervisor.stop();
  await browserExecutor?.stop().catch(error => log(error));
  relaySession?.relay.stop();
  await Promise.all([closeServer(relaySession?.server), closeServer(publicServer)]);
  process.exit(0);
}

function validateConfig(value) {
  const required = ['extensionId', 'extensionToken', 'extensionCrxPath', 'instanceId'];
  for (const name of required) {
    if (typeof value[name] !== 'string' || !value[name])
      throw new Error(`Browser Agent config is missing ${name}`);
  }
  if (!value.ssh || typeof value.ssh.host !== 'string' || typeof value.ssh.user !== 'string' ||
      typeof value.ssh.identityFile !== 'string' || typeof value.ssh.knownHostsFile !== 'string')
    throw new Error('Browser Agent SSH config is invalid');
  if (!/^[a-p]{32}$/.test(value.extensionId) || !/^[a-f0-9]{64}$/.test(value.extensionToken) ||
      !/^[0-9a-f-]{36}$/i.test(value.instanceId))
    throw new Error('Browser Agent identity config is invalid');
  if (!path.isAbsolute(value.extensionCrxPath) || !path.isAbsolute(value.ssh.identityFile) ||
      !path.isAbsolute(value.ssh.knownHostsFile) || !/^[A-Za-z0-9_.:-]+$/.test(value.ssh.host) ||
      value.ssh.host.startsWith('-') || !/^[A-Za-z0-9._-]+$/.test(value.ssh.user))
    throw new Error('Browser Agent path or SSH target is invalid');
  value.ssh.port = validPort(value.ssh.port, 22);
  value.publicPort = validPort(value.publicPort, 8931);
  value.relayPort = validPort(value.relayPort, 8932);
  if (value.publicPort === value.relayPort)
    throw new Error('Browser Agent public and relay ports must differ');
  return value;
}

function validPort(value, fallback) {
  const port = Number(value || fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`Browser Agent port is invalid: ${value}`);
  return port;
}

function authorized(header, token) {
  return header === `Bearer ${token}`;
}

async function readJSON(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit)
      throw new Error('request body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

function sendJSON(response, status, body = undefined, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store', ...headers });
  response.end(data);
}

function listen(server, port) {
  return new Promise((resolve, reject) => server.listen(port, '127.0.0.1', resolve).once('error', reject));
}

function closeServer(server) {
  if (!server?.listening)
    return Promise.resolve();
  return new Promise(resolve => server.close(resolve));
}

function log(value) {
  console.error(`[browser-agent] ${value instanceof Error ? value.stack || value.message : value}`);
}
