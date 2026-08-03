import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { allowedClient, isLoopback, parseAllowedCIDRs } from './network.mjs';
import { verifyScopedAuthorization } from './auth.mjs';

const bridgePackage = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const bridgeVersion = bridgePackage.version;
const requiredAgentVersion = bridgePackage.tyrsBrowserAgentVersion;
const requiredExtensionVersion = bridgePackage.tyrsBrowserExtensionVersion;
if (!/^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(requiredAgentVersion) ||
    !/^\d+(\.\d+){0,3}$/.test(requiredExtensionVersion))
  throw new Error('browser component versions are invalid');
const publicHost = process.env.TYRS_BROWSER_MCP_HOST || '0.0.0.0';
const publicPort = parsePort(process.env.TYRS_BROWSER_MCP_PORT, 8931);
const proxyPort = parsePort(process.env.TYRS_BROWSER_PROXY_PORT, 8932);
const internalPort = parsePort(process.env.TYRS_BROWSER_INTERNAL_MCP_PORT, 8933);
const agentPort = parsePort(process.env.TYRS_BROWSER_AGENT_PORT, 8934);
if (new Set([publicPort, proxyPort, internalPort, agentPort]).size !== 4)
  throw new Error('public, proxy, internal MCP, and agent ports must be different');
const mcpSecret = await readToken('TYRS_BROWSER_MCP_TOKEN_FILE');
const extensionToken = await readToken('TYRS_BROWSER_EXTENSION_TOKEN_FILE');
const extensionId = required('TYRS_BROWSER_EXTENSION_ID');
const releaseRoot = process.env.TYRS_BROWSER_RELEASE_DIR || '';
const exchangeRoot = process.env.TYRS_BROWSER_FILES_ROOT || '';
const allowedCIDRs = parseAllowedCIDRs(process.env.TYRS_BROWSER_ALLOWED_CIDRS || '127.0.0.0/8');
let extensionStatus = { connected: false, lastSeenAt: null };

const mcpCLI = fileURLToPath(new URL('../../cli.js', import.meta.url));
const mcpArguments = [
  mcpCLI,
  '--extension',
  '--browser', 'chrome',
  '--shared-browser-context',
  '--host', '127.0.0.1',
  '--port', String(internalPort),
  '--allowed-hosts', '*',
];
if (exchangeRoot)
  mcpArguments.push('--output-dir', exchangeRoot);
const child = spawn(process.execPath, mcpArguments, {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    ...process.env,
    PLAYWRIGHT_MCP_EXTENSION_TOKEN: extensionToken,
    PLAYWRIGHT_MCP_EXTENSION_VERSION: requiredExtensionVersion,
    PLAYWRIGHT_MCP_EXTENSION_CAPABILITY_VERSION: '1',
    PLAYWRIGHT_MCP_SCOPE_SECRET: mcpSecret,
    PLAYWRIGHT_EXTENSION_PROTOCOL: '2',
    TYRS_BROWSER_PROXY_PORT: String(proxyPort),
    TYRS_BROWSER_AGENT_PORT: String(agentPort),
    TYRS_BROWSER_AGENT_HOST: process.env.TYRS_BROWSER_AGENT_HOST || '0.0.0.0',
    TYRS_BROWSER_BRIDGE_VERSION: bridgeVersion,
    TYRS_BROWSER_REQUIRED_AGENT_VERSION: requiredAgentVersion,
    TYRS_BROWSER_REQUIRED_EXTENSION_VERSION: requiredExtensionVersion,
    TYRS_BROWSER_EXTENSION_ID: extensionId,
  },
});

child.on('exit', (code, signal) => {
  console.error(`Playwright MCP stopped: code=${code} signal=${signal}`);
  process.exit(code ?? 1);
});

const server = http.createServer(async (request, response) => {
  try {
    if (!allowedClient(request.socket, allowedCIDRs))
      return sendJSON(response, 403, { error: 'network is not allowed' });
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    if (pathname === '/health' && request.method === 'GET')
      return sendJSON(response, 200, await healthPayload());
    if (pathname === '/extension-status' && request.method === 'POST')
      return await receiveExtensionStatus(request, response);
    if (pathname === '/extension/config' && request.method === 'GET') {
      if (!isLoopback(request.socket.remoteAddress))
        return sendJSON(response, 403, { error: 'extension configuration requires loopback' });
      return sendJSON(response, 200, {
        proxyUrl: `ws://127.0.0.1:${proxyPort}/extension`,
        statusUrl: `http://127.0.0.1:${publicPort}/extension-status`,
        extensionToken,
      }, { 'access-control-allow-origin': `chrome-extension://${extensionId}` });
    }
    if (pathname === '/extension/update.xml' && request.method === 'GET')
      return await serveUpdateManifest(response);
    if (pathname === '/extension/tyrs-browser.crx' && request.method === 'GET')
      return await serveCRX(response);
    const scope = verifyScopedAuthorization(request.headers.authorization, mcpSecret);
    if (!scope)
      return sendJSON(response, 401, { error: 'unauthorized' });
    proxyToMCP(request, response, scope);
  } catch (error) {
    sendJSON(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(publicPort, publicHost, () => {
  console.log(`Tyrs Browser Bridge ${bridgeVersion} listening on ${publicHost}:${publicPort}`);
});

for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => shutdown(signal));

function proxyToMCP(request, response, scope) {
  const headers = { ...request.headers, host: `127.0.0.1:${internalPort}`,
    'x-tyrs-browser-scope': scope };
  delete headers.authorization;
  const upstream = http.request({
    host: '127.0.0.1',
    port: internalPort,
    path: request.url,
    method: request.method,
    headers,
  }, upstreamResponse => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on('error', error => sendJSON(response, 502, { error: error.message }));
  request.pipe(upstream);
}

async function receiveExtensionStatus(request, response) {
  if (!isLoopback(request.socket.remoteAddress) || !authorized(request.headers.authorization, extensionToken))
    return sendJSON(response, 401, { error: 'unauthorized' });
  const body = await readJSONBody(request, 64 * 1024);
  const compatible = Number(body.extensionProtocol) === 2 &&
    Number(body.capabilityVersion) === 1 &&
    String(body.extensionVersion || '') === requiredExtensionVersion;
  if (extensionStatus.connected && !compatible)
    return sendJSON(response, 204, undefined);
  extensionStatus = {
    connected: body.connected === true && compatible,
    profile: String(body.profile || 'current'),
    tabCount: Number(body.tabCount || 0),
    extensionVersion: String(body.extensionVersion || ''),
    extensionProtocol: Number(body.extensionProtocol || 0),
    capabilityVersion: Number(body.capabilityVersion || 0),
    chromeVersion: String(body.chromeVersion || ''),
    connectedAt: body.connectedAt || null,
    lastSeenAt: new Date().toISOString(),
  };
  sendJSON(response, 204, undefined);
}

async function healthPayload() {
  const lastSeen = extensionStatus.lastSeenAt ? Date.parse(extensionStatus.lastSeenAt) : 0;
  const connected = extensionStatus.connected === true && Date.now() - lastSeen < 45_000;
  let browserAgent = { status: 'starting', port: agentPort };
  try {
    const response = await fetch(`http://127.0.0.1:${internalPort}/browser-agent-health`, {
      signal: AbortSignal.timeout(500),
    });
    if (response.ok)
      browserAgent = { status: 'ready', port: agentPort, ...await response.json() };
    else
      browserAgent = { status: 'degraded', port: agentPort };
  } catch {
    browserAgent = { status: 'degraded', port: agentPort };
  }
  return {
    status: connected ? 'ready' : 'degraded',
    bridgeVersion,
    extensionId,
    ...extensionStatus,
    connected,
    browserAgent,
  };
}

async function serveUpdateManifest(response) {
  if (!releaseRoot)
    return sendJSON(response, 404, { error: 'release artifacts are not configured' });
  const lock = JSON.parse(await readFile(`${releaseRoot}/browser-artifacts.lock.json`, 'utf8'));
  if (lock.extensionId !== extensionId)
    throw new Error('extension release ID does not match bridge configuration');
  const codebase = `http://127.0.0.1:${publicPort}/extension/tyrs-browser.crx`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">` +
    `<app appid="${extensionId}"><updatecheck codebase="${codebase}" version="${lock.playwright.extensionVersion}"/>` +
    `</app></gupdate>`;
  response.writeHead(200, { 'content-type': 'application/xml', 'cache-control': 'no-store' });
  response.end(xml);
}

async function serveCRX(response) {
  if (!releaseRoot)
    return sendJSON(response, 404, { error: 'release artifacts are not configured' });
  const data = await readFile(`${releaseRoot}/tyrs-browser-extension.crx`);
  response.writeHead(200, {
    'content-type': 'application/x-chrome-extension',
    'content-length': data.length,
    'cache-control': 'no-store',
  });
  response.end(data);
}

function shutdown(signal) {
  server.close(() => process.exit(0));
  child.kill(signal);
  setTimeout(() => process.exit(1), 10_000).unref();
}

function authorized(header, token) {
  const value = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  const actual = Buffer.from(value);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sendJSON(response, status, body, extraHeaders = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  response.end(data);
}

async function readJSONBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit)
      throw new Error('request body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readToken(name) {
  const path = required(name);
  const token = (await readFile(path, 'utf8')).trim();
  if (!token)
    throw new Error(`${name} is empty`);
  return token;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} is required`);
  return value;
}

function parsePort(value, fallback) {
  const port = value ? Number(value) : fallback;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`invalid port: ${value}`);
  return port;
}
