import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BrowserExecutor,
  decorateTabListResult,
  waitForPageDiscovery,
} from '../lib/browser-executor.mjs';

const sessionId = '11111111-1111-4111-8111-111111111111';

function resultFor(controlledTabs, userTabs = []) {
  return { content: [{ type: 'text', text: JSON.stringify({ session: 'Test', controlledTabs, userTabs }, null, 2) }] };
}

test('discovers Chrome tabs before starting the Playwright CDP connection', async () => {
  const calls = [];
  const relay = {
    async discoverTabs() {
      calls.push('discover');
      return { count: 1, tabs: [] };
    },
    cdpEndpoint() {
      calls.push('endpoint');
      throw new Error('stop after discovery');
    },
  };
  const executor = new BrowserExecutor(relay, {
    BrowserBackend: class {},
    browserTools: [],
  }, { bootstrapUrl: 'http://127.0.0.1:8931/browser-bootstrap' });

  await assert.rejects(() => executor.start(), /stop after discovery/);
  assert.deepEqual(calls, ['discover', 'endpoint']);
});

test('bounds initial metadata discovery before opening a CDP connection', async () => {
  let closeReason = '';
  const relay = {
    async discoverTabs() {
      return await new Promise(() => {});
    },
    closeCDPConnection(reason) {
      closeReason = reason;
    },
    cdpEndpoint() {
      throw new Error('must not open CDP after metadata failure');
    },
  };
  const executor = new BrowserExecutor(relay, {
    BrowserBackend: class {},
    browserTools: [],
  }, { bootstrapUrl: 'http://127.0.0.1:8931/browser-bootstrap' });

  await assert.rejects(() => executor.start(),
      /BROWSER_METADATA_UNAVAILABLE stage=discoverTabs durationMs=5\d{3}/);
  assert.equal(closeReason, 'BROWSER_METADATA_UNAVAILABLE');
});

test('creates the bootstrap tab only when an operation needs a page', async () => {
  const backendCalls = [];
  const extensionCalls = [];
  let metadataReads = 0;
  class Backend {
    #lastMetadata;
    #primedMetadata;
    async initialize() {}
    async callTool(name, args) {
      backendCalls.push({ name, args });
      if (name !== 'browser_session_name') {
        if (this.#primedMetadata) {
          this.#lastMetadata = this.#primedMetadata;
          this.#primedMetadata = undefined;
        } else {
          metadataReads++;
          this.#lastMetadata = [];
        }
      }
      return { content: [{ type: 'text', text: '{}' }] };
    }
    primeTabMetadata(metadata) { this.#primedMetadata = metadata; }
    lastTabMetadata() { return this.#lastMetadata; }
    async dispose() {}
  }
  const relay = {
    async extensionCommand(method, params) {
      extensionCalls.push({ method, params });
      return {};
    },
  };
  const executor = new BrowserExecutor(relay, {
    BrowserBackend: Backend,
    browserTools: [],
  }, { bootstrapUrl: 'http://127.0.0.1:8931/browser-bootstrap' });

  await executor.openSession({ sessionId, clientName: 'Test' });
  assert.equal(backendCalls.some(call => call.name === 'browser_tabs' && call.args.action === 'new'), false);

  await executor.callTool({
    sessionId,
    requestId: '22222222-2222-4222-8222-222222222222',
    deadlineMs: Date.now() + 10_000,
    name: 'browser_navigate',
    arguments: { url: 'https://example.com' },
  });
  assert.deepEqual(backendCalls.slice(-2).map(call => [call.name, call.args.action]), [
    ['browser_tabs', 'new'],
    ['browser_navigate', undefined],
  ]);
  assert.equal(extensionCalls.some(call => call.method === 'tyrs.session.activate'), true);
  assert.equal(metadataReads, 1);

  await executor.callTool({
    sessionId,
    requestId: '33333333-3333-4333-8333-333333333333',
    deadlineMs: Date.now() + 10_000,
    name: 'browser_batch',
    arguments: { actions: [
      { name: 'browser_tabs', arguments: { action: 'list' } },
      { name: 'browser_tabs', arguments: { action: 'list' } },
    ] },
  });
  assert.equal(metadataReads, 2);

  await executor.finalizeSession(sessionId);
});

test('metadata failure abandons sessions without waiting for CDP release', async () => {
  let disposed = 0;
  let reset = 0;
  class Backend {
    async initialize() {}
    async callTool() { return { content: [{ type: 'text', text: '{}' }] }; }
    async dispose() { disposed++; }
  }
  const relay = {
    async extensionCommand(method) {
      if (method === 'tyrs.sessions.reset')
        reset++;
      return {};
    },
    async releaseCDP() {
      throw new Error('must not wait for CDP release');
    },
  };
  const executor = new BrowserExecutor(relay, {
    BrowserBackend: Backend,
    browserTools: [],
  }, { bootstrapUrl: 'http://127.0.0.1:8931/browser-bootstrap' });
  await executor.openSession({ sessionId, clientName: 'Test' });
  await executor.abandonMetadataFailure();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disposed, 1);
  assert.equal(reset, 1);
  assert.deepEqual(executor.sessionIds(), []);
});

test('tab discovery tolerates Chrome pages that do not enter the Playwright context', async () => {
  const context = { pages: () => [{ id: 'available' }] };
  await waitForPageDiscovery(context, 3, { timeoutMs: 20, settleMs: 1 });
  assert.equal(context.pages().length, 1);
});

test('maps an agent tab when the Chrome title is temporarily empty', () => {
  const session = { tabIds: new Map(), claimTokens: new Map() };
  const result = resultFor([{
    tabId: 'backend-tab',
    url: 'https://example.com/result',
    title: 'Example Domain',
    origin: 'agent',
    current: true,
  }]);

  decorateTabListResult(sessionId, session, result, [{
    id: 42,
    url: 'https://example.com/result',
    title: '',
    tyrs: { sessionId, sessionName: 'Test', origin: 'agent', disposition: 'omit' },
  }]);

  const tab = JSON.parse(result.content[0].text).controlledTabs[0];
  assert.equal(tab.tabId, 'chrome-tab:42');
  assert.equal(tab.origin, 'agent');
  assert.equal(tab.source, 'agent');
  assert.deepEqual(tab.lease, { ownerSessionId: sessionId, ownedByCurrentSession: true });
  assert.equal(session.tabIds.get('chrome-tab:42'), 'backend-tab');
});

test('restores retained metadata when a new backend sees the page as user-owned', () => {
  const session = { tabIds: new Map(), claimTokens: new Map() };
  const result = resultFor([{
    tabId: 'backend-retained',
    url: 'https://example.org/result',
    title: 'Example Domain',
    origin: 'user',
    current: false,
  }]);

  decorateTabListResult(sessionId, session, result, [{
    id: 84,
    url: 'https://example.org/result',
    title: '',
    tyrs: { sessionName: 'Handoff', origin: 'agent', disposition: 'handoff' },
  }]);

  const tab = JSON.parse(result.content[0].text).controlledTabs[0];
  assert.equal(tab.tabId, 'chrome-tab:84');
  assert.equal(tab.origin, 'agent');
  assert.equal(tab.source, 'agent');
  assert.equal(tab.disposition, 'handoff');
  assert.equal(tab.lease, null);
});

test('does not guess between indistinguishable user tabs', () => {
  const session = { tabIds: new Map(), claimTokens: new Map() };
  const result = resultFor([], [{
    claimToken: '11111111-2222-4333-8444-555555555555',
    url: 'https://example.net/',
    title: '',
    origin: 'user',
    current: false,
  }]);

  decorateTabListResult(sessionId, session, result, [
    { id: 1, url: 'https://example.net/', title: '', tyrs: {} },
    { id: 2, url: 'https://example.net/', title: '', tyrs: {} },
  ]);

  const tab = JSON.parse(result.content[0].text).userTabs[0];
  assert.equal(tab.claimToken, '11111111-2222-4333-8444-555555555555');
  assert.equal(session.tabIds.size, 0);
  assert.equal(session.claimTokens.size, 0);
});

test('does not expose a tab leased by another session as claimable', () => {
  const session = { tabIds: new Map(), claimTokens: new Map() };
  const claimToken = '11111111-2222-4333-8444-555555555555';
  const result = resultFor([], [{
    claimToken,
    url: 'https://example.net/leased',
    title: '',
    origin: 'user',
    current: false,
  }]);

  decorateTabListResult(sessionId, session, result, [{
    id: 8,
    url: 'https://example.net/leased',
    title: 'Other session',
    tyrs: { sessionId: '22222222-2222-4222-8222-222222222222', origin: 'user' },
  }]);

  assert.equal(session.claimTokens.has(claimToken), false);
});

test('maps an opaque claim token to one unambiguous user tab', () => {
  const session = { tabIds: new Map(), claimTokens: new Map() };
  const claimToken = '11111111-2222-4333-8444-555555555555';
  const result = resultFor([], [{
    claimToken,
    url: 'https://example.net/',
    title: 'Example',
    current: false,
  }]);

  decorateTabListResult(sessionId, session, result, [
    { id: 7, url: 'https://example.net/', title: 'Example', tyrs: {} },
  ]);

  assert.equal(session.claimTokens.get(claimToken), 'chrome-tab:7');
  assert.equal(JSON.parse(result.content[0].text).userTabs[0].tabId, undefined);
});

test('uses native metadata for the stable desktop tab result', () => {
  const session = { tabIds: new Map(), claimTokens: new Map() };
  const result = resultFor([{
    tabId: 'backend-tab',
    url: 'https://example.com/old',
    title: 'Old renderer title',
    current: false,
    origin: 'agent',
  }]);

  decorateTabListResult(sessionId, session, result, [{
    id: 9,
    url: 'https://example.com/old',
    title: 'Native title',
    active: true,
    tyrs: { sessionId, origin: 'agent' },
  }]);

  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.currentTabId, 'chrome-tab:9');
  assert.equal(parsed.controlledTabs[0].tabId, 'chrome-tab:9');
  assert.equal(parsed.controlledTabs[0].title, 'Native title');
  assert.equal(parsed.controlledTabs[0].url, 'https://example.com/old');
  assert.equal(parsed.controlledTabs[0].current, true);
});
