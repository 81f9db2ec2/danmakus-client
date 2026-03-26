import { Zstd } from '@hpcc-js/wasm-zstd';

const ZSTD_LEVEL = 6;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
let zstdInstancePromise: Promise<Zstd> | null = null;

const ensureZstdReady = async (): Promise<Zstd> => {
  if (!zstdInstancePromise) {
    zstdInstancePromise = Zstd.load().catch((error: unknown) => {
      zstdInstancePromise = null;
      throw error;
    });
  }

  return zstdInstancePromise;
};

export const normalizeBinaryPayload = (payload: Uint8Array | number[]): Uint8Array =>
  payload instanceof Uint8Array ? payload : Uint8Array.from(payload);

export const compressRawPacket = async (raw: string): Promise<Uint8Array> => {
  const zstd = await ensureZstdReady();
  return zstd.compress(textEncoder.encode(raw), ZSTD_LEVEL);
};

export const decompressRawPacket = async (payload: Uint8Array | number[]): Promise<string> => {
  const zstd = await ensureZstdReady();
  return textDecoder.decode(zstd.decompress(normalizeBinaryPayload(payload)));
};
