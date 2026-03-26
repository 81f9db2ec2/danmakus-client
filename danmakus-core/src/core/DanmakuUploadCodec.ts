import { Encoder } from '@msgpack/msgpack';
import { Zstd } from '@hpcc-js/wasm-zstd';

const ZSTD_LEVEL = 6;
const messagePackEncoder = new Encoder();
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

export const encodeZstdMessagePack = async (payload: unknown): Promise<Uint8Array> => {
  const payloadBytes = messagePackEncoder.encode(payload);
  const zstd = await ensureZstdReady();
  return zstd.compress(payloadBytes, ZSTD_LEVEL);
};
