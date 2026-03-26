import { describe, expect, it } from "bun:test";
import type { DanmakuMessage, LiveSessionOutboxItem, LiveSessionOutboxStore } from "../types";
import { DanmakuMessageQueue } from "./DanmakuMessageQueue";
import { ScopedLogger } from "./Logger";

const TEST_STREAMER_UID = 84;

function createMessage(roomId: number, timestamp: number): DanmakuMessage {
  return {
    roomId,
    cmd: "DANMU_MSG",
    raw: `{"cmd":"DANMU_MSG","roomId":${roomId},"ts":${timestamp}}`,
    timestamp,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createOutboxStore(overrides: Partial<LiveSessionOutboxStore> = {}): LiveSessionOutboxStore {
  return {
    append: async () => 0,
    listDue: async () => [],
    ack: async () => 0,
    reschedule: async () => 0,
    countPending: async () => 0,
    ...overrides,
  };
}

describe("DanmakuMessageQueue", () => {
  it("uses a 2 second upload interval by default", () => {
    const queue = new DanmakuMessageQueue({
      isRunning: () => true,
      isStopping: () => false,
      getRuntimeConnection: () => undefined,
      getLiveSessionOutbox: () => undefined,
      resolveRecordingStreamerUid: () => null,
      logger: new ScopedLogger("DanmakuMessageQueueTest"),
      recordError: () => undefined,
      emitError: () => undefined,
      emitQueueChanged: () => undefined,
    });

    expect(queue.getUploadInterval()).toBe(2000);
  });

  it("counts pending items from the live session outbox", async () => {
    const queue = new DanmakuMessageQueue({
      isRunning: () => true,
      isStopping: () => false,
      getRuntimeConnection: () => undefined,
      getLiveSessionOutbox: () => createOutboxStore({
        countPending: async () => 3,
      }),
      resolveRecordingStreamerUid: () => null,
      logger: new ScopedLogger("DanmakuMessageQueueTest"),
      recordError: () => undefined,
      emitError: () => undefined,
      emitQueueChanged: () => undefined,
    });

    await queue.refreshArchiveStats();

    expect(queue.getPendingCount()).toBe(3);
    expect(queue.getFailedCount()).toBe(0);
  });

  it("flushes buffered messages into the live session outbox when a streamerUid is available", async () => {
    let appendCallCount = 0;
    let appendedCount = 0;
    const queue = new DanmakuMessageQueue({
      isRunning: () => true,
      isStopping: () => false,
      getRuntimeConnection: () => undefined,
      getLiveSessionOutbox: () => createOutboxStore({
        append: async (items) => {
          appendCallCount += 1;
          appendedCount += items.length;
          expect(items[0]?.streamerUid).toBe(TEST_STREAMER_UID);
          expect(items[0]?.eventTsMs).toBeTypeOf("number");
          expect(items[0]?.payload).toBeInstanceOf(Uint8Array);
          return items.length;
        },
      }),
      resolveRecordingStreamerUid: () => TEST_STREAMER_UID,
      logger: new ScopedLogger("DanmakuMessageQueueTest"),
      recordError: () => undefined,
      emitError: () => undefined,
      emitQueueChanged: () => undefined,
    });

    (queue as any).messageUploadInterval = 10_000;
    (queue as any).messageBatchSize = 1;

    queue.enqueueMessage(createMessage(1001, Date.now()));
    await sleep(100);

    expect(appendCallCount).toBe(1);
    expect(appendedCount).toBe(1);
    expect(queue.getPendingMessages()).toHaveLength(0);
    expect(queue.getPendingCount()).toBe(1);
  });

  it("uploads freshly persisted outbox records without requiring a second flush cycle", async () => {
    const appendedItems: Array<{ streamerUid: number; eventTsMs: number }> = [];
    const storedRecords: LiveSessionOutboxItem[] = [];
    const ackedIds: number[] = [];
    const sentArchiveBatches: LiveSessionOutboxItem[][] = [];
    let nextId = 1;

    const queue = new DanmakuMessageQueue({
      isRunning: () => true,
      isStopping: () => false,
      getRuntimeConnection: () => ({
        getConnectionState: () => true,
        sendArchiveBatch: async (records) => {
          sentArchiveBatches.push(records.map(record => ({ ...record })));
          return {
            ackedLocalIds: records.map(record => record.id),
            rejected: [],
          };
        },
      }),
      getLiveSessionOutbox: () => createOutboxStore({
        append: async (items) => {
          for (const item of items) {
            appendedItems.push({
              streamerUid: item.streamerUid,
              eventTsMs: item.eventTsMs,
            });
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
        listDue: async ({ nowMs }) =>
          storedRecords.filter(item => item.nextRetryAtMs <= nowMs),
        ack: async (ids) => {
          ackedIds.push(...ids);
          for (const id of ids) {
            const index = storedRecords.findIndex(item => item.id === id);
            if (index >= 0) {
              storedRecords.splice(index, 1);
            }
          }
          return ids.length;
        },
      }),
      resolveRecordingStreamerUid: () => TEST_STREAMER_UID,
      logger: new ScopedLogger("DanmakuMessageQueueTest"),
      recordError: () => undefined,
      emitError: () => undefined,
      emitQueueChanged: () => undefined,
    });

    (queue as any).messageBatchSize = 1;

    queue.enqueueMessage(createMessage(1001, 1710000001000));
    await sleep(100);

    expect(appendedItems).toEqual([{
      streamerUid: TEST_STREAMER_UID,
      eventTsMs: 1710000001000,
    }]);
    expect(sentArchiveBatches).toHaveLength(1);
    expect(sentArchiveBatches[0]?.[0]).toMatchObject({
      streamerUid: TEST_STREAMER_UID,
      eventTsMs: 1710000001000,
    });
    expect(ackedIds).toEqual([1]);
    expect(queue.getPendingCount()).toBe(0);
  });

  it("uploads due outbox records and acknowledges successful localIds", async () => {
    const ackedIds: number[] = [];
    const dueRecords: LiveSessionOutboxItem[] = [{
      id: 7,
      streamerUid: TEST_STREAMER_UID,
      eventTsMs: 1710000001000,
      payload: new Uint8Array([1, 2, 3]),
      retryCount: 0,
      nextRetryAtMs: 1710000001000,
    }];

    const queue = new DanmakuMessageQueue({
      isRunning: () => true,
      isStopping: () => false,
      getRuntimeConnection: () => ({
        getConnectionState: () => true,
        sendArchiveBatch: async (records) => {
          expect(records).toHaveLength(1);
          expect(records[0]?.id).toBe(7);
          return {
            ackedLocalIds: [7],
            rejected: [],
          };
        },
      }),
      getLiveSessionOutbox: () => createOutboxStore({
        countPending: async () => 1,
        listDue: async () => dueRecords,
        ack: async (ids) => {
          ackedIds.push(...ids);
          return ids.length;
        },
      }),
      resolveRecordingStreamerUid: () => null,
      logger: new ScopedLogger("DanmakuMessageQueueTest"),
      recordError: () => undefined,
      emitError: () => undefined,
      emitQueueChanged: () => undefined,
    });

    await queue.refreshArchiveStats();
    await queue.flushPendingMessages();

    expect(ackedIds).toEqual([7]);
    expect(queue.getPendingCount()).toBe(0);
  });

  it("deletes rejected outbox records after the backend explicitly rejects them", async () => {
    const ackedIds: number[] = [];
    const rescheduledIds: number[] = [];
    const emittedErrors: Error[] = [];
    const dueRecords: LiveSessionOutboxItem[] = [{
      id: 7,
      streamerUid: TEST_STREAMER_UID,
      eventTsMs: 1710000001000,
      payload: new Uint8Array([1, 2, 3]),
      retryCount: 0,
      nextRetryAtMs: 1710000001000,
    }];

    const queue = new DanmakuMessageQueue({
      isRunning: () => true,
      isStopping: () => false,
      getRuntimeConnection: () => ({
        getConnectionState: () => true,
        sendArchiveBatch: async () => ({
          ackedLocalIds: [],
          rejected: [{
            localId: 7,
            code: "historical_upload_window_expired",
            message: "此直播场已归档, 不再接受上传",
          }],
        }),
      }),
      getLiveSessionOutbox: () => createOutboxStore({
        countPending: async () => 1,
        listDue: async () => dueRecords,
        ack: async (ids) => {
          ackedIds.push(...ids);
          return ids.length;
        },
        reschedule: async (updates) => {
          rescheduledIds.push(...updates.map(item => item.id));
          return updates.length;
        },
      }),
      resolveRecordingStreamerUid: () => null,
      logger: new ScopedLogger("DanmakuMessageQueueTest"),
      recordError: () => undefined,
      emitError: (error) => {
        emittedErrors.push(error);
      },
      emitQueueChanged: () => undefined,
    });

    await queue.refreshArchiveStats();
    await queue.flushPendingMessages();

    expect(ackedIds).toEqual([7]);
    expect(rescheduledIds).toEqual([]);
    expect(emittedErrors).toHaveLength(1);
    expect(emittedErrors[0]?.message).toContain("historical_upload_window_expired");
    expect(queue.getPendingCount()).toBe(0);
  });

  it("keeps rescheduling outbox records on transport failures even after many retries", async () => {
    const ackedIds: number[] = [];
    const rescheduled = {
      ids: [] as number[],
      retryCounts: [] as number[],
    };
    const dueRecords: LiveSessionOutboxItem[] = [{
      id: 7,
      streamerUid: TEST_STREAMER_UID,
      eventTsMs: 1710000001000,
      payload: new Uint8Array([1, 2, 3]),
      retryCount: 999,
      nextRetryAtMs: 1710000001000,
    }];

    const queue = new DanmakuMessageQueue({
      isRunning: () => true,
      isStopping: () => false,
      getRuntimeConnection: () => ({
        getConnectionState: () => true,
        sendArchiveBatch: async () => {
          throw new Error("backend offline");
        },
      }),
      getLiveSessionOutbox: () => createOutboxStore({
        countPending: async () => 1,
        listDue: async () => dueRecords,
        ack: async (ids) => {
          ackedIds.push(...ids);
          return ids.length;
        },
        reschedule: async (updates) => {
          rescheduled.ids.push(...updates.map(item => item.id));
          rescheduled.retryCounts.push(...updates.map(item => item.retryCount));
          return updates.length;
        },
      }),
      resolveRecordingStreamerUid: () => null,
      logger: new ScopedLogger("DanmakuMessageQueueTest"),
      recordError: () => undefined,
      emitError: () => undefined,
      emitQueueChanged: () => undefined,
    });

    (queue as any).messageRetryMaxAttempts = 1;

    await queue.refreshArchiveStats();
    await queue.flushPendingMessages();

    expect(ackedIds).toEqual([]);
    expect(rescheduled.ids).toEqual([7]);
    expect(rescheduled.retryCounts).toEqual([1000]);
    expect(queue.getPendingCount()).toBe(1);
  });
});
