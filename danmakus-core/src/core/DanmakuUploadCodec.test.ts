import { afterEach, describe, expect, it } from "bun:test";
import { decode } from "@msgpack/msgpack";
import { encodeArchiveUploadEnvelope } from "./DanmakuUploadCodec.js";
import { encodeMsgPackPayload, toWireIntegers } from "./CoreWebSocketCodec.js";

const originalCompressionStream = globalThis.CompressionStream;

class HangingZstdCompressionStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;

  constructor(format: string) {
    if (format === "zstd") {
      this.readable = new ReadableStream<Uint8Array>({ start() {} });
      this.writable = new WritableStream<Uint8Array>({
        write: async () => undefined,
        close: async () => undefined,
      });
      return;
    }

    if (format !== "gzip") {
      throw new TypeError(`unsupported format: ${format}`);
    }

    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.readable = new ReadableStream<Uint8Array>({
      start: value => {
        controller = value;
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      write: async () => undefined,
      close: async () => {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
  }
}

afterEach(() => {
  globalThis.CompressionStream = originalCompressionStream;
});

describe("DanmakuUploadCodec", () => {
  it("falls back to the next compression format when a stream does not settle", async () => {
    globalThis.CompressionStream = HangingZstdCompressionStream as typeof CompressionStream;

    const encoded = await encodeArchiveUploadEnvelope({
      items: [{
        localId: 1,
        streamerUid: 2,
        eventTsMs: 1710000001000,
        payload: new Uint8Array([4, 5, 6]),
      }],
    }, {
      compressionAttemptTimeoutMs: 20,
    });

    const envelope = decode(encoded.body) as { compression: string; payload: Uint8Array };
    expect(encoded.compression).toBe("gzip");
    expect(envelope.compression).toBe("gzip");
    expect(envelope.payload).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("encodes millisecond timestamps as 64-bit integers instead of float64", () => {
    const wired = toWireIntegers({
      eventTsMs: 1710000000000,
      sendDate: 1710000000000,
      roomId: 13308358,
    }) as { eventTsMs: bigint; sendDate: bigint; roomId: number };
    expect(wired.eventTsMs).toBe(1710000000000n);
    expect(wired.sendDate).toBe(1710000000000n);
    expect(wired.roomId).toBe(13308358);

    const encoded = encodeMsgPackPayload({
      eventTsMs: 1710000000000,
      danmaku: { sendDate: 1710000000000, type: 0 },
    });
    expect(encoded.includes(0xcb)).toBe(false);
    const decoded = decode(encoded, { useBigInt64: true }) as {
      eventTsMs: bigint;
      danmaku: { sendDate: bigint; type: number };
    };
    expect(decoded.eventTsMs).toBe(1710000000000n);
    expect(decoded.danmaku.sendDate).toBe(1710000000000n);
  });
});
