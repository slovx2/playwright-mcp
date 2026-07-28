import crypto from 'node:crypto';

const maxArtifactBytes = 25 * 1024 * 1024;
const maxChunkBytes = 1024 * 1024;
const largeTextThreshold = 256 * 1024;

type PendingAck = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class ToolArtifactSender {
  #pendingAcks = new Map<string, PendingAck>();

  handleMessage(message) {
    if (message.type !== 'artifact_ack')
      return false;
    const transferId = String(message.transferId || '');
    const pending = this.#pendingAcks.get(transferId);
    if (!pending)
      return true;
    this.#pendingAcks.delete(transferId);
    clearTimeout(pending.timer);
    pending.resolve();
    return true;
  }

  async externalize(stream, message, result) {
    if (!result || !Array.isArray(result.content))
      return result;
    const content: any[] = [];
    for (const item of result.content) {
      const data = artifactData(message, item);
      if (!data) {
        content.push(item);
        continue;
      }
      if (data.buffer.length > maxArtifactBytes)
        throw new Error(`Browser tool artifact exceeds ${maxArtifactBytes} bytes`);
      const transferId = crypto.randomUUID();
      const ack = this.#waitForAck(transferId);
      try {
        await stream.send({
          type: 'artifact_begin',
          sessionId: message.sessionId,
          requestId: message.requestId,
          transferId,
          contentType: data.contentType,
          mimeType: data.mimeType,
          size: data.buffer.length,
        });
        for (let offset = 0; offset < data.buffer.length; offset += maxChunkBytes) {
          await stream.send({
            type: 'artifact_chunk',
            transferId,
            data: data.buffer.subarray(offset, offset + maxChunkBytes).toString('base64'),
          });
        }
        await stream.send({
          type: 'artifact_end',
          transferId,
          sha256: crypto.createHash('sha256').update(data.buffer).digest('hex'),
        });
        await ack;
      } catch (error) {
        this.#rejectAck(transferId, error);
        await ack.catch(() => {});
        throw error;
      }
      content.push({ type: 'tyrs_artifact', transferId });
    }
    return { ...result, content };
  }

  failPending(error) {
    for (const transferId of this.#pendingAcks.keys())
      this.#rejectAck(transferId, error);
  }

  #waitForAck(transferId: string) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingAcks.delete(transferId);
        reject(new Error('Browser tool artifact acknowledgement timed out'));
      }, 30_000);
      this.#pendingAcks.set(transferId, { resolve, reject, timer });
    });
  }

  #rejectAck(transferId: string, reason) {
    const pending = this.#pendingAcks.get(transferId);
    if (!pending)
      return;
    this.#pendingAcks.delete(transferId);
    clearTimeout(pending.timer);
    pending.reject(reason instanceof Error ? reason : new Error(String(reason)));
  }
}

function artifactData(message, item) {
  if (item?.type === 'image' && typeof item.data === 'string') {
    const buffer = Buffer.from(item.data, 'base64');
    if (!item.data || buffer.toString('base64') !== item.data)
      throw new Error('Browser tool returned invalid image data');
    return {
      buffer,
      contentType: 'image',
      mimeType: String(item.mimeType || 'application/octet-stream'),
    };
  }
  if (item?.type !== 'text' || typeof item.text !== 'string')
    return undefined;
  const buffer = Buffer.from(item.text);
  if (!shouldExternalizeText(message, item.text, buffer.length))
    return undefined;
  return { buffer, contentType: 'text', mimeType: 'text/plain; charset=utf-8' };
}

function shouldExternalizeText(message, text: string, size: number) {
  if (size >= largeTextThreshold || message.name === 'browser_snapshot')
    return true;
  if (message.name !== 'browser_batch')
    return false;
  const actions = Array.isArray(message.arguments?.actions) ? message.arguments.actions : [];
  return actions.some(action => action?.name === 'browser_snapshot') ||
    text.includes('"name": "browser_snapshot"');
}
