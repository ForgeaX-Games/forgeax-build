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

// Injected into the served HTML entry's <head>:
//  - <meta name="google" content="notranslate"> is the page-level opt-out that
//    Chromium/Edge translate both honor. We inject it here (rather than relying
//    on command-line flags like --disable-features=Translate, which Edge's own
//    translate implementation ignores) so the "translate this page?" prompt
//    never appears, regardless of which browser/profile shows the window.
//  - the keep-alive ping lets the launcher tell whether the game window is still
//    open — decoupled from the spawned browser process, whose foreground handle
//    exits early on Windows (Chromium hands the window off to a detached
//    process), which would otherwise tear down the server.
const HEAD_INJECT =
  `<meta name="google" content="notranslate">` +
  `<script>(function(){function p(){fetch('/__ping').catch(function(){})}p();setInterval(p,1500)}())</script>`;

let lastPing = 0;
const startTime = Date.now();

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    let pathname = decodeURIComponent(url.pathname);

    // Keep-alive heartbeat from the injected client script.
    if (pathname === '/__ping') {
      lastPing = Date.now();
      return new Response(null, { status: 204 });
    }

    if (pathname === '/') pathname = '/index.html';

    const filePath = join(webRoot, pathname);
    if (!filePath.startsWith(webRoot)) {
      return new Response('Forbidden', { status: 403 });
    }

    const file = Bun.file(filePath);
    if (!(await file.exists())) {
      return new Response('Not Found', { status: 404 });
    }

    // Inject the notranslate meta + keep-alive ping into the HTML entry. We also
    // force the document language to match the content so the browser never
    // detects a foreign-language page worth offering to translate.
    if (pathname === '/index.html') {
      const html = await file.text();
      let patched = html.includes('</head>')
        ? html.replace('</head>', `${HEAD_INJECT}</head>`)
        : `${HEAD_INJECT}${html}`;
      patched = patched.replace(/<html(?![^>]*\blang=)/i, '<html lang="en" translate="no"');
      return new Response(patched, { headers: { 'Content-Type': 'text/html' } });
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
  // Fire-and-forget: do NOT tie the server lifetime to this process. On Windows
  // the foreground msedge/chrome process hands the window to a detached process
  // and exits immediately, so awaiting its exit would stop the server while the
  // visible window is still loading (→ ERR_CONNECTION_REFUSED).
  Bun.spawn({
    cmd: [
      browserExe,
      `--app=${gameUrl}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,800',
      // Belt-and-suspenders against the "translate this page?" prompt. The real
      // fix is the injected <meta name="google" content="notranslate"> (Edge's
      // own translate ignores --disable-features=Translate), but these are
      // harmless and cover the Chromium translate UI on Chrome.
      '--disable-translate',
      '--disable-features=Translate',
      '--lang=en-US',
    ],
    stdout: 'ignore',
    stderr: 'ignore',
  });
} else {
  await fallbackDefaultBrowser();
  console.log(`[forgeax-player] server running. Visit ${gameUrl} — close this process to stop.`);
}

// Lifetime is governed by the injected keep-alive heartbeat, not the spawned
// browser process. While the game window is open the page pings /__ping; once
// the window closes the pings stop and the launcher shuts the server down and
// exits — so nothing lingers in the background.
const IDLE_MS = 8000; // window considered closed after this gap once it has pinged
const NO_PING_GRACE_MS = 60000; // give the browser this long to cold-start + load
const timer = setInterval(() => {
  const now = Date.now();
  const pinged = lastPing > 0;
  if ((pinged && now - lastPing > IDLE_MS) || (!pinged && now - startTime > NO_PING_GRACE_MS)) {
    clearInterval(timer);
    try { server.stop(true); } catch { /* ignore */ }
    process.exit(0);
  }
}, 2000);
