// build-standalone.ts — package a single .forgeax/games/<slug> into a
// self-contained static site that runs locally without the studio server.
//
//   bun export/build-standalone.ts <slug> <outDir>
//
// What it produces in <outDir>:
//   index.html              entry (loads the bundled engine + game)
//   assets/*.js, *.wasm     engine runtime + the game, bundled by Vite
//   shaders/…               WGSL/GLSL shader pack + manifest.json
//   game-assets/…           the game's raw assets/ dir, copied verbatim
//   game-scenes/…           the game's raw scenes/ dir (level packs), if any
//   pack-index.json         per-game asset catalog with RELATIVE urls
//   serve.sh, README.md     how to run it locally
//
// Approach: a generated entry statically imports the game's entry module (so
// the game is bundled at build time, not fetched/transpiled at runtime), pins
// base './' and relative shader + pack-index urls. Assets are shipped raw and
// catalogued with relative urls — exactly what the dev preview serves — so the
// runtime decodes them client-side (no prod texture-cook step needed).
import { build } from 'vite';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync, cpSync, chmodSync, readdirSync,
} from 'node:fs';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { gltfImporter } from '@forgeax/engine-gltf';
import { imageImporter } from '@forgeax/engine-image/image-importer';
// Note: fbxImporter is imported dynamically inside the vite config block
// to avoid resolving the native module when just running the script.

const here = dirname(fileURLToPath(import.meta.url)); // .../engine-src/export
// Engine source migrated to packages/editor/packages/play-runtime; the studio
// packager copies this script into the selected engine root and passes its
// path via FORGEAX_ENGINE_ROOT so vite + game (.forgeax/games) resolve there.
const engineSrc = process.env.FORGEAX_ENGINE_ROOT
  ? resolve(process.env.FORGEAX_ENGINE_ROOT)
  : resolve(here, '..');                              // .../engine-src

// SSOT-derived list of @forgeax workspace packages resolvable from the engine
// root — exactly the set vite resolves natively here. Used for dedupe so the
// WHOLE @forgeax family collapses to one instance each. A hand-listed subset
// (the old 5-entry dedupe) drifts: under preserveSymlinks:true the nested-pnpm
// engine-physics ↔ rapier symlink-diamond recurses without bound and rollup
// fails to resolve @dimforge/rapier*-compat. Mirrors vite.config.ts's
// forgeaxWorkspacePackages() — keep the two in sync.
function forgeaxWorkspacePackages(root: string): string[] {
  const out = new Set<string>(['@forgeax/scene']);
  try {
    for (const name of readdirSync(resolve(root, 'node_modules/@forgeax'))) {
      out.add(`@forgeax/${name}`);
    }
  } catch { /* node_modules not materialised — fall through */ }
  return [...out];
}
const FORGEAX_WS_PKGS = forgeaxWorkspacePackages(engineSrc);

const slug = process.argv[2];
const outDir = process.argv[3];
if (!slug || !outDir) {
  console.error('usage: bun export/build-standalone.ts <slug> <outDir>');
  process.exit(2);
}
if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(slug)) {
  console.error(`invalid slug: ${slug}`);
  process.exit(2);
}

// The studio packager copies the currently-running game into a temp dir
// physically under the engine root and passes it via FORGEAX_GAME_DIR, so the
// game's bare imports (@forgeax/*) resolve from the engine root's node_modules.
// Falls back to the engine-root .forgeax/games junction for standalone CLI use.
const gameDir = process.env.FORGEAX_GAME_DIR
  ? resolve(process.env.FORGEAX_GAME_DIR)
  : resolve(engineSrc, '.forgeax/games', slug);
if (!existsSync(gameDir)) {
  console.error(`game not found: ${gameDir}`);
  process.exit(2);
}

let forge: { entry?: string; name?: string; physics?: unknown; defaultScene?: unknown } = {};
try { forge = JSON.parse(readFileSync(join(gameDir, 'forge.json'), 'utf8')); } catch { /* defaults */ }
const entryRel = (forge.entry ?? 'main.ts').replace(/^\.?\//, '');
const gameName = String(forge.name ?? slug);
// Normalize forge.json `physics` into the engine's CreateAppOptions.physics
// value (mirrors play-runtime/src/main.ts). Absent => physics stays off, so
// non-physics games pay zero rapier-WASM cost.
const physicsMode =
  forge.physics === '3d' || forge.physics === true || forge.physics === 'rapier-3d' ? 'rapier-3d'
  : forge.physics === '2d' || forge.physics === 'rapier-2d' ? 'rapier-2d'
  : null;
// Host-instantiated defaultScene GUID (forge.json `defaultScene`). When set,
// the generated entry resolves + instantiates it before bootstrap so the game
// receives a world already carrying the scene entities.
const defaultSceneGuid =
  typeof forge.defaultScene === 'string' && forge.defaultScene.length > 0 ? forge.defaultScene : null;

// The dev preview's per-game pack roots are BOTH `assets/` and `scenes/`: levels
// live in scenes/<id>.pack.json (the defaultScene GUID resolves there), monsters
// /materials in assets/. Ship + catalog both so loadByGuid(defaultScene) resolves
// in the frozen build, not just in dev.
const PACK_DIRS = ['assets', 'scenes'] as const;
const packRoots = PACK_DIRS.map((d) => join(gameDir, d)).filter((p) => existsSync(p));

// Shared template assets (e.g. the default game's sky.hdr skylight cube-texture,
// GUID 81eec382-...) live under the engine root's shared-assets/ dir, folded into
// EVERY game's catalog by the dev preview (vite.config.ts sharedAssetRoots()).
// The standalone export must scan it too, otherwise loadByGuid(sky) fails at
// runtime and installHdrSky falls back to a warm solid ambient — tinting the
// whole scene orange. Import it through pluginPack alongside the game's own roots.
const sharedAssetsDir = resolve(engineSrc, 'shared-assets');
const packRootsAll = existsSync(sharedAssetsDir) ? [...packRoots, sharedAssetsDir] : packRoots;

// ── Generate the standalone entry + html at the engine root so the emitted
// index.html lands at <outDir> root (Vite keeps html paths relative to root). ──
// The gen files live at engineSrc ROOT (shared across runs), so their names are
// per-run unique: two concurrent exports must not clobber / cleanup each other's
// `.export-gen.*` at the same path.
const runId = randomUUID().slice(0, 8);
const genHtmlName = `.export-gen.${runId}.index.html`;
const genEntryName = `.export-gen.${runId}.main.ts`;
const genHtml = join(engineSrc, genHtmlName);
const genEntry = join(engineSrc, genEntryName);
// Import the game by a path relative to engineSrc (where the gen entry lives),
// so it works whether the game sits at the default .forgeax/games junction or
// in the packager's temp copy (FORGEAX_GAME_DIR), both physically under engineSrc.
// Only `./` and `../` are valid ES relative-specifier prefixes: a hidden dir like
// `.forgeax-export/…` starts with `.` but is NOT relative, so always prepend `./`
// unless already `./`/`../`-prefixed. (vite@6 tolerates a bare leading dot, but
// the declared vite@8 / rolldown does not — this keeps export forward-compatible.)
const relGameEntry = relative(engineSrc, join(gameDir, entryRel)).split(sep).join('/');
const gameEntryImport = (relGameEntry.startsWith('./') || relGameEntry.startsWith('../'))
  ? relGameEntry
  : `./${relGameEntry}`;

// The game module is statically imported (bundled at build time) and consumed
// via loadGame, which validates the `bootstrap` export and returns the entry.
// This mirrors the dev preview (play-runtime): host instantiates the
// defaultScene (when one exists) BEFORE bootstrap runs, then calls
// bootstrap(world, ctx) with the world that already carries the scene entities.
// Physics is enabled by passing `plugins: [physicsPlugin(mode)]` in createApp's
// 2nd (CreateAppOptions) arg — MIRRORS play-runtime. CreateAppOptions.physics is
// a READBACK field (a PhysicsWorld handle), NOT the backend selector: passing the
// backend string there is silently dropped, so the export never actually got
// physics (bullets couldn't knock props — the "editor bounces the ball, the EXE
// doesn't" symptom). Import + reference physicsPlugin ONLY when this game opts in
// (forge.json "physics"), so non-physics games don't bundle the rapier WASM.
const physicsImportLine = physicsMode
  ? "import { physicsPlugin } from '@forgeax/engine-physics';\n"
  : '';
const createAppOptsExpr = physicsMode ? '{ plugins: [physicsPlugin(PHYSICS)] }' : '{}';

const entrySrc = `import { createApp, loadGame } from '@forgeax/engine-app';
import { AssetGuid } from '@forgeax/engine-pack/guid';
${physicsImportLine}import * as gameModule from ${JSON.stringify(gameEntryImport)};

const SLUG = ${JSON.stringify(slug)};
const PHYSICS = ${JSON.stringify(physicsMode)};
const DEFAULT_SCENE = ${JSON.stringify(defaultSceneGuid)};

function fail(msg: string) {
  const pre = document.createElement('pre');
  pre.style.cssText = 'position:fixed;inset:0;margin:0;padding:24px;background:#1a1a1f;color:#ff8a8a;font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap;overflow:auto;z-index:99999';
  const insecure = location.protocol === 'http:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
  pre.textContent = (insecure
    ? '\\u26a0 WebGPU requires a secure context. Open over http://localhost (use ./serve.sh) or https.\\n\\n'
    : '') + msg;
  document.body.appendChild(pre);
}

// Dump a structured inner error (RhiError-shaped) so the on-screen message
// carries the REAL cause. createApp/createRenderer wrap the actual GPU failure
// in EngineEnvironmentError.detail.{webgpuError (Channel 2), wgpuError
// (Channel 3 fallback)}; String(err) alone drops all of it.
function fmtInner(label: string, re: any): string {
  if (!re || typeof re !== 'object') return '';
  const out = ['', '-- ' + label + ' --'];
  if (re.message) out.push('message:  ' + String(re.message));
  if (re.code) out.push('code:     ' + String(re.code));
  if (re.expected) out.push('expected: ' + String(re.expected));
  if (re.hint) out.push('hint:     ' + String(re.hint));
  if (re.detail !== undefined) {
    try { out.push('detail:   ' + JSON.stringify(re.detail)); }
    catch { out.push('detail:   ' + String(re.detail)); }
  }
  return out.join('\\n');
}
function formatEngineError(err: any): string {
  const head = (err && err.name ? err.name + ': ' : '') + (err && err.message ? err.message : String(err));
  let body = '';
  let detail = (err && typeof err === 'object') ? err.detail : undefined;
  // Some wrappers nest the real EngineEnvironmentError under detail.cause.
  if (detail && detail.cause && typeof detail.cause === 'object' && detail.cause.detail) {
    body += fmtInner('cause', detail.cause);
    detail = detail.cause.detail;
  }
  if (detail) {
    body += fmtInner('webgpu (Channel 2)', detail.webgpuError);
    body += fmtInner('wgpu (Channel 3 fallback)', detail.wgpuError);
  }
  return head + body;
}

(async () => {
  const root = document.getElementById('app') ?? document.body;
  const canvas = document.createElement('canvas');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  const dpr = Math.min(window.devicePixelRatio, 2);
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  root.appendChild(canvas);

  // createApp(canvas, opts, bundler): shaderManifestUrl belongs on the 3rd
  // (BundlerOptions) arg — passing it on the 2nd is silently dropped and the
  // engine falls back to '/shaders/manifest.json' (404 in a standalone build).
  // The 2nd arg carries the physics plugin (see physicsImportLine note above):
  // ${createAppOptsExpr} — plugins:[physicsPlugin(mode)] when the game opts in.
  const app = await createApp(
    canvas,
    ${createAppOptsExpr},
    { shaderManifestUrl: './shaders/manifest.json' },
  );
  if (!app.ok) { fail('createApp failed: ' + formatEngineError(app.error)); return; }
  const { world, renderer } = app.value;

  renderer.assets.configurePackIndex('./pack-index.json');

  window.addEventListener('resize', () => {
    const d = Math.min(window.devicePixelRatio, 2);
    canvas.width = window.innerWidth * d;
    canvas.height = window.innerHeight * d;
  });

  // Instantiate the forge.json defaultScene BEFORE bootstrap so the game
  // module receives a world that already contains the scene entities (mirrors
  // play-runtime/src/main.ts). Assets resolve via the prod pack-index above.
  let defaultSceneRoot;
  let defaultScene;
  if (DEFAULT_SCENE) {
    const parsed = AssetGuid.parse(DEFAULT_SCENE);
    if (parsed.ok) {
      const assetRes = await renderer.assets.loadByGuid(parsed.value);
      if (assetRes.ok) {
        defaultScene = assetRes.value;
        const handle = world.allocSharedRef('SceneAsset', assetRes.value);
        const inst = renderer.assets.instantiate(handle, world);
        if (inst.ok) defaultSceneRoot = inst.value;
        else console.error('[export] defaultScene instantiate failed:', inst.error);
      } else {
        console.error('[export] defaultScene loadByGuid failed:', assetRes.error);
      }
    } else {
      console.error('[export] defaultScene GUID malformed:', DEFAULT_SCENE);
    }
  }

  // BootstrapContext: world is the explicit first arg (not a ctx field).
  const ctx = {
    renderer,
    assets: renderer.assets,
    app: app.value,
    registerUpdate(fn: (dt: number) => void) { app.value.registerUpdate(fn); },
    ...(defaultSceneRoot !== undefined ? { defaultSceneRoot } : {}),
    ...(defaultScene !== undefined ? { defaultScene } : {}),
  };

  // loadGame validates a NAMED \`bootstrap\` function export on the resolved
  // module; pass the game module namespace verbatim (no { default } wrap).
  const res = await loadGame(SLUG, async () => gameModule);
  if (!res.ok) { fail('loadGame failed: ' + JSON.stringify(res.error)); return; }
  await res.value(world, ctx as never);
  app.value.start();
})().catch((e) => fail(String(e?.stack ?? e)));
`;

const htmlSrc = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${gameName.replace(/[<>&]/g, '')}</title>
    <style>
      html, body { margin: 0; padding: 0; height: 100%; background: #000; color: #fff; font-family: system-ui, sans-serif; }
      #app, canvas { width: 100vw; height: 100vh; display: block; }
    </style>
    <script type="module" src="./${genEntryName}"></script>
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>
`;

writeFileSync(genEntry, entrySrc);
writeFileSync(genHtml, htmlSrc);

const cleanupGen = () => {
  rmSync(genEntry, { force: true });
  rmSync(genHtml, { force: true });
};

try {
  console.log(`[export] building game "${slug}" → ${outDir}`);

  let fbxImporterModule: { fbxImporter: any } | undefined;
  try {
    fbxImporterModule = await import('@forgeax/engine-fbx');
  } catch (e) {
    console.warn('[export] fbx importer missing; fbx models will not be exported', e);
  }

  await build({
    root: engineSrc,
    base: './',
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    plugins: [
      forgeaxShader() as never,
      pluginPack({
        roots: packRootsAll,
        importers: [imageImporter, gltfImporter, ...(fbxImporterModule ? [fbxImporterModule.fbxImporter] : [])],
      }) as never,
    ],
    resolve: {
      alias: { '@forgeax/game-types': resolve(engineSrc, 'src/types.ts') },
      // Dedupe the WHOLE @forgeax family (SSOT-derived) so each engine package
      // resolves to a single instance — collapses the preserveSymlinks:true
      // nested-pnpm symlink-diamond (engine-physics ↔ rapier) that an under-set
      // dedupe lets recurse without bound.
      dedupe: FORGEAX_WS_PKGS,
      preserveSymlinks: true,
    },
    build: {
      outDir,
      emptyOutDir: true,
      target: 'esnext',
      rollupOptions: {
        input: genHtml,
        // engine-app conditionally `import()`s the Node-only rhi-debug
        // entrypoints (main `.` + `/adapter`) behind the FORGEAX_ENGINE_RHI_DEBUG
        // flag, which is OFF in a standalone export (the vite-plugin-rhi-debug
        // `define` is dev-only). Those modules pull node:fs / node:path / pngjs,
        // which rollup can't bundle for the browser (broken __vite-browser-external
        // stubs). Mark them external so they stay runtime dynamic imports that
        // never fire here. The browser-safe `/capture-browser` subpath is NOT
        // externalized — it is legitimately bundled.
        external: [
          '@forgeax/engine-rhi-debug',
          '@forgeax/engine-rhi-debug/adapter',
        ],
        // Emit ONE self-contained bundle: inline every dynamic import() into the
        // entry chunk instead of code-splitting it into a separate lazy chunk.
        //
        // WHY (Android release): the engine lazily `import()`s the physics
        // backend (@forgeax/engine-physics-rapier3d → @dimforge/rapier*-compat)
        // and other feature chunks at runtime. In an Android WebView the game is
        // served from assets/public/ via WebViewAssetLoader over the virtual
        // https://appassets.androidplatform.net origin. The entry <script
        // type=module> loads fine (navigation subresource), but a JS-initiated
        // runtime import() of a code-split chunk fails with
        // `TypeError: Failed to fetch dynamically imported module` — the
        // intercepted response is treated as an opaque origin, so createApp's
        // physics plugin build() throws plugin-build-failed on device. Inlining
        // removes every runtime import() fetch: all engine + game + rapier code
        // ships inside the entry chunk that already loads, so there is nothing
        // left to fetch lazily. A standalone game bundle is meant to be one
        // self-contained artifact anyway, so the larger single chunk is fine.
        //
        // externalized rhi-debug stays a bare (never-fired) dynamic import and is
        // unaffected — it is not bundled, so it is not something to inline.
        output: {
          inlineDynamicImports: true,
        },
      },
    },
  });
} finally {
  cleanupGen();
}

// ── Relocate emitted html to <outDir>/index.html (assets are base-relative so
// they keep resolving from the same directory). ──
const emittedHtml = join(outDir, genHtmlName);
if (existsSync(emittedHtml)) renameSync(emittedHtml, join(outDir, 'index.html'));

// ── Ship raw assets ──
// The game's raw assets and scenes are copied so they match what pluginPack emits.
for (const d of PACK_DIRS) {
  const src = join(gameDir, d);
  if (existsSync(src)) cpSync(src, join(outDir, `game-${d}`), { recursive: true });
}

// ── Rebase pack-index.json packageUrls to shipped, base-relative files. ──
// pluginPack (catalog v2) emits each row with an ABSOLUTE `packageUrl`
// (`/assets/<guid>.pack-<hash>.json`) pointing at the vite-emitted Pack v2 file.
// Under this export's `base: './'` an absolute `/assets/…` only resolves when the
// site is served from the origin ROOT; a sub-path deployment (or the desktop
// launcher mounting the build under a prefix) then 404s every asset. Rewrite each
// packageUrl to a RELATIVE `./assets/…` so it resolves against pack-index.json's
// own location (assets-runtime resolveCatalogAssetUrl uses `new URL(packageUrl,
// packIndexUrl)`). The Pack v2 files themselves reference their body.bin artifacts
// by pack-relative paths, so no further rewrite is needed inside them.
//
// CRITICAL: the runtime catalog parser (assets-runtime parseCatalog) REJECTS the
// ENTIRE pack-index if ANY row carries a legacy locator field (`relativeUrl`) or
// any of metadata/compression/artifacts/assetCodec/contentEncoding — it demands
// navigation-only rows. The previous rebase INJECTED `relativeUrl` onto every
// source-path row, so the current engine dropped the whole index at runtime →
// loadByGuid failed for the scene, character, sky (→ warm ambient fallback) and
// HUD, i.e. the "packaged EXE looks nothing like the editor" symptom. So we must
// only ever touch `packageUrl` and preserve every other field verbatim via spread.
type PackRow = {
  guid: string;
  packageUrl?: string;
  kind: string;
  [key: string]: unknown;
};
const idxPath = join(outDir, 'pack-index.json');
if (existsSync(idxPath)) {
  const rows: PackRow[] = JSON.parse(readFileSync(idxPath, 'utf8'));
  const rebased = rows.map((e) => {
    const url = typeof e.packageUrl === 'string' ? e.packageUrl : '';
    if (!url) return e;
    // Normalize to a path relative to outDir root, then verify it was shipped.
    const stripped = url.replace(/^\.?\//, '');
    if (existsSync(join(outDir, stripped))) {
      return { ...e, packageUrl: `./${stripped}` };
    }
    // Not shipped under outDir — leave it so the row still parses, but surface it
    // in the build log so a missing artifact is visible now, not as a silent
    // runtime 404. (Absolute origin-root URLs still work for a root-served build.)
    console.warn(`[export] pack-index packageUrl not shipped under outDir: ${url} (guid ${e.guid})`);
    return e;
  });
  writeFileSync(idxPath, JSON.stringify(rebased));
}

// ── serve.sh + README ──
const serveSh = `#!/usr/bin/env bash
# Serve this standalone game on http://localhost:8123
# WebGPU requires a secure context, so it MUST be served over localhost (not a
# bare file:// open, and not a non-localhost IP).
set -e
PORT="\${1:-8123}"
cd "$(dirname "$0")"
echo "Serving on http://localhost:\${PORT}  (Ctrl-C to stop)"
if command -v npx >/dev/null 2>&1; then
  exec npx --yes serve -l "\${PORT}" .
elif command -v python3 >/dev/null 2>&1; then
  exec python3 -m http.server "\${PORT}" --bind 127.0.0.1
else
  echo "Need npx (node) or python3 to serve. Install one, or use any static server." >&2
  exit 1
fi
`;
writeFileSync(join(outDir, 'serve.sh'), serveSh);
chmodSync(join(outDir, 'serve.sh'), 0o755);

const readme = `# ${gameName} — standalone build

A self-contained build of the \`${slug}\` game. It runs entirely in the browser
with no studio server.

## Run it

\`\`\`bash
./serve.sh            # serves http://localhost:8123
\`\`\`

Then open **http://localhost:8123** in a WebGPU-capable browser
(Chrome/Edge 113+). 

> WebGPU only works over a **secure context** — i.e. \`localhost\` or HTTPS.
> Opening \`index.html\` directly as a \`file://\` will NOT work, and serving it
> on a non-localhost IP over plain HTTP will show a WebGPU diagnostic.
> If your static server sends the wrong MIME type for \`.wasm\`, prefer
> \`npx serve\` (used by \`serve.sh\`) which sets \`application/wasm\`.

## Contents

| path | what |
|------|------|
| \`index.html\`      | entry |
| \`assets/\`         | bundled engine runtime + game (JS + wgpu wasm) |
| \`shaders/\`        | shader pack + \`manifest.json\` |
| \`game-assets/\`    | the game's raw assets |
| \`game-scenes/\`    | the game's raw scene/level packs (if any) |
| \`pack-index.json\` | asset catalog (relative urls) |
`;
writeFileSync(join(outDir, 'README.md'), readme);

console.log(`[export] done: ${outDir}`);
