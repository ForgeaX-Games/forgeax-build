// M2 types.test-d.ts (t2a) — GameContext v2 type contract assertion
//
// Design: compile-time-only type test — zero runtime overhead.
// Uses `satisfies` keyword to assert structural type compatibility
// without introducing `expect-type` or `vitest` dependency.
// Bun's tsc is available via `npx tsc --noEmit`.
//
// RED stage (t2a): current types.ts still exports THREE-derived fields,
// so these assertions should produce type errors.
// GREEN stage (t2b): after types.ts rewrite, tsc --noEmit passes clean.

import type { World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-runtime';
import type { AssetRegistry } from '@forgeax/engine-runtime';
import type { App } from '@forgeax/engine-app';

// ── GameContext v2 expectation ──
//
// Per plan-strategy D4: { world, renderer, assets, app, registerUpdate }.
// Types are re-exported from engine packages, no Studio aliases (charter P4).

interface ExpectedGameContext {
  readonly world: World;
  readonly renderer: Renderer;
  readonly assets: AssetRegistry;
  readonly app: App;
  registerUpdate(fn: (dt: number) => void): void;
}

// ── GameEntry expectation ──
//
// Per plan-strategy D4: (ctx: GameContext) => void | Promise<void>.
// Supports both sync and async entry functions.

type ExpectedGameEntry = (ctx: ExpectedGameContext) => void | Promise<void>;

// ── Type assertions via satisfies ──
//
// These compile-time checks verify that the imported GameContext / GameEntry
// from types.ts are structurally assignable to the expected shapes.
// tsc --noEmit will fail here if types.ts still carries THREE fields.

import type { GameContext, GameEntry } from '../src/types';

// If types.ts is v1 (THREE), this should fail because GameContext has
// scene/camera/renderer(THREE.WebGLRenderer)/clock instead of
// world/renderer/engine-runtime.Renderer/assets.
const _ctx: ExpectedGameContext = {} as GameContext;

// Verify that GameContext passed to a GameEntry function is structurally
// compatible with the expected entry shape.
const _entry: ExpectedGameEntry = {} as GameEntry;

// ── Verify GameContext can be used as expected without `as` (AC-11) ──
//
// A minimal function that consumes GameContext the way AI users would.
// If types.ts has correct re-exports, this compiles without `as` casts.

function exerciseContext(ctx: GameContext): void {
  // Access world (should be World from @forgeax/engine-ecs)
  const w: World = ctx.world;
  void w;

  // Access renderer (should be Renderer from @forgeax/engine-runtime)
  const r: Renderer = ctx.renderer;
  void r;

  // Access assets (should be AssetRegistry from @forgeax/engine-runtime)
  const a: AssetRegistry = ctx.assets;
  void a;

  // Use registerUpdate
  ctx.registerUpdate((dt: number) => {
    void dt;
  });
}

// ── Verify GameEntry shapes compile ──

const syncEntry: GameEntry = (ctx: GameContext) => {
  exerciseContext(ctx);
};

const asyncEntry: GameEntry = async (ctx: GameContext) => {
  exerciseContext(ctx);
};

void syncEntry;
void asyncEntry;

// ── Verify that old THREE fields are NOT present on GameContext ──
//
// After types.ts v2 rewrite, these should generate type errors (good — they
// prove the old API is no longer accessible). During t2a red stage, these
// might compile fine because GameContext still has THREE fields — that's
// expected: the test-d.ts red signal comes from the EXPECTED shape mismatch
// above, not from these negative assertions.
//
// We comment these out because they'd cause false-green during red stage.
// They become active assertions during t2b green stage.
//
// Expected compile errors after t2b:
//   Property 'scene' does not exist on type 'GameContext'.
//   Property 'clock' does not exist on type 'GameContext'.

// Uncomment after t2b to verify old fields are inaccessible:
// const _noScene: never = ({} as GameContext).scene;
// const _noClock: never = ({} as GameContext).clock;