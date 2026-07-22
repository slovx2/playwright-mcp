import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { allowedClient, isLoopback, parseAllowedCIDRs } from './network.mjs';

const bridgeVersion = '0.1.3';
const publicHost = process.env.TYRS_BROWSER_MCP_HOST || '0.0.0.0';
const publicPort = parsePort(process.env.TYRS_BROWSER_MCP_PORT, 8931);
const relayPort = parsePort(process.env.TYRS_BROWSER_RELAY_PORT, 8932);
const internalPort = parsePort(process.env.TYRS_BROWSER_INTERNAL_MCP_PORT, 8933);
if (new Set([publicPort, relayPort, internalPort]).size !== 3)
  throw new Error('public, relay, and internal MCP ports must be different');
const mcpToken = await readToken('TYRS_BROWSER_MCP_TOKEN_FILE');
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
    PLAYWRIGHT_EXTENSION_PROTOCOL: '2',
    TYRS_BROWSER_RELAY_PORT: String(relayPort),
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
      return sendJSON(response, 200, healthPayload());
    if (pathname === '/extension-status' && request.method === 'POST')
      return await receiveExtensionStatus(request, response);
    if (pathname === '/extension/config' && request.method === 'GET') {
      if (!isLoopback(request.socket.remoteAddress))
        return sendJSON(response, 403, { error: 'extension configuration requires loopback' });
      return sendJSON(response, 200, {
        relayUrl: `ws://127.0.0.1:${relayPort}/extension`,
        statusUrl: `http://127.0.0.1:${publicPort}/extension-status`,
        extensionToken,
      }, { 'access-control-allow-origin': `chrome-extension://${extensionId}` });
    }
    if (pathname === '/extension/update.xml' && request.method === 'GET')
      return await serveUpdateManifest(response);
    if (pathname === '/extension/tyrs-browser.crx' && request.method === 'GET')
      return await serveCRX(response);
    if (!authorized(request.headers.authorization, mcpToken))
      return sendJSON(response, 401, { error: 'unauthorized' });
    proxyToMCP(request, response);
  } catch (error) {
    sendJSON(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(publicPort, publicHost, () => {
  console.log(`Tyrs Browser Bridge ${bridgeVersion} listening on ${publicHost}:${publicPort}`);
});

for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => shutdown(signal));

function proxyToMCP(request, response) {
  const headers = { ...request.headers, host: `127.0.0.1:${internalPort}` };
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
  extensionStatus = {
    connected: body.connected === true,
    profile: String(body.profile || 'current'),
    tabCount: Number(body.tabCount || 0),
    extensionVersion: String(body.extensionVersion || ''),
    chromeVersion: String(body.chromeVersion || ''),
    connectedAt: body.connectedAt || null,
    lastSeenAt: new Date().toISOString(),
  };
  sendJSON(response, 204, undefined);
}

function healthPayload() {
  const lastSeen = extensionStatus.lastSeenAt ? Date.parse(extensionStatus.lastSeenAt) : 0;
  const connected = extensionStatus.connected === true && Date.now() - lastSeen < 45_000;
  return {
    status: connected ? 'ready' : 'degraded',
    bridgeVersion,
    extensionId,
    ...extensionStatus,
    connected,
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
