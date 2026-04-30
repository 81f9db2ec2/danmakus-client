import { Encoder } from '@msgpack/msgpack';

export type ArchiveRequestCompression = 'zstd' | 'brotli' | 'gzip' | 'identity';
type CompressionStreamFormat = Exclude<ArchiveRequestCompression, 'identity'>;
type CompressionStreamLike = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};
type CompressionStreamCtor = new (format: string) => CompressionStreamLike;
export type ArchiveUploadEnvelope = {
  compression: ArchiveRequestCompression;
  body: Uint8Array;
};

const messagePackEncoder = new Encoder();
const compressionOrder: CompressionStreamFormat[] = ['zstd', 'brotli', 'gzip'];
const COMPRESSION_ATTEMPT_TIMEOUT_MS = 3000;

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

const toUint8Array = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error(`压缩流返回了无效数据: ${Object.prototype.toString.call(value)}`);
};

const readReadableStream = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(toUint8Array(value));
    }
  }
  return concatUint8Arrays(chunks);
};

const tryCompressWithStream = async (
  format: CompressionStreamFormat,
  payload: Uint8Array,
  timeoutMs: number,
): Promise<Uint8Array | null> => {
  const StreamCtor = (globalThis as typeof globalThis & {
    CompressionStream?: CompressionStreamCtor;
  }).CompressionStream;
  if (!StreamCtor) {
    return null;
  }

  let stream: CompressionStreamLike;
  try {
    stream = new StreamCtor(format);
  } catch {
    return null;
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const compressTask = (async (): Promise<Uint8Array | null> => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });
    reader = source.pipeThrough(stream).getReader();
    return await readReadableStream(reader);
  })().catch(() => null);

  const timeoutTask = new Promise<null>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, timeoutMs);
  });

  const compressed = await Promise.race([compressTask, timeoutTask]);
  if (timeoutId) {
    clearTimeout(timeoutId);
  }

  if (timedOut) {
    const activeReader = reader as ReadableStreamDefaultReader<Uint8Array> | null;
    if (activeReader) {
      void activeReader.cancel().catch(() => undefined);
    }
  }

  return compressed;
};

export const encodeArchiveUploadEnvelope = async (
  payload: unknown,
  options?: { compressionAttemptTimeoutMs?: number },
): Promise<ArchiveUploadEnvelope> => {
  const payloadBytes = messagePackEncoder.encode(payload);
  const timeoutMs = Math.max(1, Math.floor(options?.compressionAttemptTimeoutMs ?? COMPRESSION_ATTEMPT_TIMEOUT_MS));
  for (const compression of compressionOrder) {
    const compressed = await tryCompressWithStream(compression, payloadBytes, timeoutMs);
    if (compressed) {
      return {
        compression,
        body: messagePackEncoder.encode({
          compression,
          payload: compressed,
        }),
      };
    }
  }

  const compression = 'identity' satisfies ArchiveRequestCompression;
  return {
    compression,
    body: messagePackEncoder.encode({
      compression,
      payload: payloadBytes,
    }),
  };
};
