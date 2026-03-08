import { describe, expect, it } from "bun:test";
import { StreamerStatusManager } from "./StreamerStatusManager";

describe("StreamerStatusManager room priority", () => {
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
