import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright-core';

type Session = {
  backend: any;
  bootstrapPending: boolean;
  queue: Promise<void>;
  controllers: Map<string, AbortController>;
  activeRequestId?: string;
  workspace: string;
  timing?: { cdpCount: number; cdpMs: number };
  tabIds: Map<string, string>;
  claimTokens: Map<string, string>;
};

export class BrowserExecutor {
  #relay: any;
  #BrowserBackend: any;
  #browserTools: any[];
  #browser: any;
  #context: any;
  #bootstrapUrl: string;
  #sessions = new Map<string, Session>();
  #activeSessionIds = new Set<string>();
  #ownershipQueue = Promise.resolve();

  constructor(relay, tools, options: { bootstrapUrl: string }) {
    this.#relay = relay;
    this.#BrowserBackend = tools.BrowserBackend;
    this.#browserTools = tools.browserTools;
    const bootstrapUrl = new URL(options.bootstrapUrl);
    if (bootstrapUrl.protocol !== 'http:' || bootstrapUrl.hostname !== '127.0.0.1')
      throw new Error('Browser bootstrap URL must use loopback HTTP');
    this.#bootstrapUrl = bootstrapUrl.href;
  }

  currentSessionId() {
    return this.#activeSessionIds.size === 1 ? [...this.#activeSessionIds][0] : '';
  }

  sessionIds() {
    return [...this.#sessions.keys()];
  }

  recordCDPTiming(_method, durationMs) {
    if (this.#activeSessionIds.size !== 1)
      return;
    const session = this.#sessions.get([...this.#activeSessionIds][0]);
    if (!session?.timing)
      return;
    session.timing.cdpCount++;
    session.timing.cdpMs += durationMs;
  }

  async start() {
    await this.#readNativeTabMetadata();
    this.#browser = await chromium.connectOverCDP(this.#relay.cdpEndpoint(), {
      isLocal: true,
      timeout: 0,
    } as any);
    this.#context = this.#browser.contexts()[0];
    if (!this.#context)
      throw new Error('Chrome 没有可用的浏览器上下文');
  }

  async openSession(message) {
    const sessionId = requiredId(message.sessionId, 'sessionId');
    if (this.#sessions.has(sessionId))
      throw new Error('Browser session already exists');
    let workspace = '';
    let backend;
    const sessionName = defaultSessionName(String(message.clientName || 'Browser task'));
    try {
      await this.#relay.extensionCommand('tyrs.session.open', [{
        sessionId,
        name: sessionName,
        bootstrapUrl: `${this.#bootstrapUrl}#${sessionId}`,
      }]);
      workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), `tyrs-browser-${sessionId.slice(0, 8)}-`));
      backend = new this.#BrowserBackend({
        codegen: 'none',
        imageResponses: 'allow',
        outputDir: workspace,
        outputMode: 'stdout',
        snapshot: { mode: 'none' },
        isolatedTabs: true,
        protectSensitiveData: true,
        timeouts: { action: 5_000, navigation: 60_000, expect: 5_000 },
      }, this.#context, this.#browserTools, {
        sessionId,
        listTabs: async () => normalizeTabMetadata(await this.#discoverTabs()),
        invalidate: reason => this.#relay.closeCDPConnection?.(reason),
      });
      await backend.initialize({
        clientName: String(message.clientName || 'Tyrs Browser'),
        cwd: workspace,
        scope: sessionId,
      });
      await backend.callTool('browser_session_name', {
        name: sessionName,
      }, new AbortController().signal);
      this.#sessions.set(sessionId, {
        backend,
        bootstrapPending: true,
        queue: Promise.resolve(),
        controllers: new Map(),
        workspace,
        tabIds: new Map(),
        claimTokens: new Map(),
      });
    } catch (error) {
      await backend?.dispose().catch(() => {});
      if (workspace)
        await fs.promises.rm(workspace, { recursive: true, force: true }).catch(() => {});
      await this.#relay.extensionCommand('tyrs.session.finalize', [{ sessionId }]).catch(() => {});
      throw error;
    }
  }

  async callTool(message) {
    const sessionId = requiredId(message.sessionId, 'sessionId');
    const requestId = requiredId(message.requestId, 'requestId');
    const session = this.#sessions.get(sessionId);
    if (!session)
      throw new Error('Browser session is not open');
    const requestedName = String(message.name || '');
    const requestedArgs = message.arguments || {};
    const controller = new AbortController();
    session.controllers.set(requestId, controller);
    const queuedAt = performance.now();
    const run = async () => {
      if (Number(message.deadlineMs) <= Date.now())
        throw new Error('Browser tool deadline elapsed before execution');
      this.#activeSessionIds.add(sessionId);
      session.activeRequestId = requestId;
      const executionStartedAt = performance.now();
      session.timing = { cdpCount: 0, cdpMs: 0 };
      try {
        await this.#relay.extensionCommand('tyrs.session.activate', [{ sessionId }]);
        const name = requestedName;
        const result = name === 'browser_batch' ?
          await this.#callBatch(sessionId, session, requestedArgs, controller.signal) :
          await this.#callSingle(sessionId, session, name, requestedArgs, controller.signal);
        controller.signal.throwIfAborted();
        const timing = session.timing;
        return {
          result,
          timings: {
            queueMs: round(executionStartedAt - queuedAt),
            executionMs: round(performance.now() - executionStartedAt),
            cdpMs: round(timing?.cdpMs || 0),
            cdpCount: timing?.cdpCount || 0,
            backend: result?._meta?.tyrsTiming,
          },
        };
      } finally {
        await this.#relay.extensionCommand('tyrs.session.idle', [{ sessionId }]).catch(() => {});
        session.controllers.delete(requestId);
        if (session.activeRequestId === requestId)
          session.activeRequestId = undefined;
        this.#activeSessionIds.delete(sessionId);
        session.timing = undefined;
      }
    };
    const name = requestedName;
    const args = requestedArgs;
    const resultPromise = session.queue.then(() =>
      isOwnershipSensitive(name, args) ? this.#withOwnershipLock(run) : run());
    session.queue = resultPromise.then(() => {}, () => {});
    return await resultPromise;
  }

  cancel(message) {
    const session = this.#sessions.get(String(message.sessionId || ''));
    session?.controllers.get(String(message.requestId || ''))?.abort(new Error(String(message.reason || 'cancelled')));
  }

  interruptActiveCall(sessionId, reason = 'Browser control yielded to the user') {
    const session = this.#sessions.get(sessionId);
    if (!session?.activeRequestId)
      return;
    session.controllers.get(session.activeRequestId)?.abort(
        new Error(`BROWSER_CONTROL_INTERRUPTED: ${reason}`));
  }

  async finalizeSession(sessionId) {
    const session = this.#sessions.get(sessionId);
    if (!session)
      return;
    this.#sessions.delete(sessionId);
    for (const controller of session.controllers.values())
      controller.abort(new Error('Browser session finalized'));
    await session.queue.catch(() => {});
    let finalizeError;
    try {
      await session.backend.callTool('browser_tabs', { action: 'finalize' }, new AbortController().signal);
    } catch (error) {
      finalizeError = error;
    }
    await this.#relay.extensionCommand('tyrs.session.finalize', [{ sessionId }]).catch(error => finalizeError ??= error);
    await session.backend.dispose().catch(() => {});
    await fs.promises.rm(session.workspace, { recursive: true, force: true }).catch(() => {});
    if (finalizeError)
      throw finalizeError;
  }

  async stop() {
    await Promise.all([...this.#sessions.keys()].map(sessionId => this.finalizeSession(sessionId)));
    await this.#relay.releaseCDP?.().catch(() => {});
    await this.#browser?.close().catch(() => {});
    this.#browser = undefined;
    this.#context = undefined;
  }

  async abandonMetadataFailure() {
    const sessions = [...this.#sessions.entries()];
    this.#sessions.clear();
    for (const [, session] of sessions) {
      for (const controller of session.controllers.values())
        controller.abort(new Error('BROWSER_METADATA_UNAVAILABLE'));
    }
    await Promise.all(sessions.map(async ([, session]) => {
      await session.backend.dispose().catch(() => {});
      await fs.promises.rm(session.workspace, { recursive: true, force: true }).catch(() => {});
    }));
    void this.#relay.extensionCommand('tyrs.sessions.reset', []).catch(() => {});
    void this.#browser?.close().catch(() => {});
    this.#browser = undefined;
    this.#context = undefined;
  }

  async #syncExtensionState(sessionId, name, args, nativeTabId?: number, claimedTab?: { title: string; url: string }) {
    if (name === 'browser_session_name')
      await this.#relay.extensionCommand('tyrs.session.name', [{ sessionId, name: String(args.name || '') }]);
    if (name === 'browser_visibility')
      await this.#relay.extensionCommand('tyrs.visibility', [{ sessionId, visible: args.visible === true }]);
    if (name === 'browser_tabs' && args.action === 'claim') {
      await this.#relay.extensionCommand('tyrs.tab.claim', [{
        sessionId,
        tabId: nativeTabId,
        title: claimedTab?.title || '',
        url: claimedTab?.url || '',
      }]);
    }
    if (name === 'browser_tabs' && (args.action === 'mark_deliverable' || args.action === 'mark_handoff')) {
      await this.#relay.extensionCommand('tyrs.tab.disposition', [{
        sessionId,
        ...(nativeTabId === undefined ? {} : { tabId: nativeTabId }),
        disposition: args.action === 'mark_deliverable' ? 'deliverable' : 'handoff',
      }]);
    }
    if (name === 'browser_tabs' && args.action === 'finalize')
      await this.#relay.extensionCommand('tyrs.session.finalize', [{ sessionId }]);
  }

  async #callSingle(sessionId, session, name, args, signal, callMetadata?) {
    const bootstrapped = await this.#ensureBootstrapTab(sessionId, session, name, signal, callMetadata);
    const metadata = callMetadata ?? (bootstrapped ? session.backend.lastTabMetadata?.() : undefined);
    const prepared = await this.#prepareCall(sessionId, session, name, args, signal, metadata);
    const discoveredTabs = metadata || prepared.discoveredTabs;
    if (discoveredTabs)
      session.backend.primeTabMetadata?.(normalizeTabMetadata(discoveredTabs));
    const result = await session.backend.callTool(name, prepared.args, signal);
    if (!result?.isError) {
      await this.#syncExtensionState(sessionId, name, prepared.args, prepared.nativeTabId, prepared.claimedTab);
      if (name === 'browser_tabs' && ['new', 'claim', 'select'].includes(String(prepared.args.action || '')))
        session.bootstrapPending = false;
    }
    if (name === 'browser_tabs' && prepared.args.action !== 'finalize') {
      const resultMetadata = discoveredTabs || session.backend.lastTabMetadata?.() || [];
      this.#decorateTabListResult(sessionId, session, result, resultMetadata);
    }
    return result;
  }

  async #ensureBootstrapTab(sessionId, session, name, signal, callMetadata?) {
    if (!session.bootstrapPending || !requiresBootstrapTab(name))
      return false;
    if (callMetadata)
      session.backend.primeTabMetadata?.(normalizeTabMetadata(callMetadata));
    const result = await session.backend.callTool('browser_tabs', {
      action: 'new',
      url: `${this.#bootstrapUrl}#${sessionId}`,
    }, signal);
    if (result?.isError)
      throw new Error('无法为浏览器操作创建初始标签页');
    session.bootstrapPending = false;
    return true;
  }

  async #callBatch(sessionId, session, rawArgs, signal) {
    const actions = rawArgs?.actions;
    if (!Array.isArray(actions) || actions.length < 1 || actions.length > 20) {
      return {
        content: [{ type: 'text', text: '### Error\nbrowser_batch requires 1 to 20 actions' }],
        isError: true,
      };
    }
    const steps = [];
    const attachments = [];
    let failed = false;
    let close = false;
    const startedAt = performance.now();
    let callMetadata;
    for (let index = 0; index < actions.length; index++) {
      if (signal.aborted)
        throw signal.reason ?? new Error('Browser batch was cancelled');
      const action = actions[index] || {};
      const name = String(action.name || '');
      const args = action.arguments || {};
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      if ((name === 'browser_navigate' || name === 'browser_tabs') && /^javascript:/i.test(url)) {
        steps.push({ index, name, ok: false, text: 'javascript: URLs are not allowed in browser_batch' });
        failed = true;
        break;
      }
      const result = await this.#callSingle(sessionId, session, name, args, signal, callMetadata);
      callMetadata ??= session.backend.lastTabMetadata?.();
      const text = result.content?.filter(item => item.type === 'text')
          .map(item => item.text).join('\n') || '';
      steps.push({
        index,
        name,
        ok: result.isError !== true,
        text,
        timing: result?._meta?.tyrsTiming,
      });
      attachments.push(...(result.content || []).filter(item => item.type !== 'text'));
      close ||= result.isClose === true;
      if (result.isError) {
        failed = true;
        break;
      }
      if (result.isClose)
        break;
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          completed: steps.filter(step => step.ok).length,
          failedAt: failed ? steps.length - 1 : undefined,
          durationMs: round(performance.now() - startedAt),
          steps,
        }, null, 2),
      }, ...attachments],
      ...(failed ? { isError: true } : {}),
      ...(close ? { isClose: true } : {}),
    };
  }

  async #discoverTabs() {
    const { count: expectedPageCount, tabs } = await this.#readNativeTabMetadata();
    await waitForPageDiscovery(this.#context, expectedPageCount);
    return tabs;
  }

  async #readNativeTabMetadata() {
    const startedAt = performance.now();
    let timer;
    try {
      return await Promise.race([
        this.#relay.discoverTabs(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('metadata timeout')), 5_000);
        }),
      ]) as any;
    } catch {
      const durationMs = Math.round(performance.now() - startedAt);
      this.#relay.closeCDPConnection?.('BROWSER_METADATA_UNAVAILABLE');
      throw new Error(`BROWSER_METADATA_UNAVAILABLE stage=discoverTabs durationMs=${durationMs}`);
    } finally {
      if (timer)
        clearTimeout(timer);
    }
  }

  async #prepareCall(sessionId, session, name, rawArgs, signal, callMetadata?) {
    const args = { ...rawArgs };
    const action = String(args.action || '');
    const controlledAction = name === 'browser_tabs' &&
      ['close', 'select', 'mark_deliverable', 'mark_handoff'].includes(action) && args.tabId;
    const requiresDiscovery = name === 'browser_tabs' &&
      (action === 'claim' || controlledAction) ||
      (name === 'browser_visibility' && args.tabId);
    const discoveredTabs = requiresDiscovery ? (callMetadata || await this.#discoverTabs()) : undefined;

    if (name === 'browser_tabs' && action === 'claim') {
      const claimToken = String(args.claimToken || '');
      const stableTabId = session.claimTokens.get(claimToken);
      session.claimTokens.delete(claimToken);
      if (!stableTabId)
        throw new Error('Claim token is invalid or expired; list tabs again');
      const nativeTabId = parseNativeTabId(stableTabId);
      const discovered = discoveredTabs?.find(tab => tab.id === nativeTabId);
      if (!discovered || discovered.tyrs?.sessionId)
        throw new Error('Claimed tab is no longer available; list tabs again');
      return {
        args,
        discoveredTabs,
        nativeTabId,
        claimedTab: { title: String(discovered.title || ''), url: String(discovered.url || '') },
      };
    }

    let stableTabId = isNativeTabId(args.tabId) ? String(args.tabId) :
      [...session.tabIds].find(([, backendId]) => backendId === args.tabId)?.[0];
    if (!stableTabId)
      return { args, discoveredTabs };
    const nativeTabId = parseNativeTabId(stableTabId);
    const discovered = discoveredTabs?.find(tab => tab.id === nativeTabId);
    if (!discovered)
      throw new Error(`Chrome tab ${args.tabId} is no longer available`);
    if (discovered.tyrs?.sessionId && discovered.tyrs.sessionId !== sessionId)
      throw new Error(`Tab is leased by session ${discovered.tyrs.sessionId}`);
    if (name === 'browser_tabs' &&
        (action === 'mark_deliverable' || action === 'mark_handoff') &&
        discovered.tyrs?.sessionId !== sessionId) {
      throw new Error('Tab must be claimed before it can be marked');
    }
    let backendTabId = session.tabIds.get(stableTabId);
    if (!backendTabId) {
      session.backend.primeTabMetadata?.(normalizeTabMetadata(discoveredTabs || []));
      const listed = await session.backend.callTool(
          'browser_tabs', { action: 'list' }, signal);
      if (listed?.isError)
        throw new Error('Could not resolve the selected Chrome tab');
      this.#decorateTabListResult(sessionId, session, listed, discoveredTabs || []);
      backendTabId = session.tabIds.get(stableTabId);
    }
    if (!backendTabId)
      throw new Error(`Chrome tab ${stableTabId} did not become available`);
    args.tabId = backendTabId;
    return { args, discoveredTabs, nativeTabId };
  }

  #decorateTabListResult(sessionId, session, result, discoveredTabs) {
    decorateTabListResult(sessionId, session, result, discoveredTabs);
  }

  async #withOwnershipLock<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.#ownershipQueue;
    let release!: () => void;
    const gate = new Promise<void>(resolve => release = resolve);
    this.#ownershipQueue = previous.then(() => gate);
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }
}

export async function waitForPageDiscovery(context, expectedPageCount,
    options: { timeoutMs?: number; settleMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const settleMs = options.settleMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let observedPageCount = context.pages().length;
  let settledAt = Date.now();
  while (observedPageCount < expectedPageCount && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
    const currentPageCount = context.pages().length;
    if (currentPageCount !== observedPageCount) {
      observedPageCount = currentPageCount;
      settledAt = Date.now();
    } else if (Date.now() - settledAt >= settleMs) {
      break;
    }
  }
}

function isOwnershipSensitive(name, args) {
  if (name === 'browser_tabs')
    return ['list', 'new', 'claim', 'finalize'].includes(String(args.action || ''));
  if (name !== 'browser_batch' || !Array.isArray(args.actions))
    return false;
  return args.actions.some(action => action?.name === 'browser_tabs');
}

function requiresBootstrapTab(name) {
  return !['browser_close', 'browser_session_name', 'browser_tabs', 'browser_visibility'].includes(name);
}

function defaultSessionName(value) {
  const title = value.trim().slice(0, 56) || 'Browser task';
  const emoji = /test|测试|验收|e2e/i.test(title) ? '🧪' :
    (/build|code|github|构建|代码/i.test(title) ? '🔧' :
      (/search|research|find|搜索|调研/i.test(title) ? '🔎' :
        (/document|write|文档|写作/i.test(title) ? '📝' : '🌐')));
  return `${emoji} ${title}`;
}

function isNativeTabId(value) {
  return /^chrome-tab:\d+$/.test(String(value || ''));
}

function parseNativeTabId(value) {
  const tabId = Number(String(value).slice('chrome-tab:'.length));
  if (!Number.isInteger(tabId) || tabId < 0)
    throw new Error('Invalid Chrome tab id');
  return tabId;
}

function extractResultJSON(result) {
  const item = result?.content?.find(candidate =>
    candidate?.type === 'text' && candidate.text.includes('{'));
  if (!item)
    return undefined;
  const start = item.text.indexOf('{');
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < item.text.length; index++) {
    const char = item.text[index];
    if (quoted) {
      if (escaped)
        escaped = false;
      else if (char === '\\')
        escaped = true;
      else if (char === '"')
        quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === '{')
      depth++;
    else if (char === '}' && --depth === 0) {
      const end = index + 1;
      try {
        return { item, start, end, value: JSON.parse(item.text.slice(start, end)) };
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function decorateTabListResult(sessionId, session, result, discoveredTabs) {
  const parsed = extractResultJSON(result);
  if (!parsed || !Array.isArray(parsed.value.controlledTabs) || !Array.isArray(parsed.value.userTabs))
    return;
  session.tabIds.clear();
  session.claimTokens.clear();
  const unused = new Set<number>(discoveredTabs.map((_tab, index) => index));
  const backendCurrentTabId = parsed.value.currentTabId;
  for (const tab of parsed.value.controlledTabs) {
    const match = matchDiscoveredTab(sessionId, tab, discoveredTabs, unused);
    if (match === undefined)
      continue;
    unused.delete(match);
    const native = discoveredTabs[match];
    const stableId = `chrome-tab:${native.id}`;
    if (typeof tab.tabId === 'string')
      session.tabIds.set(stableId, tab.tabId);
    if (tab.tabId === backendCurrentTabId)
      parsed.value.currentTabId = stableId;
    const origin = native.tyrs?.origin || 'user';
    tab.tabId = stableId;
    tab.title = String(native.title || '');
    tab.url = String(native.url || '');
    tab.current = native.active === true;
    tab.origin = origin;
    tab.source = origin;
    tab.session = native.tyrs?.sessionName;
    tab.disposition = native.tyrs?.disposition || 'omit';
    tab.lease = native.tyrs?.sessionId ? {
      ownerSessionId: native.tyrs.sessionId,
      ownedByCurrentSession: native.tyrs.sessionId === sessionId,
    } : null;
    if (native.active)
      parsed.value.currentTabId = stableId;
  }
  for (const tab of parsed.value.userTabs) {
    const match = matchDiscoveredTab(sessionId, tab, discoveredTabs, unused);
    if (match === undefined)
      continue;
    unused.delete(match);
    const native = discoveredTabs[match];
    tab.title = String(native.title || '');
    tab.url = String(native.url || '');
    tab.current = native.active === true;
    if (typeof tab.claimToken === 'string')
      session.claimTokens.set(tab.claimToken, `chrome-tab:${native.id}`);
  }
  parsed.item.text = `${parsed.item.text.slice(0, parsed.start)}` +
    `${JSON.stringify(parsed.value, null, 2)}${parsed.item.text.slice(parsed.end)}`;
}

function normalizeTabMetadata(tabs) {
  return tabs.map(tab => ({
    id: tab.id,
    title: String(tab.title || ''),
    url: String(tab.url || ''),
    active: tab.active === true,
    tyrs: tab.tyrs,
  }));
}

function matchDiscoveredTab(sessionId, tab, discoveredTabs, unused: Set<number>) {
  const urlCandidates = [...unused].filter(index =>
    String(discoveredTabs[index].url || '') === String(tab.url || ''));
  if (!urlCandidates.length)
    return undefined;
  const ownershipCandidates = urlCandidates.filter(index =>
    ownershipMatches(sessionId, tab, discoveredTabs[index].tyrs));
  const hasOwnershipMetadata = urlCandidates.some(index => {
    const state = discoveredTabs[index].tyrs;
    return !!(state?.sessionId || state?.origin);
  });
  const preferred = ownershipCandidates.length ? ownershipCandidates :
    (hasOwnershipMetadata ? [] : urlCandidates);
  const titleCandidates = preferred.filter(index => {
    const nativeTitle = String(discoveredTabs[index].title || '');
    const backendTitle = String(tab.title || '');
    return nativeTitle && backendTitle && nativeTitle === backendTitle;
  });
  if (titleCandidates.length === 1)
    return titleCandidates[0];
  if (preferred.length === 1)
    return preferred[0];
  return undefined;
}

function ownershipMatches(sessionId, tab, state) {
  if (tab.origin === 'agent') {
    return state?.origin === 'agent' &&
      (state.sessionId === sessionId ||
        (!state.sessionId && state.disposition && state.disposition !== 'omit'));
  }
  if (tab.origin === 'user' && tab.current)
    return state?.origin === 'user' && state.sessionId === sessionId;
  return !state?.sessionId;
}

function requiredId(value, name) {
  const text = String(value || '');
  if (!/^[0-9a-f-]{36}$/i.test(text))
    throw new Error(`Invalid ${name}`);
  return text;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
