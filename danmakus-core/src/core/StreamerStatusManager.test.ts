import { describe, expect, it } from "bun:test";
import { StreamerStatusManager } from "./StreamerStatusManager.js";

const TEST_STREAMER_STATUS_UID = 126;

describe("StreamerStatusManager room priority", () => {
  it("maps uId from streamer-status api responses into uId", async () => {
    const manager: any = new StreamerStatusManager(
      30,
      "https://example.com/api/v2/core-runtime",
      async () => new Response(JSON.stringify([
        {
          roomId: 202,
          uId: TEST_STREAMER_STATUS_UID,
          isLive: true,
        },
      ]), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    manager.updateHoldingRooms([202]);

    await manager.checkStreamersStatus();

    expect(manager.getStreamerStatus(202)?.uId).toBe(TEST_STREAMER_STATUS_UID);
  });

  it("queries immediately, waits 60 seconds while offline, then 30 seconds after going live", async () => {
    const scheduled: Array<{ handler: () => void; delay: number }> = [];
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((handler: TimerHandler, delay?: number) => {
      const normalizedDelay = Number(delay ?? 0);
      if (normalizedDelay === 0 || normalizedDelay >= 30_000) {
        scheduled.push({ handler: handler as () => void, delay: normalizedDelay });
        return scheduled.length as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(handler, normalizedDelay);
    }) as typeof setTimeout;

    let isLive = false;
    let requestCount = 0;
    const manager = new StreamerStatusManager(
      30,
      "https://example.com/api/v2/core-runtime",
      async () => {
        requestCount++;
        return new Response(JSON.stringify([{ roomId: 202, isLive }]), {
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    manager.updateHoldingRooms([202]);

    try {
      manager.start();
      const initialTimer = scheduled.shift();
      expect(initialTimer?.delay).toBe(0);
      initialTimer?.handler();
      await Bun.sleep(0);
      expect(requestCount).toBe(1);
      expect(scheduled[0]?.delay).toBe(60_000);

      isLive = true;
      const offlineTimer = scheduled.shift();
      offlineTimer?.handler();
      await Bun.sleep(0);
      expect(requestCount).toBe(2);
      expect(scheduled[0]?.delay).toBe(30_000);
    } finally {
      manager.stop();
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  it("marks held recording rooms as high priority", () => {
    const manager: any = new StreamerStatusManager(30, "https://example.com/api/v2/core-runtime");
    manager.updateHoldingRooms([201, 301, 302]);
    manager.updateRecordingRooms([201, 202]);
    manager.statusCache = new Map([
      [201, { roomId: 201, isLive: true }],
      [301, { roomId: 301, isLive: true }],
      [302, { roomId: 302, isLive: true }],
    ]);

    const rooms = manager.getRoomsToConnect([201], [201, 301, 302], 3);

    expect(rooms.map((item: { roomId: number }) => item.roomId)).toEqual([201, 301, 302]);
    expect(rooms[0].priority).toBe("high");
    expect(rooms[1].priority).toBe("server");
  });
});
