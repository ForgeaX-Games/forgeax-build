// build-reel-asset.ts — turn a per-game wb-reel disk state into a shippable
// engine asset: `assets/reel-game.pack.json` (internal-text-package,
// kind:'reel-game') + co-located `assets/reel-media/<hash>.<ext>`.
//
//   bun reel-src/export/build-reel-asset.ts <slug> [projectRoot]
//
// This is the "importer / distill" step for Route B (no engine Importer needed —
// it emits a .pack.json directly). It reads the active scenario, resolves every
// media ref to bytes (per-game assets dir first, then the legacy global
// .reel-assets as a migration fallback), rewrites refs to bundle-relative URLs,
// and patches forge.json.reelGameGuid so the packager can find the entry.
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  buildReelGameAsset,
  type ResolvedBlob,
} from '../../../marketplace/plugins/wb-reel/src/scenario/pkg/buildReelGameAsset.ts';

const here = dirname(fileURLToPath(import.meta.url));

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

function fail(msg: string): never {
  console.error(`[reel-asset] ${msg}`);
  process.exit(2);
}

/** Walk up from `start` to find a dir containing `.forgeax/games`. */
function findProjectRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, '.forgeax', 'games'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** filename ext, falling back to a mime → ext map when the ext is unhelpful. */
function extOf(filename: string, mime: string): string {
  const raw = extname(filename).replace(/^\./, '').toLowerCase();
  if (raw && raw !== 'bin') return raw;
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'video/mp4') return 'mp4';
  if (mime === 'video/webm') return 'webm';
  if (mime === 'video/quicktime') return 'mov';
  if (mime === 'audio/mpeg') return 'mp3';
  if (mime === 'audio/wav' || mime === 'audio/x-wav') return 'wav';
  if (mime === 'audio/ogg') return 'ogg';
  if (mime === 'audio/mp4' || mime === 'audio/aac') return 'm4a';
  return raw || 'bin';
}

interface AssetRecord {
  id: string;
  filename: string;
  mimeType: string;
  meta?: { mediaId?: string };
}

function loadManifest(dir: string): AssetRecord[] {
  const p = join(dir, 'manifest.json');
  if (!existsSync(p)) return [];
  try {
    const m = JSON.parse(readFileSync(p, 'utf-8')) as { assets?: AssetRecord[] };
    return Array.isArray(m.assets) ? m.assets : [];
  } catch {
    return [];
  }
}

const slug = process.argv[2];
const projectRootArg = process.argv[3];
if (!slug || !SLUG_RE.test(slug)) fail(`usage: bun build-reel-asset.ts <slug> [projectRoot]  (bad slug: ${slug})`);

const projectRoot = projectRootArg ?? findProjectRoot(here) ?? process.cwd();
const gameDir = resolve(projectRoot, '.forgeax/games', slug);
if (!existsSync(gameDir)) fail(`game not found: ${gameDir}`);

const scenariosPath = join(gameDir, 'reel', 'scenarios.json');
if (!existsSync(scenariosPath)) fail(`not a reel game (no ${scenariosPath})`);

const db = JSON.parse(readFileSync(scenariosPath, 'utf-8')) as {
  activeId?: string;
  items?: Array<{ id: string; scenario: Record<string, unknown> }>;
};
const item = (db.items ?? []).find((i) => i.id === db.activeId);
if (!item) fail(`no active scenario (activeId=${db.activeId ?? 'null'})`);
const scenario = item.scenario;

// Media resolution: per-game assets dir first, then the legacy global
// .reel-assets (migration fallback so already-made games stay exportable).
const perGameAssets = join(gameDir, 'reel', 'assets');
const globalAssets = resolve(projectRoot, 'packages/marketplace/plugins/wb-reel/.reel-assets');
const manifests = [
  { dir: perGameAssets, records: loadManifest(perGameAssets) },
  { dir: globalAssets, records: loadManifest(globalAssets) },
];

function findRecord(ref: string): { dir: string; rec: AssetRecord } | null {
  for (const m of manifests) {
    const rec = m.records.find((r) => r.meta?.mediaId === ref || r.id === ref);
    if (rec) return { dir: m.dir, rec };
  }
  return null;
}

const resolveBlob = async (ref: string): Promise<ResolvedBlob> => {
  if (/^https?:\/\//.test(ref)) return { kind: 'external', url: ref };
  const found = findRecord(ref);
  if (!found) return { kind: 'missing', reason: 'no manifest record' };
  const p = resolve(found.dir, found.rec.filename);
  if (!existsSync(p)) return { kind: 'missing', reason: `blob file gone (${found.rec.filename})` };
  const bytes = new Uint8Array(readFileSync(p));
  return { kind: 'blob', bytes, ext: extOf(found.rec.filename, found.rec.mimeType) };
};

// Stable identity across re-exports: reuse forge.json.reelGameGuid if present.
let forge: Record<string, unknown> = {};
const forgePath = join(gameDir, 'forge.json');
try {
  forge = JSON.parse(readFileSync(forgePath, 'utf-8')) as Record<string, unknown>;
} catch {
  /* forge.json may not exist for reel-only games; we still write reelGameGuid below */
}
const existingGuid = typeof forge.reelGameGuid === 'string' ? forge.reelGameGuid : '';
const guid = UUID_RE.test(existingGuid) ? existingGuid : randomUUID();

const result = await buildReelGameAsset(scenario as never, { guid, resolveBlob });

const assetsOut = join(gameDir, 'assets');
mkdirSync(assetsOut, { recursive: true });
writeFileSync(join(assetsOut, 'reel-game.pack.json'), JSON.stringify(result.packJson, null, 2));
for (const f of result.mediaFiles) {
  const dest = join(assetsOut, f.path);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, f.bytes);
}

// Patch forge.json with the reel-game entry guid (P4.1 schema field).
forge.reelGameGuid = guid;
if (typeof forge.id !== 'string') forge.id = slug;
if (typeof forge.name !== 'string') forge.name = String(item.scenario['title'] ?? slug);
if (typeof forge.schemaVersion !== 'string') forge.schemaVersion = '1.0.0';
writeFileSync(forgePath, JSON.stringify(forge, null, 2));

console.log(
  `[reel-asset] ${slug}: guid=${guid} · packed ${result.mediaFiles.length} media · ` +
    `external ${result.external.length} · missing ${result.missing.length}`,
);
if (result.missing.length) {
  console.warn(`[reel-asset] missing refs:\n  ${result.missing.map((m) => `${m.ref} (${m.reason})`).join('\n  ')}`);
}
console.log(`[reel-asset] wrote ${join(assetsOut, 'reel-game.pack.json')}`);
