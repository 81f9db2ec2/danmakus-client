const textEncoder = new TextEncoder();

export function computeDanmakuFingerprint(raw: string | Uint8Array): bigint {
  const globalBun = (globalThis as any).Bun;
  if (globalBun && typeof globalBun.hash?.xxHash3 === 'function') {
    return globalBun.hash.xxHash3(raw);
  }

  const bytes = typeof raw === 'string' ? textEncoder.encode(raw) : raw;
  if (bytes.length === 0) {
    return 0n;
  }

  // Fallback 64-bit FNV-1a hash if xxHash3 is unavailable
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i]);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash;
}
