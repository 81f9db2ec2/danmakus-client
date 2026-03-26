import { describe, expect, test } from 'bun:test';
import { ConfigManager } from './ConfigManager';

describe('ConfigManager CookieCloud overrides', () => {
  test('keeps local CookieCloud config when applying account config', () => {
    const manager = new ConfigManager({
      runtimeUrl: 'https://example.com/api/v2/core-runtime',
      cookieCloudKey: 'local-key',
      cookieCloudPassword: 'local-password',
      cookieCloudHost: 'https://cookie.local',
      cookieRefreshInterval: 120
    });

    manager.applyAccountConfig({
      maxConnections: 5,
      runtimeUrl: 'https://example.com/api/v2/core-runtime',
      autoReconnect: true,
      reconnectInterval: 5000,
      statusCheckInterval: 30,
      cookieCloudKey: 'remote-key',
      cookieCloudPassword: 'remote-password',
      cookieCloudHost: 'https://cookie.remote',
      cookieRefreshInterval: 30,
      streamers: [],
      requestServerRooms: true,
      allowedAreas: [],
      allowedParentAreas: []
    } as any);

    expect(manager.getConfig().cookieCloudKey).toBe('local-key');
    expect(manager.getConfig().cookieCloudPassword).toBe('local-password');
    expect(manager.getConfig().cookieCloudHost).toBe('https://cookie.local');
    expect(manager.getConfig().cookieRefreshInterval).toBe(120);
  });

  test('does not enable CookieCloud from account config alone', () => {
    const manager = new ConfigManager({
      runtimeUrl: 'https://example.com/api/v2/core-runtime'
    });

    manager.applyAccountConfig({
      maxConnections: 5,
      runtimeUrl: 'https://example.com/api/v2/core-runtime',
      autoReconnect: true,
      reconnectInterval: 5000,
      statusCheckInterval: 30,
      cookieCloudKey: 'remote-key',
      cookieCloudPassword: 'remote-password',
      cookieCloudHost: 'https://cookie.remote',
      cookieRefreshInterval: 30,
      streamers: [],
      requestServerRooms: true,
      allowedAreas: [],
      allowedParentAreas: []
    } as any);

    expect(manager.hasCookieCloudConfig()).toBe(false);
    expect(manager.getConfig().cookieCloudKey).toBeUndefined();
    expect(manager.getConfig().cookieCloudPassword).toBeUndefined();
    expect(manager.getConfig().cookieCloudHost).toBe('https://cookie.danmakus.com');
    expect(manager.getConfig().cookieRefreshInterval).toBe(3600);
  });

  test('keeps local capacityOverride from cli options', () => {
    const manager = new ConfigManager({
      runtimeUrl: 'https://example.com/api/v2/core-runtime',
      maxConnections: 5
    });

    manager.updateFromCliOptions({
      capacityOverride: 3
    });

    expect(manager.getConfig().capacityOverride).toBe(3);
  });

  test('normalizes excludedServerRoomUserIds from account config', () => {
    const manager = new ConfigManager({
      runtimeUrl: 'https://example.com/api/v2/core-runtime'
    });

    manager.applyAccountConfig({
      maxConnections: 5,
      runtimeUrl: 'https://example.com/api/v2/core-runtime',
      autoReconnect: true,
      reconnectInterval: 5000,
      statusCheckInterval: 30,
      streamers: [],
      requestServerRooms: true,
      allowedAreas: [],
      allowedParentAreas: [],
      excludedServerRoomUserIds: [300, -1, 200, 300, 100.8]
    });

    expect(manager.getConfig().excludedServerRoomUserIds).toEqual([100, 200, 300]);
  });
});
