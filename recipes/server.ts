// Recipe: forgeax-server -> output/apps/server/
//
// Strategy: copy a fixed allowlist of files/dirs from the local source repo
// to the build output. Excludes node_modules, .git, dist (those are either
// runtime install or local-only).

import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecipeContext } from '../scripts/orchestrate';

const COPY_LIST = [
  'src',
  'bin',
  'package.json',
  'tsconfig.json',
  'README.md',
  'bun.lock',
  '.gitignore',
];

const SKIP_RX = /(?:^|[\\/])(?:node_modules|\.git|dist|\.cache|\.forgeax)(?:[\\/]|$)/;

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
    throw new Error('recipe[server] requires a non-null repo in sources.yaml');
  }
  const sourceDir = join(ctx.localRoot, ctx.source.repo);
  const targetDir = join(ctx.output, ctx.source.target);

  if (!(await exists(sourceDir))) {
    throw new Error(`recipe[server] source dir missing: ${sourceDir}`);
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
  if (pkg.name !== '@forgeax/server') {
    pkg.name = '@forgeax/server';
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log('  normalized package.json name -> @forgeax/server');
  }

  console.log(`  recipe[server] done (${copied} items)`);
};

export default recipe;
