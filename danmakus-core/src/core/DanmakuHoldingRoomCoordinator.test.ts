import { describe, expect, it } from "bun:test";
import type { DanmakuConfig } from "../types";
import { DanmakuHoldingRoomCoordinator } from "./DanmakuHoldingRoomCoordinator";
import { StreamerStatusManager } from "./StreamerStatusManager";

function createCoordinatorContext(options?: {
  requestServerRooms?: boolean;
  holdingRooms?: number[];
  recordingRooms?: number[];
  connectedRooms?: Array<{ roomId: number; priority: "high" | "normal" | "low" | "server" }>;
}) {
  const disconnectedRooms: number[] = [];
  const queuedConnects: Array<{ roomId: number; priority: "high" | "normal" | "low" | "server" }> = [];
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
      getConnectionState: () => true,
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
    updateConnections: () => undefined,
    syncRuntimeState: () => undefined,
    refreshStatusNow: () => undefined,
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

  it("keeps recording-only rooms in legacy non-pull mode", () => {
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

      expect(disconnectedRooms).toEqual([]);
      expect(connectionMap.has(201)).toBe(true);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});
