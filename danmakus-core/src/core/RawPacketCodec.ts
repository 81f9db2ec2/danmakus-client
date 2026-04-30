export const normalizeBinaryPayload = (payload: Uint8Array | number[]): Uint8Array =>
  payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
