/**
 * ForgeaX Player Launcher — universal Windows game launcher.
 *
 * Compiled via `bun build --compile` into a standalone exe. At runtime:
 *   1. Locates `_web/` next to the exe.
 *   2. Starts Bun.serve on 127.0.0.1 (random port) — secure context for WebGPU.
 *   3. Opens Edge/Chrome in `--app` mode (no address bar, app-window feel).
 *
 * One compiled exe is reused across all games; the window title comes from
 * the HTML `<title>` inside `_web/index.html`.
 */

import { resolve, join, extname } from 'node:path';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const MIME_MAP: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.wgsl': 'text/plain',
  '.glsl': 'text/plain',
  '.txt': 'text/plain',
  '.md': 'text/plain',
};

function mimeFor(path: string): string {
  return MIME_MAP[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

const exeDir = typeof Bun !== 'undefined' && process.execPath
  ? resolve(process.execPath, '..')
  : resolve(import.meta.dir);

const webRoot = resolve(exeDir, '_web');

if (!existsSync(webRoot)) {
  console.error(`[forgeax-player] _web/ directory not found next to the executable.`);
  console.error(`  Expected at: ${webRoot}`);
  console.error(`  Make sure _web/ containing index.html sits beside this exe.`);
  process.exit(1);
}

let configTitle = 'ForgeaX Game';
try {
  const cfgPath = join(exeDir, 'forgeax-player.json');
  if (existsSync(cfgPath)) {
    const cfg = JSON.parse(await Bun.file(cfgPath).text()) as { title?: string };
    if (cfg.title) configTitle = cfg.title;
  }
} catch { /* ignore */ }

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';

    const filePath = join(webRoot, pathname);
    if (!filePath.startsWith(webRoot)) {
      return new Response('Forbidden', { status: 403 });
    }

    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return new Response('Not Found', { status: 404 });
    }

    return new Response(file, {
      headers: { 'Content-Type': mimeFor(filePath) },
    });
  },
});

const gameUrl = `http://127.0.0.1:${server.port}`;
console.log(`[forgeax-player] serving ${configTitle} at ${gameUrl}`);

/**
 * Locate a real Chromium-based browser executable. We probe absolute install
 * paths instead of relying on PATH/exitCode heuristics — the previous approach
 * misfired when Edge was already running (the spawned `--app` process delegates
 * to the existing instance and exits, which looked like a failure and fell back
 * to a full default-browser window).
 */
function findBrowserExe(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] ?? '';
  const candidates = [
    join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local ? join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
  ].filter(Boolean);
  return candidates.find((p) => existsSync(p));
}

async function fallbackDefaultBrowser(): Promise<void> {
  try {
    if (process.platform === 'win32') {
      Bun.spawn({ cmd: ['cmd', '/c', 'start', '', gameUrl], stdout: 'ignore', stderr: 'ignore' });
    } else if (process.platform === 'darwin') {
      Bun.spawn({ cmd: ['open', gameUrl], stdout: 'ignore', stderr: 'ignore' });
    } else {
      Bun.spawn({ cmd: ['xdg-open', gameUrl], stdout: 'ignore', stderr: 'ignore' });
    }
    console.log(`[forgeax-player] opened in default browser`);
  } catch {
    console.log(`[forgeax-player] could not open browser — visit ${gameUrl} manually`);
  }
}

const browserExe = findBrowserExe();
if (browserExe) {
  // A dedicated --user-data-dir forces a brand-new, isolated app window instead
  // of merging into the user's already-running browser (which would surface a
  // full window with an address bar). --app gives the chromeless app feel.
  const profileDir = join(tmpdir(), `forgeax-player-${process.pid}`);
  console.log(`[forgeax-player] opening app window via ${browserExe}`);
  const proc = Bun.spawn({
    cmd: [
      browserExe,
      `--app=${gameUrl}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,800',
    ],
    stdout: 'ignore',
    stderr: 'ignore',
  });
  // When the player closes the game window, the dedicated browser instance
  // exits — shut the local server down too so nothing lingers in the background.
  await proc.exited;
  try { server.stop(true); } catch { /* ignore */ }
  process.exit(0);
} else {
  await fallbackDefaultBrowser();
  console.log(`[forgeax-player] server running. Visit ${gameUrl} — close this process to stop.`);
}
