// per-game-isolation.integration.test.ts - w8 integration test
// AC-01: per-game index isolation via dev server curl
//
// Starts vite dev server, curls /preview/pack-index/shoot.json and
// /preview/pack-index/shoot-opt.json, asserts:
// 1. Both indices are non-empty
// 2. Every entry has 4 core fields with non-empty values
// 3. Both indices return valid JSON arrays
//
// GUID values may be identical across games (shoot-opt is a copy of shoot
// with no GUID recast per OOS-2). The key property is per-game physical
// isolation: each game gets its own catalog file, so there is no cross-game
// collision that would collapse the catalog to empty.
//
// The dev server requires .forgeax/games/ with shoot and shoot-opt symlinks
// already in place. This test assumes the main tree's .forgeax/ games are
// symlinked into the engine-src working directory.

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { spawn, type Subprocess } from 'bun';

const DEV_PORT = 15176; // Use a dedicated port to avoid conflicts.
const BASE_URL = `http://localhost:${DEV_PORT}/preview`;
const DEV_READY_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 500;

let devProcess: Subprocess | null = null;

async function waitForServer(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // server not ready yet
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

async function fetchJson(url: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return (await res.json()) as Array<Record<string, unknown>>;
}

beforeAll(async () => {
  devProcess = spawn(['bun', 'run', 'dev'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, FORGEAX_ENGINE_PORT: String(DEV_PORT) },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const ready = await waitForServer(`${BASE_URL}/`, DEV_READY_TIMEOUT_MS);
  if (!ready) {
    devProcess.kill();
    throw new Error(`w8 integration: vite dev server did not become ready within ${DEV_READY_TIMEOUT_MS}ms at ${BASE_URL}/`);
  }
});

afterAll(() => {
  if (devProcess) {
    devProcess.kill();
  }
});

describe('w8 per-game index isolation (AC-01)', () => {
  test('/preview/pack-index/shoot.json returns non-empty catalog', async () => {
    const catalog = await fetchJson(`${BASE_URL}/pack-index/shoot.json`);
    expect(catalog.length).toBeGreaterThan(0);
  });

  test('/preview/pack-index/shoot-opt.json returns non-empty catalog', async () => {
    const catalog = await fetchJson(`${BASE_URL}/pack-index/shoot-opt.json`);
    expect(catalog.length).toBeGreaterThan(0);
  });

  test('shoot catalog entries have 4 core fields', async () => {
    const catalog = await fetchJson(`${BASE_URL}/pack-index/shoot.json`);
    for (const e of catalog) {
      expect(e.guid).toBeString();
      expect(e.guid).not.toBe('');
      expect(e.relativeUrl).toBeString();
      expect(e.relativeUrl).not.toBe('');
      expect(e.kind).toBeString();
      expect(e.kind).not.toBe('');
      expect(e.sourcePath).toBeString();
      expect(e.sourcePath).not.toBe('');
    }
  });

  test('shoot-opt catalog entries have 4 core fields', async () => {
    const catalog = await fetchJson(`${BASE_URL}/pack-index/shoot-opt.json`);
    for (const e of catalog) {
      expect(e.guid).toBeString();
      expect(e.guid).not.toBe('');
      expect(e.relativeUrl).toBeString();
      expect(e.relativeUrl).not.toBe('');
      expect(e.kind).toBeString();
      expect(e.kind).not.toBe('');
      expect(e.sourcePath).toBeString();
      expect(e.sourcePath).not.toBe('');
    }
  });

  test('shoot and shoot-opt catalogs have same entry count (both 77 material packs)', async () => {
    const shootCat = await fetchJson(`${BASE_URL}/pack-index/shoot.json`);
    const shootOptCat = await fetchJson(`${BASE_URL}/pack-index/shoot-opt.json`);
    expect(shootCat.length).toBe(shootOptCat.length);
    expect(shootCat.length).toBe(77);
  });

  test('shoot entries only reference shoot paths, shoot-opt only shoot-opt paths (per-game isolation)', async () => {
    const shootCat = await fetchJson(`${BASE_URL}/pack-index/shoot.json`);
    const shootOptCat = await fetchJson(`${BASE_URL}/pack-index/shoot-opt.json`);
    for (const e of shootCat) {
      const sp = String(e.sourcePath);
      expect(sp).toContain('shoot');
      expect(sp).not.toContain('shoot-opt');
    }
    for (const e of shootOptCat) {
      const sp = String(e.sourcePath);
      expect(sp).toContain('shoot-opt');
      expect(sp).not.toContain('/shoot/');
    }
  });

  test('both catalogs have same GUID values (expected: shoot-opt is a copy with no GUID recast)', async () => {
    const shootCat = await fetchJson(`${BASE_URL}/pack-index/shoot.json`);
    const shootOptCat = await fetchJson(`${BASE_URL}/pack-index/shoot-opt.json`);
    const shootGuids = new Set(shootCat.map((e) => e.guid));
    for (const e of shootOptCat) {
      expect(shootGuids.has(e.guid)).toBe(true);
    }
  });
});