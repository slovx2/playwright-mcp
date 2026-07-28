import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DownloadRelay } from '../lib/download-relay.mjs';

test('download completion waits for checksum transfer acknowledgement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tyrs-agent-download-'));
  const file = join(directory, 'result.txt');
  await writeFile(file, 'desktop download');
  const sent = [];
  let downloadRelay;
  const stream = {
    send: async message => {
      sent.push(message);
      if (message.type === 'download_end')
        downloadRelay.handleAgentMessage({ type: 'download_ack', transferId: message.transferId });
    },
  };
  downloadRelay = new DownloadRelay({
    queryDownloads: async () => [{ id: 9, state: 'complete', filename: file }],
  }, () => stream, () => '11111111-1111-4111-8111-111111111111');
  const forwarded = [];
  await downloadRelay.onCDPMessage({ method: 'Browser.downloadWillBegin',
    params: { guid: 'download-guid', url: 'https://example.test/file' } }, message => forwarded.push(message));
  downloadRelay.onExtensionEvent('chrome.downloads.onCreated', [{
    id: 9, url: 'https://example.test/file', filename: file, state: 'in_progress', fileSize: 16,
    startTime: new Date().toISOString(),
  }]);
  downloadRelay.onExtensionEvent('chrome.downloads.onChanged', [{ id: 9, state: { current: 'complete' } }]);
  await downloadRelay.onCDPMessage({ method: 'Browser.downloadProgress',
    params: { guid: 'download-guid', state: 'completed' } }, message => forwarded.push(message));
  assert.deepEqual(sent.map(message => message.type), ['download_begin', 'download_chunk', 'download_end']);
  assert.equal(sent[0].sessionId, '11111111-1111-4111-8111-111111111111');
  assert.equal(forwarded.at(-1).params.state, 'completed');
  await rm(directory, { recursive: true, force: true });
});
