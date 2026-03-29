import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBunSqliteLiveSessionOutbox } from './BunSqliteLiveSessionOutbox.js';

const TEST_STREAMER_UID = 84;

describe('BunSqliteLiveSessionOutbox', () => {
  it('persists pending records in a sqlite file', async () => {
    const nowMs = Date.now();
    const databasePath = join(
      tmpdir(),
      `danmakus-live-session-outbox-${randomUUID()}.sqlite3`,
    );
    const outbox = createBunSqliteLiveSessionOutbox({ databasePath });

    await outbox.append([
      {
        streamerUid: TEST_STREAMER_UID,
        eventTsMs: nowMs,
        payload: new Uint8Array([1, 2, 3]),
      },
    ]);

    const dueRecords = await outbox.listDue({ nowMs, limit: 10 });
    expect(dueRecords).toHaveLength(1);
    expect(dueRecords[0]?.payload).toEqual(new Uint8Array([1, 2, 3]));
    expect(await outbox.countPending()).toBe(1);

    const reopenedOutbox = createBunSqliteLiveSessionOutbox({ databasePath });
    expect(await reopenedOutbox.countPending()).toBe(1);

    await reopenedOutbox.ack([dueRecords[0]!.id]);
    expect(await reopenedOutbox.countPending()).toBe(0);
  });
});
