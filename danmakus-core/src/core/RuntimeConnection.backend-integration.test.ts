import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { RuntimeConnection } from "./RuntimeConnection";

type StartedHost = {
  port: number;
  process: ReturnType<typeof Bun.spawn>;
};

type DebugAccount = {
  id: number;
  token: string;
  maxConnections: number;
  recordingUserIds: number[];
  excludedServerRoomUserIds: number[];
};

type DebugStreamer = {
  userId: number;
  roomId: number;
  isLive: boolean;
  name: string;
  title: string;
  area: string;
  parentArea: string;
  watchCount: number;
  danmakuCount: number;
  fansCount: number;
  followCount: number;
  startedAtUnixMs: number;
};

type CoreRuntimeStateDto = {
  clientId: string;
  holdingRooms?: number[];
  connectedRooms?: number[];
};

type DebugRequestRoomPayload = {
  clientId: string;
  holdingRooms: number[];
  connectedRooms: number[];
  desiredCount: number;
  reason: string;
};

type DebugRequestRoomEvaluation = {
  error?: string | null;
  sameAccountActiveReservedUserIds?: number[];
  otherAccountReservedUserIds?: number[];
  reservedRooms?: Array<{
    accountId: number;
    clientId: string;
    roomId: number;
    userId: number;
    isActiveClient: boolean;
  }>;
  candidates?: Array<{
    roomId: number;
    userId: number;
    isFollowed: boolean;
    candidateSource: string;
  }>;
  response?: {
    holdingRooms?: number[];
    newlyAssignedRooms?: number[];
    droppedRooms?: number[];
  };
};

type SimulatedClient = {
  token: string;
  clientId: string;
  forwardedFor: string;
  maxConnections: number;
  runtime: RuntimeConnection;
  holdingRooms: number[];
  connectedRooms: number[];
};

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../../../../");
const smokeHostProjectPath = path.join(
  repoRoot,
  "Tests",
  "Smoke",
  "DanmakusBackend.Tools.CoreRuntimeSmokeHost",
  "DanmakusBackend.Tools.CoreRuntimeSmokeHost.csproj",
);

let startedHost: StartedHost | null = null;

beforeAll(async () => {
  startedHost = await startBackendHost();
}, 30_000);

afterAll(async () => {
  if (!startedHost) {
    return;
  }

  startedHost.process.kill();
  await startedHost.process.exited;
  startedHost = null;
}, 30_000);

describe("RuntimeConnection backend integration", () => {
  it("requests rooms from backend test host after runtime sync", async () => {
    const host = requireStartedHost();
    await resetHost(host.port);
    await setAccounts(host.port, [
      {
        id: 1,
        token: "token-account-1",
        maxConnections: 5,
        recordingUserIds: [],
        excludedServerRoomUserIds: [],
      },
    ]);
    await setStreamers(
      host.port,
      Array.from({ length: 8 }, (_, index) => createStreamer(3001 + index, true)),
    );

    await syncRuntimeState(host.port, "token-account-1", "client-1");
    const runtime = new RuntimeConnection(
      `http://127.0.0.1:${host.port}/api/v2/core-runtime?token=token-account-1&clientId=client-1`,
    );
    await runtime.connect();

    const response = await runtime.requestRooms({
      holdingRooms: [],
      connectedRooms: [],
      desiredCount: 3,
      reason: "client-backend-smoke",
    });

    expect(response).not.toBeNull();
    expect(response?.holdingRooms.length).toBe(3);
    expect(response?.newlyAssignedRooms.length).toBe(3);
    expect(response?.droppedRooms).toEqual([]);
  });

  it("supports seeded multi-round same-account multi-client allocation against backend test host", async () => {
    const host = requireStartedHost();
    await resetHost(host.port);

    const accountOne: DebugAccount = {
      id: 1,
      token: "token-account-1",
      maxConnections: 4,
      recordingUserIds: [1001, 1002, 1003],
      excludedServerRoomUserIds: [1010, 1011],
    };
    const accountTwo: DebugAccount = {
      id: 2,
      token: "token-account-2",
      maxConnections: 3,
      recordingUserIds: [1004],
      excludedServerRoomUserIds: [],
    };
    await setAccounts(host.port, [accountOne, accountTwo]);

    const streamers = new Map<number, DebugStreamer>(
      Array.from({ length: 40 }, (_, index) => {
        const streamer = createStreamer(1001 + index, index < 24);
        return [streamer.userId, streamer] as const;
      }),
    );
    await setStreamers(host.port, [...streamers.values()]);

    const clients: SimulatedClient[] = [
      createClient(host.port, accountOne.token, "account-1-client-a", "10.0.0.1", accountOne.maxConnections),
      createClient(host.port, accountOne.token, "account-1-client-b", "10.0.0.2", accountOne.maxConnections),
      createClient(host.port, accountTwo.token, "account-2-client-a", "10.0.0.3", accountTwo.maxConnections),
    ];

    for (const client of clients) {
      await syncRuntimeState(host.port, client.token, client.clientId, client.forwardedFor);
      const connected = await client.runtime.connect();
      expect(connected).toBe(true);
    }

    const random = createSeededRandom(20260326);
    for (let round = 0; round < 16; round++) {
      toggleRandomLiveStates(streamers, random, 5);
      await setStreamers(host.port, [...streamers.values()]);
      const lastPayloadByClientId = new Map<string, DebugRequestRoomPayload>();

      for (const client of shuffle(clients, random)) {
        const payload: DebugRequestRoomPayload = {
          clientId: client.clientId,
          holdingRooms: [...client.holdingRooms],
          connectedRooms: [...client.connectedRooms],
          desiredCount: Math.max(0, client.maxConnections - client.holdingRooms.length),
          reason: `client-seeded-round-${round}`,
        };
        lastPayloadByClientId.set(client.clientId, payload);
        const response = await client.runtime.requestRooms(payload);

        expect(response).not.toBeNull();
        const nextHoldingRooms = response?.holdingRooms ?? [];
        const liveRoomIds = new Set(
          [...streamers.values()].filter(streamer => streamer.isLive).map(streamer => streamer.roomId),
        );

        expect(nextHoldingRooms.length).toBeLessThanOrEqual(client.maxConnections);
        nextHoldingRooms.forEach(roomId => expect(liveRoomIds.has(roomId)).toBe(true));

        client.holdingRooms = [...nextHoldingRooms];
        client.connectedRooms = nextHoldingRooms.filter(() => random() < 0.65);
      }

      const roomToUserId = new Map([...streamers.values()].map(streamer => [streamer.roomId, streamer.userId]));
      const accountOneAssignedUserIds = clients
        .filter(client => client.token === accountOne.token)
        .flatMap(client => client.holdingRooms)
        .map(roomId => roomToUserId.get(roomId))
        .filter((userId): userId is number => typeof userId === "number");
      const duplicateUserIds = accountOneAssignedUserIds.filter(
        (userId, index, values) => values.indexOf(userId) !== index,
      );

      expect(accountOneAssignedUserIds).not.toContain(1010);
      expect(accountOneAssignedUserIds).not.toContain(1011);
      if (duplicateUserIds.length > 0) {
        const runtimeStates = await getCoreClients(host.port, accountOne.token);
        const accountOnePayloads = [...lastPayloadByClientId.values()]
          .filter(payload => payload.clientId.startsWith("account-1-client-"));
        const evaluations = await Promise.all(
          accountOnePayloads.map(async payload => ({
            clientId: payload.clientId,
            payload,
            evaluation: await debugEvaluateRequestRoom(host.port, accountOne.token, payload),
          })),
        );
        throw new Error([
          `同账号 client 出现重复主播分配: round=${round}`,
          `duplicateUserIds=${JSON.stringify([...new Set(duplicateUserIds)].sort((left, right) => left - right))}`,
          `accountOneAssignedUserIds=${JSON.stringify(accountOneAssignedUserIds)}`,
          `clientHoldingRooms=${JSON.stringify(clients
            .filter(client => client.token === accountOne.token)
            .map(client => ({ clientId: client.clientId, holdingRooms: client.holdingRooms, connectedRooms: client.connectedRooms })))}`,
          `backendRuntimeStates=${JSON.stringify(runtimeStates)}`,
          `requestEvaluations=${JSON.stringify(evaluations)}`,
        ].join("\n"));
      }

      const onlineFollowedUserIds = [...streamers.values()]
        .filter(streamer => streamer.isLive && accountOne.recordingUserIds.includes(streamer.userId))
        .map(streamer => streamer.userId);
      for (const userId of onlineFollowedUserIds) {
        expect(accountOneAssignedUserIds).toContain(userId);
      }
    }
  });
});

async function startBackendHost(): Promise<StartedHost> {
  const port = await getFreePort();
  const process = Bun.spawn(
    ["dotnet", "run", "--project", smokeHostProjectPath, "--", "--port", String(port)],
    {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  try {
    await waitForHealth(port, process);
    return { port, process };
  } catch (error) {
    process.kill();
    await process.exited;
    throw error;
  }
}

function requireStartedHost(): StartedHost {
  if (!startedHost) {
    throw new Error("backend test host 未启动");
  }
  return startedHost;
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("无法获取空闲端口"));
        return;
      }

      const { port } = address;
      server.close(error => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

async function waitForHealth(
  port: number,
  process: ReturnType<typeof Bun.spawn>,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      const stderr = await new Response(process.stderr).text();
      throw new Error(`backend test host 提前退出: ${stderr}`);
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok && (await response.text()) === "ok") {
        return;
      }
    } catch {
    }

    await Bun.sleep(200);
  }

  const stderr = await new Response(process.stderr).text();
  throw new Error(`等待 backend test host 超时: ${stderr}`);
}

async function resetHost(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/debug/reset`, {
    method: "POST",
  });
  expect(response.status).toBe(204);
}

async function setAccounts(port: number, accounts: DebugAccount[]): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/debug/accounts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ accounts }),
  });
  expect(response.ok).toBe(true);
}

async function setStreamers(port: number, streamers: DebugStreamer[]): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/debug/streamers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ streamers }),
  });
  expect(response.ok).toBe(true);
}

async function syncRuntimeState(port: number, token: string, clientId: string, forwardedFor?: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/api/v2/core-runtime/sync`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Token: token,
      ...(forwardedFor ? { "X-Forwarded-For": forwardedFor } : {}),
    },
    body: JSON.stringify({
      clientId,
      clientVersion: "test",
      isRunning: true,
      runtimeConnected: true,
      cookieValid: true,
      connectedRooms: [],
      connectionInfo: [],
      holdingRooms: [],
      messageCount: 0,
      lastError: null,
    }),
  });
  expect(response.ok).toBe(true);
}

async function getCoreClients(port: number, token: string): Promise<CoreRuntimeStateDto[]> {
  const response = await fetch(`http://127.0.0.1:${port}/api/v2/core-runtime/clients`, {
    method: "GET",
    headers: {
      Token: token,
    },
  });
  expect(response.ok).toBe(true);
  const payload = await response.json() as {
    code?: number;
    data?: CoreRuntimeStateDto[];
  };
  expect(payload.code).toBe(200);
  return payload.data ?? [];
}

async function debugEvaluateRequestRoom(
  port: number,
  token: string,
  payload: DebugRequestRoomPayload,
): Promise<DebugRequestRoomEvaluation> {
  const response = await fetch(`http://127.0.0.1:${port}/debug/request-room-evaluate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Token: token,
    },
    body: JSON.stringify(payload),
  });
  expect(response.ok).toBe(true);
  const envelope = await response.json() as {
    code?: number;
    data?: DebugRequestRoomEvaluation;
  };
  expect(envelope.code).toBe(200);
  return envelope.data ?? {};
}

function createClient(
  port: number,
  token: string,
  clientId: string,
  forwardedFor: string,
  maxConnections: number,
): SimulatedClient {
  return {
    token,
    clientId,
    forwardedFor,
    maxConnections,
    runtime: new RuntimeConnection(
      `http://127.0.0.1:${port}/api/v2/core-runtime?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(clientId)}`,
      true,
      5000,
      { "X-Forwarded-For": forwardedFor },
    ),
    holdingRooms: [],
    connectedRooms: [],
  };
}

function createStreamer(userId: number, isLive: boolean): DebugStreamer {
  const offset = userId % 1000;
  return {
    userId,
    roomId: 900000 + offset,
    isLive,
    name: `streamer-${userId}`,
    title: `room-${userId}`,
    area: "game",
    parentArea: "entertainment",
    watchCount: 1000 - offset,
    danmakuCount: 100 + offset,
    fansCount: 10000 + offset,
    followCount: 500 + offset,
    startedAtUnixMs: Date.now() - (20 + offset % 30) * 60_000,
  };
}

function toggleRandomLiveStates(
  streamers: Map<number, DebugStreamer>,
  random: () => number,
  toggleCount: number,
): void {
  for (const streamer of shuffle([...streamers.values()], random).slice(0, toggleCount)) {
    streamers.set(streamer.userId, {
      ...streamer,
      isLive: !streamer.isLive,
    });
  }
}

function shuffle<T>(values: T[], random: () => number): T[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target]!, result[index]!];
  }
  return result;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
