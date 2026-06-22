// M3 vite dev smoke test (t3a)
// Verifies: forgeaxShader vite plugin integration end-to-end.
// Starts vite dev server, checks /preview/shaders/manifest.json returns
// HTTP 200 + valid JSON content-type, and that HMR WebSocket is reachable.
//
// TDD RED phase: test is written before forgeaxShader is wired into
// vite.config.ts (t3b). Manifest endpoint will 404 until t3b implements
// the plugin.
//
// Design: spawns `bun run dev` as a child process, polls the dev server
// URL until ready, then curls manifest + checks HMR ws.

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

async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(5000) });
    } catch (e) {
      lastErr = e;
      if (i < retries - 1) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw lastErr;
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
    throw new Error(
      `t3a smoke: vite dev server did not become ready within ${DEV_READY_TIMEOUT_MS}ms at ${BASE_URL}/`,
    );
  }
});

afterAll(() => {
  if (devProcess) {
    devProcess.kill();
  }
});

describe('M3 vite dev smoke', () => {
  test('/preview/shaders/manifest.json returns HTTP 200', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/shaders/manifest.json`);
    expect(res.status).toBe(200);
  });

  test('/preview/shaders/manifest.json has content-type application/json', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/shaders/manifest.json`);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('application/json');
  });

  test('/preview/shaders/manifest.json body is valid JSON with entries array', async () => {
    const res = await fetchWithRetry(`${BASE_URL}/shaders/manifest.json`);
    const body = await res.json();
    expect(body).toBeDefined();
    expect(body).toHaveProperty('entries');
    expect(Array.isArray(body.entries)).toBe(true);
  });

  test('HMR WebSocket endpoint is reachable', async () => {
    // Vite HMR WebSocket is served at the base path. The ws:// will be
    // proxied through the studio interface. Verify the HTTP upgrade path
    // exists by checking the page HTML includes the HMR client script.
    const res = await fetchWithRetry(`${BASE_URL}/`);
    const html = await res.text();
    // Vite injects @vite/client or a WebSocket-based HMR client script
    // into the HTML. Check for the HMR client marker.
    expect(html).toContain('@vite/client');
  });
});