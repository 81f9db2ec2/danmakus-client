import { describe, expect, it } from "bun:test";
import { StreamerStatusManager } from "./StreamerStatusManager";

describe("StreamerStatusManager room priority", () => {
  it("prioritizes recording rooms over holding rooms", () => {
    const manager: any = new StreamerStatusManager(30, "https://example.com/api/v2/core-runtime");
    manager.updateHoldingRooms([301, 302, 303]);
    manager.updateRecordingRooms([201, 202]);
    manager.statusCache = new Map([
      [201, { roomId: 201, isLive: true }],
      [202, { roomId: 202, isLive: true }],
      [301, { roomId: 301, isLive: true }],
      [302, { roomId: 302, isLive: true }],
      [303, { roomId: 303, isLive: true }],
    ]);

    const rooms = manager.getRoomsToConnect([201, 202], [301, 302, 303], 3);

    expect(rooms.map((item: { roomId: number }) => item.roomId)).toEqual([201, 202, 301]);
    expect(rooms[0].priority).toBe("high");
    expect(rooms[2].priority).toBe("server");
  });
});
