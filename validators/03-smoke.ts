// Validator: boot the output server in standalone mode and confirm /api/health.
// MVP scope: smoke just the server (studio + engine boot is a STEP 26 concern,
// behind playwright). FORGEAX_NO_SPAWN=1 + FORGEAX_NO_WATCH=1 + cleared API key
// keep this hermetic and fast.

import { join } from 'node:path';
import type { ValidatorContext } from '../scripts/validate';

const SMOKE_PORT = 18909; // off the default 18900 to avoid conflicts during validate

async function fetchHealth(url: string, timeoutMs = 3500): Promise<unknown> {
  const start = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (e) {
      lastErr = e;
    }
    await Bun.sleep(120);
  }
  throw new Error(`no /api/health within ${timeoutMs}ms: ${(lastErr as Error)?.message ?? ''}`);
}

const validator = async (ctx: ValidatorContext) => {
  // Post v2 flat layout: server lives at output/server/, not output/apps/server/.
  const main = join(ctx.output, 'server', 'src', 'main.ts');
  const env = {
    ...process.env,
    FORGEAX_NO_SPAWN: '1',
    FORGEAX_NO_WATCH: '1',
    FORGEAX_PROJECT_ROOT: ctx.output,
    ANTHROPIC_API_KEY: '',
    FORGEAX_SERVER_PORT: String(SMOKE_PORT),
  };

  const proc = Bun.spawn(['bun', main], {
    env,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  try {
    const body = (await fetchHealth(`http://127.0.0.1:${SMOKE_PORT}/api/health`)) as {
      status?: string;
      name?: string;
      version?: string;
      projectRoot?: string;
    };
    if (body?.status !== 'ok') throw new Error(`unexpected /api/health body: ${JSON.stringify(body)}`);
    if (body.name !== '@forgeax/server') {
      throw new Error(`expected name @forgeax/server, got ${body.name}`);
    }
    console.log(`  /api/health -> ok (version ${body.version}, root ${body.projectRoot})`);
  } finally {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    await proc.exited.catch(() => {});
  }
};

export default validator;
