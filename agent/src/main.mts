import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { WebSocket } from 'ws';

import { DownloadRelay } from './download-relay.mjs';
import { SSHSupervisor } from './ssh-supervisor.mjs';

const require = createRequire(import.meta.url);
const { tools } = require('playwright-core/lib/coreBundle');
const { CDPRelayServer } = tools;
const releaseInfo = JSON.parse(await fs.promises.readFile(
    new URL('../browser-agent-release.json', import.meta.url), 'utf8'));
const agentVersion = releaseInfo.agentVersion;
const extensionVersion = releaseInfo.extensionVersion;
if (!/^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(agentVersion) ||
    !/^\d+(\.\d+){0,3}$/.test(extensionVersion))
  throw new Error('Browser Agent release metadata is invalid');

const configPath = process.env.TYRS_BROWSER_AGENT_CONFIG || path.join(os.homedir(),
    'Library', 'Application Support', 'Tyrs Hand', 'browser-agent', 'config.json');
const config = validateConfig(JSON.parse(await fs.promises.readFile(configPath, 'utf8')));
process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = config.extensionToken;
process.env.PLAYWRIGHT_EXTENSION_PROTOCOL = '2';

let remoteStream;
let cdpSocket;
let cdpStreamId;
let pendingCDPMessages = [];
let extensionStatus = { connected: false, tabCount: 0, extensionVersion: '', chromeVersion: '' };
let relaySession;
let restartingRelay;
let relayConnected = false;
let lastRemoteMessageAt = 0;

const publicServer = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname === '/health')
      return sendJSON(response, 200, { agentVersion, sshConnected: Boolean(remoteStream),
        ...extensionStatus, connected: extensionStatus.connected && relayConnected });
    if (url.pathname === '/extension/config')
      return sendJSON(response, 200, {
        relayUrl: `ws://127.0.0.1:${config.relayPort}/extension`,
        statusUrl: `http://127.0.0.1:${config.publicPort}/extension-status`,
        extensionToken: config.extensionToken,
      }, { 'access-control-allow-origin': `chrome-extension://${config.extensionId}` });
    if (url.pathname === '/extension-status' && request.method === 'POST') {
      if (!authorized(request.headers.authorization, config.extensionToken))
        return sendJSON(response, 401, { error: 'unauthorized' });
      const body = await readJSON(request, 64 * 1024);
      const wasConnected = extensionStatus.connected;
      extensionStatus = {
        connected: body.connected === true,
        tabCount: Number(body.tabCount || 0),
        extensionVersion: String(body.extensionVersion || ''),
        chromeVersion: String(body.chromeVersion || ''),
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
    lastRemoteMessageAt = Date.now();
    stream.on('message', message => void handleRemoteMessage(message, stream).catch(async error => {
      log(error);
      await stream.send({ type: 'error', message: error instanceof Error ? error.message : String(error) }).catch(() => {});
      stream.close();
    }));
    stream.on('close', () => disconnectRemote(stream));
    void stream.send({ type: 'hello', protocol: 1, agentVersion, platform: 'darwin', instanceId: config.instanceId })
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
    relayConnected = false;
    await sendStatus().catch(error => log(error));
    cdpSocket?.close();
    cdpSocket = undefined;
    if (relaySession) {
      relaySession.relay.stop();
      await closeServer(relaySession.server);
    }
    const server = http.createServer();
    await listen(server, config.relayPort);
    const relay = new CDPRelayServer(server, 'chrome');
    const downloads = new DownloadRelay(relay, () => remoteStream);
    relay.setDelegate({
      onExtensionEvent: (method, params) => downloads.onExtensionEvent(method, params),
      onCDPMessage: (message, forward) => downloads.onCDPMessage(message, forward),
    });
    relaySession = { server, relay, downloads };
    void relay.establishExtensionConnection('Tyrs Desktop Browser Agent').then(async () => {
      if (relaySession?.relay !== relay)
        return;
      relayConnected = true;
      extensionStatus.connected = true;
      await sendStatus().catch(error => log(error));
    }).catch(async error => {
      log(error);
      if (relaySession?.relay === relay)
        await restartRelay();
    });
  })().finally(() => restartingRelay = undefined);
  return await restartingRelay;
}

async function handleRemoteMessage(message, stream) {
  if (remoteStream !== stream)
    return;
  lastRemoteMessageAt = Date.now();
  if (relaySession?.downloads.handleAgentMessage(message))
    return;
  switch (message.type) {
    case 'welcome':
      if (message.protocol !== 1 || Number(message.maxFileBytes) !== 25 * 1024 * 1024)
        throw new Error('Worker Browser Agent protocol is incompatible');
      break;
    case 'ping':
      await stream.send({ type: 'pong', at: message.at });
      break;
    case 'pong':
      break;
    case 'cdp_open':
      await openCDP(String(message.streamId || ''));
      break;
    case 'cdp_message':
      if (message.streamId === cdpStreamId && cdpSocket?.readyState === WebSocket.OPEN)
        cdpSocket.send(String(message.message || ''));
      else if (message.streamId === cdpStreamId && cdpSocket?.readyState === WebSocket.CONNECTING)
        pendingCDPMessages.push(String(message.message || ''));
      break;
    case 'cdp_close':
      if (message.streamId === cdpStreamId) {
        cdpSocket?.close();
        await restartRelay();
      }
      break;
  }
}

async function openCDP(streamId) {
  if (restartingRelay)
    await restartingRelay;
  if (!relayConnected || !extensionStatus.connected)
    throw new Error('Chrome Extension 尚未连接');
  cdpSocket?.close();
  cdpStreamId = streamId;
  pendingCDPMessages = [];
  const socket = new WebSocket(relaySession.relay.cdpEndpoint());
  cdpSocket = socket;
  socket.on('open', () => {
    for (const message of pendingCDPMessages)
      socket.send(message);
    pendingCDPMessages = [];
  });
  socket.on('message', data => void remoteStream?.send({ type: 'cdp_message', streamId, message: data.toString() }).catch(error => log(error)));
  socket.on('close', () => {
    if (cdpSocket !== socket)
      return;
    cdpSocket = undefined;
    void remoteStream?.send({ type: 'cdp_close', streamId }).catch(() => {});
  });
  socket.on('error', error => log(error));
}

async function sendStatus() {
  await remoteStream?.send({ type: 'status', agentVersion, ...extensionStatus,
    connected: extensionStatus.connected && relayConnected });
}

function disconnectRemote(stream) {
  if (remoteStream !== stream)
    return;
  remoteStream = undefined;
  lastRemoteMessageAt = 0;
  relaySession?.downloads.failPending(new Error('Worker relay disconnected'));
  cdpSocket?.close();
  void restartRelay().catch(error => log(error));
}

async function shutdown() {
  clearInterval(statusTimer);
  clearInterval(heartbeatTimer);
  supervisor.stop();
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
