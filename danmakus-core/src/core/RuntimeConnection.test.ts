import { afterEach, describe, expect, it } from "bun:test";
import { decode } from "@msgpack/msgpack";
import { Zstd } from "@hpcc-js/wasm-zstd";
import { RuntimeConnection } from "./RuntimeConnection.js";

const TEST_STREAMER_UID = 84;

const originalFetch = globalThis.fetch;

const normalizeBodyBytes = async (body: BodyInit | null | undefined): Promise<Uint8Array> => {
  if (!body) {
    return new Uint8Array(0);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }
  throw new Error(`unsupported request body type: ${Object.prototype.toString.call(body)}`);
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("RuntimeConnection room pull", () => {
  it("posts local holding state to request-room and returns normalized response", async () => {
    const requests: Array<{ url: string; body: unknown; headers: Headers }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
        headers: new Headers(init?.headers),
      });

      return new Response(JSON.stringify({
        code: 200,
        data: {
          holdingRooms: [202, 203],
          newlyAssignedRooms: [203],
          droppedRooms: [201],
          effectiveCapacity: 4,
          nextRequestAfter: 1710000000000,
          shortfall: {
            reason: 'candidate_pool_exhausted',
            missingCount: 1,
            candidateCount: 2,
            assignableCandidateCount: 2,
            blockedBySameAccountCount: 0,
            blockedByOtherAccountsCount: 1,
          },
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const runtime = new RuntimeConnection("https://example.com/api/v2/core-runtime?token=test-token&clientId=test-client");
    await runtime.connect();

    const result = await (runtime as any).requestRooms({
      holdingRooms: [201, 202],
      connectedRooms: [202],
      desiredCount: 2,
      capacityOverride: 4,
      reason: "capacity-refresh",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://example.com/api/v2/core-runtime/request-room");
    expect(requests[0]?.headers.get("Token")).toBe("test-token");
    expect(requests[0]?.body).toEqual({
      clientId: "test-client",
      holdingRooms: [201, 202],
      connectedRooms: [202],
      desiredCount: 2,
      capacityOverride: 4,
      reason: "capacity-refresh",
    });
    expect(result).toEqual({
      holdingRooms: [202, 203],
      newlyAssignedRooms: [203],
      droppedRooms: [201],
      effectiveCapacity: 4,
      nextRequestAfter: 1710000000000,
      shortfall: {
        reason: 'candidate_pool_exhausted',
        missingCount: 1,
        candidateCount: 2,
        assignableCandidateCount: 2,
        blockedBySameAccountCount: 0,
        blockedByOtherAccountsCount: 1,
      },
    });
  });

  it("falls back to api.danmakus.com when primary runtime api fails", async () => {
    const requests: Array<{ url: string; body: unknown; headers: Headers }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        headers: new Headers(init?.headers),
      });

      if (url.startsWith('https://example.com/')) {
        return new Response('bad gateway', { status: 502 });
      }

      return new Response(JSON.stringify({
        code: 200,
        data: {
          holdingRooms: [401],
          newlyAssignedRooms: [401],
          droppedRooms: [],
          effectiveCapacity: 1,
          nextRequestAfter: 1710000001000,
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const runtime = new RuntimeConnection("https://example.com/api/v2/core-runtime?token=test-token&clientId=test-client");
    await runtime.connect();

    const result = await (runtime as any).requestRooms({
      holdingRooms: [],
      connectedRooms: [],
      desiredCount: 1,
      reason: "fallback-check",
    });

    expect(requests.map((item) => item.url)).toEqual([
      'https://example.com/api/v2/core-runtime/request-room',
      'https://api.danmakus.com/api/v2/core-runtime/request-room'
    ]);
    expect(result).toEqual({
      holdingRooms: [401],
      newlyAssignedRooms: [401],
      droppedRooms: [],
      effectiveCapacity: 1,
      nextRequestAfter: 1710000001000,
      shortfall: null,
    });
    expect(runtime.getConnectionState()).toBe(true);
  });

  it("marks runtime disconnected after request-room fails on all candidates", async () => {
    let disconnectedError: Error | undefined;
    globalThis.fetch = (async () => new Response('bad gateway', { status: 502 })) as typeof fetch;

    const runtime = new RuntimeConnection("https://example.com/api/v2/core-runtime?token=test-token&clientId=test-client");
    runtime.onDisconnected = (error?: Error) => {
      disconnectedError = error;
    };
    await runtime.connect();

    const result = await (runtime as any).requestRooms({
      holdingRooms: [201],
      connectedRooms: [201],
      desiredCount: 1,
      reason: "disconnect-check",
    });

    expect(result).toBeNull();
    expect(runtime.getConnectionState()).toBe(false);
    expect(disconnectedError).toBeInstanceOf(Error);
  });

  it("posts archive batches with streamerUid and eventTsMs only", async () => {
    const requests: Array<{ url: string; body: unknown; headers: Headers }> = [];
    const zstd = await Zstd.load();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const bodyBytes = await normalizeBodyBytes(init?.body);
      requests.push({
        url: String(input),
        body: decode(zstd.decompress(bodyBytes)),
        headers: new Headers(init?.headers),
      });

      return new Response(JSON.stringify({
        code: 200,
        data: {
          ackedLocalIds: [7],
          rejected: [],
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const runtime = new RuntimeConnection("https://example.com/api/v2/core-runtime?token=test-token&clientId=test-client");
    await runtime.connect();

    await runtime.sendArchiveBatch([{
      id: 7,
      streamerUid: TEST_STREAMER_UID,
      eventTsMs: 1710000001000,
      payload: new Uint8Array([1, 2, 3]),
      retryCount: 0,
      nextRetryAtMs: 1710000001000,
    }]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://example.com/api/v2/core-runtime/upload-danmakus-v3");
    expect(requests[0]?.headers.get("Content-Type")).toBe("application/x-msgpack");
    expect(requests[0]?.headers.get("Content-Encoding")).toBe("zstd");
    expect(requests[0]?.body).toEqual({
      batchId: expect.any(String),
      clientId: "test-client",
      items: [{
        localId: 7,
        streamerUid: TEST_STREAMER_UID,
        eventTsMs: 1710000001000,
        payload: new Uint8Array([1, 2, 3]),
      }],
    });
  });
});
