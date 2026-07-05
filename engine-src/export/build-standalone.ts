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
if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) {
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

// ── Generate the standalone entry + html at the engine root so the emitted
// index.html lands at <outDir> root (Vite keeps html paths relative to root). ──
const genHtmlName = '.export-gen.index.html';
const genEntryName = '.export-gen.main.ts';
const genHtml = join(engineSrc, genHtmlName);
const genEntry = join(engineSrc, genEntryName);
// Import the game by a path relative to engineSrc (where the gen entry lives),
// so it works whether the game sits at the default .forgeax/games junction or
// in the packager's temp copy (FORGEAX_GAME_DIR), both physically under engineSrc.
const relGameEntry = relative(engineSrc, join(gameDir, entryRel)).split(sep).join('/');
const gameEntryImport = relGameEntry.startsWith('.') ? relGameEntry : `./${relGameEntry}`;

// The game module is statically imported (bundled at build time) and consumed
// via loadGame, which validates the `bootstrap` export and returns the entry.
// This mirrors the dev preview (play-runtime): host instantiates the
// defaultScene (when one exists) BEFORE bootstrap runs, then calls
// bootstrap(world, ctx) with the world that already carries the scene entities.
const entrySrc = `import { createApp, loadGame } from '@forgeax/engine-app';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import * as gameModule from ${JSON.stringify(gameEntryImport)};

const SLUG = ${JSON.stringify(slug)};
const PHYSICS = ${JSON.stringify(physicsMode)};
const DEFAULT_SCENE = ${JSON.stringify(defaultSceneGuid)};

function fail(msg: string) {
  const pre = document.createElement('pre');
  pre.style.cssText = 'position:fixed;inset:0;margin:0;padding:24px;background:#1a1a1f;color:#ff8a8a;font:13px/1.5 ui-monospace,monospace;white-space:pre-wrap;z-index:99999';
  const insecure = location.protocol === 'http:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1';
  pre.textContent = (insecure
    ? '\\u26a0 WebGPU requires a secure context. Open over http://localhost (use ./serve.sh) or https.\\n\\n'
    : '') + msg;
  document.body.appendChild(pre);
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
  const app = await createApp(
    canvas,
    PHYSICS ? { physics: PHYSICS } : {},
    { shaderManifestUrl: './shaders/manifest.json' },
  );
  if (!app.ok) { fail('createApp failed: ' + String(app.error)); return; }
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
        roots: packRoots,
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
