// Validator runner. Loads each validator under validators/ and runs them
// against output/. Filled in STEP 18.

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const OUTPUT = join(ROOT, 'output');

export interface ValidatorContext {
  root: string;
  output: string;
}

export type Validator = (ctx: ValidatorContext) => Promise<void>;

async function main() {
  if (!existsSync(OUTPUT)) {
    console.error(`[validate] no output/ at ${OUTPUT}`);
    process.exit(1);
  }
  const dir = join(ROOT, 'validators');
  if (!existsSync(dir)) {
    console.warn('[validate] no validators/ dir; nothing to do');
    return;
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  console.log(`[validate] ${files.length} validators found`);

  let pass = 0;
  let fail = 0;
  for (const f of files) {
    const name = f.replace(/\.ts$/, '');
    const mod = (await import(join(dir, f))) as { default?: Validator; validator?: Validator };
    const v = mod.default ?? mod.validator;
    if (!v) {
      console.warn(`[validate] [SKIP] ${name} (no default export)`);
      continue;
    }
    try {
      console.log(`[validate] [RUN] ${name}`);
      await v({ root: ROOT, output: OUTPUT });
      console.log(`[validate] [OK]  ${name}`);
      pass++;
    } catch (e) {
      console.error(`[validate] [FAIL] ${name}:`, (e as Error).message);
      fail++;
    }
  }

  console.log(`[validate] done. pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('[validate] FAILED:', e);
  process.exit(1);
});
