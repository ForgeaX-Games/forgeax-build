import type { Renderer } from '@forgeax/engine-runtime';
// engine #650 (Tier-2 decomposition) moved AssetRegistry into engine-assets-runtime.
import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import type { App, GameEntry as EngineGameEntry } from '@forgeax/engine-app';

export interface GameContext {
  readonly world: World;
  readonly renderer: Renderer;
  readonly assets: AssetRegistry;
  readonly app: App;
  registerUpdate(fn: (dt: number) => void): void;
}

export type GameEntry = (ctx: GameContext) => void | Promise<void>;
export type { EngineGameEntry };
