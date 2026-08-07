import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ENGINE_SRC = resolve(import.meta.dirname!, '..');
const viteConfig = readFileSync(resolve(ENGINE_SRC, 'vite.config.ts'), 'utf8');
const mainSource = readFileSync(resolve(ENGINE_SRC, 'src/main.ts'), 'utf8');

describe('single-game runtime boundary', () => {
  test('Vite accepts one explicit game directory only', () => {
    expect(viteConfig).toContain('FORGEAX_GAME_DIR');
    expect(viteConfig).toContain('singleGamePackRoots');
    expect(viteConfig).toContain('createRuntimeScopeController');
    expect(viteConfig).not.toContain('gameAssetRoots');
    expect(viteConfig).not.toContain('perGamePackRoots');
    expect(viteConfig).not.toContain('gameSlugs');
    expect(viteConfig).not.toContain('forgeaxPerGamePackIndex');
    expect(viteConfig).not.toContain('FORGEAX_PREVIEW_GAMES_DIR');
  });

  test('browser runtime consumes the authoritative binding', () => {
    expect(mainSource).toContain('__pack/runtime-binding.json');
    expect(mainSource).toContain('configureRuntimeBinding');
    expect(mainSource).toContain('createDevImportTransport(runtimeBinding)');
    expect(mainSource).not.toContain('pack-index/${gameId}.json');
    expect(mainSource).not.toContain('falling back to global index');
    expect(mainSource).not.toContain('createDevImportTransport()');
  });

  test('the producer has no global asset route', () => {
    expect(viteConfig).not.toContain("req.url === '/preview/pack-index.json'");
    expect(viteConfig).not.toContain("req.url = '/pack-index.json'");
    expect(viteConfig).toContain("'/__pack/'");
  });
});
