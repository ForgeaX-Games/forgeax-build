import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntimeScopeController } from '../src/runtime-scope-controller';

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function requestBody(value: unknown) {
  const body = JSON.stringify(value);
  return (event: 'data' | 'end' | 'error', listener: (...args: any[]) => void) => {
    if (event === 'data') listener(body);
    if (event === 'end') listener();
  };
}

function harness() {
  let current: any;
  let handler: any;
  const roots: string[][] = [];
  const pack = {
    async rebind(binding: any, nextRoots: readonly string[]) {
      roots.push([...nextRoots]);
      current = { ...binding, status: 'ready', authority: 'authoritative', diagnostics: [] };
      return current;
    },
    runtimeBinding: () => current,
  };
  const controller = createRuntimeScopeController({
    pack: pack as any,
    base: '/preview',
    secret: 'secret',
    resolveRoots: (gameDir) => [join(gameDir, 'assets')],
  });
  controller.configureServer({
    middlewares: {
      use(next: any) {
        handler = next;
      },
    },
  });
  return { handler: () => handler, roots };
}

function response() {
  const state: { statusCode?: number; headers: Record<string, string>; body?: string } = {
    headers: {},
  };
  return {
    state,
    get statusCode() { return state.statusCode; },
    set statusCode(value: number | undefined) { state.statusCode = value; },
    setHeader(name: string, value: string) { state.headers[name] = value; },
    end(body?: string) { state.body = body; },
  };
}

describe('runtime scope controller', () => {
  test('rejects unauthenticated bind and accepts one exact game directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-runtime-scope-'));
    tempRoots.push(root);
    mkdirSync(join(root, 'assets'));
    const { handler, roots } = harness();

    const forbidden = response();
    await handler()({
      url: '/__pack/control/bind',
      method: 'POST',
      headers: {},
      on: requestBody({ gameId: 'active', scopeId: 'scope-a', generation: 1, gameDir: root }),
    }, forbidden, () => {});
    expect(forbidden.state.statusCode).toBe(403);

    const accepted = response();
    await handler()({
      url: '/__pack/control/bind',
      method: 'POST',
      headers: { 'x-forgeax-runtime-secret': 'secret' },
      on: requestBody({ gameId: 'active', scopeId: 'scope-a', generation: 1, gameDir: root }),
    }, accepted, () => {});
    expect(accepted.state.statusCode).toBe(200);
    expect(JSON.parse(accepted.state.body!)).toMatchObject({ gameId: 'active', scopeId: 'scope-a', generation: 1, status: 'ready' });
    expect(roots).toEqual([[realpathSync(join(root, 'assets'))]]);
  });

  test('binding endpoint exposes the current generation and rejects stale rebinding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-runtime-scope-'));
    tempRoots.push(root);
    const { handler } = harness();
    const bind = (generation: number) => handler()({
      url: '/__pack/control/bind',
      method: 'POST',
      headers: { 'x-forgeax-runtime-secret': 'secret' },
      on: requestBody({ gameId: 'active', scopeId: 'scope-a', generation, gameDir: root }),
    }, response(), () => {});
    await bind(2);

    const binding = response();
    await handler()({ url: '/__pack/runtime-binding.json', method: 'GET' }, binding, () => {});
    expect(binding.state.statusCode).toBe(200);
    expect(JSON.parse(binding.state.body!)).toMatchObject({ generation: 2, status: 'ready' });

    const stale = response();
    await handler()({
      url: '/__pack/control/bind',
      method: 'POST',
      headers: { 'x-forgeax-runtime-secret': 'secret' },
      on: requestBody({ gameId: 'active', scopeId: 'scope-a', generation: 1, gameDir: root }),
    }, stale, () => {});
    expect(stale.state.statusCode).toBe(409);
  });
});
