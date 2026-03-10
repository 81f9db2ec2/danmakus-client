import { describe, expect, it } from "bun:test";
import type { DanmakuConfig } from "../types";
import { DanmakuHoldingRoomCoordinator } from "./DanmakuHoldingRoomCoordinator";
import { StreamerStatusManager } from "./StreamerStatusManager";

function createCoordinatorContext(options?: {
  requestServerRooms?: boolean;
  holdingRooms?: number[];
  recordingRooms?: number[];
  connectedRooms?: Array<{ roomId: number; priority: "high" | "normal" | "low" | "server" }>;
  runtimeConnected?: boolean;
}) {
  const disconnectedRooms: number[] = [];
  const queuedConnects: Array<{ roomId: number; priority: "high" | "normal" | "low" | "server" }> = [];
  let syncCallCount = 0;
  let updateConnectionsCallCount = 0;
  let refreshStatusNowCallCount = 0;
  const connectionMap = new Map(
    (options?.connectedRooms ?? []).map((item) => [
      item.roomId,
      {
        roomId: item.roomId,
        priority: item.priority,
        connectedAt: Date.now(),
        connection: {
          close: () => disconnectedRooms.push(item.roomId),
        },
      },
    ])
  );
  let holdingRooms = [...(options?.holdingRooms ?? [])];
  let recordingRooms = [...(options?.recordingRooms ?? [])];
  let queuedRoomConnects: Array<{ roomId: number; priority: "high" | "normal" | "low" | "server" }> = [];
  const queuedRoomIds = new Set<number>();
  let roomConnectQueueTimer: ReturnType<typeof setTimeout> | undefined;
  let lastRoomConnectStartAt = 0;

  const statusManager: any = new StreamerStatusManager(30, "https://example.com/api/v2/core-runtime");
  statusManager.updateHoldingRooms(holdingRooms);
  statusManager.updateRecordingRooms(recordingRooms);
  statusManager.statusCache = new Map([
    [201, { roomId: 201, isLive: true }],
    [301, { roomId: 301, isLive: true }],
  ]);

  const config: DanmakuConfig = {
    runtimeUrl: "https://example.com/api/v2/core-runtime",
    maxConnections: 5,
    requestServerRooms: options?.requestServerRooms ?? true,
    streamers: [],
  } as DanmakuConfig;

  const context = {
    isRunning: () => true,
    isStopping: () => false,
    getConfig: () => config,
    getRuntimeConnection: () => ({
      getConnectionState: () => options?.runtimeConnected ?? true,
      requestRooms: async () => null,
    }),
    getStatusManager: () => statusManager,
    getRecordingRoomIds: () => [...recordingRooms],
    getConnections: () => connectionMap,
    disconnectFromRoom: (roomId: number) => {
      const connection = connectionMap.get(roomId);
      if (!connection) {
        return;
      }
      connection.connection.close();
      connectionMap.delete(roomId);
    },
    connectToRoom: async (roomId: number, priority: "high" | "normal" | "low" | "server") => {
      queuedConnects.push({ roomId, priority });
    },
    updateConnections: () => {
      updateConnectionsCallCount += 1;
    },
    syncRuntimeState: () => {
      syncCallCount += 1;
    },
    refreshStatusNow: () => {
      refreshStatusNowCallCount += 1;
    },
    updateHoldingRooms: (roomIds: number[]) => {
      holdingRooms = [...roomIds];
      statusManager.updateHoldingRooms(roomIds);
    },
    getHoldingRoomIds: () => [...holdingRooms],
    setHoldingRoomIds: (roomIds: number[]) => {
      holdingRooms = [...roomIds];
    },
    getHoldingRoomRequestRefreshing: () => false,
    setHoldingRoomRequestRefreshing: () => undefined,
    getNextHoldingRoomRequestAt: () => 0,
    setNextHoldingRoomRequestAt: () => undefined,
    getQueuedRoomConnects: () => queuedRoomConnects,
    setQueuedRoomConnects: (value: Array<{ roomId: number; priority: "high" | "normal" | "low" | "server" }>) => {
      queuedRoomConnects = value;
    },
    getQueuedRoomIds: () => queuedRoomIds,
    getRoomConnectQueueTimer: () => roomConnectQueueTimer,
    setRoomConnectQueueTimer: (value: ReturnType<typeof setTimeout> | undefined) => {
      roomConnectQueueTimer = value;
    },
    getLastRoomConnectStartAt: () => lastRoomConnectStartAt,
    setLastRoomConnectStartAt: (value: number) => {
      lastRoomConnectStartAt = value;
    },
    getRoomConnectStartInterval: () => 10_000,
    getLastRoomAssigned: () => undefined,
    setLastRoomAssigned: () => undefined,
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      child: () => this,
    },
  };

  return {
    coordinator: new DanmakuHoldingRoomCoordinator(context as never),
    disconnectedRooms,
    queuedConnects,
    connectionMap,
    getSyncCallCount: () => syncCallCount,
    getUpdateConnectionsCallCount: () => updateConnectionsCallCount,
    getRefreshStatusNowCallCount: () => refreshStatusNowCallCount,
  };
}

describe("DanmakuHoldingRoomCoordinator room selection", () => {
  it("disconnects recording-only rooms when room pull mode is enabled", () => {
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, _timeout?: number) => 1 as ReturnType<typeof setTimeout>) as typeof setTimeout;

    try {
      const { coordinator, disconnectedRooms, connectionMap } = createCoordinatorContext({
        requestServerRooms: true,
        holdingRooms: [301],
        recordingRooms: [201],
        connectedRooms: [{ roomId: 201, priority: "high" }],
      });

      coordinator.applyConnectionsUpdate();

      expect(disconnectedRooms).toEqual([201]);
      expect(connectionMap.has(201)).toBe(false);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it("disconnects recording-only rooms even when supplemental assignments are disabled", () => {
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, _timeout?: number) => 1 as ReturnType<typeof setTimeout>) as typeof setTimeout;

    try {
      const { coordinator, disconnectedRooms, connectionMap } = createCoordinatorContext({
        requestServerRooms: false,
        holdingRooms: [301],
        recordingRooms: [201],
        connectedRooms: [{ roomId: 201, priority: "high" }],
      });

      coordinator.applyConnectionsUpdate();

      expect(disconnectedRooms).toEqual([201]);
      expect(connectionMap.has(201)).toBe(false);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it("still requests server assignments when supplemental assignments are disabled", async () => {
    let requestPayload: Record<string, unknown> | null = null;
    const statusManager: any = new StreamerStatusManager(30, "https://example.com/api/v2/core-runtime");
    statusManager.updateHoldingRooms([]);
    statusManager.updateRecordingRooms([201]);
    statusManager.statusCache = new Map([
      [201, { roomId: 201, isLive: true }],
    ]);

    let holdingRooms: number[] = [];
    const coordinator = new DanmakuHoldingRoomCoordinator({
      isRunning: () => true,
      isStopping: () => false,
      getConfig: () => ({
        runtimeUrl: "https://example.com/api/v2/core-runtime",
        maxConnections: 5,
        requestServerRooms: false,
        streamers: [],
      } as DanmakuConfig),
      getRuntimeConnection: () => ({
        getConnectionState: () => true,
        requestRooms: async (payload: Record<string, unknown>) => {
          requestPayload = payload;
          return {
            holdingRooms: [201],
            newlyAssignedRooms: [201],
            droppedRooms: [],
            effectiveCapacity: 5,
            nextRequestAfter: 0,
          };
        },
      }),
      getStatusManager: () => statusManager,
      getRecordingRoomIds: () => [201],
      getConnections: () => new Map(),
      disconnectFromRoom: () => undefined,
      connectToRoom: async () => undefined,
      updateConnections: () => undefined,
      syncRuntimeState: () => undefined,
      refreshStatusNow: () => undefined,
      updateHoldingRooms: (rooms: number[]) => {
        holdingRooms = [...rooms];
        statusManager.updateHoldingRooms(rooms);
      },
      getHoldingRoomIds: () => [...holdingRooms],
      setHoldingRoomIds: (rooms: number[]) => {
        holdingRooms = [...rooms];
      },
      getHoldingRoomRequestRefreshing: () => false,
      setHoldingRoomRequestRefreshing: () => undefined,
      getNextHoldingRoomRequestAt: () => 0,
      setNextHoldingRoomRequestAt: () => undefined,
      getQueuedRoomConnects: () => [],
      setQueuedRoomConnects: () => undefined,
      getQueuedRoomIds: () => new Set<number>(),
      getRoomConnectQueueTimer: () => undefined,
      setRoomConnectQueueTimer: () => undefined,
      getLastRoomConnectStartAt: () => 0,
      setLastRoomConnectStartAt: () => undefined,
      getRoomConnectStartInterval: () => 10_000,
      getLastRoomAssigned: () => undefined,
      setLastRoomAssigned: () => undefined,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
        child: () => this,
      },
    } as never);

    const success = await coordinator.refreshHoldingRoomsIfNeeded(5, "followed-only", { force: true });

    expect(success).toBe(true);
    expect(requestPayload).toEqual({
      reason: "followed-only",
      holdingRooms: [],
      connectedRooms: [],
      desiredCount: 5,
      capacityOverride: undefined,
    });
    expect(holdingRooms).toEqual([201]);
  });

  it("does not fan out refreshes or sync when holding room result is unchanged", () => {
    const {
      coordinator,
      getSyncCallCount,
      getUpdateConnectionsCallCount,
      getRefreshStatusNowCallCount,
    } = createCoordinatorContext({
      holdingRooms: [301],
      connectedRooms: [{ roomId: 301, priority: "server" }],
    });

    coordinator.applyHoldingRoomResult({
      holdingRooms: [301],
      newlyAssignedRooms: [],
      droppedRooms: [],
      effectiveCapacity: 5,
      nextRequestAfter: 0,
    });

    expect(getRefreshStatusNowCallCount()).toBe(0);
    expect(getUpdateConnectionsCallCount()).toBe(0);
    expect(getSyncCallCount()).toBe(0);
  });

  it("does not sync runtime state on a no-op connections update", () => {
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, _timeout?: number) => 1 as ReturnType<typeof setTimeout>) as typeof setTimeout;

    try {
      const { coordinator, getSyncCallCount } = createCoordinatorContext({
        holdingRooms: [301],
        connectedRooms: [{ roomId: 301, priority: "server" }],
        runtimeConnected: false,
      });

      coordinator.applyConnectionsUpdate();

      expect(getSyncCallCount()).toBe(0);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});
