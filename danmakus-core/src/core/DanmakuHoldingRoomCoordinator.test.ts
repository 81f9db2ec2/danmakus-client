import { describe, expect, it } from "bun:test";
import type { DanmakuConfig, RuntimeRoomPullShortfallDto } from "../types/index.js";
import { DanmakuHoldingRoomCoordinator } from "./DanmakuHoldingRoomCoordinator.js";
import { StreamerStatusManager } from "./StreamerStatusManager.js";

function createCoordinatorContext(options?: {
  requestServerRooms?: boolean;
  maxConnections?: number;
  capacityOverride?: number;
  holdingRooms?: number[];
  holdingRoomShortfall?: RuntimeRoomPullShortfallDto | null;
  recordingRooms?: number[];
  connectedRooms?: Array<{ roomId: number; priority: "high" | "normal" | "low" | "server" }>;
  runtimeConnected?: boolean;
  sendStateReport?: (payload: Record<string, unknown>) => boolean;
}) {
  const disconnectedRooms: number[] = [];
  const queuedConnects: Array<{ roomId: number; priority: "high" | "normal" | "low" | "server" }> = [];
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
  const holdingRoomShortfall = options?.holdingRoomShortfall ? { ...options.holdingRoomShortfall } : null;
  const recordingRooms = [...(options?.recordingRooms ?? [])];

  const statusManager: any = new StreamerStatusManager(30, "https://example.com/api/v2/core-runtime");
  statusManager.updateHoldingRooms(holdingRooms);
  statusManager.updateRecordingRooms(recordingRooms);
  statusManager.statusCache = new Map([
    [201, { roomId: 201, isLive: true }],
    [301, { roomId: 301, isLive: true }],
  ]);

  const config: DanmakuConfig = {
    runtimeUrl: "https://example.com/api/v2/core-runtime",
    maxConnections: options?.maxConnections ?? 5,
    capacityOverride: options?.capacityOverride,
    requestServerRooms: options?.requestServerRooms ?? true,
    streamers: [],
  } as DanmakuConfig;

  const context = {
    isRunning: () => true,
    isStopping: () => false,
    getConfig: () => config,
    getRuntimeConnection: () => ({
      getConnectionState: () => options?.runtimeConnected ?? true,
      sendStateReport: (payload: Record<string, unknown>) => options?.sendStateReport?.(payload) ?? true,
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
    refreshStatusNow: () => {
      refreshStatusNowCallCount += 1;
    },
    updateHoldingRooms: (roomIds: number[]) => {
      holdingRooms = [...roomIds];
      statusManager.updateHoldingRooms(roomIds);
    },
    getRoomConnectStartInterval: () => 10_000,
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
    coordinator: new DanmakuHoldingRoomCoordinator(context as never, {
      holdingRoomIds: [...holdingRooms],
      holdingRoomShortfall,
    }),
    disconnectedRooms,
    queuedConnects,
    connectionMap,
    getStatusChangedCallCount: () => statusChangedCallCount,
    getUpdateConnectionsCallCount: () => updateConnectionsCallCount,
    getRefreshStatusNowCallCount: () => refreshStatusNowCallCount,
  };
}

describe("DanmakuHoldingRoomCoordinator room selection", () => {
  it("connects live recording rooms with high priority when assigned in holding rooms", () => {
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, _timeout?: number) => 1 as ReturnType<typeof setTimeout>) as typeof setTimeout;

    try {
      const { coordinator, queuedConnects, connectionMap } = createCoordinatorContext({
        requestServerRooms: true,
        holdingRooms: [201, 301],
        recordingRooms: [201],
        connectedRooms: [{ roomId: 201, priority: "high" }],
      });

      coordinator.applyConnectionsUpdate();

      expect(connectionMap.has(201)).toBe(true);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it("disconnects offline recording rooms", () => {
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, _timeout?: number) => 1 as ReturnType<typeof setTimeout>) as typeof setTimeout;

    try {
      const { coordinator, disconnectedRooms, connectionMap } = createCoordinatorContext({
        requestServerRooms: false,
        holdingRooms: [],
        recordingRooms: [999], // 999 is not live in statusCache
        connectedRooms: [{ roomId: 999, priority: "high" }],
      });

      coordinator.applyConnectionsUpdate();

      expect(disconnectedRooms).toEqual([999]);
      expect(connectionMap.has(999)).toBe(false);
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
        sendStateReport: (payload: Record<string, unknown>) => {
          requestPayload = payload;
          return true;
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
      getRoomConnectStartInterval: () => 10_000,
      notifyStatusChanged: () => undefined,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
        child: () => this,
      },
    } as never);

    const success = coordinator.reportHoldingRoomState("followed-only", { force: true });

    expect(success).toBe(true);
    expect(requestPayload).toEqual({
      reason: "followed-only",
      holdingRooms: [],
      connectedRooms: [],
      desiredCount: 5,
      capacity: 5,
      capacityOverride: undefined,
    });
    coordinator.applyHoldingRoomResult({
      holdingRooms: [201],
      newlyAssignedRooms: [201],
      droppedRooms: [],
      effectiveCapacity: 5,
      nextRequestAfter: 0,
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
    expect(getStatusChangedCallCount()).toBe(0);
  });

  it("syncs status when only shortfall changes", () => {
    const {
      coordinator,
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

    expect(coordinator.getHoldingRoomShortfall()).toEqual({
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
  });

  it("clears stale shortfall after capacity is filled", async () => {
    const {
      coordinator,
      getStatusChangedCallCount,
    } = createCoordinatorContext({
      holdingRooms: [101, 102, 103, 104, 105],
      holdingRoomShortfall: {
        reason: "candidate_pool_exhausted",
        missingCount: 1,
      },
    });

    const success = coordinator.reportHoldingRoomState("capacity-refresh");

    expect(success).toBe(false);
    expect(coordinator.getHoldingRoomShortfall()).toBeNull();
    expect(getStatusChangedCallCount()).toBe(1);
  });

  it("uses local capacityOverride as the effective assignment capacity", async () => {
    let requestPayload: Record<string, unknown> | undefined;
    const { coordinator } = createCoordinatorContext({
      maxConnections: 20,
      capacityOverride: 40,
      holdingRooms: Array.from({ length: 20 }, (_, index) => 1000 + index),
      sendStateReport: (payload) => {
        requestPayload = payload;
        return true;
      },
    });

    const success = coordinator.reportHoldingRoomState("capacity-override", { force: true });

    expect(success).toBe(true);
    expect(requestPayload).toEqual({
      reason: "capacity-override",
      holdingRooms: Array.from({ length: 20 }, (_, index) => 1000 + index),
      connectedRooms: [],
      desiredCount: 20,
      capacity: 40,
      capacityOverride: 40,
    });
    coordinator.applyHoldingRoomResult({
      holdingRooms: Array.from({ length: 40 }, (_, index) => 1000 + index),
      newlyAssignedRooms: Array.from({ length: 20 }, (_, index) => 2000 + index),
      droppedRooms: [],
      effectiveCapacity: 40,
      nextRequestAfter: 0,
    });
    expect(coordinator.getHoldingRoomIds()).toEqual(Array.from({ length: 40 }, (_, index) => 1000 + index));
  });

  it("does not sync runtime state on a no-op connections update", () => {
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, _timeout?: number) => 1 as ReturnType<typeof setTimeout>) as typeof setTimeout;

    try {
      const { coordinator } = createCoordinatorContext({
        holdingRooms: [301],
        connectedRooms: [{ roomId: 301, priority: "server" }],
        runtimeConnected: false,
      });

      coordinator.applyConnectionsUpdate();
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
      const { coordinator } = createCoordinatorContext({
        holdingRooms: [301],
      });

      coordinator.applyConnectionsUpdate();
      expect(coordinator.getHoldingRoomIds()).toEqual([301]);

      now += 8 * 60 * 1000 + 1;
      coordinator.applyConnectionsUpdate();

      expect(coordinator.getHoldingRoomIds()).toEqual([]);
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
      now += 8 * 60 * 1000 + 1;
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

  it("automatically derives default shortfall when holding rooms do not fill capacity and no explicit shortfall is provided", () => {
    const { coordinator, getStatusChangedCallCount } = createCoordinatorContext({
      maxConnections: 5,
      holdingRooms: [301, 302],
    });

    expect(coordinator.getHoldingRoomShortfall()).toEqual({
      reason: "no_candidates",
      candidateCount: 2,
      assignableCandidateCount: 2,
      blockedBySameAccountCount: 0,
      blockedByOtherAccountsCount: 0,
      missingCount: 3,
    });

    coordinator.applyHoldingRoomResult({
      holdingRooms: [301, 302, 303, 304, 305],
      newlyAssignedRooms: [303, 304, 305],
      droppedRooms: [],
      effectiveCapacity: 5,
    });

    expect(coordinator.getHoldingRoomShortfall()).toBeNull();
    expect(getStatusChangedCallCount()).toBe(1);
  });

  it("returns null shortfall when holding rooms reach or exceed target capacity", () => {
    const { coordinator } = createCoordinatorContext({
      maxConnections: 3,
      holdingRooms: [101, 102, 103],
    });

    expect(coordinator.getHoldingRoomShortfall()).toBeNull();
  });

  it("retains local holding rooms when sendStateReport fails under unstable network", () => {
    const {
      coordinator,
      getSyncCallCount,
      getStatusChangedCallCount,
      getUpdateConnectionsCallCount,
      getRefreshStatusNowCallCount,
    } = createCoordinatorContext({
      holdingRooms: [301],
      sendStateReport: () => false,
    });

    const success = coordinator.reportHoldingRoomState("network-flaky", { force: true });

    expect(success).toBe(false);
    expect(coordinator.getHoldingRoomIds()).toEqual([301]);
    expect(getRefreshStatusNowCallCount()).toBe(0);
    expect(getUpdateConnectionsCallCount()).toBe(0);
    expect(getStatusChangedCallCount()).toBe(0);
  });

  it("skips repeat state report while newly assigned rooms are still pending connection", () => {
    let reportCallCount = 0;
    const { coordinator } = createCoordinatorContext({
      holdingRooms: [301],
      sendStateReport: () => {
        reportCallCount += 1;
        return true;
      },
    });

    coordinator.applyHoldingRoomResult({
      holdingRooms: [301, 401],
      newlyAssignedRooms: [401],
      droppedRooms: [],
      effectiveCapacity: 5,
      nextRequestAfter: 0,
    });

    const success = coordinator.reportHoldingRoomState("assignment-tag-changed", { force: true });

    expect(success).toBe(false);
    expect(reportCallCount).toBe(0);
  });

  it("allows state report again after pending room is represented in connections", () => {
    let reportCallCount = 0;
    let lastPayload: Record<string, unknown> | null = null;
    const {
      coordinator,
      connectionMap,
    } = createCoordinatorContext({
      holdingRooms: [301],
      sendStateReport: (payload) => {
        reportCallCount += 1;
        lastPayload = payload;
        return true;
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

    const success = coordinator.reportHoldingRoomState("capacity-refresh", { force: true });

    expect(success).toBe(true);
    expect(reportCallCount).toBe(1);
    expect(lastPayload).toEqual({
      reason: "capacity-refresh",
      holdingRooms: [301, 401],
      connectedRooms: [401],
      desiredCount: 3,
      capacity: 5,
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
  });
});
