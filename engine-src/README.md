# @forgeax/preview-runtime

Engine host for the Studio Preview iframe. Initializes the WebGPU renderer and ECS World, then loads the user's game `main.ts` via Vite dynamic import.

## Run

```bash
bun --filter @forgeax/preview-runtime dev   # :15173
```

Access through the Studio UI proxy: `http://localhost:18920/preview/?game=<slug>`

## Boot sequence

1. `createRenderer(canvas, { shaderManifestUrl })` — WebGPU init; renders diagnostic overlay on failure
2. `World` + register 5 core components (Transform / MeshFilter / MeshRenderer / Camera / DirectionalLight)
3. `setSceneAssetResolver` — bridge AssetRegistry to World
4. `loadGame(slug)` — HEAD pre-check + dynamic import `.forgeax/games/<slug>/src/main.ts`
5. `requestAnimationFrame` loop — renderer.draw + update hooks

## GameEntry contract

```ts
import type { GameContext, GameEntry } from '@forgeax/game-types';

const start: GameEntry = (ctx) => {
  const { world, renderer, assets, registerUpdate } = ctx;
  // ...
};
export default start;
```

`@forgeax/game-types` is a Vite alias pointing to `src/types.ts`.

## Relationship to game template

When the user clicks "New Game" in Studio, the server copies the template from `packages/editor/packages/engine/templates/game-default/` into `.forgeax/games/<slug>/`. The template's `src/main.ts` exports a `GameEntry` function, which this runtime loads and executes via dynamic import.

## Vite config notes

- `base: '/preview/'` — aligned with interface (:18920) proxy path
- `preserveSymlinks: true` — ensures game code resolves `@forgeax/*` packages through symlinks
- `forgeaxShader` plugin — serves `/shaders/manifest.json` in dev middleware
- HMR clientPort targets the interface port (18920)
