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
//   pack-index.json         per-game asset catalog with RELATIVE urls
//   serve.sh, README.md     how to run it locally
//
// Approach: a generated entry statically imports the game's entry module (so
// the game is bundled at build time, not fetched/transpiled at runtime), pins
// base './' and relative shader + pack-index urls. Assets are shipped raw and
// catalogued with relative urls — exactly what the dev preview serves — so the
// runtime decodes them client-side (no prod texture-cook step needed).
import { build } from 'vite';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync, cpSync, chmodSync,
} from 'node:fs';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { buildPerGameCatalog } from '../pack-catalog.ts';

const here = dirname(fileURLToPath(import.meta.url)); // .../engine-src/export
const engineSrc = resolve(here, '..');                // .../engine-src

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

const gameDir = resolve(engineSrc, '.forgeax/games', slug);
if (!existsSync(gameDir)) {
  console.error(`game not found: ${gameDir}`);
  process.exit(2);
}
const gameAssets = join(gameDir, 'assets');

let forge: { entry?: string; name?: string } = {};
try { forge = JSON.parse(readFileSync(join(gameDir, 'forge.json'), 'utf8')); } catch { /* defaults */ }
const entryRel = (forge.entry ?? 'main.ts').replace(/^\.?\//, '');
const gameName = String(forge.name ?? slug);

// ── Generate the standalone entry + html at the engine root so the emitted
// index.html lands at <outDir> root (Vite keeps html paths relative to root). ──
const genHtmlName = '.export-gen.index.html';
const genEntryName = '.export-gen.main.ts';
const genHtml = join(engineSrc, genHtmlName);
const genEntry = join(engineSrc, genEntryName);
const gameEntryImport = `./.forgeax/games/${slug}/${entryRel}`;

const entrySrc = `import { createApp, loadGame } from '@forgeax/engine-app';
import gameEntry from ${JSON.stringify(gameEntryImport)};

const SLUG = ${JSON.stringify(slug)};

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

  const app = await createApp(canvas, { shaderManifestUrl: './shaders/manifest.json' });
  if (!app.ok) { fail('createApp failed: ' + String(app.error)); return; }
  const { world, renderer } = app.value;

  renderer.assets.configurePackIndex('./pack-index.json');

  window.addEventListener('resize', () => {
    const d = Math.min(window.devicePixelRatio, 2);
    canvas.width = window.innerWidth * d;
    canvas.height = window.innerHeight * d;
  });

  const ctx = {
    world,
    renderer,
    assets: renderer.assets,
    app: app.value,
    registerUpdate(fn: (dt: number) => void) { app.value.registerUpdate(fn); },
  };

  const res = await loadGame(SLUG, async () => ({ default: gameEntry }));
  if (!res.ok) { fail('loadGame failed: ' + JSON.stringify(res.error)); return; }
  await res.value(ctx as never);
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
  await build({
    root: engineSrc,
    base: './',
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    plugins: [forgeaxShader() as never],
    resolve: {
      alias: { '@forgeax/game-types': resolve(engineSrc, 'src/types.ts') },
      dedupe: [
        '@forgeax/engine-runtime',
        '@forgeax/engine-ecs',
        '@forgeax/engine-types',
        '@forgeax/engine-rhi',
        '@forgeax/engine-math',
      ],
      preserveSymlinks: true,
    },
    build: {
      outDir,
      emptyOutDir: true,
      target: 'esnext',
      rollupOptions: { input: genHtml },
    },
  });
} finally {
  cleanupGen();
}

// ── Relocate emitted html to <outDir>/index.html (assets are base-relative so
// they keep resolving from the same directory). ──
const emittedHtml = join(outDir, genHtmlName);
if (existsSync(emittedHtml)) renameSync(emittedHtml, join(outDir, 'index.html'));

// ── Ship raw assets + a relative per-game pack-index (mirrors dev preview). ──
if (existsSync(gameAssets)) {
  cpSync(gameAssets, join(outDir, 'game-assets'), { recursive: true });
}
let catalog: Array<{ guid: string; relativeUrl: string; kind: string; sourcePath?: string }> = [];
try {
  catalog = existsSync(gameAssets) ? await buildPerGameCatalog(gameAssets) : [];
} catch (e) {
  console.warn('[export] pack catalog build failed:', e instanceof Error ? e.message : String(e));
}
const rebased = catalog.map((e) => {
  const parts = (e.sourcePath ?? e.relativeUrl).split('/assets/');
  const rel = parts.length > 1 ? parts[parts.length - 1] : (e.relativeUrl.split('/').pop() ?? '');
  return { guid: e.guid, relativeUrl: `./game-assets/${rel}`, kind: e.kind };
});
writeFileSync(join(outDir, 'pack-index.json'), JSON.stringify(rebased));

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
| \`pack-index.json\` | asset catalog (relative urls) |
`;
writeFileSync(join(outDir, 'README.md'), readme);

console.log(`[export] done: ${outDir}`);
