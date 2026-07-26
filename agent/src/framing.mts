import { EventEmitter } from 'node:events';

export const preface = Buffer.from('TYRS-BROWSER/1\n');
export const maxFrameSize = 64 * 1024 * 1024;
export const maxPrefaceNoise = 64 * 1024;

export class FramedStream extends EventEmitter {
  #input: any;
  #output: any;
  #buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  #ready = false;
  #closed = false;

  constructor(input: any, output: any) {
    super();
    this.#input = input;
    this.#output = output;
    input.on('data', chunk => this.#onData(chunk));
    input.on('end', () => this.#close());
    input.on('error', error => this.#close(error));
    output.on('error', error => this.#close(error));
  }

  ready() {
    return this.#ready;
  }

  async send(message: Record<string, unknown>) {
    if (this.#closed)
      throw new Error('Browser Agent stream is closed');
    const payload = Buffer.from(JSON.stringify(message));
    if (payload.length > maxFrameSize)
      throw new Error('Browser Agent frame is too large');
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(payload.length);
    const data = Buffer.concat([header, payload]);
    if (!this.#output.write(data)) {
      await new Promise<void>((resolve, reject) => {
        const onDrain = () => finish(resolve);
        const onClose = () => finish(() => reject(new Error('Browser Agent stream closed during write')));
        const onError = error => finish(() => reject(error));
        const finish = callback => {
          this.#output.off('drain', onDrain);
          this.#output.off('close', onClose);
          this.#output.off('error', onError);
          callback();
        };
        this.#output.once('drain', onDrain);
        this.#output.once('close', onClose);
        this.#output.once('error', onError);
      });
    }
  }

  close() {
    this.#output.destroy();
    this.#close();
  }

  #onData(chunk: Buffer) {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    if (!this.#ready) {
      const index = this.#buffer.indexOf(preface);
      if (index === -1) {
        if (this.#buffer.length > maxPrefaceNoise + preface.length)
          this.#close(new Error('Browser Agent preface not found'));
        return;
      }
      if (index > maxPrefaceNoise)
        return this.#close(new Error('Browser Agent preface exceeded noise limit'));
      this.#buffer = this.#buffer.subarray(index + preface.length);
      this.#ready = true;
      this.emit('ready');
    }
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length > maxFrameSize)
        return this.#close(new Error('Browser Agent frame is too large'));
      if (this.#buffer.length < length + 4)
        return;
      const payload = this.#buffer.subarray(4, 4 + length);
      this.#buffer = this.#buffer.subarray(4 + length);
      try {
        const message = JSON.parse(payload.toString());
        if (!message || typeof message.type !== 'string')
          throw new Error('Browser Agent message has no type');
        this.emit('message', message);
      } catch (error) {
        return this.#close(error);
      }
    }
  }

  #close(error?: unknown) {
    if (this.#closed)
      return;
    this.#closed = true;
    this.#input.destroy();
    this.#output.destroy();
    if (error)
      this.emit('streamerror', error);
    this.emit('close');
  }
}
