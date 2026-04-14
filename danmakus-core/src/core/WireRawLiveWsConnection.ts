/// <reference path="../types/brotli.d.ts" />

import brotliDecompress from 'brotli/decompress.js';
import type { LiveWsConnection } from '../types/index.js';

type CompressionKind = 'deflate' | 'brotli';
type LiveWsEventListener = (event: any) => void;
type WireRawMessage = {
  data: any;
  raw: string;
};
type DecompressionStreamCtor = new (format: CompressionKind) => {
  readable: any;
  writable: any;
};
type BrotliDecompressFn = (input: Uint8Array, outSize?: number) => Uint8Array | ArrayBuffer | ArrayBufferView;

const textDecoder = new TextDecoder();

const concatUint8Arrays = (chunks: Uint8Array[]): Uint8Array => {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
};

const toUint8Array = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
};

const extractFrameBytes = (event: any): Uint8Array | null =>
  toUint8Array(event?.data ?? event);

const readReadableStream = async (readable: any): Promise<Uint8Array> => {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(toUint8Array(value) ?? new Uint8Array(0));
    }
  }
  return concatUint8Arrays(chunks);
};

const importNodeZlib = async (): Promise<typeof import('node:zlib')> => {
  const dynamicImport = new Function(
    'specifier',
    'return import(specifier);',
  ) as (specifier: string) => Promise<typeof import('node:zlib')>;
  return await dynamicImport('node:zlib');
};

const canUseNodeZlib = (): boolean =>
  typeof process !== 'undefined'
  && process !== null
  && typeof process.versions === 'object'
  && process.versions !== null
  && typeof process.versions.node === 'string'
  && process.versions.node.length > 0;

const tryDecompressWithStream = async (format: CompressionKind, payload: Uint8Array): Promise<Uint8Array | null> => {
  const StreamCtor = (globalThis as typeof globalThis & {
    DecompressionStream?: DecompressionStreamCtor;
  }).DecompressionStream;
  if (!StreamCtor) {
    return null;
  }

  let stream: InstanceType<DecompressionStreamCtor>;
  try {
    stream = new StreamCtor(format);
  } catch {
    return null;
  }

  const writer = stream.writable.getWriter();
  await writer.write(payload);
  await writer.close();
  return await readReadableStream(stream.readable);
};

const decompressDeflate = async (payload: Uint8Array): Promise<Uint8Array> => {
  const streamResult = await tryDecompressWithStream('deflate', payload);
  if (streamResult) {
    return streamResult;
  }

  if (!canUseNodeZlib()) {
    throw new Error('当前运行时不支持 deflate 解压');
  }

  const { inflateSync } = await importNodeZlib();
  return new Uint8Array(inflateSync(payload));
};

const decompressBrotli = async (payload: Uint8Array): Promise<Uint8Array> => {
  const decompressed = toUint8Array((brotliDecompress as BrotliDecompressFn)(payload));
  if (!decompressed) {
    throw new Error('brotli 返回了无效的解压结果');
  }
  return decompressed;
};

const collectWireRawMessages = async (
  frame: Uint8Array,
  messages: WireRawMessage[],
): Promise<void> => {
  if (frame.length < 16) {
    return;
  }

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  for (let offset = 0; offset + 16 <= frame.length;) {
    const packetLength = view.getInt32(offset);
    if (packetLength <= 0 || offset + packetLength > frame.length) {
      throw new Error(`收到损坏的弹幕 packet，length=${packetLength}, frameLength=${frame.length}, offset=${offset}`);
    }

    const headerLength = view.getInt16(offset + 4);
    if (headerLength < 16 || offset + headerLength > offset + packetLength) {
      throw new Error(`收到损坏的弹幕 header，headerLength=${headerLength}, packetLength=${packetLength}`);
    }

    const protocol = view.getInt16(offset + 6);
    const operation = view.getInt32(offset + 8);
    const body = frame.subarray(offset + headerLength, offset + packetLength);
    offset += packetLength;

    if (operation !== 5 || body.length === 0) {
      continue;
    }

    if (protocol === 0) {
      const raw = textDecoder.decode(body);
      messages.push({
        raw,
        data: JSON.parse(raw),
      });
      continue;
    }

    if (protocol === 2) {
      await collectWireRawMessages(await decompressDeflate(body), messages);
      continue;
    }

    if (protocol === 3) {
      await collectWireRawMessages(await decompressBrotli(body), messages);
    }
  }
};

const decodeWireRawMessages = async (frame: Uint8Array): Promise<WireRawMessage[]> => {
  const messages: WireRawMessage[] = [];
  await collectWireRawMessages(frame, messages);
  return messages;
};

class WireRawLiveWsConnection implements LiveWsConnection {
  private readonly listeners = new Map<string, Set<LiveWsEventListener>>();

  constructor(private readonly baseConnection: LiveWsConnection) {
    this.forwardEvent('open');
    this.forwardEvent('live');
    this.forwardEvent('heartbeat');
    this.forwardEvent('close');
    this.forwardEvent('error');
    this.baseConnection.addEventListener('message', (event: any) => {
      void this.handleMessageFrame(event).catch((error) => {
        this.emit('error', { error });
      });
    });
  }

  addEventListener(type: string, listener: LiveWsEventListener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set<LiveWsEventListener>();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: LiveWsEventListener): void {
    const set = this.listeners.get(type);
    if (!set) {
      return;
    }
    set.delete(listener);
    if (set.size === 0) {
      this.listeners.delete(type);
    }
  }

  close(): void {
    this.baseConnection.close();
  }

  private forwardEvent(type: string): void {
    this.baseConnection.addEventListener(type, (event: any) => {
      this.emit(type, event);
    });
  }

  private async handleMessageFrame(event: any): Promise<void> {
    const frame = extractFrameBytes(event);
    if (!frame || frame.length === 0) {
      return;
    }

    const messages = await decodeWireRawMessages(frame);
    for (const message of messages) {
      this.emit('msg', message);
    }
  }

  private emit(type: string, event: any): void {
    const set = this.listeners.get(type);
    if (!set || set.size === 0) {
      return;
    }

    for (const listener of set) {
      listener(event);
    }
  }
}

export const createWireRawLiveWsConnection = (baseConnection: LiveWsConnection): LiveWsConnection =>
  new WireRawLiveWsConnection(baseConnection);
