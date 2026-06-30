// Recipe: forgeax-cli (vendored forgeax-cli snapshot) -> output/apps/cli/
//
// Strategy: copy a fixed allowlist of files/dirs from the local source repo
// to the build output. Skip ui/ (we use forgeax-interface for the MVP),
// docker/ (deployment-specific upstream), tests/, docs/, node_modules,
// pnpm-lock.yaml (bun-first), and the dangerous delete.sh helper.

import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecipeContext } from '../scripts/orchestrate';

const COPY_LIST = [
  // sources
  'src',
  'bin',
  'capabilities',
  'templates',
  // configs
  'package.json',
  'tsconfig.json',
  'bun.lock',
  '.gitignore',
  '.gitmodules',
  // docs (forgeax-aware + upstream original side-by-side)
  'README.md',
  'UPSTREAM_AGENTEAM_README.md',
  'AGENTS.md',
  'AGENTIC.md',
  // boot helpers
  'start.sh',
];

const SKIP_RX = /(?:^|[\\/])(?:node_modules|\.git|dist|\.cache|\.forgeax|tests|docs|ui|docker)(?:[\\/]|$)/;

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
    throw new Error('recipe[cli] requires a non-null repo in sources.yaml');
  }
  const sourceDir = join(ctx.localRoot, ctx.source.repo);
  const targetDir = join(ctx.output, ctx.source.target);

  if (!(await exists(sourceDir))) {
    throw new Error(`recipe[cli] source dir missing: ${sourceDir}`);
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

  // Sanity: package.json name must be @forgeax/cli (set in STEP 03 already; defensive normalize).
  const pkgPath = join(targetDir, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  if (pkg.name !== '@forgeax/cli') {
    pkg.name = '@forgeax/cli';
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log('  normalized package.json name -> @forgeax/cli');
  }
  if (!pkg.private) {
    pkg.private = true;
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log('  set package.json private: true');
  }

  // D1 sanity: src/main.ts must exist (the daemon entry).
  const mainTsExists = await exists(join(targetDir, 'src', 'main.ts'));
  if (!mainTsExists) {
    throw new Error('recipe[cli] missing src/main.ts (daemon entry); aborted');
  }

  // D11 sanity: bin/agenteam must exist (the cli launcher).
  const binExists = await exists(join(targetDir, 'bin', 'agenteam'));
  if (!binExists) {
    throw new Error('recipe[cli] missing bin/agenteam (launcher); aborted');
  }

  console.log(`  ✓ src/main.ts + bin/agenteam present`);
  console.log(`  recipe[cli] done (${copied} top-level items)`);
};

export default recipe;
