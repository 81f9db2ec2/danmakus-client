import { describe, expect, it } from "bun:test";
import type { DanmakuMessage } from "../types";
import { DanmakuMessageQueue } from "./DanmakuMessageQueue";
import { ScopedLogger } from "./Logger";

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

describe("DanmakuMessageQueue", () => {
  it("uses a 2 second upload interval by default", () => {
    const queue = new DanmakuMessageQueue({
      isRunning: () => true,
      isStopping: () => false,
      getRuntimeConnection: () => undefined,
      logger: new ScopedLogger("DanmakuMessageQueueTest"),
      recordError: () => undefined,
      emitError: () => undefined,
      emitQueueChanged: () => undefined,
    });

    expect(queue.getUploadInterval()).toBe(2000);
  });

  it("waits for the upload interval after a batch finishes before sending the next batch", async () => {
    let sendCallCount = 0;
    let resolveFirstUpload: ((value: number) => void) | undefined;
    let firstUploadStarted!: () => void;
    let secondUploadStarted!: () => void;
    const firstUploadStartedPromise = new Promise<void>((resolve) => {
      firstUploadStarted = resolve;
    });
    const secondUploadStartedPromise = new Promise<void>((resolve) => {
      secondUploadStarted = resolve;
    });
    const sendStartedAt: number[] = [];

    const queue = new DanmakuMessageQueue({
      isRunning: () => true,
      isStopping: () => false,
      getRuntimeConnection: () => ({
        getConnectionState: () => true,
        sendMessages: async (messages: DanmakuMessage[]) => {
          sendCallCount += 1;
          sendStartedAt.push(Date.now());
          if (sendCallCount === 1) {
            firstUploadStarted();
            return await new Promise<number>((resolve) => {
              resolveFirstUpload = resolve;
            });
          }

          secondUploadStarted();
          return messages.length;
        },
      }),
      logger: new ScopedLogger("DanmakuMessageQueueTest"),
      recordError: () => undefined,
      emitError: () => undefined,
      emitQueueChanged: () => undefined,
    });

    (queue as any).messageUploadInterval = 80;

    queue.enqueueMessage(createMessage(1001, Date.now()));
    await firstUploadStartedPromise;

    queue.enqueueMessage(createMessage(1001, Date.now() + 1));
    await sleep(50);

    const firstCompletedAt = Date.now();
    resolveFirstUpload?.(1);

    await sleep(55);
    expect(sendCallCount).toBe(1);

    await secondUploadStartedPromise;
    expect(sendCallCount).toBe(2);
    expect(sendStartedAt[1]! - firstCompletedAt).toBeGreaterThanOrEqual(70);
  });
});
