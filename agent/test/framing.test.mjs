import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { FramedStream, maxFrameSize, maxPrefaceNoise, preface } from '../lib/framing.mjs';

test('framed stream ignores bounded SSH startup noise and parses split frames', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const stream = new FramedStream(input, output);
  const messages = [];
  stream.on('message', message => messages.push(message));
  input.write('shell banner\nTYRS-BROWSER/1\n');
  const payload = Buffer.from(JSON.stringify({ type: 'ping', at: 7 }));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  input.write(header.subarray(0, 2));
  input.write(Buffer.concat([header.subarray(2), payload]));
  input.write(Buffer.concat([
    frame({ type: 'status', connected: true }),
    frame({ type: 'pong', at: 8 }),
  ]));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(messages, [
    { type: 'ping', at: 7 },
    { type: 'status', connected: true },
    { type: 'pong', at: 8 },
  ]);

  const written = [];
  output.on('data', chunk => written.push(chunk));
  await stream.send({ type: 'pong', at: 7 });
  const encoded = Buffer.concat(written);
  assert.equal(encoded.readUInt32BE(0), encoded.length - 4);
  assert.deepEqual(JSON.parse(encoded.subarray(4).toString()), { type: 'pong', at: 7 });
});

test('framed stream rejects excessive preface noise and oversized frames', async () => {
  for (const inputData of [
    Buffer.concat([Buffer.alloc(maxPrefaceNoise + 1, 0x78), preface]),
    Buffer.concat([preface, oversizedHeader()]),
  ]) {
    const input = new PassThrough();
    const output = new PassThrough();
    const stream = new FramedStream(input, output);
    const error = new Promise(resolve => stream.once('streamerror', resolve));
    input.write(inputData);
    assert.ok(await error instanceof Error);
  }
});

function frame(message) {
  const payload = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

function oversizedHeader() {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(maxFrameSize + 1);
  return header;
}
