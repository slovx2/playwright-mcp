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

test('framed stream serializes concurrent writes behind one backpressure listener', async () => {
  const input = new PassThrough();
  const output = new PassThrough({ highWaterMark: 1 });
  const stream = new FramedStream(input, output);
  const writes = Array.from({ length: 100 }, (_, id) => stream.send({ type: 'event', id }));

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(output.listenerCount('drain'), 1);
  assert.equal(output.listenerCount('close'), 2);
  assert.equal(output.listenerCount('error'), 2);

  const chunks = [];
  output.on('data', chunk => chunks.push(chunk));
  await Promise.all(writes);
  assert.deepEqual(decodeFrames(Buffer.concat(chunks)),
      Array.from({ length: 100 }, (_, id) => ({ type: 'event', id })));
  assert.equal(output.listenerCount('drain'), 0);
  assert.equal(output.listenerCount('close'), 1);
  assert.equal(output.listenerCount('error'), 1);
});

test('framed stream rejects the active and queued writes when backpressure stream closes', async () => {
  const input = new PassThrough();
  const output = new PassThrough({ highWaterMark: 1 });
  const stream = new FramedStream(input, output);
  const writes = [stream.send({ type: 'first' }), stream.send({ type: 'second' })];
  await new Promise(resolve => setImmediate(resolve));
  output.destroy();
  const results = await Promise.allSettled(writes);
  assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected']);
  assert.match(results[0].reason.message, /closed during write/);
  assert.match(results[1].reason.message, /stream is closed/);
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

function decodeFrames(data) {
  const messages = [];
  while (data.length) {
    const length = data.readUInt32BE(0);
    messages.push(JSON.parse(data.subarray(4, 4 + length).toString()));
    data = data.subarray(4 + length);
  }
  return messages;
}
