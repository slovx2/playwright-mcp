import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BrowserExecutor,
  decorateTabListResult,
  waitForPageDiscovery,
} from '../lib/browser-executor.mjs';

const sessionId = '11111111-1111-4111-8111-111111111111';

function resultFor(tabs) {
  return { content: [{ type: 'text', text: JSON.stringify({ session: 'Test', tabs }, null, 2) }] };
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

test('tab discovery tolerates Chrome pages that do not enter the Playwright context', async () => {
  const context = { pages: () => [{ id: 'available' }] };
  await waitForPageDiscovery(context, 3, { timeoutMs: 20, settleMs: 1 });
  assert.equal(context.pages().length, 1);
});

test('maps an agent tab when the Chrome title is temporarily empty', () => {
  const session = { tabIds: new Map() };
  const result = resultFor([{
    id: 'backend-tab',
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

  const tab = JSON.parse(result.content[0].text).tabs[0];
  assert.equal(tab.tabId, 'chrome-tab:42');
  assert.equal(tab.origin, 'agent');
  assert.equal(tab.source, 'agent');
  assert.deepEqual(tab.lease, { ownerSessionId: sessionId, ownedByCurrentSession: true });
  assert.equal(session.tabIds.get('chrome-tab:42'), 'backend-tab');
});

test('restores retained metadata when a new backend sees the page as user-owned', () => {
  const session = { tabIds: new Map() };
  const result = resultFor([{
    id: 'backend-retained',
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

  const tab = JSON.parse(result.content[0].text).tabs[0];
  assert.equal(tab.tabId, 'chrome-tab:84');
  assert.equal(tab.origin, 'agent');
  assert.equal(tab.source, 'agent');
  assert.equal(tab.disposition, 'handoff');
  assert.equal(tab.lease, null);
});

test('does not guess between indistinguishable user tabs', () => {
  const session = { tabIds: new Map() };
  const result = resultFor([{
    id: 'backend-user',
    url: 'https://example.net/',
    title: '',
    origin: 'user',
    current: false,
  }]);

  decorateTabListResult(sessionId, session, result, [
    { id: 1, url: 'https://example.net/', title: '', tyrs: {} },
    { id: 2, url: 'https://example.net/', title: '', tyrs: {} },
  ]);

  const tab = JSON.parse(result.content[0].text).tabs[0];
  assert.equal(tab.tabId, undefined);
  assert.equal(session.tabIds.size, 0);
});
