import { describe, expect, it } from 'bun:test';
import {
  CoreWsOpCode,
  decodeMsgPackPayload,
  decodeWsFrame,
  encodeMsgPackPayload,
  encodeWsFrame,
  WS_FRAME_HEADER_SIZE,
} from './CoreWebSocketCodec.js';

describe('CoreWebSocketCodec', () => {
  it('encodes and decodes a frame with empty payload', () => {
    const frame = encodeWsFrame(CoreWsOpCode.CLIENT_AUTH, 12345);
    expect(frame.byteLength).toBe(WS_FRAME_HEADER_SIZE);

    const decoded = decodeWsFrame(frame);
    expect(decoded.opCode).toBe(CoreWsOpCode.CLIENT_AUTH);
    expect(decoded.seq).toBe(12345);
    expect(decoded.payload.byteLength).toBe(0);
  });

  it('encodes and decodes a frame with messagepack payload', () => {
    const authData = {
      token: 'test-token-xyz',
      clientId: 'client-node-01',
      version: '1.2.3',
    };
    const payload = encodeMsgPackPayload(authData);
    const frame = encodeWsFrame(CoreWsOpCode.CLIENT_AUTH, 1, payload);

    expect(frame.byteLength).toBe(WS_FRAME_HEADER_SIZE + payload.byteLength);

    const decoded = decodeWsFrame(frame);
    expect(decoded.opCode).toBe(CoreWsOpCode.CLIENT_AUTH);
    expect(decoded.seq).toBe(1);

    const decodedAuth = decodeMsgPackPayload<typeof authData>(decoded.payload);
    expect(decodedAuth).toEqual(authData);
  });

  it('throws error when frame is too short', () => {
    const shortData = new Uint8Array([1, 2, 3]);
    expect(() => decodeWsFrame(shortData)).toThrow('WebSocket 帧过短');
  });
});
