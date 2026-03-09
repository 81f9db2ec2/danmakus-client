import { describe, expect, test } from 'bun:test';
import { attachCliEventListeners } from './runtime';

describe('attachCliEventListeners', () => {
  test('does not register danmaku or gift payload logging in cli mode', () => {
    const events: string[] = [];
    const client = {
      on(event: string) {
        events.push(event);
      }
    };

    attachCliEventListeners(client as any, { verbose: true } as any, console);

    expect(events).not.toContain('DANMU_MSG');
    expect(events).not.toContain('msg');
    expect(events).not.toContain('SEND_GIFT');
    expect(events).toContain('connected');
    expect(events).toContain('disconnected');
  });
});
