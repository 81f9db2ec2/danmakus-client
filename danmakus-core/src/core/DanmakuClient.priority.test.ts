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
      client.holdingRoomCoordinator.queueRoomConnect(6154037, "high");
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
        clientsTag: null,
        recordingTag: null,
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

    await client.runtimeSync.heartbeatRuntimeState();

    expect(refreshCalls).toEqual([
      {
        maxConnections: 5,
        reason: "assignment-tag-changed",
        options: { force: true },
      },
    ]);
    expect(client.assignmentTag).toBe("assignment-tag-v2");
  });

  it("does not request rooms on heartbeat when assignment tag is unchanged", async () => {
    const client: any = new DanmakuClient({
      runtimeUrl: "https://example.com/api/v2/core-runtime",
      maxConnections: 5,
      requestServerRooms: true,
      streamers: [],
    });

    const refreshCalls: Array<{ maxConnections: number; reason: string; options?: { force?: boolean } }> = [];
    client.assignmentTag = "assignment-tag-v2";
    client.accountClient = {
      heartbeatRuntimeState: async () => ({
        configTag: null,
        assignmentTag: "assignment-tag-v2",
        clientsTag: null,
        recordingTag: null,
      }),
    };
    client.handleAccountConfigTagChange = async () => undefined;
    client.handleClientsTagChange = async () => undefined;
    client.handleRecordingTagChange = async () => undefined;
    client.refreshHoldingRoomsIfNeeded = async (
      maxConnections: number,
      reason: string,
      options?: { force?: boolean }
    ) => {
      refreshCalls.push({ maxConnections, reason, options });
      return true;
    };

    await client.runtimeSync.heartbeatRuntimeState();

    expect(refreshCalls).toEqual([]);
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
    expect(client.connections.has(999)).toBe(false);
    expect(closedRooms).toEqual([101, 999]);
    expect(client._connectionsUpdated).toBe(true);
    expect(client._synced).toBe(true);
  });

  it("abandons an in-flight connect when the room is no longer desired", async () => {
    const client: any = new DanmakuClient({
      runtimeUrl: "https://example.com/api/v2/core-runtime",
      maxConnections: 5,
      requestServerRooms: true,
      streamers: [],
    });

    let resolveConnectionOptions: ((value: unknown) => void) | undefined;
    let factoryCallCount = 0;
    client.isRunning = true;
    client._desiredRooms = [{ roomId: 4455, priority: "server" }];
    client.statusManager = {
      getRoomsToConnect: () => client._desiredRooms,
    };
    client.resolveLiveWsConnectionOptions = () => new Promise((resolve) => {
      resolveConnectionOptions = resolve;
    });
    client.liveWsConnectionFactory = async () => {
      factoryCallCount += 1;
      return {
        addEventListener: () => undefined,
        close: () => undefined,
      };
    };
    client.syncRuntimeState = async () => undefined;

    const connecting = client.connectToRoom(4455, "server");
    client._desiredRooms = [];
    resolveConnectionOptions?.({
      roomId: 4455,
      address: "wss://example.com/sub",
      key: "key-4455",
      uid: 1,
      protover: 3,
    });
    await connecting;

    expect(factoryCallCount).toBe(0);
    expect(client.connections.has(4455)).toBe(false);
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

  it("refreshes statuses and connections immediately when recording rooms change", async () => {
    const client: any = new DanmakuClient({
      runtimeUrl: "https://example.com/api/v2/core-runtime",
      maxConnections: 5,
      requestServerRooms: false,
      streamers: [],
    });

    const updatedRooms: number[][] = [];
    let refreshNowCount = 0;
    let refreshHoldingRoomsCount = 0;
    let updateConnectionsCount = 0;
    client.isRunning = true;
    client.statusManager = {
      updateRecordingRooms: (rooms: number[]) => {
        updatedRooms.push([...rooms]);
      },
      refreshNow: () => {
        refreshNowCount += 1;
      },
    };
    client.updateConnections = () => {
      updateConnectionsCount += 1;
    };
    client.refreshHoldingRoomsIfNeeded = async () => {
      refreshHoldingRoomsCount += 1;
      return true;
    };
    client.accountClient = {
      getRecordingList: async () => ({
        data: [
          {
            channel: { roomId: 2233 },
          },
        ],
        tags: { recordingTag: "recording-tag-v2", configTag: null, clientsTag: null },
      }),
    };

    await client.controlState.refreshRecordingList(true);

    expect(client.recordingRoomIds).toEqual([2233]);
    expect(updatedRooms).toEqual([[2233]]);
    expect(refreshNowCount).toBe(1);
    expect(refreshHoldingRoomsCount).toBe(1);
    expect(updateConnectionsCount).toBe(1);
  });

  it("skips duplicate connections that resolve to the same actual room", async () => {
    const client: any = new DanmakuClient({
      runtimeUrl: "https://example.com/api/v2/core-runtime",
      maxConnections: 5,
      requestServerRooms: true,
      streamers: [],
    });

    let factoryCallCount = 0;
    client.isRunning = true;
    client._desiredRooms = [
      { roomId: 1001, priority: "high" },
      { roomId: 1002, priority: "server" },
    ];
    client.statusManager = {
      getRoomsToConnect: () => client._desiredRooms,
    };
    client.resolveLiveWsConnectionOptions = async (roomId: number) => ({
      roomId: 5566,
      address: "wss://example.com/sub",
      key: `key-${roomId}`,
      uid: 1,
      protover: 3,
    });
    client.liveWsConnectionFactory = async () => {
      factoryCallCount += 1;
      return {
        addEventListener: () => undefined,
        close: () => undefined,
      };
    };
    client.syncRuntimeState = async () => undefined;

    await client.connectToRoom(1001, "high");
    await client.connectToRoom(1002, "server");

    expect(factoryCallCount).toBe(1);
    expect(client.connections.size).toBe(1);
    expect(client.connections.get(1001)?.resolvedRoomId).toBe(5566);
    expect(client.connections.has(1002)).toBe(false);
  });

  it("drops identical incoming messages within the dedup window", async () => {
    const client: any = new DanmakuClient({
      runtimeUrl: "https://example.com/api/v2/core-runtime",
      maxConnections: 5,
      requestServerRooms: true,
      streamers: [],
    });

    client.isRunning = true;
    client.messageQueue.scheduleMessageDispatch = () => undefined;

    const message = {
      roomId: 7788,
      cmd: "DANMU_MSG",
      raw: '{"cmd":"DANMU_MSG","info":[1,2,3]}',
      timestamp: Date.now(),
      data: { cmd: "DANMU_MSG" },
    };

    await client.handleMessage(message);
    await client.handleMessage({ ...message, timestamp: message.timestamp + 1 });

    expect(client.messageCount).toBe(1);
    expect(client.messageQueue.getPendingCount()).toBe(1);
  });
});
