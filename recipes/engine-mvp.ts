// Recipe: copy packages/build/engine-src/ -> output/engine/
//
// Engine source lives at packages/build/engine-src/ as real files (rather
// than string constants embedded in this recipe like before). This lets
// studio dev mode boot vite *directly* from engine-src/ without needing
// the build pipeline to run first, AND removes the dependency on
// packages/forgeax/engine/ for source-mode development.
//
// Two consumers of engine-src/:
//   1. studio scripts/run.sh: `cd packages/build/engine-src && bunx vite`
//      (engine-src has its own node_modules; bun install once via
//      scripts/bootstrap.sh)
//   2. this recipe: cp -r engine-src/ -> output/engine/ for release
//      pipeline. build.sh publish then rsyncs output/engine/ ->
//      packages/forgeax/engine/ as part of the release artifact.
//
// Layout under engine-src/:
//   index.html         (vite entry; script src=./src/main.ts, relative)
//   vite.config.ts     (root: '..', base: '/preview/', hmr: false)
//   src/main.ts        (GameContext bootstrap + VAG_PREVIEW/VAG_CONSOLE bridges)
//   src/types.ts       (GameContext / GameEntry types)
//   package.json       (three + vite deps)
//   tsconfig.json
//   README.md
//   .gitignore

import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RecipeContext } from '../scripts/orchestrate';

const recipe = async (ctx: RecipeContext) => {
  const sourceDir = join(ctx.root, 'engine-src');
  const targetDir = join(ctx.output, ctx.source.target);

  await mkdir(targetDir, { recursive: true });
  await cp(sourceDir, targetDir, {
    recursive: true,
    // Don't copy node_modules, .vite caches, or .forgeax (runtime symlink in
    // studio dev mode — not part of the release artifact).
    filter: (src) =>
      !/\/node_modules(\/|$)/.test(src) &&
      !/\/\.vite(\/|$)/.test(src) &&
      !/\/\.forgeax(\/|$)/.test(src),
  });

  console.log(`  + copied packages/build/engine-src/ -> ${ctx.source.target}/`);
  console.log('  recipe[engine-mvp] done (sourced from engine-src/, no template literals)');
};

export default recipe;
