// Validator: tsc --noEmit in every output subdir that has a tsconfig.json.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ValidatorContext } from '../scripts/validate';

// harness has no tsconfig (markdown/JSON only). Other dirs all do.
const SKIP_NAMES = new Set<string>(['harness']);

async function run(cwd: string, cmd: string[]): Promise<number> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
  return await proc.exited;
}

const validator = async (ctx: ValidatorContext) => {
  // Post v2 flat layout: cli/server/interface/engine/harness sit directly
  // under ctx.output, not under apps/ or packages/.
  const dirs: string[] = [];
  for (const sub of readdirSync(ctx.output)) {
    if (SKIP_NAMES.has(sub)) continue;
    const dir = join(ctx.output, sub);
    if (existsSync(join(dir, 'tsconfig.json'))) dirs.push(dir);
  }
  console.log(`  tsc --noEmit in ${dirs.length} subdirs`);
  for (const d of dirs) {
    const rel = d.replace(ctx.output, 'output');
    console.log(`    ${rel}`);
    const code = await run(d, ['bunx', '--bun', 'tsc', '--noEmit']);
    if (code !== 0) throw new Error(`tsc failed in ${rel} (exit ${code})`);
  }
};

export default validator;
