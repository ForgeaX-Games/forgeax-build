// Public type aliases for game source imports. The runtime itself uses the
// engine-app bootstrap contract directly; keeping these aliases here preserves
// the Vite path without inventing a second host context protocol.
export type { BootstrapContext, BootstrapEntry, GameContext } from '@forgeax/engine-app';
export type { BootstrapEntry as EngineGameEntry } from '@forgeax/engine-app';
export type { BootstrapEntry as GameEntry } from '@forgeax/engine-app';
