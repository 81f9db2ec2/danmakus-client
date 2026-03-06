import { afterEach, describe, expect, it } from "bun:test";
import { RuntimeConnection } from "./RuntimeConnection";

const originalFetch = globalThis.fetch;

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
    });
  });
});
