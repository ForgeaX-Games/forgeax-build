# @forgeax/preview-runtime

Engine host for one active game. Initializes the WebGPU renderer and ECS World,
then loads that game's `main.ts` via Vite dynamic import. The host accepts the
exact game directory through `FORGEAX_GAME_DIR`; it never discovers sibling
games or combines their asset catalogs.

## Run

```bash
bun --filter @forgeax/preview-runtime dev   # :15173
```

The launcher/server binds one game through the authenticated runtime-scope
control route. Direct single-game starts may provide `FORGEAX_GAME_DIR` and
`FORGEAX_GAME_ID`. Access through the Studio UI proxy after binding:
`http://localhost:18920/preview/?game=<slug>`.

## Boot sequence

1. Read the server-confirmed runtime binding for the active game.
2. `createApp(canvas, { plugins })` — WebGPU and opt-in physics init; shader manifest is supplied through the bundler argument.
3. Configure the bound catalog/import/package URLs for the one runtime realm.
4. `loadGame(slug)` — HEAD pre-check + dynamic import from the exact `host-games/<slug>` mount.
5. `requestAnimationFrame` loop — renderer.draw + ECS `Update` systems.

## Bootstrap contract

```ts
import type { BootstrapContext } from '@forgeax/game-types';
import type { World } from '@forgeax/engine-ecs';

export async function bootstrap(world: World, ctx?: BootstrapContext): Promise<void> {
  const { renderer, assets } = ctx ?? {};
  // ...
}
```

`@forgeax/game-types` is a Vite alias pointing to `src/types.ts`.

## Relationship to game template

When the user clicks "New Game" in Studio, the server copies the template from `packages/editor/packages/engine/templates/game-default/` into `.forgeax/games/<slug>/`, then binds that exact directory to the Play realm. The template's `main.ts` exports a `bootstrap(world, ctx)` function, which this runtime loads and executes.

## Vite config notes

- `base: '/preview/'` — aligned with interface (:18920) proxy path
- `preserveSymlinks: true` — ensures game code resolves `@forgeax/*` packages through symlinks
- `forgeaxShader` plugin — serves `/shaders/manifest.json` in dev middleware
- `pluginPack` scans only the bound game's `assets/` and `scenes/` plus explicit shared product assets
- `/__pack/scopes/<scope>/<generation>/...` is the only dev catalog/import/package route
- HMR clientPort targets the interface port (18920)
