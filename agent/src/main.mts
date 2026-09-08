import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { BrowserExecutor } from './browser-executor.mjs';
import { AgentConfig, WorkerConfig, validateConfig } from './config.mjs';
import { DownloadRelay } from './download-relay.mjs';
import { SSHSupervisor } from './ssh-supervisor.mjs';
import { ServiceTunnels } from './service-tunnels.mjs';
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
const config: AgentConfig = validateConfig(JSON.parse(await fs.promises.readFile(configPath, 'utf8')));
process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = config.extensionToken;
process.env.PLAYWRIGHT_MCP_EXTENSION_VERSION = extensionVersion;
process.env.PLAYWRIGHT_EXTENSION_PROTOCOL = '2';
process.env.PLAYWRIGHT_MCP_EXTENSION_CAPABILITY_VERSION = '1';

const capabilityVersion = 2;
let extensionStatus = { connected: false, tabCount: 0, extensionVersion: '',
  extensionProtocol: 2, capabilityVersion: 1, chromeVersion: '', reason: 'Chrome extension 未连接' };
let relaySession;
let restartingRelay;
let relayConnected = false;
let browserExecutor: BrowserExecutor | undefined;
let browserExecutorLifecycle: Promise<void> = Promise.resolve();
type WorkerConnection = {
  id: string;
  worker: WorkerConfig;
  supervisor: SSHSupervisor;
  stream?: any;
  generation: string;
  sessions: Set<string>;
  services: Set<string>;
  serviceTunnels: ServiceTunnels;
  status: 'connecting' | 'connected' | 'disconnected' | 'incompatible';
  lastError?: string;
  lastConnectedAt?: string;
  lastRemoteMessageAt: number;
  remoteControlQueue: Promise<void>;
};
const workerConnections = new Map<string, WorkerConnection>();
const sessionOwners = new Map<string, WorkerConnection>();
const serviceOwners = new Map<string, WorkerConnection>();
const toolArtifacts = new ToolArtifactSender();

const publicServer = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname === '/health')
      return sendJSON(response, 200, {
        agentVersion,
        sshConnected: [...workerConnections.values()].some(connection => Boolean(connection.stream)),
        workers: [...workerConnections.values()].map(connection => ({
          id: connection.id,
          sshConnected: Boolean(connection.stream),
          status: connection.status,
          sessionCount: connection.sessions.size,
          lastError: connection.lastError,
          lastConnectedAt: connection.lastConnectedAt,
        })),
        ...extensionStatus,
        connected: extensionStatus.connected && relayConnected,
      });
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
        proxyUrl: `ws://127.0.0.1:${config.proxyPort}/extension`,
        statusUrl: `http://127.0.0.1:${config.publicPort}/extension-status`,
        extensionToken: config.extensionToken,
      }, { 'access-control-allow-origin': `chrome-extension://${config.extensionId}` });
    }
    if (url.pathname === '/extension-status' && request.method === 'POST') {
      if (!authorized(request.headers.authorization, config.extensionToken))
        return sendJSON(response, 401, { error: 'unauthorized' });
      const body = await readJSON(request, 64 * 1024);
      const compatible = Number(body.extensionProtocol) === 2 &&
        Number(body.capabilityVersion) === 1 &&
        String(body.extensionVersion || '') === extensionVersion;
      if (relayConnected && !compatible)
        return sendJSON(response, 204);
      extensionStatus = {
        connected: relayConnected,
        tabCount: Number(body.tabCount || 0),
        extensionVersion: String(body.extensionVersion || ''),
        extensionProtocol: Number(body.extensionProtocol || 0),
        capabilityVersion: Number(body.capabilityVersion || 0),
        chromeVersion: String(body.chromeVersion || ''),
        reason: relayConnected ? '' :
          (body.connected === true && Number(body.extensionProtocol) !== 2 ?
          'Chrome extension 协议版本不匹配' :
          (body.connected === true && Number(body.capabilityVersion) !== 1 ?
            'Chrome extension 能力版本不匹配' :
            (body.connected === true && String(body.extensionVersion || '') !== extensionVersion ?
            `Chrome extension 版本不匹配，需要 ${extensionVersion}` :
              'Chrome extension 或本地执行器正在连接'))),
      };
      await sendStatus().catch(error => log(error));
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

for (const worker of config.workers)
  startWorkerConnection(worker);

const statusTimer = setInterval(() => void sendStatus().catch(error => log(error)), 30_000);
const heartbeatTimer = setInterval(() => {
  for (const connection of workerConnections.values()) {
    const stream = connection.stream;
    if (!stream)
      continue;
    if (Date.now() - connection.lastRemoteMessageAt > 45_000) {
      stream.close();
      continue;
    }
    void stream.send({ type: 'ping', at: Date.now() }).catch(() => stream.close());
  }
}, 15_000);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => void shutdown());

function startWorkerConnection(worker: WorkerConfig) {
  let supervisor!: SSHSupervisor;
  const connection = {} as WorkerConnection;
  connection.id = worker.id;
  connection.worker = worker;
  connection.generation = '';
  connection.sessions = new Set();
  connection.services = new Set();
  connection.status = 'connecting';
  connection.lastRemoteMessageAt = Date.now();
  connection.remoteControlQueue = Promise.resolve();
  connection.serviceTunnels = new ServiceTunnels({ ssh: worker.ssh }, (serviceId, activeConnections) => {
    void connection.stream?.send({
      type: 'service_activity', generation: connection.generation, serviceId, activeConnections,
    }).catch(error => logWorker(connection, error));
  }, message => message && logWorker(connection, message));
  supervisor = new SSHSupervisor({ ssh: worker.ssh }, {
    onConnection: stream => {
      connection.generation = '';
      connection.stream = stream;
      connection.status = 'connected';
      connection.lastError = undefined;
      connection.lastConnectedAt = new Date().toISOString();
      connection.lastRemoteMessageAt = Date.now();
      connection.remoteControlQueue = Promise.resolve();
      stream.on('message', message => {
        if (connection.stream !== stream)
          return;
        const ordered = ['welcome', 'session_open', 'session_finalize', 'service_open',
          'service_close', 'service_reset'].includes(message.type);
        const task = ordered ?
          (connection.remoteControlQueue = connection.remoteControlQueue.then(() =>
            handleRemoteMessage(message, connection, stream))) :
          (message.type === 'tool_call' ?
            connection.remoteControlQueue.then(() => handleRemoteMessage(message, connection, stream)) :
            handleRemoteMessage(message, connection, stream));
        void task.catch(async error => {
          logWorker(connection, error);
          await stream.send({ type: 'error', message: error instanceof Error ? error.message : String(error) }).catch(() => {});
          stream.close();
        });
      });
      stream.on('close', () => disconnectWorker(connection, stream));
      void stream.send({ type: 'hello', protocol: 2, capabilityVersion, agentVersion, bridgeVersion,
        platform: 'darwin', instanceId: config.instanceId,
        capabilities: ['local-tool-execution', 'cancellation', 'sessions', 'artifacts', 'service-tunnels'] })
          .then(() => sendStatus(connection)).catch(error => logWorker(connection, error));
    },
    onDisconnect: details => {
      connection.status = connection.stream ? 'disconnected' : 'connecting';
      logWorker(connection, `SSH disconnected: ${JSON.stringify(details)}`);
    },
    onError: error => {
      connection.lastError = error instanceof Error ? error.message : String(error);
      logWorker(connection, error);
    },
    onLog: message => message && logWorker(connection, message),
  });
  connection.supervisor = supervisor;
  workerConnections.set(connection.id, connection);
  supervisor.start();
}

function logWorker(connection: WorkerConnection, value: unknown) {
  log(`[worker=${connection.id}] ${value instanceof Error ? value.stack || value.message : value}`);
}

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
      await sessionOwners.get(sessionId)?.stream?.send({
        type: 'session_interrupted',
        sessionId,
        reason: 'Desktop Browser Agent connection was reset',
      }).catch(() => {});
    }
    await stopBrowserExecutor(true);
    for (const connection of workerConnections.values()) {
      for (const sessionId of connection.sessions)
        sessionOwners.delete(sessionId);
      connection.sessions.clear();
    }
    if (relaySession) {
      relaySession.relay.stop();
      await closeServer(relaySession.server);
    }
    const server = http.createServer();
    await listen(server, config.proxyPort);
    const relay = new CDPRelayServer(server, 'chrome');
    const downloads = new DownloadRelay(relay, () => {
      const sessionId = browserExecutor?.currentSessionId() || '';
      return sessionOwners.get(sessionId)?.stream;
    }, () => browserExecutor?.currentSessionId() || '');
    relay.setDelegate({
      onExtensionEvent: (method, params) => {
        downloads.onExtensionEvent(method, params);
        if (String(method) === 'tyrs.takeover')
          void handleTakeover(params).catch(error => log(error));
      },
      onCDPMessage: (message, forward) => downloads.onCDPMessage(message, forward),
      onCDPTiming: (method, durationMs) => browserExecutor?.recordCDPTiming(method, durationMs),
      onExtensionDisconnected: () => {
        if (relaySession?.relay === relay && relayConnected)
          void restartRelay().catch(error => log(error));
      },
    });
    relaySession = { server, relay, downloads };
    void relay.establishExtensionConnection('Tyrs Desktop Browser Agent').then(async () => {
      if (relaySession?.relay !== relay)
        return;
      await relay.extensionCommand('tyrs.sessions.reset', []);
      relayConnected = true;
      extensionStatus.connected = true;
      extensionStatus.extensionVersion = extensionVersion;
      extensionStatus.extensionProtocol = 2;
      extensionStatus.capabilityVersion = 1;
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

async function handleRemoteMessage(message, connection: WorkerConnection, stream = connection.stream) {
  if (connection.stream !== stream)
    return;
  if (!stream)
    return;
  connection.lastRemoteMessageAt = Date.now();
  if (toolArtifacts.handleMessage(message, stream))
    return;
  if (relaySession?.downloads.handleAgentMessage(message, stream))
    return;
  switch (message.type) {
    case 'welcome':
      if (message.protocol !== 2 || message.capabilityVersion !== capabilityVersion ||
          message.bridgeVersion !== bridgeVersion ||
          Number(message.maxFileBytes) !== 25 * 1024 * 1024 ||
          typeof message.generation !== 'string' || !Array.isArray(message.capabilities) ||
          !['local-tool-execution', 'cancellation', 'sessions', 'artifacts', 'service-tunnels']
              .every(value => message.capabilities.includes(value)))
        throw new Error('Worker Browser Agent protocol is incompatible');
      connection.generation = message.generation;
      connection.status = 'connected';
      break;
    case 'ping':
      await stream.send({ type: 'pong', at: message.at });
      break;
    case 'pong':
      break;
    case 'session_open':
      assertGeneration(connection, message);
      claimSession(connection, message);
      await (await ensureExecutor()).openSession(message);
      break;
    case 'session_finalize':
      assertGeneration(connection, message);
      await finalizeOwnedSession(connection, String(message.sessionId || ''));
      break;
    case 'tool_call':
      assertGeneration(connection, message);
      assertSessionOwner(connection, message);
      void executeRemoteTool(message, connection);
      break;
    case 'tool_cancel':
      assertGeneration(connection, message);
      assertSessionOwner(connection, message);
      browserExecutor?.cancel(message);
      break;
    case 'service_open':
      assertGeneration(connection, message);
      await handleServiceOpen(message, connection);
      break;
    case 'service_close':
      assertGeneration(connection, message);
      await handleServiceClose(message, connection);
      break;
    case 'service_reset':
      assertGeneration(connection, message);
      await connection.serviceTunnels.closeAll();
      for (const serviceId of connection.services)
        serviceOwners.delete(serviceId);
      connection.services.clear();
      break;
  }
}

function claimSession(connection: WorkerConnection, message) {
  const sessionId = String(message.sessionId || '');
  if (!/^[0-9a-f-]{36}$/i.test(sessionId))
    throw new Error('Invalid browser session ID');
  if (sessionOwners.has(sessionId))
    throw new Error('Browser session ID is already owned by another connection');
  sessionOwners.set(sessionId, connection);
  connection.sessions.add(sessionId);
}

function assertSessionOwner(connection: WorkerConnection, message) {
  const sessionId = String(message.sessionId || '');
  if (sessionOwners.get(sessionId) !== connection)
    throw new Error('Browser session belongs to another Worker connection');
}

async function finalizeOwnedSession(connection: WorkerConnection, sessionId: string) {
  if (sessionOwners.get(sessionId) !== connection)
    return;
  sessionOwners.delete(sessionId);
  connection.sessions.delete(sessionId);
  try {
    await browserExecutor?.finalizeSession(sessionId);
  } finally {
    await stopBrowserExecutor(false);
  }
}

async function handleServiceOpen(message, connection: WorkerConnection) {
  const stream = connection.stream;
  if (!stream)
    return;
  try {
    const serviceId = String(message.serviceId || '');
    const existingOwner = serviceOwners.get(serviceId);
    if (existingOwner && existingOwner !== connection)
      throw new Error('Service tunnel belongs to another Worker connection');
    const endpointPort = await connection.serviceTunnels.open(serviceId,
        Number(message.targetPort));
    serviceOwners.set(serviceId, connection);
    connection.services.add(serviceId);
    await stream.send({
      type: 'service_result', requestId: message.requestId,
      serviceId: message.serviceId, endpointPort,
    });
  } catch (error) {
    await stream.send({
      type: 'service_result', requestId: message.requestId,
      serviceId: message.serviceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleServiceClose(message, connection: WorkerConnection) {
  const stream = connection.stream;
  if (!stream)
    return;
  try {
    const serviceId = String(message.serviceId || '');
    if (serviceOwners.get(serviceId) !== connection)
      throw new Error('Service tunnel belongs to another Worker connection');
    await connection.serviceTunnels.close(serviceId);
    serviceOwners.delete(serviceId);
    connection.services.delete(serviceId);
    await stream.send({
      type: 'service_result', requestId: message.requestId, serviceId: message.serviceId,
    });
  } catch (error) {
    await stream.send({
      type: 'service_result', requestId: message.requestId,
      serviceId: message.serviceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function executeRemoteTool(message, connection: WorkerConnection) {
  const stream = connection.stream;
  const startedAt = performance.now();
  let executor: BrowserExecutor | undefined;
  try {
    if (!isCurrentConnection(connection, message))
      return;
    executor = await ensureExecutor();
    const executed = await executor.callTool(message);
    if (!isCurrentConnection(connection, message))
      return;
    const result = await toolArtifacts.externalize(stream, message, executed.result);
    if (!isCurrentConnection(connection, message))
      return;
    await stream.send({
      type: 'tool_result',
      sessionId: message.sessionId,
      requestId: message.requestId,
      result,
      timings: { ...executed.timings,
        agentTotalMs: Math.round((performance.now() - startedAt) * 100) / 100 },
    });
    if (executed.result?.isClose)
      await finalizeOwnedSession(connection, String(message.sessionId || ''));
  } catch (error) {
    if (!isCurrentConnection(connection, message))
      return;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const interrupted = errorMessage.includes('BROWSER_CONTROL_INTERRUPTED');
    if (interrupted) {
      const reason = errorMessage.slice(errorMessage.indexOf('BROWSER_CONTROL_INTERRUPTED') +
        'BROWSER_CONTROL_INTERRUPTED'.length).replace(/^:\s*/, '') || 'Browser control yielded to the user';
      await stream.send({ type: 'session_interrupted', sessionId: message.sessionId,
        reason }).catch(() => {});
      return;
    }
    const metadataUnavailable = errorMessage.includes('BROWSER_METADATA_UNAVAILABLE');
    await stream.send({
      type: 'tool_result',
      sessionId: message.sessionId,
      requestId: message.requestId,
      result: {
        content: [{ type: 'text', text: `### Error\n${errorMessage}` }],
        isError: true,
        ...(metadataUnavailable ? { isClose: true } : {}),
      },
      timings: { agentTotalMs: Math.round((performance.now() - startedAt) * 100) / 100 },
    }).catch(() => {});
    if (metadataUnavailable)
      await finalizeOwnedSession(connection, String(message.sessionId || ''));
  }
}

async function handleTakeover(params) {
  const [details = {}] = Array.isArray(params) ? params : [];
  const sessionId = String(details.sessionId || browserExecutor?.currentSessionId() || '');
  if (!sessionId)
    return;
  const kind = String(details.kind || 'input');
  if (sessionOwners.has(sessionId))
    browserExecutor?.interruptActiveCall(sessionId, `Browser control yielded to the user (${kind})`);
}

async function ensureExecutor(): Promise<BrowserExecutor> {
  return await queueBrowserExecutorLifecycle(async () => {
    if (browserExecutor)
      return browserExecutor;
    if (!relaySession || !relayConnected || !extensionStatus.connected)
      throw new Error('Chrome Extension 尚未连接');
    const relay = relaySession.relay;
    const executor = new BrowserExecutor(relay, tools, {
      bootstrapUrl: `http://127.0.0.1:${config.publicPort}/browser-bootstrap`,
    });
    await executor.start();
    if (relaySession?.relay !== relay || !relayConnected) {
      await executor.stop().catch(() => {});
      throw new Error('Chrome Extension 连接在初始化期间发生变化');
    }
    browserExecutor = executor;
    return executor;
  });
}

async function stopBrowserExecutor(force: boolean, expected?: BrowserExecutor,
    abandonMetadataFailure = false): Promise<void> {
  await queueBrowserExecutorLifecycle(async () => {
    const executor = browserExecutor;
    if (expected && executor !== expected)
      return;
    if (!executor || (!force && executor.sessionIds().length > 0))
      return;
    browserExecutor = undefined;
    const stopping = abandonMetadataFailure ? executor.abandonMetadataFailure() : executor.stop();
    await stopping.catch(error => log(error));
  });
}

function queueBrowserExecutorLifecycle<T>(callback: () => T | Promise<T>): Promise<T> {
  const result = browserExecutorLifecycle.then(callback, callback);
  browserExecutorLifecycle = result.then(() => {}, () => {});
  return result;
}

function isCurrentConnection(connection: WorkerConnection, message): boolean {
  return Boolean(connection.stream) && connection.generation !== '' &&
    message.generation === connection.generation &&
    sessionOwners.get(String(message.sessionId || '')) === connection;
}

function assertGeneration(connection: WorkerConnection, message) {
  if (!connection.generation || message.generation !== connection.generation)
    throw new Error('Browser Agent generation is stale');
}

async function sendStatus(connection?: WorkerConnection) {
  const payload = { type: 'status', agentVersion, ...extensionStatus,
    connected: extensionStatus.connected && relayConnected };
  if (connection) {
    await connection.stream?.send(payload);
    return;
  }
  await Promise.all([...workerConnections.values()].map(item =>
    item.stream?.send(payload).catch(error => logWorker(item, error))));
}

async function disconnectWorker(connection: WorkerConnection, stream) {
  if (connection.stream !== stream)
    return;
  connection.stream = undefined;
  connection.generation = '';
  connection.lastRemoteMessageAt = 0;
  connection.status = 'disconnected';
  const reason = new Error(`Worker ${connection.id} Browser Agent disconnected`);
  relaySession?.downloads.failPending(reason, stream);
  toolArtifacts.failPending(reason, stream);
  const sessions = [...connection.sessions];
  for (const sessionId of sessions) {
    sessionOwners.delete(sessionId);
    connection.sessions.delete(sessionId);
    await stream.send({ type: 'session_interrupted', sessionId,
      reason: reason.message }).catch(() => {});
    await browserExecutor?.finalizeSession(sessionId).catch(error => logWorker(connection, error));
  }
  const services = [...connection.services];
  connection.services.clear();
  for (const serviceId of services)
    serviceOwners.delete(serviceId);
  await connection.serviceTunnels.closeAll().catch(error => logWorker(connection, error));
  await stopBrowserExecutor(false);
  logWorker(connection, 'Worker connection cleaned up');
}

async function shutdown() {
  clearInterval(statusTimer);
  clearInterval(heartbeatTimer);
  for (const connection of workerConnections.values()) {
    connection.supervisor.stop();
    await connection.serviceTunnels.closeAll();
  }
  await stopBrowserExecutor(true);
  relaySession?.relay.stop();
  await Promise.all([closeServer(relaySession?.server), closeServer(publicServer)]);
  process.exit(0);
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
