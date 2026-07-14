// build-reel-standalone.ts — package a single .forgeax/games/<slug> interactive
// film-game (wb-reel) into a self-contained static site that plays in any modern
// browser with NO studio server and NO WebGPU.
//
//   bun reel-src/export/build-reel-standalone.ts <slug> <outDir> [projectRoot]
//
// What it produces in <outDir>:
//   index.html              wb-reel player (auto-boots ?surface=player&src=pack)
//   assets/*.js,*.css       the bundled wb-reel React app (Vite)
//   reel-game.pack.json     the reel-game asset document (internal-text-package)
//   reel-media/<hash>.<ext> co-located media files
//   pack-index.json         single-entry catalog → reel-game.pack.json
//   serve.sh, README.md     how to run it locally
//
// Approach: first run build-reel-asset (P2.3) to emit the reel-game asset +
// media into the game dir, then Vite-build the wb-reel app (reusing its own
// vite.config) with base './' and an injected redirect so the static index
// auto-enters player + pack-source mode. The player reads the scenario from the
// co-located pack-index — no GPU device, no dev server.
import type { Plugin } from 'vite';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import {
  writeFileSync,
  readFileSync,
  existsSync,
  cpSync,
  chmodSync,
} from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url)); // .../build/reel-src/export
const wbReelDir = resolve(here, '../../../marketplace/extensions/wb-reel');

// reel-src has no node_modules of its own — resolve vite from the wb-reel
// package (which depends on it) so this script runs without a local install.
const require = createRequire(import.meta.url);
const vitePath = require.resolve('vite', { paths: [wbReelDir] });
const { build } = (await import(pathToFileURL(vitePath).href)) as typeof import('vite');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

function fail(msg: string): never {
  console.error(`[reel-standalone] ${msg}`);
  process.exit(2);
}

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

const slug = process.argv[2];
const outDir = process.argv[3];
const projectRootArg = process.argv[4];
if (!slug || !SLUG_RE.test(slug)) fail(`usage: bun build-reel-standalone.ts <slug> <outDir> [projectRoot]  (bad slug: ${slug})`);
if (!outDir) fail('usage: bun build-reel-standalone.ts <slug> <outDir> [projectRoot]  (missing outDir)');

const projectRoot = projectRootArg ?? findProjectRoot(here) ?? process.cwd();
const gameDir = resolve(projectRoot, '.forgeax/games', slug);
if (!existsSync(gameDir)) fail(`game not found: ${gameDir}`);

// ── 1) Emit the reel-game asset + media into the game dir (P2.3). ──
console.log(`[reel-standalone] building reel-game asset for "${slug}"…`);
const assetProc = Bun.spawn({
  cmd: [process.execPath || 'bun', resolve(here, 'build-reel-asset.ts'), slug, projectRoot],
  stdout: 'inherit',
  stderr: 'inherit',
});
const assetCode = await assetProc.exited;
if (assetCode !== 0) fail(`build-reel-asset failed (exit ${assetCode})`);

const packPath = join(gameDir, 'assets', 'reel-game.pack.json');
if (!existsSync(packPath)) fail(`reel-game.pack.json not produced at ${packPath}`);
const packJson = JSON.parse(readFileSync(packPath, 'utf-8')) as {
  assets: Array<{ guid: string; kind: string }>;
};
const guid = packJson.assets[0]?.guid;
if (!guid) fail('reel-game.pack.json has no asset guid');

// ── 2) Vite-build the wb-reel app with base './' + auto-player-boot redirect. ──
const playerBootPlugin: Plugin = {
  name: 'reel-standalone-player-boot',
  // Inject a tiny redirect so opening the static index lands in player + pack
  // mode without the user appending query params by hand.
  transformIndexHtml(html) {
    const redirect =
      `<script>(function(){try{var u=new URL(location.href);` +
      `if(u.searchParams.get('surface')!=='player'||u.searchParams.get('src')!=='pack'){` +
      `u.searchParams.set('surface','player');u.searchParams.set('src','pack');` +
      `location.replace(u.toString());}}catch(e){}})();</script>`;
    return html.replace('</head>', `${redirect}</head>`);
  },
};

console.log(`[reel-standalone] vite build → ${outDir}`);
await build({
  root: wbReelDir,
  base: './',
  configFile: resolve(wbReelDir, 'vite.config.ts'),
  mode: 'production',
  logLevel: 'warn',
  plugins: [playerBootPlugin],
  build: {
    outDir: resolve(outDir),
    emptyOutDir: true,
    sourcemap: false,
  },
});

// ── 3) Ship the reel-game asset + media + a single-entry pack-index. ──
const assetsSrc = join(gameDir, 'assets');
cpSync(packPath, join(outDir, 'reel-game.pack.json'));
const mediaSrc = join(assetsSrc, 'reel-media');
if (existsSync(mediaSrc)) cpSync(mediaSrc, join(outDir, 'reel-media'), { recursive: true });
writeFileSync(
  join(outDir, 'pack-index.json'),
  JSON.stringify([{ guid, kind: 'reel-game', relativeUrl: './reel-game.pack.json' }]),
);

// ── 4) serve.sh + README (no WebGPU caveat — reel runs on any modern browser). ──
const serveSh = `#!/usr/bin/env bash
# Serve this standalone interactive film-game on http://localhost:8123
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

const readme = `# ${slug} — standalone interactive film-game

A self-contained build of the \`${slug}\` interactive film-game (影游). It runs
entirely in the browser with no studio server.

## Run it

\`\`\`bash
./serve.sh            # serves http://localhost:8123
\`\`\`

Then open **http://localhost:8123** — it auto-enters the player.

> Unlike 3D engine games, this needs **no WebGPU** — any modern browser works.
> Opening \`index.html\` as a bare \`file://\` may not work because the player
> fetches \`pack-index.json\`; serve it over http (use \`./serve.sh\`).

## Contents

| path | what |
|------|------|
| \`index.html\`           | player entry (auto \`?surface=player&src=pack\`) |
| \`assets/\`              | bundled wb-reel player app (JS/CSS) |
| \`reel-game.pack.json\`  | the reel-game asset document |
| \`reel-media/\`          | co-located media (images/video/audio) |
| \`pack-index.json\`      | asset catalog (relative urls) |
`;
writeFileSync(join(outDir, 'README.md'), readme);

console.log(`[reel-standalone] done: ${outDir}`);
