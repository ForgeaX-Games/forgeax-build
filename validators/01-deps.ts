// Validator: install deps for output/. Either workspace at root, or per-subdir.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ValidatorContext } from '../scripts/validate';

async function bunInstall(cwd: string): Promise<number> {
  const proc = Bun.spawn(['bun', 'install'], { cwd, stdout: 'inherit', stderr: 'inherit' });
  return await proc.exited;
}

const validator = async (ctx: ValidatorContext) => {
  const rootPkg = join(ctx.output, 'package.json');
  if (existsSync(rootPkg)) {
    const pkg = JSON.parse(readFileSync(rootPkg, 'utf8'));
    if (pkg.workspaces) {
      console.log('  workspace root: bun install at output/');
      const code = await bunInstall(ctx.output);
      if (code !== 0) throw new Error(`bun install at root failed (exit ${code})`);
      return;
    }
  }
  // Post v2 flat layout: cli/server/interface/engine/harness sit directly
  // under ctx.output, not under apps/ or packages/.
  const dirs: string[] = [];
  for (const sub of readdirSync(ctx.output)) {
    const dir = join(ctx.output, sub);
    if (existsSync(join(dir, 'package.json'))) dirs.push(dir);
  }
  console.log(`  no workspace yet; bun install across ${dirs.length} subdirs`);
  for (const d of dirs) {
    const rel = d.replace(ctx.output, 'output');
    console.log(`    - ${rel}`);
    const code = await bunInstall(d);
    if (code !== 0) throw new Error(`bun install ${rel} (exit ${code})`);
  }
};

export default validator;
