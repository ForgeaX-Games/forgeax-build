// M1 integration smoke test (t1a)
// Starts vite dev server, verifies /preview/ and /preview/shaders/manifest.json
// return HTTP 200, confirming the engine-src dev server base path is alive.
//
// Design: spawns `bun run dev` as a child process, polls the dev server
// URL until ready, then curls two endpoints. Bun test natively supports
// fetch without extra dependencies.

import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { spawn, type Subprocess } from 'bun';

const DEV_PORT = Number(process.env.FORGEAX_ENGINE_PORT ?? 15173);
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

beforeAll(async () => {
  // Spawn vite dev server in engine-src cwd
  devProcess = spawn(['bun', 'run', 'dev'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: { ...process.env, FORGEAX_ENGINE_PORT: String(DEV_PORT) },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const ready = await waitForServer(`${BASE_URL}/`, DEV_READY_TIMEOUT_MS);
  if (!ready) {
    devProcess.kill();
    throw new Error(
      `t1a smoke: vite dev server did not become ready within ${DEV_READY_TIMEOUT_MS}ms at ${BASE_URL}/`,
    );
  }
});

afterAll(() => {
  if (devProcess) {
    devProcess.kill();
  }
});

describe('M1 integration smoke', () => {
  test('/preview/ returns HTTP 200', async () => {
    const res = await fetch(`${BASE_URL}/`);
    expect(res.status).toBe(200);
  });

  test('/preview/shaders/manifest.json returns HTTP 200', async () => {
    const res = await fetch(`${BASE_URL}/shaders/manifest.json`);
    expect(res.status).toBe(200);
  });

  test('/preview/ response is HTML (content-type includes text/html)', async () => {
    const res = await fetch(`${BASE_URL}/`);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('text/html');
  });
});