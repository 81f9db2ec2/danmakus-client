import { describe, expect, it } from "bun:test";
import { brotliCompressSync } from "node:zlib";
import type { LiveWsConnection } from "../types/index.js";
import { createWireRawLiveWsConnection } from "./WireRawLiveWsConnection.js";

const textEncoder = new TextEncoder();

class MockLiveWsConnection implements LiveWsConnection {
  private readonly listeners = new Map<string, Set<(event: any) => void>>();

  addEventListener(type: string, listener: (event: any) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set<(event: any) => void>();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.emit("close", {});
  }

  emit(type: string, event: any): void {
    const set = this.listeners.get(type);
    if (!set) {
      return;
    }
    for (const listener of set) {
      listener(event);
    }
  }
}

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

const createPacket = (body: Uint8Array, protocol: number): Uint8Array => {
  const packet = new Uint8Array(body.length + 16);
  const view = new DataView(packet.buffer);
  view.setInt32(0, packet.length);
  view.setInt16(4, 16);
  view.setInt16(6, protocol);
  view.setInt32(8, 5);
  view.setInt32(12, 1);
  packet.set(body, 16);
  return packet;
};

const flushAsyncTasks = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 10));
};

describe("createWireRawLiveWsConnection", () => {
  it("emits exact raw json for uncompressed message packets", async () => {
    const base = new MockLiveWsConnection();
    const wrapped = createWireRawLiveWsConnection(base);
    const received: Array<{ data: any; raw: string; }> = [];
    wrapped.addEventListener("msg", (event: any) => {
      received.push(event);
    });

    const raw = '{"cmd":"DANMU_MSG","info":[1,2,3]}';
    base.emit("message", { data: createPacket(textEncoder.encode(raw), 0) });
    await flushAsyncTasks();

    expect(received).toHaveLength(1);
    expect(received[0]?.raw).toBe(raw);
    expect(received[0]?.data).toEqual(JSON.parse(raw));
  });

  it("decodes brotli frames into per-message raw json strings", async () => {
    const base = new MockLiveWsConnection();
    const wrapped = createWireRawLiveWsConnection(base);
    const received: Array<{ data: any; raw: string; }> = [];
    wrapped.addEventListener("msg", (event: any) => {
      received.push(event);
    });

    const rawOne = '{"cmd":"DANMU_MSG","info":[[0,1,25,16777215,1776127683212],"\u6ce5\u568e\u5b9d\u5b9d",[248833739,"user-a",0,0],[],[],[],[],0,0,{"ct":"{}"}]}';
    const rawTwo = '{"cmd":"WATCHED_CHANGE","data":{"num":123}}';
    const innerFrame = concatUint8Arrays([
      createPacket(textEncoder.encode(rawOne), 0),
      createPacket(textEncoder.encode(rawTwo), 0),
    ]);
    const outerFrame = createPacket(new Uint8Array(brotliCompressSync(innerFrame)), 3);
    base.emit("message", { data: outerFrame });
    await flushAsyncTasks();

    expect(received.map(item => item.raw)).toEqual([rawOne, rawTwo]);
    expect(received[0]?.data.cmd).toBe("DANMU_MSG");
    expect(received[1]?.data.cmd).toBe("WATCHED_CHANGE");
  });

  it("falls back when DecompressionStream exists but brotli is unsupported", async () => {
    const originalDecompressionStream = (globalThis as typeof globalThis & {
      DecompressionStream?: unknown;
    }).DecompressionStream;

    class UnsupportedBrotliDecompressionStream {
      constructor(format: string) {
        if (format === "brotli") {
          throw new TypeError("Unsupported compression format: 'brotli'");
        }
        throw new TypeError(`Unexpected format: ${format}`);
      }
    }

    (globalThis as typeof globalThis & { DecompressionStream?: unknown }).DecompressionStream =
      UnsupportedBrotliDecompressionStream;

    try {
      const base = new MockLiveWsConnection();
      const wrapped = createWireRawLiveWsConnection(base);
      const received: Array<{ data: any; raw: string; }> = [];
      wrapped.addEventListener("msg", (event: any) => {
        received.push(event);
      });

      const raw = '{"cmd":"WATCHED_CHANGE","data":{"num":456}}';
      const innerFrame = createPacket(textEncoder.encode(raw), 0);
      const outerFrame = createPacket(new Uint8Array(brotliCompressSync(innerFrame)), 3);
      base.emit("message", { data: outerFrame });
      await flushAsyncTasks();

      expect(received).toHaveLength(1);
      expect(received[0]?.raw).toBe(raw);
      expect(received[0]?.data).toEqual(JSON.parse(raw));
    } finally {
      (globalThis as typeof globalThis & { DecompressionStream?: unknown }).DecompressionStream =
        originalDecompressionStream;
    }
  });
});
