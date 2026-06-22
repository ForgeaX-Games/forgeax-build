// Build orchestrator entry. Loads config/sources.yaml, then runs each
// recipe (recipes/<name>.ts) in the listed order.
//
// MVP: recipes are filled progressively (STEP 13-17). Missing recipes log
// a warning but do not fail the build, so the skeleton is testable
// before all recipes land.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import yaml from 'js-yaml';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const WORKSPACE = join(ROOT, 'workspace');
const OUTPUT = join(ROOT, 'output');

interface SourceEntry {
  name: string;
  repo: string | null;
  recipe: string;
  target: string;
  description?: string;
  fallback_template?: string;
}

interface SourcesConfig {
  version: string;
  local_root: string;
  sources: SourceEntry[];
}

export interface RecipeContext {
  root: string;       // build orchestrator root
  workspace: string;  // workspace/
  output: string;     // output/
  localRoot: string;  // resolved local source root
  source: SourceEntry;
}

export type Recipe = (ctx: RecipeContext) => Promise<void>;

function loadConfig(): SourcesConfig {
  const text = readFileSync(join(ROOT, 'config', 'sources.yaml'), 'utf8');
  const cfg = yaml.load(text) as SourcesConfig;
  if (!cfg?.sources) throw new Error('sources.yaml missing `sources`');
  return cfg;
}

async function loadRecipe(name: string): Promise<Recipe | null> {
  const path = join(ROOT, 'recipes', `${name}.ts`);
  if (!existsSync(path)) return null;
  const mod = (await import(path)) as { default?: Recipe; recipe?: Recipe };
  return mod.default ?? mod.recipe ?? null;
}

async function main() {
  const mode = process.argv[2] ?? 'release-source';
  if (mode !== 'release-source') {
    console.error(`unknown orchestrate mode: ${mode}`);
    process.exit(1);
  }

  const cfg = loadConfig();
  const localRoot = resolve(ROOT, cfg.local_root);

  console.log(`[orchestrate] config v${cfg.version}, ${cfg.sources.length} sources`);
  console.log(`[orchestrate] local_root = ${localRoot}`);
  console.log(`[orchestrate] output    = ${OUTPUT}`);
  console.log('');

  let ran = 0;
  let skipped = 0;
  for (const src of cfg.sources) {
    const recipe = await loadRecipe(src.recipe);
    if (!recipe) {
      console.warn(
        `[orchestrate] [SKIP] ${src.name} -> recipes/${src.recipe}.ts not implemented yet`,
      );
      skipped++;
      continue;
    }
    console.log(`[orchestrate] [RUN]  ${src.name} -> ${src.target}`);
    await recipe({ root: ROOT, workspace: WORKSPACE, output: OUTPUT, localRoot, source: src });
    ran++;
  }

  console.log('');
  console.log(`[orchestrate] done. ran=${ran} skipped=${skipped}`);
}

main().catch((e) => {
  console.error('[orchestrate] FAILED:', e);
  process.exit(1);
});
