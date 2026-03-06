import { describe, expect, it } from "bun:test";
import { DanmakuClient } from "./DanmakuClient";

describe("DanmakuClient room connect queue", () => {
  it("starts the first queued room connect immediately", () => {
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
      expect(delays[0]).toBe(0);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      client.roomConnectQueueTimer = undefined;
    }
  });
});

describe("DanmakuClient room pull flow", () => {
  it("forces a room request on heartbeat when assignment tag changes", async () => {
    const client: any = new DanmakuClient({
      runtimeUrl: "https://example.com/api/v2/core-runtime",
      maxConnections: 5,
      requestServerRooms: true,
      streamers: [],
    });

    const refreshCalls: Array<{ maxConnections: number; reason: string; options?: { force?: boolean } }> = [];
    client.accountClient = {
      heartbeatRuntimeState: async () => ({
        configTag: null,
        assignmentTag: "assignment-tag-v2",
      }),
    };
    client.handleAccountConfigTagChange = async () => undefined;
    client.refreshHoldingRoomsIfNeeded = async (
      maxConnections: number,
      reason: string,
      options?: { force?: boolean }
    ) => {
      refreshCalls.push({ maxConnections, reason, options });
      return true;
    };

    await client.heartbeatRuntimeState();

    expect(refreshCalls).toEqual([
      {
        maxConnections: 5,
        reason: "assignment-tag-changed",
        options: { force: true },
      },
    ]);
    expect(client.assignmentTag).toBe("assignment-tag-v2");
  });

  it("requests rooms with current holding state and applies the returned holding rooms", async () => {
    const client: any = new DanmakuClient({
      runtimeUrl: "https://example.com/api/v2/core-runtime",
      maxConnections: 5,
      requestServerRooms: true,
      streamers: [],
    });

    const closedRooms: number[] = [];
    client.holdingRoomIds = [101, 102];
    client.connections = new Map([
      [101, { roomId: 101, priority: "server", connectedAt: 1, connection: { close: () => closedRooms.push(101) } }],
      [999, { roomId: 999, priority: "high", connectedAt: 1, connection: { close: () => closedRooms.push(999) } }],
    ]);
    client.statusManager = {
      updateHoldingRooms: (rooms: number[]) => {
        client._updatedRooms = rooms;
      },
      refreshNow: () => {
        client._refreshed = true;
      },
    };
    client.updateConnections = () => {
      client._connectionsUpdated = true;
    };
    client.syncRuntimeState = async () => {
      client._synced = true;
    };
    client.runtimeConnection = {
      getConnectionState: () => true,
      requestRooms: async (payload: unknown) => {
        client._requestPayload = payload;
        return {
          holdingRooms: [102, 103],
          newlyAssignedRooms: [103],
          droppedRooms: [101],
          effectiveCapacity: 5,
          nextRequestAfter: null,
        };
      },
    };

    const success = await client.refreshHoldingRoomsIfNeeded(5, "manual-refresh");

    expect(success).toBe(true);
    expect(client._requestPayload).toEqual({
      reason: "manual-refresh",
      holdingRooms: [101, 102],
      connectedRooms: [101],
      desiredCount: 3,
      capacityOverride: undefined,
    });
    expect(client.holdingRoomIds).toEqual([102, 103]);
    expect(client._updatedRooms).toEqual([102, 103]);
    expect(client.connections.has(101)).toBe(false);
    expect(client.connections.has(999)).toBe(true);
    expect(closedRooms).toEqual([101]);
    expect(client._connectionsUpdated).toBe(true);
    expect(client._synced).toBe(true);
  });

  it("forces a room request during reconnect even when cooldown is active and desiredCount is zero", async () => {
    const client: any = new DanmakuClient({
      runtimeUrl: "https://example.com/api/v2/core-runtime",
      maxConnections: 5,
      requestServerRooms: true,
      streamers: [],
    });

    client.holdingRoomIds = [101, 102, 103, 104, 105];
    client.nextHoldingRoomRequestAt = Date.now() + 60_000;
    client.statusManager = {
      updateHoldingRooms: () => undefined,
      refreshNow: () => undefined,
    };
    client.updateConnections = () => undefined;
    client.syncRuntimeState = async () => undefined;
    client.runtimeConnection = {
      getConnectionState: () => true,
      requestRooms: async (payload: unknown) => {
        client._requestPayload = payload;
        return {
          holdingRooms: [101, 102, 103, 104, 105],
          newlyAssignedRooms: [],
          droppedRooms: [],
          effectiveCapacity: 5,
          nextRequestAfter: null,
        };
      },
    };

    const success = await client.refreshHoldingRoomsIfNeeded(5, "runtime-reconnect", { force: true });

    expect(success).toBe(true);
    expect(client._requestPayload).toEqual({
      reason: "runtime-reconnect",
      holdingRooms: [101, 102, 103, 104, 105],
      connectedRooms: [],
      desiredCount: 0,
      capacityOverride: undefined,
    });
  });
});
