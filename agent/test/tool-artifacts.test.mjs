import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { ToolArtifactSender } from '../lib/tool-artifacts.mjs';

test('tool artifacts transfer screenshots and snapshots with checksum acknowledgement', async () => {
  const sender = new ToolArtifactSender();
  const messages = [];
  const stream = {
    async send(message) {
      messages.push(message);
      if (message.type === 'artifact_end')
        setImmediate(() => sender.handleMessage({ type: 'artifact_ack', transferId: message.transferId }));
    },
  };
  const request = {
    sessionId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    name: 'browser_batch',
    arguments: { actions: [{ name: 'browser_snapshot', arguments: {} }] },
  };
  const result = await sender.externalize(stream, request, {
    content: [
      { type: 'text', text: 'snapshot result' },
      { type: 'image', data: Buffer.from('png bytes').toString('base64'), mimeType: 'image/png' },
    ],
  });

  assert.deepEqual(result.content.map(item => item.type), ['tyrs_artifact', 'tyrs_artifact']);
  assert.deepEqual(messages.map(message => message.type), [
    'artifact_begin', 'artifact_chunk', 'artifact_end',
    'artifact_begin', 'artifact_chunk', 'artifact_end',
  ]);
  for (const end of messages.filter(message => message.type === 'artifact_end')) {
    const chunks = messages.filter(message =>
      message.type === 'artifact_chunk' && message.transferId === end.transferId);
    const data = Buffer.concat(chunks.map(message => Buffer.from(message.data, 'base64')));
    assert.equal(crypto.createHash('sha256').update(data).digest('hex'), end.sha256);
  }
});

test('small ordinary text remains in the tool result frame', async () => {
  const sender = new ToolArtifactSender();
  const result = await sender.externalize({ send: () => assert.fail('unexpected transfer') }, {
    sessionId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    name: 'browser_click',
    arguments: {},
  }, { content: [{ type: 'text', text: 'clicked' }] });
  assert.deepEqual(result.content, [{ type: 'text', text: 'clicked' }]);
});
