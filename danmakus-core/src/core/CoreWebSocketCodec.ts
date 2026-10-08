import { decode as decodeMsgPack, encode as encodeMsgPack } from '@msgpack/msgpack';

export const WS_FRAME_HEADER_SIZE = 5;

export const CoreWsOpCode = {
  // Client -> Server (0x01 ~ 0x1F)
  CLIENT_AUTH: 0x01,
  CLIENT_UPLOAD_DANMAKU: 0x02,
  CLIENT_STATE_REPORT: 0x03,
  CLIENT_REQUEST_ROOMS: 0x04,

  // Server -> Client (0x81 ~ 0x9F)
  SERVER_AUTH_RESULT: 0x81,
  SERVER_UPLOAD_ACK: 0x82,
  SERVER_PUSH_ROOM_ASSIGN: 0x83,
  SERVER_PUSH_STREAMER_STATUS: 0x84,
  SERVER_ERROR_NOTIFY: 0x8F,
} as const;

export type CoreWsOpCodeValue = typeof CoreWsOpCode[keyof typeof CoreWsOpCode];

export interface CoreWsFrame {
  opCode: number;
  seq: number;
  payload: Uint8Array;
}

export function encodeWsFrame(opCode: number, seq: number, payload?: Uint8Array): Uint8Array {
  const payloadLength = payload?.byteLength ?? 0;
  const frame = new Uint8Array(WS_FRAME_HEADER_SIZE + payloadLength);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);

  view.setUint8(0, opCode & 0xff);
  view.setUint32(1, seq >>> 0, true); // Little-Endian

  if (payload && payloadLength > 0) {
    frame.set(payload, WS_FRAME_HEADER_SIZE);
  }

  return frame;
}

export function decodeWsFrame(data: Uint8Array): CoreWsFrame {
  if (data.byteLength < WS_FRAME_HEADER_SIZE) {
    throw new Error(`WebSocket 帧过短: 长度 ${data.byteLength} < ${WS_FRAME_HEADER_SIZE}`);
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const opCode = view.getUint8(0);
  const seq = view.getUint32(1, true); // Little-Endian
  const payload = data.subarray(WS_FRAME_HEADER_SIZE);

  return { opCode, seq, payload };
}

const INT32_MIN = -0x80000000;
const UINT32_MAX = 0xffffffff;

export function toWireIntegers(value: unknown): unknown {
  if (typeof value === 'number' && Number.isSafeInteger(value) && (value > UINT32_MAX || value < INT32_MIN)) {
    return BigInt(value);
  }
  if (Array.isArray(value)) {
    return value.map(toWireIntegers);
  }
  if (value !== null && typeof value === 'object' && value.constructor === Object) {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input)) {
      output[key] = toWireIntegers(input[key]);
    }
    return output;
  }
  return value;
}

export function encodeMsgPackPayload<T>(data: T): Uint8Array {
  return encodeMsgPack(toWireIntegers(data) as T, { useBigInt64: true });
}

export function decodeMsgPackPayload<T>(payload: Uint8Array): T {
  return decodeMsgPack(payload, { useBigInt64: true }) as T;
}
