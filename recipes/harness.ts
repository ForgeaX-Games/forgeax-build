// Recipe: forgeax-harness skills + schemas -> output/packages/harness/
//
// IRON RULE (MISSION §3): NO Python in forgeax output. We only vendor:
//   - skills/<name>/SKILL.md  (and any markdown/json siblings, NOT .py)
//   - schemas/*.json
//   - rules/*.md  (if present)
// We synthesize a tiny scripts/install.ts hook (TS, not Python) per SPEC.

import { mkdir, readdir, copyFile, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { RecipeContext } from '../scripts/orchestrate';

const VENDOR_EXT = new Set(['.md', '.json']);
const SKIP_DIR_RX = /(?:^|[\\/])(?:node_modules|\.git|__pycache__|\.venv|venv|dist|\.cache)(?:[\\/]|$)/;

const INSTALL_TS = `// forgeax-harness postinstall hook (TS, not Python).
// Currently a no-op placeholder — Vendor skills are loaded by the cli at startup.
// In the future this can: validate skill schemas, mount symlinks, register MCP servers.
console.log('[harness] install hook ok (no-op MVP)');
`;

const PKG_JSON = `{
  "name": "@forgeax/harness",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Vendored skills + schemas (markdown/JSON only, no python). Loaded by forgeax-cli.",
  "scripts": {
    "postinstall": "bun scripts/install.ts"
  }
}
`;

const README = `# @forgeax/harness

Vendored skill markdown + JSON schemas. Loaded by \`forgeax-cli\` at startup.

## Layout

\`\`\`
skills/<skill-id>/
├── SKILL.md           # required — the skill definition
└── *.md / *.json      # optional siblings (sub-docs, schemas)
schemas/*.json         # global schemas
\`\`\`

## Iron rule

**No Python lands here.** The upstream \`forgeax-harness\` repo has Python tooling for harness development; we vendor only the markdown/JSON outputs. See \`forgeax-dev-diary/2026-05-11/MISSION.md\` §3.
`;

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function vendorTreeShallow(srcDir: string, dstDir: string): Promise<number> {
  if (!(await exists(srcDir))) return 0;
  let count = 0;
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    if (SKIP_DIR_RX.test(e.name)) continue;
    const src = join(srcDir, e.name);
    const dst = join(dstDir, e.name);
    if (e.isDirectory()) {
      await mkdir(dst, { recursive: true });
      count += await vendorTreeShallow(src, dst);
    } else if (e.isFile()) {
      const ext = e.name.slice(e.name.lastIndexOf('.')).toLowerCase();
      if (!VENDOR_EXT.has(ext)) continue; // skip .py / .toml / .txt etc
      await mkdir(dirname(dst), { recursive: true });
      await copyFile(src, dst);
      count++;
    }
  }
  return count;
}

const recipe = async (ctx: RecipeContext) => {
  if (!ctx.source.repo) {
    throw new Error('recipe[harness] requires a non-null repo in sources.yaml');
  }
  const sourceDir = join(ctx.localRoot, ctx.source.repo);
  const targetDir = join(ctx.output, ctx.source.target);

  if (!(await exists(sourceDir))) {
    throw new Error(`recipe[harness] source dir missing: ${sourceDir}`);
  }
  await mkdir(join(targetDir, 'skills'), { recursive: true });
  await mkdir(join(targetDir, 'schemas'), { recursive: true });
  await mkdir(join(targetDir, 'scripts'), { recursive: true });

  const skillCount = await vendorTreeShallow(
    join(sourceDir, 'skills'),
    join(targetDir, 'skills'),
  );
  const schemaCount = await vendorTreeShallow(
    join(sourceDir, 'schemas'),
    join(targetDir, 'schemas'),
  );
  const ruleCount = await vendorTreeShallow(
    join(sourceDir, 'rules'),
    join(targetDir, 'rules'),
  );

  await writeFile(join(targetDir, 'package.json'), PKG_JSON);
  await writeFile(join(targetDir, 'README.md'), README);
  await writeFile(join(targetDir, 'scripts', 'install.ts'), INSTALL_TS);
  await writeFile(join(targetDir, '.gitignore'), 'node_modules/\n');

  // Sanity check: forgeax-playwright-loop must be present (D10).
  const playwrightSkillExists = await exists(
    join(targetDir, 'skills', 'forgeax-playwright-loop', 'SKILL.md'),
  );
  if (!playwrightSkillExists) {
    throw new Error(
      'recipe[harness] missing required skill forgeax-playwright-loop (MISSION D10). ' +
        'Add it to upstream harness/skills/forgeax-playwright-loop/SKILL.md before building.',
    );
  }

  console.log(`  + skills (${skillCount} files)`);
  console.log(`  + schemas (${schemaCount} files)`);
  console.log(`  + rules (${ruleCount} files)`);
  console.log('  + package.json + README.md + scripts/install.ts');
  console.log('  ✓ forgeax-playwright-loop present (D10 satisfied)');
  console.log(`  recipe[harness] done`);
};

export default recipe;
