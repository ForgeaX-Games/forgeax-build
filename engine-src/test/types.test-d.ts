// Compile-time contract test for the release runtime's canonical bootstrap
// aliases. This file has no runtime side effects.

import type { BootstrapContext, BootstrapEntry } from '@forgeax/engine-app';
import type { World } from '@forgeax/engine-ecs';
import type {
  BootstrapContext as AliasContext,
  BootstrapEntry as AliasEntry,
  GameContext,
  GameEntry,
} from '../src/types';

const _world: World = {} as World;
const _ctx: BootstrapContext = {} as AliasContext;
const _entry: BootstrapEntry = {} as AliasEntry;
const _gameContext: BootstrapContext = {} as GameContext;
const _gameEntry: BootstrapEntry = {} as GameEntry;

void _world;
void _ctx;
void _entry;
void _gameContext;
void _gameEntry;
