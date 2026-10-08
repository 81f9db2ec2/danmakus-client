import { describe, expect, it } from "bun:test";
import { RuntimeConnection } from "./RuntimeConnection.js";

const TEST_STREAMER_UID = 84;

describe("RuntimeConnection", () => {
  it("routes sendStateReport through wsConnection when available", async () => {
    const runtime = new RuntimeConnection("https://example.com/api/v2/core-runtime?token=test-token&clientId=test-client");
    let reportedState: any = null;
    (runtime as any).wsConnection = {
      connected: true,
      sendStateReport: (state: any) => {
        reportedState = state;
        return true;
      },
    };

    const success = runtime.sendStateReport({
      holdingRooms: [101, 102],
      connectedRooms: [101],
      desiredCount: 2,
      capacity: 4,
      reason: "capacity-refresh",
    });

    expect(success).toBe(true);
    expect(reportedState).toEqual({
      holdingRooms: [101, 102],
      connectedRooms: [101],
      desiredCount: 2,
      capacity: 4,
      reason: "capacity-refresh",
    });
  });

  it("registers push callbacks to wsConnection", async () => {
    const runtime = new RuntimeConnection("https://example.com/api/v2/core-runtime?token=test-token&clientId=test-client");
    let registeredCallbacks: any = null;
    (runtime as any).wsConnection = {
      setCallbacks: (cb: any) => {
        registeredCallbacks = cb;
      },
    };

    const callbacks = {
      onStreamerStatusPush: () => undefined,
      onRoomAssignPush: () => undefined,
    };
    runtime.setCallbacks(callbacks);

    expect(registeredCallbacks).toEqual(callbacks);
  });

  it("routes sendArchiveBatch through wsConnection and throws when disconnected", async () => {
    const runtime = new RuntimeConnection("https://example.com/api/v2/core-runtime?token=test-token&clientId=test-client");

    // Disconnected: throws
    expect(runtime.sendArchiveBatch([{
      id: 7,
      streamerUid: TEST_STREAMER_UID,
      eventTsMs: 1710000001000,
      payload: new Uint8Array([1, 2, 3]),
      retryCount: 0,
      nextRetryAtMs: 1710000001000,
    }])).rejects.toThrow("WebSocket 未连接");

    // Connected: delegates to wsConnection
    let uploadedRecords: any = null;
    (runtime as any).wsConnection = {
      connected: true,
      sendArchiveBatch: async (records: any) => {
        uploadedRecords = records;
        return { rejected: [] };
      },
    };

    const res = await runtime.sendArchiveBatch([{
      id: 7,
      streamerUid: TEST_STREAMER_UID,
      eventTsMs: 1710000001000,
      payload: new Uint8Array([1, 2, 3]),
      retryCount: 0,
      nextRetryAtMs: 1710000001000,
    }]);

    expect(res).toEqual({ rejected: [] });
    expect(uploadedRecords).toHaveLength(1);
    expect(uploadedRecords[0].id).toBe(7);
  });
});
