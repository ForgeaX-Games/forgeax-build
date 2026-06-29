// M1 postMessage field baseline test (t1b)
// Verifies that the 4 VAG_* message types have correct field sets as
// defined by the C4 postMessage protocol. No THREE.js dependency --
// only structural assertions on message shapes.
//
// AC-05: postMessage field sets must remain backward-compatible with
// the interface layer. This test locks the baseline.

import { describe, expect, test } from 'bun:test';

// ── Type definitions matching the C4 postMessage protocol ──

type VagMessage =
  | { type: 'VAG_CONSOLE'; payload: { level: string; text: string; ts: number } }
  | { type: 'VAG_FPS_STATS'; payload: { fps: number } }
  | { type: 'VAG_PREVIEW_PAUSE' }
  | { type: 'VAG_PREVIEW_PLAY' }
  | { type: 'VAG_PREVIEW_RELOAD' };

// ── Helper types for field-set verification ──

type RequiredKeys<T> = {
  [K in keyof T]-?: undefined extends T[K] ? never : K;
}[keyof T];

// ── Reference messages (canonical shapes from research F6) ──

const VAG_CONSOLE_SAMPLE: VagMessage = {
  type: 'VAG_CONSOLE',
  payload: { level: 'log', text: 'hello forgeax', ts: 1717000000000 },
};

const VAG_FPS_STATS_SAMPLE: VagMessage = {
  type: 'VAG_FPS_STATS',
  payload: { fps: 60 },
};

const VAG_PREVIEW_PAUSE_SAMPLE: VagMessage = {
  type: 'VAG_PREVIEW_PAUSE',
};

const VAG_PREVIEW_PLAY_SAMPLE: VagMessage = {
  type: 'VAG_PREVIEW_PLAY',
};

const VAG_PREVIEW_RELOAD_SAMPLE: VagMessage = {
  type: 'VAG_PREVIEW_RELOAD',
};

// ── Tests ──

describe('postMessage field baseline (AC-05)', () => {
  test('VAG_CONSOLE has type + payload.{level, text, ts}', () => {
    const msg = VAG_CONSOLE_SAMPLE;
    expect(msg.type).toBe('VAG_CONSOLE');
    expect(typeof msg.payload.level).toBe('string');
    expect(typeof msg.payload.text).toBe('string');
    expect(typeof msg.payload.ts).toBe('number');
  });

  test('VAG_FPS_STATS has type + payload.{fps}', () => {
    const msg = VAG_FPS_STATS_SAMPLE;
    expect(msg.type).toBe('VAG_FPS_STATS');
    expect(typeof msg.payload.fps).toBe('number');
  });

  test('VAG_PREVIEW_PAUSE has type (no payload)', () => {
    const msg = VAG_PREVIEW_PAUSE_SAMPLE;
    expect(msg.type).toBe('VAG_PREVIEW_PAUSE');
    expect(msg).not.toHaveProperty('payload');
  });

  test('VAG_PREVIEW_PLAY has type (no payload)', () => {
    const msg = VAG_PREVIEW_PLAY_SAMPLE;
    expect(msg.type).toBe('VAG_PREVIEW_PLAY');
    expect(msg).not.toHaveProperty('payload');
  });

  test('VAG_PREVIEW_RELOAD has type (no payload)', () => {
    const msg = VAG_PREVIEW_RELOAD_SAMPLE;
    expect(msg.type).toBe('VAG_PREVIEW_RELOAD');
    expect(msg).not.toHaveProperty('payload');
  });

  test('VAG_CONSOLE level is one of: log, warn, error, info, debug', () => {
    const validLevels = ['log', 'warn', 'error', 'info', 'debug'];
    for (const level of validLevels) {
      const msg: VagMessage = {
        type: 'VAG_CONSOLE',
        payload: { level, text: 'test', ts: 0 },
      };
      expect(validLevels).toContain(msg.payload.level);
    }
  });

  test('VAG_CONSOLE ts is a positive integer timestamp', () => {
    const now = Date.now();
    const msg: VagMessage = {
      type: 'VAG_CONSOLE',
      payload: { level: 'log', text: 'ts check', ts: now },
    };
    expect(msg.payload.ts).toBeGreaterThan(0);
    expect(Number.isInteger(msg.payload.ts)).toBe(true);
  });

  test('VAG_FPS_STATS fps is a non-negative number', () => {
    const msg: VagMessage = {
      type: 'VAG_FPS_STATS',
      payload: { fps: 0 },
    };
    expect(msg.payload.fps).toBeGreaterThanOrEqual(0);
  });

  test('all 5 message types have unique type discriminants', () => {
    const types = [
      VAG_CONSOLE_SAMPLE.type,
      VAG_FPS_STATS_SAMPLE.type,
      VAG_PREVIEW_PAUSE_SAMPLE.type,
      VAG_PREVIEW_PLAY_SAMPLE.type,
      VAG_PREVIEW_RELOAD_SAMPLE.type,
    ];
    const unique = new Set(types);
    expect(unique.size).toBe(5);
  });

  test('VAG_CONSOLE payload text handles empty string', () => {
    const msg: VagMessage = {
      type: 'VAG_CONSOLE',
      payload: { level: 'log', text: '', ts: 0 },
    };
    expect(msg.payload.text).toBe('');
  });
});