import { describe, expect, it } from "bun:test";
import { DanmakuClient } from "./DanmakuClient.js";

const TEST_RECORDING_UID = 84;
const TEST_STATUS_UID = 126;

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
  it("does not enqueue recorder lifecycle messages on websocket connect and close", async () => {
    const client: any = new DanmakuClient({
      runtimeUrl: "https://example.com/api/v2/core-runtime",
      maxConnections: 5,
      requestServerRooms: true,
      streamers: [],
    });

    const listeners = new Map<string, (event?: any) => void>();
    client.isRunning = true;
    client.statusManager = {
      getRoomsToConnect: () => [{ roomId: 4455, priority: "server" }],
      getStreamerStatus: () => ({ roomId: 4455, isLive: false }),
      refreshNow: () => undefined,
      updateHoldingRooms: () => undefined,
    };
    client.resolveLiveWsConnectionOptions = async () => ({
      roomId: 4455,
      address: "wss://example.com/sub",
      key: "key-4455",
      uid: 1,
      protover: 3,
    });
    client.liveWsConnectionFactory = async () => ({
      addEventListener: (type: string, listener: (event?: any) => void) => {
        listeners.set(type, listener);
      },
      close: () => undefined,
    });
    client.messageQueue.scheduleMessageDispatch = () => undefined;
    client.syncRuntimeState = async () => undefined;

    await client.connectToRoom(4455, "server");

    listeners.get("CONNECT_SUCCESS")?.({ data: {} });
    listeners.get("close")?.({ code: 1000, reason: "" });

    expect(client.messageQueue.getPendingCount()).toBe(0);
  });

  it("does not enqueue recorder lifecycle messages when streamer status turns offline", () => {
    const client: any = new DanmakuClient({
      runtimeUrl: "https://example.com/api/v2/core-runtime",
      maxConnections: 5,
      requestServerRooms: true,
      streamers: [],
    });

    client.messageQueue.scheduleMessageDispatch = () => undefined;
    client.statusManager = {};
    client.setupStatusManagerEvents();
    client.statusManager.onStatusUpdated?.([{ roomId: 2233, isLive: false }]);

    expect(client.messageQueue.getPendingCount()).toBe(0);
  });

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

  it("resumes queued uploads immediately after runtime reconnect", async () => {
    const client: any = new DanmakuClient({
      runtimeUrl: "https://example.com/api/v2/core-runtime",
      maxConnections: 5,
      requestServerRooms: true,
      streamers: [],
    });

    const phases: string[] = [];
    const sentLocalIds: number[] = [];
    const storedRecords: Array<{
      id: number;
      streamerUid: number;
      eventTsMs: number;
      payload: Uint8Array;
      retryCount: number;
      nextRetryAtMs: number;
    }> = [];
    let runtimeConnected = true;
    let nextId = 1;
    let resolveRefresh!: () => void;
    const refreshPromise = new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    });

    client.isRunning = true;
    client.statusManager = {
      updateHoldingRooms: () => undefined,
      refreshNow: () => undefined,
    };
    client.syncRuntimeState = async () => {
      phases.push("sync");
    };
    client.refreshHoldingRoomsIfNeeded = async () => {
      phases.push("refresh:start");
      await refreshPromise;
      phases.push("refresh:end");
      return true;
    };
    client.updateConnections = () => {
      phases.push("updateConnections");
    };
    const currentConfig = client.configManager.getConfig();
    client.configManager.getConfig = () => ({
      ...currentConfig,
      liveSessionOutbox: {
        append: async (items: Array<{ streamerUid: number; eventTsMs: number; payload: Uint8Array }>) => {
          for (const item of items) {
            storedRecords.push({
              id: nextId++,
              streamerUid: item.streamerUid,
              eventTsMs: item.eventTsMs,
              payload: item.payload,
              retryCount: 0,
              nextRetryAtMs: item.eventTsMs,
            });
          }
          return items.length;
        },
        listDue: async ({ nowMs }: { nowMs: number }) =>
          storedRecords.filter(item => item.nextRetryAtMs <= nowMs),
        ack: async (ids: number[]) => {
          sentLocalIds.push(...ids);
          for (const id of ids) {
            const index = storedRecords.findIndex(item => item.id === id);
            if (index >= 0) {
              storedRecords.splice(index, 1);
            }
          }
          return ids.length;
        },
        reschedule: async () => 0,
        countPending: async () => storedRecords.length,
      },
    });
    client.recordings = [{
      channel: {
        uId: TEST_RECORDING_UID,
        uName: "主播",
        roomId: 101,
        faceUrl: "",
        isLiving: true,
        livingInfo: null,
      },
      setting: {
        isPublic: false,
      },
      todayDanmakusCount: 0,
    }];
    client.runtimeConnection = {
      getConnectionState: () => runtimeConnected,
      sendArchiveBatch: async (records: Array<{ id: number }>) => {
        phases.push("send");
        return {
          ackedLocalIds: records.map((record) => record.id),
          rejected: [],
        };
      },
    };
    client.setupRuntimeEvents();
    client.messageQueue.messageUploadInterval = 10;

    client.messageQueue.enqueueMessage({
      roomId: 101,
      cmd: "DANMU_MSG",
      raw: '{"cmd":"DANMU_MSG"}',
      timestamp: Date.now(),
    });

    runtimeConnected = false;
    client.runtimeConnection.onDisconnected?.(new Error("runtime down"));
    runtimeConnected = true;
    client.runtimeConnection.onReconnected?.();

    await Bun.sleep(40);
    expect(sentLocalIds).toEqual([1]);
    expect(phases.includes("refresh:start")).toBe(true);
    expect(phases.includes("refresh:end")).toBe(false);
    expect(phases).toContain("send");

    resolveRefresh();
  });

  it("uploads queued messages with the built-in outbox when no liveSessionOutbox is configured", async () => {
    const client: any = new DanmakuClient({
      runtimeUrl: "https://example.com/api/v2/core-runtime",
      maxConnections: 5,
      requestServerRooms: false,
      streamers: [],
    });

    const uploadedBatches: Array<Array<{ id: number; streamerUid: number; eventTsMs: number }>> = [];
    client.isRunning = true;
    client.recordings = [{
      channel: {
        uId: TEST_RECORDING_UID,
        uName: "主播",
        roomId: 101,
        faceUrl: "",
        isLiving: true,
        livingInfo: null,
      },
      setting: {
        isPublic: false,
      },
      todayDanmakusCount: 0,
    }];
    client.runtimeConnection = {
      getConnectionState: () => true,
      sendArchiveBatch: async (records: Array<{ id: number; streamerUid: number; eventTsMs: number }>) => {
        uploadedBatches.push(records);
        return {
          ackedLocalIds: records.map(record => record.id),
          rejected: [],
        };
      },
    };
    client.messageQueue.messageUploadInterval = 10;

    client.messageQueue.enqueueMessage({
      roomId: 101,
      cmd: "DANMU_MSG",
      raw: '{"cmd":"DANMU_MSG"}',
      timestamp: Date.now(),
    });

    await Bun.sleep(40);

    expect(uploadedBatches).toHaveLength(1);
    expect(uploadedBatches[0]).toHaveLength(1);
    expect(uploadedBatches[0]?.[0]?.streamerUid).toBe(TEST_RECORDING_UID);
  });

  it("uploads queued messages for server-assigned rooms using status uid fallback", async () => {
    const client: any = new DanmakuClient({
      runtimeUrl: "https://example.com/api/v2/core-runtime",
      maxConnections: 5,
      requestServerRooms: true,
      streamers: [],
    });

    const uploadedBatches: Array<Array<{ id: number; streamerUid: number; eventTsMs: number }>> = [];
    client.isRunning = true;
    client.recordings = [];
    client.statusManager = {
      getStreamerStatus: (roomId: number) => roomId === 202 ? ({
        roomId: 202,
        uId: TEST_STATUS_UID,
        isLive: true,
      }) : undefined,
    };
    client.runtimeConnection = {
      getConnectionState: () => true,
      sendArchiveBatch: async (records: Array<{ id: number; streamerUid: number; eventTsMs: number }>) => {
        uploadedBatches.push(records);
        return {
          ackedLocalIds: records.map(record => record.id),
          rejected: [],
        };
      },
    };
    client.messageQueue.messageUploadInterval = 10;

    client.messageQueue.enqueueMessage({
      roomId: 202,
      cmd: "DANMU_MSG",
      raw: '{"cmd":"DANMU_MSG"}',
      timestamp: Date.now(),
    });

    await Bun.sleep(40);

    expect(uploadedBatches).toHaveLength(1);
    expect(uploadedBatches[0]).toHaveLength(1);
    expect(uploadedBatches[0]?.[0]?.streamerUid).toBe(TEST_STATUS_UID);
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

  it("forces supplemental assignment refresh when excluded server room user ids change", async () => {
    const client: any = new DanmakuClient({
      runtimeUrl: "https://example.com/api/v2/core-runtime",
      maxConnections: 5,
      requestServerRooms: true,
      streamers: [],
    });

    const refreshCalls: Array<{ maxConnections: number; reason: string; options?: { force?: boolean } }> = [];
    let updateConnectionsCount = 0;
    client.isRunning = true;
    client.updateConnections = () => {
      updateConnectionsCount += 1;
    };
    client.refreshHoldingRoomsIfNeeded = async (
      maxConnections: number,
      reason: string,
      options?: { force?: boolean }
    ) => {
      refreshCalls.push({ maxConnections, reason, options });
      return true;
    };

    await client.applyAccountConfigSnapshot({
      maxConnections: 5,
      runtimeUrl: "https://example.com/api/v2/core-runtime",
      autoReconnect: true,
      reconnectInterval: 5000,
      statusCheckInterval: 30,
      streamers: [],
      requestServerRooms: true,
      allowedAreas: [],
      allowedParentAreas: [],
      excludedServerRoomUserIds: [200, 100, 200],
    }, "config-tag-v2");

    expect(client.configManager.getConfig().excludedServerRoomUserIds).toEqual([100, 200]);
    expect(refreshCalls).toEqual([
      {
        maxConnections: 5,
        reason: "account-config-excluded-uids-changed",
        options: { force: true },
      },
    ]);
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

  it("falls back to备用 WebSocket 地址 when the primary address fails", async () => {
    const client: any = new DanmakuClient({
      runtimeUrl: "https://example.com/api/v2/core-runtime",
      maxConnections: 5,
      requestServerRooms: true,
      streamers: [],
    });

    const attemptedAddresses: string[] = [];
    client.isRunning = true;
    client.statusManager = {
      getRoomsToConnect: () => [{ roomId: 4455, priority: "server" }],
      getStreamerStatus: () => ({ roomId: 4455, isLive: false }),
      refreshNow: () => undefined,
      updateHoldingRooms: () => undefined,
    };
    client.resolveLiveWsConnectionOptions = async () => ({
      roomId: 4455,
      address: "wss://broadcastlv.chat.bilibili.com/sub",
      fallbackAddresses: ["wss://tx-bj-live-comet-01.chat.bilibili.com/sub"],
      key: "key-4455",
      uid: 1,
      protover: 3,
    });
    client.liveWsConnectionFactory = async (_roomId: number, options: any) => {
      attemptedAddresses.push(options.address);
      if (options.address === "wss://broadcastlv.chat.bilibili.com/sub") {
        throw new Error("primary websocket unavailable");
      }

      return {
        addEventListener: () => undefined,
        close: () => undefined,
      };
    };
    client.syncRuntimeState = async () => undefined;

    await client.connectToRoom(4455, "server");

    expect(attemptedAddresses).toEqual([
      "wss://broadcastlv.chat.bilibili.com/sub",
      "wss://tx-bj-live-comet-01.chat.bilibili.com/sub",
    ]);
    expect(client.connections.has(4455)).toBe(true);
  });
});
