import crypto from 'node:crypto';
import fs from 'node:fs';

const maxFileSize = 25 * 1024 * 1024;
const chunkSize = 1024 * 1024;

export class DownloadRelay {
  #relay: any;
  #getStream: () => any;
  #getSessionId: () => string;
  #downloads: any[] = [];
  #items: any[] = [];
  #acks = new Map<string, { resolve: () => void, reject: (error: unknown) => void }>();

  constructor(relay, getStream, getSessionId = () => '') {
    this.#relay = relay;
    this.#getStream = getStream;
    this.#getSessionId = getSessionId;
  }

  onExtensionEvent(method, params) {
    if (method === 'chrome.downloads.onCreated') {
      const [item] = params;
      this.#items.push({ ...item, seenAt: Date.now(), completed: item.state === 'complete', matched: false });
      this.#pair();
    } else if (method === 'chrome.downloads.onChanged') {
      const [delta] = params;
      const item = this.#items.find(candidate => candidate.id === delta.id);
      if (item && delta.state?.current === 'complete')
        item.completed = true;
      if (item && delta.filename?.current)
        item.filename = delta.filename.current;
    }
  }

  async onCDPMessage(message, forward) {
    if (message.method === 'Browser.downloadWillBegin') {
      this.#downloads.push({ guid: message.params.guid, url: message.params.url,
        startedAt: Date.now(), matched: false });
      this.#pair();
      forward(message);
      return;
    }
    if (message.method !== 'Browser.downloadProgress' || message.params?.state !== 'completed') {
      if (message.method === 'Browser.downloadProgress' && message.params?.state === 'canceled')
        this.#forget(message.params.guid);
      forward(message);
      return;
    }
    let pair;
    try {
      pair = await this.#waitForPair(message.params.guid);
      await this.#waitForCompletion(pair.item);
      await this.#transfer(message.params.guid, pair.item.id);
      forward(message);
    } catch (error) {
      await this.#getStream()?.send({ type: 'error', message: `下载回传失败: ${error instanceof Error ? error.message : String(error)}` }).catch(() => {});
      forward({ ...message, params: { ...message.params, state: 'canceled' } });
    } finally {
      this.#forget(message.params.guid, pair?.item.id);
    }
  }

  handleAgentMessage(message) {
    if (message.type !== 'download_ack')
      return false;
    const callback = this.#acks.get(String(message.transferId || ''));
    if (callback) {
      this.#acks.delete(String(message.transferId));
      callback.resolve();
    }
    return true;
  }

  failPending(error) {
    for (const callback of this.#acks.values())
      callback.reject(error);
    this.#acks.clear();
  }

  #pair() {
    for (const download of this.#downloads) {
      if (download.matched)
        continue;
      const item = this.#items.find(candidate => !candidate.matched &&
        (candidate.url === download.url || candidate.finalUrl === download.url) &&
        startedNear(candidate.startTime, download.startedAt));
      if (!item)
        continue;
      download.matched = true;
      item.matched = true;
      download.item = item;
    }
  }

  async #waitForPair(guid) {
    return await waitFor(() => {
      this.#pair();
      const download = this.#downloads.find(candidate => candidate.guid === guid);
      return download?.item ? download : undefined;
    }, 10_000, '无法关联 Chrome 下载');
  }

  async #waitForCompletion(item) {
    await waitFor(() => item.completed ? true : undefined, 30_000, 'Chrome 下载未完成');
  }

  async #transfer(guid, downloadId) {
    const [item] = await this.#relay.queryDownloads(downloadId);
    if (!item || item.state !== 'complete' || !item.filename)
      throw new Error('Chrome 没有返回已完成下载的文件路径');
    const stat = await fs.promises.lstat(item.filename);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error('Chrome 下载不是普通文件');
    if (stat.size > maxFileSize)
      throw new Error('文件大小超过 25 MiB');
    const stream = this.#getStream();
    if (!stream)
      throw new Error('Worker relay 未连接');
    const transferId = crypto.randomUUID();
    const sessionId = this.#getSessionId();
    if (!sessionId)
      throw new Error('下载没有关联的浏览器会话');
    let acknowledgement;
    try {
      await stream.send({ type: 'download_begin', sessionId, transferId, guid, size: stat.size });
      const digest = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(item.filename, { highWaterMark: chunkSize })) {
        digest.update(chunk);
        await stream.send({ type: 'download_chunk', transferId, data: chunk.toString('base64') });
      }
      acknowledgement = this.#expectAcknowledgement(transferId);
      await stream.send({ type: 'download_end', transferId, sha256: digest.digest('hex') });
      await acknowledgement;
    } catch (error) {
      const callback = this.#acks.get(transferId);
      this.#acks.delete(transferId);
      callback?.reject(error);
      await acknowledgement?.catch(() => {});
      await stream.send({ type: 'error', transferId, guid,
        message: `下载传输中断: ${error instanceof Error ? error.message : String(error)}` }).catch(() => {});
      throw error;
    }
  }

  #expectAcknowledgement(transferId) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#acks.delete(transferId);
        reject(new Error('Worker 下载确认超时'));
      }, 60_000);
      this.#acks.set(transferId, {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
    });
  }

  #forget(guid, downloadId?) {
    this.#downloads = this.#downloads.filter(download => download.guid !== guid);
    if (downloadId !== undefined)
      this.#items = this.#items.filter(item => item.id !== downloadId);
  }
}

function startedNear(startTime, expected) {
  if (typeof startTime !== 'string')
    return true;
  const actual = Date.parse(startTime);
  return !Number.isFinite(actual) || Math.abs(actual - expected) <= 120_000;
}

async function waitFor(probe, timeout, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined)
      return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
