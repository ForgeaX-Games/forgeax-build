// Recipe: forgeax-interface -> output/apps/interface/
//
// - whitelist copy (excludes node_modules, .git, .png design refs)
// - rename package.json: name -> @forgeax/interface
// - rewrite vite.config.ts so server can override port/host via env

import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecipeContext } from '../scripts/orchestrate';

const COPY_LIST = [
  'src',
  'public',
  'index.html',
  'package.json',
  'tsconfig.json',
  'README.md',
  'bun.lock',
  '.gitignore',
];

// Skip dev-time directories AND only the top-level design-reference PNGs
// (interface-files.png / interface-preview.png / sub-agent-switcher.png) —
// keep src/assets/**/*.png which are real runtime UI assets.
const SKIP_RX = /(?:^|[\\/])(?:node_modules|\.git|dist|\.cache|\.forgeax)(?:[\\/]|$)|(?:^|[\\/])(?:interface-files|interface-preview|sub-agent-switcher)\.png$/;

const VITE_CONFIG = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Port/host default to MISSION.md §6 constants but server can override at spawn time.
const PORT = Number(process.env.FORGEAX_INTERFACE_PORT ?? 18920);
const HOST = process.env.FORGEAX_INTERFACE_HOST ?? '0.0.0.0';
const SERVER = process.env.FORGEAX_SERVER_URL ?? 'http://127.0.0.1:18900';
const SERVER_WS = SERVER.replace(/^http/, 'ws');

export default defineConfig({
  plugins: [react()],
  server: {
    port: PORT,
    host: HOST,
    strictPort: true,
    open: false,
    // Polling stays ON here (unlike the dev interface/editor configs which use
    // native FSEvents). This config ships in the PUBLIC release monorepo and is
    // run by downloaded forgeax instances in unknown/diverse environments
    // (Docker bind-mounts, WSL, network drives) where native file events
    // silently don't fire — polling keeps HMR working everywhere. The dev
    // stack (packages/interface) is local macOS, so it can safely go native.
    // interval 1000ms (not 300) — this poller is always-on regardless of edits,
    // so the relaxed rate cuts idle CPU ~2/3 for release users; the extra HMR
    // latency is irrelevant since end-users rarely edit the interface source.
    watch: { usePolling: true, interval: 1000 },
    proxy: {
      '/api': { target: SERVER, changeOrigin: true },
      '/ws': { target: SERVER_WS, ws: true, changeOrigin: true },
    },
  },
});
`;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const recipe = async (ctx: RecipeContext) => {
  if (!ctx.source.repo) {
    throw new Error('recipe[interface] requires a non-null repo in sources.yaml');
  }
  const sourceDir = join(ctx.localRoot, ctx.source.repo);
  const targetDir = join(ctx.output, ctx.source.target);

  if (!(await exists(sourceDir))) {
    throw new Error(`recipe[interface] source dir missing: ${sourceDir}`);
  }
  await mkdir(targetDir, { recursive: true });

  let copied = 0;
  for (const item of COPY_LIST) {
    const src = join(sourceDir, item);
    const dst = join(targetDir, item);
    if (!(await exists(src))) {
      console.warn(`  [skip] ${item} not present in source`);
      continue;
    }
    await cp(src, dst, {
      recursive: true,
      errorOnExist: false,
      force: true,
      filter: (path) => !SKIP_RX.test(path),
    });
    console.log(`  + ${item}`);
    copied++;
  }

  const pkgPath = join(targetDir, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  pkg.name = '@forgeax/interface';
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log('  normalized package.json name -> @forgeax/interface');

  await writeFile(join(targetDir, 'vite.config.ts'), VITE_CONFIG);
  console.log('  rewrote vite.config.ts (env-driven port/host)');

  console.log(`  recipe[interface] done (${copied} items)`);
};

export default recipe;
