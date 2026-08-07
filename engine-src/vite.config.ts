import { defineConfig } from 'vite';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { forgeaxShader } from '@forgeax/engine-vite-plugin-shader';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import {
  createRuntimeScopeController,
  type RuntimeScopeCommand,
} from './src/runtime-scope-controller';

const here = dirname(fileURLToPath(import.meta.url));
const viteRoot = here;

// This host accepts one game directory supplied by the launcher or the server.
// It never scans a parent games directory. `host-games/<gameId>` is only the
// browser-visible mount for that one exact directory.
const GAME_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const GAMES_URL_PREFIX = process.env.FORGEAX_GAMES_URL_PREFIX ?? 'host-games';
const INITIAL_GAME_DIR = process.env.FORGEAX_GAME_DIR
  ? resolve(process.env.FORGEAX_GAME_DIR)
  : '';
const INITIAL_GAME_ID = process.env.FORGEAX_GAME_ID
  ?? (INITIAL_GAME_DIR ? basename(INITIAL_GAME_DIR) : '');
const RUNTIME_SCOPE_SECRET = process.env.FORGEAX_RUNTIME_SCOPE_SECRET;
const INITIAL_SCOPE_ID = process.env.FORGEAX_RUNTIME_SCOPE_ID ?? INITIAL_GAME_ID;
const INITIAL_GENERATION = Number(process.env.FORGEAX_RUNTIME_GENERATION ?? 1);

if (INITIAL_GAME_DIR && !GAME_ID_RE.test(INITIAL_GAME_ID)) {
  throw new Error(`invalid FORGEAX_GAME_ID: ${INITIAL_GAME_ID}`);
}

function gameUrlBase(base: string, gameId: string): string {
  const prefix = base.replace(/\/$/, '');
  return `${prefix}/${GAMES_URL_PREFIX}/${gameId}`;
}

function forgeaxWorkspacePackages(): string[] {
  const out = new Set<string>(['@forgeax/scene']);
  try {
    for (const name of readdirSync(resolve(here, 'node_modules/@forgeax'))) {
      out.add(`@forgeax/${name}`);
    }
  } catch {
    // Dependencies may be materialised by the Studio carrier later.
  }
  return [...out];
}

const FORGEAX_WS_PKGS = forgeaxWorkspacePackages();
const PORT = Number(process.env.FORGEAX_ENGINE_PORT ?? 15173);
const HOST = process.env.FORGEAX_ENGINE_HOST ?? '0.0.0.0';

function forgeaxShaderBaseStrip() {
  return {
    name: 'forgeax:shader-base-strip',
    configureServer(server: { middlewares: { use(fn: Function): unknown } }) {
      server.middlewares.use((req: { url?: string }, _res: unknown, next: () => void) => {
        if (req.url === '/preview/shaders/manifest.json') req.url = '/shaders/manifest.json';
        next();
      });
    },
  };
}

// Scoped Pack routes are mounted under `/preview/` in the browser but the
// producer middleware consumes the route without the Vite base prefix. There
// is intentionally no strip for `/pack-index.json`: unbound dev producers do
// not expose a global asset route.
function forgeaxPackBaseStrip() {
  const prefixes = ['/__pack/'];
  return {
    name: 'forgeax:pack-base-strip',
    configureServer(server: { middlewares: { use(fn: Function): unknown } }) {
      server.middlewares.use((req: { url?: string }, _res: unknown, next: () => void) => {
        const url = req.url;
        if (url) {
          for (const prefix of prefixes) {
            if (url === `/preview${prefix}` || url.startsWith(`/preview${prefix}`)) {
              req.url = url.slice('/preview'.length);
              break;
            }
          }
        }
        next();
      });
    },
  };
}

let mountedGameLink: string | undefined;

/** Mount exactly one game below the Vite root for source and pack URLs. */
function setupSingleGameRootFarm(gameDir: string, gameId: string): void {
  const targetPath = resolve(gameDir);
  if (!existsSync(targetPath) || !lstatSync(targetPath).isDirectory()) {
    throw new Error(`active game directory does not exist: ${targetPath}`);
  }
  const mountRoot = resolve(here, GAMES_URL_PREFIX);
  mkdirSync(mountRoot, { recursive: true });
  const linkPath = resolve(mountRoot, gameId);

  if (mountedGameLink !== undefined && mountedGameLink !== linkPath) {
    try {
      if (lstatSync(mountedGameLink).isSymbolicLink()) unlinkSync(mountedGameLink);
    } catch {
      // The previous exact mount may already be gone.
    }
  }

  try {
    const existing = lstatSync(linkPath);
    if (!existing.isSymbolicLink()) {
      throw new Error(`refusing to replace non-symlink active game mount: ${linkPath}`);
    }
    if (realpathSync(linkPath) === realpathSync(targetPath)) {
      mountedGameLink = linkPath;
      return;
    }
    unlinkSync(linkPath);
  } catch (error) {
    if (error instanceof Error && !error.message.includes('ENOENT')) throw error;
  }
  symlinkSync(targetPath, linkPath, 'junction');
  mountedGameLink = linkPath;
}

if (INITIAL_GAME_DIR) setupSingleGameRootFarm(INITIAL_GAME_DIR, INITIAL_GAME_ID);

/** Roots for the active game plus explicit product-owned shared assets. */
function singleGamePackRoots(gameDir: string, gameId: string): string[] {
  const roots = [
    gameDir ? resolve(here, GAMES_URL_PREFIX, gameId, 'assets') : '',
    gameDir ? resolve(here, GAMES_URL_PREFIX, gameId, 'scenes') : '',
    resolve(here, 'shared-assets'),
  ];
  return roots.filter((root, index) => root !== '' && existsSync(root) && roots.indexOf(root) === index);
}

function forgeaxRuntimeIdentity() {
  const instanceRootAbs = process.env.FORGEAX_PROJECT_ROOT
    ? resolve(process.env.FORGEAX_PROJECT_ROOT)
    : undefined;
  return {
    name: 'forgeax:runtime-identity',
    configureServer(server: { middlewares: { use(fn: Function): unknown } }) {
      server.middlewares.use((
        req: { url?: string },
        res: { statusCode: number; setHeader(name: string, value: string): void; end(body: string): void },
        next: () => void,
      ) => {
        if (req.url?.split('?')[0] !== '/preview/__forgeax_health') {
          next();
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'ok', name: '@forgeax/preview-runtime', instanceRootAbs }));
      });
    },
  };
}

const initialScopeCommand: RuntimeScopeCommand | undefined = (
  INITIAL_GAME_DIR
  && GAME_ID_RE.test(INITIAL_GAME_ID)
  && /^[a-zA-Z0-9._:-]{1,256}$/.test(INITIAL_SCOPE_ID)
  && Number.isSafeInteger(INITIAL_GENERATION)
  && INITIAL_GENERATION > 0
) ? {
  gameId: INITIAL_GAME_ID,
  scopeId: INITIAL_SCOPE_ID,
  generation: INITIAL_GENERATION,
  gameDir: INITIAL_GAME_DIR,
} : undefined;

const pack = pluginPack({
  roots: singleGamePackRoots(INITIAL_GAME_DIR, INITIAL_GAME_ID),
  base: '/preview/',
  importers: [imageImporter],
});

const runtimeScopeController = createRuntimeScopeController({
  pack,
  base: '/preview',
  secret: RUNTIME_SCOPE_SECRET,
  initial: initialScopeCommand,
  prepareGameMount: setupSingleGameRootFarm,
  resolveRoots: singleGamePackRoots,
});

function silenceShaderEmitInServe(plugin: any) {
  let isServe = false;
  const orig = plugin;
  return {
    ...orig,
    configResolved(config: { command: string }) {
      isServe = config.command === 'serve';
      if (typeof orig.configResolved === 'function') return orig.configResolved.call(this, config);
    },
    buildStart(this: any) {
      if (!isServe || typeof orig.buildStart !== 'function') return orig.buildStart?.call(this);
      const proxy = new Proxy(this, {
        get(target, prop) { return prop === 'emitFile' ? () => '' : (target as any)[prop]; },
      });
      return orig.buildStart.call(proxy);
    },
    transform(this: any, code: string, id: string) {
      if (typeof orig.transform !== 'function') return undefined;
      if (!isServe) return orig.transform.call(this, code, id);
      const proxy = new Proxy(this, {
        get(target, prop) { return prop === 'emitFile' ? () => '' : (target as any)[prop]; },
      });
      return orig.transform.call(proxy, code, id);
    },
  };
}

export default defineConfig({
  root: viteRoot,
  base: '/preview/',
  cacheDir: resolve(here, '.vite'),
  publicDir: resolve(here, 'public'),
  define: {
    __FORGEAX_GAMES_URL_PREFIX__: JSON.stringify(GAMES_URL_PREFIX),
  },
  plugins: [
    forgeaxShaderBaseStrip() as never,
    forgeaxPackBaseStrip() as never,
    forgeaxRuntimeIdentity() as never,
    pack as never,
    runtimeScopeController as never,
    silenceShaderEmitInServe(forgeaxShader()) as never,
  ],
  optimizeDeps: {
    exclude: FORGEAX_WS_PKGS,
  },
  resolve: {
    alias: { '@forgeax/game-types': resolve(here, 'src/types.ts') },
    dedupe: FORGEAX_WS_PKGS,
    preserveSymlinks: true,
  },
  server: {
    port: PORT,
    host: HOST,
    strictPort: true,
    open: false,
    watch: {
      usePolling: true,
      interval: 1000,
      ignored: [
        '**/.forgeax/agenteam-state/**',
        '**/.forgeax/cache/**',
        '**/.forgeax/packs/**',
        '**/node_modules/**',
        '**/dist/**',
        '**/.git/**',
        '**/.vite/**',
      ],
    },
    fs: {
      allow: [viteRoot, ...(INITIAL_GAME_DIR ? [INITIAL_GAME_DIR] : [])],
      strict: false,
    },
    hmr: {
      clientPort: Number(
        process.env.FORGEAX_HMR_CLIENT_PORT ?? process.env.FORGEAX_INTERFACE_PORT ?? 18920,
      ),
    },
  },
  build: {
    target: 'esnext',
    outDir: resolve(here, 'dist'),
  },
});
