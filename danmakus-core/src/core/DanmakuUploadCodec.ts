import { Zstd } from '@hpcc-js/wasm-zstd';

const ZSTD_LEVEL = 6;
const textEncoder = new TextEncoder();
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

export const encodeZstdJson = async (payload: unknown): Promise<Uint8Array> => {
  const jsonPayload = JSON.stringify(payload);
  const payloadBytes = textEncoder.encode(jsonPayload);
  const zstd = await ensureZstdReady();
  return zstd.compress(payloadBytes, ZSTD_LEVEL);
};
