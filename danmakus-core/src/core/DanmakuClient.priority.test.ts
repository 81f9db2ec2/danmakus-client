import { describe, expect, it } from "bun:test";
import { DanmakuClient } from "./DanmakuClient";

describe("DanmakuClient room connect queue", () => {
  it("waits 10 seconds before the first queued room connect", () => {
    const client: any = new DanmakuClient({
      runtimeUrl: "https://example.com/api/v2/core-runtime",
      maxConnections: 5,
      streamers: [],
    });

    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number) => {
      delays.push(Number(timeout ?? 0));
      return 1 as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    try {
      client.isRunning = true;
      client.queueRoomConnect(6154037, "high");
      expect(delays[0]).toBe(10_000);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      client.roomConnectQueueTimer = undefined;
    }
  });
});

describe("DanmakuClient recording priority", () => {
  it("drops server-assigned rooms when recording rooms already fill capacity", () => {
    const client: any = new DanmakuClient({
      runtimeUrl: "https://example.com/api/v2/core-runtime",
      maxConnections: 5,
      requestServerRooms: true,
      streamers: [],
    });

    client.recordingRoomIds = [101, 102, 103, 104, 105];
    client.serverAssignedRooms = [201, 202];
    client.connections = new Map();
    client.statusManager = {
      updateServerRooms: (rooms: number[]) => {
        client._updatedServerRooms = rooms;
      },
      updateRecordingRooms: () => undefined,
      getStreamerStatus: (roomId: number) => ({ roomId, isLive: true }),
    };

    client.trimServerAssignedRoomsToCapacity(5);

    expect(client.serverAssignedRooms).toEqual([]);
    expect(client._updatedServerRooms).toEqual([]);
  });

  it("prefers non-recording server rooms when only one extra slot remains", () => {
    const client: any = new DanmakuClient({
      runtimeUrl: "https://example.com/api/v2/core-runtime",
      maxConnections: 5,
      requestServerRooms: true,
      streamers: [],
    });

    client.recordingRoomIds = [101, 102, 103, 104];
    client.serverAssignedRooms = [101, 102, 103, 104, 201];
    client.connections = new Map();
    client.statusManager = {
      updateServerRooms: (rooms: number[]) => {
        client._updatedServerRooms = rooms;
      },
      updateRecordingRooms: () => undefined,
      getStreamerStatus: (roomId: number) => ({ roomId, isLive: true }),
    };

    client.trimServerAssignedRoomsToCapacity(5);

    expect(client.serverAssignedRooms).toEqual([201]);
    expect(client._updatedServerRooms).toEqual([201]);
  });
});
