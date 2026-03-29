import { describe, expect, it } from "bun:test";
import type { DanmakuConfig, RuntimeRoomPullShortfallDto } from "../types/index.js";
import { DanmakuHoldingRoomCoordinator } from "./DanmakuHoldingRoomCoordinator.js";
import { StreamerStatusManager } from "./StreamerStatusManager.js";

function createCoordinatorContext(options?: {
  requestServerRooms?: boolean;
  holdingRooms?: number[];
  holdingRoomShortfall?: RuntimeRoomPullShortfallDto | null;
  recordingRooms?: number[];
  connectedRooms?: Array<{ roomId: number; priority: "high" | "normal" | "low" | "server" }>;
  runtimeConnected?: boolean;
  requestRooms?: (payload: Record<string, unknown>) => Promise<{
    holdingRooms: number[];
    newlyAssignedRooms: number[];
    droppedRooms: number[];
    effectiveCapacity: number;
    nextRequestAfter?: number | null;
    shortfall?: RuntimeRoomPullShortfallDto | null;
  } | null>;
}) {
  const disconnectedRooms: number[] = [];
  const queuedConnects: Array<{ roomId: number; priority: "high" | "normal" | "low" | "server" }> = [];
  let syncCallCount = 0;
  let statusChangedCallCount = 0;
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
  let holdingRoomShortfall = options?.holdingRoomShortfall ? { ...options.holdingRoomShortfall } : null;
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
      requestRooms: async (payload: Record<string, unknown>) => options?.requestRooms?.(payload) ?? null,
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
    getHoldingRoomShortfall: () => (holdingRoomShortfall ? { ...holdingRoomShortfall } : null),
    setHoldingRoomShortfall: (value: RuntimeRoomPullShortfallDto | null) => {
      holdingRoomShortfall = value ? { ...value } : null;
    },
    notifyStatusChanged: () => {
      statusChangedCallCount += 1;
    },
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
    getStatusChangedCallCount: () => statusChangedCallCount,
    getUpdateConnectionsCallCount: () => updateConnectionsCallCount,
    getRefreshStatusNowCallCount: () => refreshStatusNowCallCount,
    getHoldingRoomShortfall: () => (holdingRoomShortfall ? { ...holdingRoomShortfall } : null),
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
    let holdingRoomShortfall: RuntimeRoomPullShortfallDto | null = null;
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
      getHoldingRoomShortfall: () => (holdingRoomShortfall ? { ...holdingRoomShortfall } : null),
      setHoldingRoomShortfall: (value: RuntimeRoomPullShortfallDto | null) => {
        holdingRoomShortfall = value ? { ...value } : null;
      },
      notifyStatusChanged: () => undefined,
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
      getStatusChangedCallCount,
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
    expect(getStatusChangedCallCount()).toBe(0);
  });

  it("syncs status when only shortfall changes", () => {
    const {
      coordinator,
      getHoldingRoomShortfall,
      getRefreshStatusNowCallCount,
      getStatusChangedCallCount,
      getSyncCallCount,
      getUpdateConnectionsCallCount,
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
      shortfall: {
        reason: "candidate_pool_exhausted",
        missingCount: 1,
        candidateCount: 4,
        assignableCandidateCount: 4,
        blockedBySameAccountCount: 0,
        blockedByOtherAccountsCount: 0,
      },
    });

    expect(getHoldingRoomShortfall()).toEqual({
      reason: "candidate_pool_exhausted",
      missingCount: 1,
      candidateCount: 4,
      assignableCandidateCount: 4,
      blockedBySameAccountCount: 0,
      blockedByOtherAccountsCount: 0,
    });
    expect(getRefreshStatusNowCallCount()).toBe(0);
    expect(getUpdateConnectionsCallCount()).toBe(0);
    expect(getStatusChangedCallCount()).toBe(1);
    expect(getSyncCallCount()).toBe(1);
  });

  it("clears stale shortfall after capacity is filled", async () => {
    const {
      coordinator,
      getHoldingRoomShortfall,
      getStatusChangedCallCount,
      getSyncCallCount,
    } = createCoordinatorContext({
      holdingRooms: [101, 102, 103, 104, 105],
      holdingRoomShortfall: {
        reason: "candidate_pool_exhausted",
        missingCount: 1,
      },
    });

    const success = await coordinator.refreshHoldingRoomsIfNeeded(5, "capacity-refresh");

    expect(success).toBe(false);
    expect(getHoldingRoomShortfall()).toBeNull();
    expect(getStatusChangedCallCount()).toBe(1);
    expect(getSyncCallCount()).toBe(1);
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

  it("releases stale holding rooms that stay disconnected for too long", () => {
    const originalDateNow = Date.now;
    const originalSetTimeout = globalThis.setTimeout;
    let now = 1_000;
    Date.now = () => now;
    globalThis.setTimeout = ((handler: TimerHandler, _timeout?: number) => {
      if (typeof handler === "function") {
        handler();
      }
      return 1 as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    try {
      const { coordinator, getSyncCallCount } = createCoordinatorContext({
        holdingRooms: [301],
      });

      coordinator.applyConnectionsUpdate();
      expect(coordinator.getHoldingRoomIds()).toEqual([301]);

      now += 5 * 60 * 1000 + 1;
      coordinator.applyConnectionsUpdate();

      expect(coordinator.getHoldingRoomIds()).toEqual([]);
      expect(getSyncCallCount()).toBeGreaterThan(0);
    } finally {
      Date.now = originalDateNow;
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it("keeps connected holding rooms even after the stale release window", () => {
    const originalDateNow = Date.now;
    const originalSetTimeout = globalThis.setTimeout;
    let now = 1_000;
    Date.now = () => now;
    globalThis.setTimeout = ((handler: TimerHandler, _timeout?: number) => {
      if (typeof handler === "function") {
        handler();
      }
      return 1 as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    try {
      const { coordinator } = createCoordinatorContext({
        holdingRooms: [301],
        connectedRooms: [{ roomId: 301, priority: "server" }],
      });

      coordinator.applyConnectionsUpdate();
      now += 5 * 60 * 1000 + 1;
      coordinator.applyConnectionsUpdate();

      expect(coordinator.getHoldingRoomIds()).toEqual([301]);
    } finally {
      Date.now = originalDateNow;
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it("keeps current room connections while runtime is disconnected to avoid flapping", () => {
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, _timeout?: number) => 1 as ReturnType<typeof setTimeout>) as typeof setTimeout;

    try {
      const { coordinator, disconnectedRooms, connectionMap } = createCoordinatorContext({
        holdingRooms: [301],
        connectedRooms: [{ roomId: 201, priority: "high" }],
        runtimeConnected: false,
      });

      coordinator.applyConnectionsUpdate();

      expect(disconnectedRooms).toEqual([]);
      expect(connectionMap.has(201)).toBe(true);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it("retains local holding rooms when request-room fails under unstable network", async () => {
    const {
      coordinator,
      getSyncCallCount,
      getStatusChangedCallCount,
      getUpdateConnectionsCallCount,
      getRefreshStatusNowCallCount,
    } = createCoordinatorContext({
      holdingRooms: [301],
    });

    const success = await coordinator.refreshHoldingRoomsIfNeeded(5, "network-flaky", { force: true });

    expect(success).toBe(false);
    expect(coordinator.getHoldingRoomIds()).toEqual([301]);
    expect(getRefreshStatusNowCallCount()).toBe(0);
    expect(getUpdateConnectionsCallCount()).toBe(0);
    expect(getStatusChangedCallCount()).toBe(0);
    expect(getSyncCallCount()).toBe(0);
  });

  it("skips repeat request-room while newly assigned rooms are still pending connection", async () => {
    let requestCallCount = 0;
    const { coordinator } = createCoordinatorContext({
      holdingRooms: [301],
      requestRooms: async () => {
        requestCallCount += 1;
        return {
          holdingRooms: [301, 401],
          newlyAssignedRooms: [401],
          droppedRooms: [],
          effectiveCapacity: 5,
          nextRequestAfter: 0,
        };
      },
    });

    coordinator.applyHoldingRoomResult({
      holdingRooms: [301, 401],
      newlyAssignedRooms: [401],
      droppedRooms: [],
      effectiveCapacity: 5,
      nextRequestAfter: 0,
    });

    const success = await coordinator.refreshHoldingRoomsIfNeeded(5, "assignment-tag-changed", { force: true });

    expect(success).toBe(false);
    expect(requestCallCount).toBe(0);
  });

  it("allows request-room again after pending room is represented in connections", async () => {
    let requestCallCount = 0;
    let lastPayload: Record<string, unknown> | null = null;
    const {
      coordinator,
      connectionMap,
    } = createCoordinatorContext({
      holdingRooms: [301],
      requestRooms: async (payload) => {
        requestCallCount += 1;
        lastPayload = payload;
        return null;
      },
    });

    coordinator.applyHoldingRoomResult({
      holdingRooms: [301, 401],
      newlyAssignedRooms: [401],
      droppedRooms: [],
      effectiveCapacity: 5,
      nextRequestAfter: 0,
    });
    connectionMap.set(401, {
      roomId: 401,
      priority: "server",
      connectedAt: Date.now(),
      connection: {
        close: () => undefined,
      },
    });

    const success = await coordinator.refreshHoldingRoomsIfNeeded(5, "capacity-refresh", { force: true });

    expect(success).toBe(false);
    expect(requestCallCount).toBe(1);
    expect(lastPayload).toEqual({
      reason: "capacity-refresh",
      holdingRooms: [301, 401],
      connectedRooms: [401],
      desiredCount: 3,
      capacityOverride: undefined,
    });
  });

  it("disconnects zombie room connections after server reassignment drops a holding room", () => {
    const {
      coordinator,
      disconnectedRooms,
      connectionMap,
      getSyncCallCount,
      getStatusChangedCallCount,
      getUpdateConnectionsCallCount,
      getRefreshStatusNowCallCount,
    } = createCoordinatorContext({
      holdingRooms: [301, 302],
      connectedRooms: [
        { roomId: 301, priority: "server" },
        { roomId: 302, priority: "server" },
      ],
    });

    coordinator.applyHoldingRoomResult({
      holdingRooms: [302],
      newlyAssignedRooms: [],
      droppedRooms: [301],
      effectiveCapacity: 5,
      nextRequestAfter: 0,
    });

    expect(coordinator.getHoldingRoomIds()).toEqual([302]);
    expect(disconnectedRooms).toEqual([301]);
    expect(connectionMap.has(301)).toBe(false);
    expect(connectionMap.has(302)).toBe(true);
    expect(getRefreshStatusNowCallCount()).toBe(1);
    expect(getUpdateConnectionsCallCount()).toBe(1);
    expect(getStatusChangedCallCount()).toBe(1);
    expect(getSyncCallCount()).toBe(1);
  });
});
