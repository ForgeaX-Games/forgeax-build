// pack-catalog.test.ts - w4 red test for per-root catalog builder
// TDD RED phase: buildPerGameCatalog() does not exist yet, these tests will fail.
//
// Uses the main-tree shoot fixture (.forgeax/games/shoot/assets/) to assert
// the catalog builder produces 4-field entries (guid/relativeUrl/kind/sourcePath).
// Shoot is a pure .pack.json game (77 material pack files, no .meta.json),
// so the testsuite stays focused on the legacy arm.
//
// The shoot fixture path references the main studio tree absolute path because
// .forgeax/ is gitignored and absent in worktrees. This is a conscious choice:
// M2 tests run against the canonical shoot content rather than a manufactured
// fixture subset.

import { beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Path to the main studio tree's shoot assets. Must exist as a precondition;
// if missing the tests are skipped (not failed) so whitebox CI can run without
// a full forgeax-studio clone.
const STUDIO_ROOT = resolve(import.meta.dirname!, '..', '..', '..', '..', '..', '..');
const SHOOT_ASSETS = resolve(STUDIO_ROOT, '..', 'forgeax-studio', '.forgeax', 'games', 'shoot', 'assets');

const hasShootFixture = existsSync(SHOOT_ASSETS);

let buildPerGameCatalog:
  | ((root: string, base?: string) => Promise<Array<Record<string, unknown>>>)
  | null = null;
try {
  const mod = await import('../pack-catalog.js');
  buildPerGameCatalog = mod.buildPerGameCatalog;
} catch {
  buildPerGameCatalog = null;
}

describe('pack-catalog.ts', () => {
  test('buildPerGameCatalog is importable', () => {
    expect(buildPerGameCatalog).not.toBeNull();
  });

  describe('shoot fixture (77 .pack.json material files)', () => {
    const skip = !hasShootFixture || !buildPerGameCatalog;

    let entries: Array<Record<string, unknown>>;

    beforeAll(async () => {
      if (!buildPerGameCatalog) return;
      entries = await buildPerGameCatalog(SHOOT_ASSETS);
    });

    test.skipIf(skip)('catalog is non-empty', () => {
      expect(entries.length).toBeGreaterThan(0);
    });

    test.skipIf(skip)('every entry has 4 core fields with non-empty values', () => {
      for (const e of entries) {
        expect(e.guid, `entry missing guid`).toBeString();
        expect(e.guid, `entry has empty guid`).not.toBe('');
        expect(e.relativeUrl, `entry ${e.guid} missing relativeUrl`).toBeString();
        expect(e.relativeUrl, `entry ${e.guid} has empty relativeUrl`).not.toBe('');
        expect(e.kind, `entry ${e.guid} missing kind`).toBeString();
        expect(e.kind, `entry ${e.guid} has empty kind`).not.toBe('');
        expect(e.sourcePath, `entry ${e.guid} missing sourcePath`).toBeString();
        expect(e.sourcePath, `entry ${e.guid} has empty sourcePath`).not.toBe('');
      }
    });

    test.skipIf(skip)('all entries have kind = material (shoot is pure material packs)', () => {
      for (const e of entries) {
        expect(e.kind).toBe('material');
      }
    });

    test.skipIf(skip)('all guids are valid UUIDs', () => {
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      for (const e of entries) {
        expect(e.guid).toMatch(uuidRe);
      }
    });

    test.skipIf(skip)('catalog entry count matches shoot material count (77)', () => {
      expect(entries.length).toBe(77);
    });

    // Regression guard for the asset-fetch-failed bug (loadByGuid). The runtime
    // fetches each relativeUrl verbatim from the preview iframe origin, and the
    // interface dev server only proxies /preview/* to the engine. So every
    // relativeUrl MUST carry the /preview prefix — without it the fetch falls
    // through to the interface SPA, returns index.html (200, text/html), and
    // JSON parsing fails. Previously these entries were root-absolute
    // (/.forgeax/...) which silently broke every game's material load.
    test.skipIf(skip)('every relativeUrl carries the default /preview base prefix', () => {
      for (const e of entries) {
        expect(
          e.relativeUrl,
          `entry ${e.guid} relativeUrl must start with /preview/ (got ${e.relativeUrl})`,
        ).toMatch(/^\/preview\/\.forgeax\/games\//);
      }
    });
  });

  describe('base prefix parameter', () => {
    const skip = !hasShootFixture || !buildPerGameCatalog;

    test.skipIf(skip)('default base prefixes /preview', async () => {
      const entries = await buildPerGameCatalog!(SHOOT_ASSETS);
      expect(entries[0]!.relativeUrl).toStartWith('/preview/.forgeax/');
    });

    test.skipIf(skip)('explicit empty base emits root-absolute url (prod/standalone use)', async () => {
      const entries = await buildPerGameCatalog!(SHOOT_ASSETS, '');
      expect(entries[0]!.relativeUrl).toStartWith('/.forgeax/');
      expect(entries[0]!.relativeUrl).not.toStartWith('/preview/');
    });

    test.skipIf(skip)('custom base is applied verbatim (trailing slash tolerated)', async () => {
      const entries = await buildPerGameCatalog!(SHOOT_ASSETS, '/custom/');
      expect(entries[0]!.relativeUrl).toStartWith('/custom/.forgeax/');
    });
  });

  describe('empty root returns empty catalog', () => {
    test('empty array on non-existent root', async () => {
      if (!buildPerGameCatalog) {
        expect(buildPerGameCatalog).not.toBeNull();
        return;
      }
      const result = await buildPerGameCatalog('/tmp/nonexistent-assets-dir-42a9f1b3');
      expect(result).toBeArray();
      expect(result.length).toBe(0);
    });
  });

  // Regression guard for the skybox-not-rendering bug: an `.hdr` sidecar whose
  // sub-asset declares kind:'equirect' (feat-20260630 internalized IBL) must
  // fold to a kind:'equirect' catalog row carrying rgba16float metadata — NOT be
  // silently dropped. Previously the image-importer arm only knew 'image' /
  // 'cube-texture', so the equirect sub-asset produced no row, loadByGuid found
  // no entry, and the Skylight/skybox fell back to the camera clear-color.
  // Uses the real tracked sky.hdr baked into a temp game dir so the row's
  // rgba16float metadata comes from an actual import (matches the SSOT
  // build-catalog.ts and play-runtime pack-catalog.ts equirect arms).
  describe('equirect .hdr sub-asset (feat-20260630 internalized IBL)', () => {
    const SKY_HDR = resolve(
      import.meta.dirname!,
      '..',
      'shared-assets',
      'template-game-default',
      'sky.hdr',
    );
    const hasSkyHdr = existsSync(SKY_HDR);
    const skip = !hasSkyHdr || !buildPerGameCatalog;
    const SKY_GUID = '81eec382-392f-5a93-8998-0ecf11ef7990';

    let tmpDir: string | null = null;
    let entries: Array<Record<string, unknown>> = [];

    beforeAll(async () => {
      if (skip) return;
      // Build a minimal game asset root: sky.hdr + an equirect sidecar. The
      // catalog builder runs relative to process.cwd(); mkdtemp under the
      // engine-src cwd keeps relative(cwd, ...) sane and the temp dir is removed
      // in afterAll (below, via rmSync in the last test's finally is fragile, so
      // we rely on the OS tmpdir cleanup — mkdtemp under tmpdir()).
      tmpDir = mkdtempSync(resolve(tmpdir(), 'fx-equirect-'));
      copyFileSync(SKY_HDR, resolve(tmpDir, 'sky.hdr'));
      writeFileSync(
        resolve(tmpDir, 'sky.hdr.meta.json'),
        JSON.stringify({
          kind: 'external-asset-package',
          importer: 'image',
          schemaVersion: '1.0.0',
          source: 'sky.hdr',
          importSettings: { colorSpace: 'linear', mipmap: 'auto' },
          subAssets: [{ guid: SKY_GUID, sourceIndex: 0, kind: 'equirect' }],
        }),
      );
      entries = await buildPerGameCatalog!(tmpDir, '');
    });

    test.skipIf(skip)('emits a catalog row for the equirect sub-asset (not dropped)', () => {
      const row = entries.find((e) => e.guid === SKY_GUID);
      expect(row, 'equirect sub-asset must produce a catalog row').toBeDefined();
    });

    test.skipIf(skip)('row carries kind:equirect (matches runtime equirectLoader)', () => {
      const row = entries.find((e) => e.guid === SKY_GUID)!;
      expect(row.kind).toBe('equirect');
    });

    test.skipIf(skip)('row metadata is rgba16float linear (baked .bin)', () => {
      const row = entries.find((e) => e.guid === SKY_GUID)!;
      const meta = row.metadata as Record<string, unknown>;
      expect(meta).toBeDefined();
      expect(meta.format).toBe('rgba16float');
      expect(meta.colorSpace).toBe('linear');
      expect(row.relativeUrl).toMatch(/\.bin$/);
    });

    test.skipIf(skip)('cleanup temp dir', () => {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});