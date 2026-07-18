#!/usr/bin/env bun
/**
 * sync-upstream — pull forgeax-cli upstream into the forgeax-cli vendor snapshot.
 *
 * Direction:
 *   git@github.com:ForgeaX-Games/forgeax-cli (ref) ──rsync──> ../forgeax-cli/
 *
 * This is the FIRST stage of the forgeax build pipeline. The vendor stage
 * (recipes/cli.ts) reads forgeax-cli/ and copies it into output/apps/cli/;
 * the publish stage rsyncs output/ → ../forgeax/. Those two stages are
 * independent and configured separately — do NOT try to share SYNC/KEEP
 * config between them.
 *
 * Strategy: three phases.
 *   1. stash:   move KEEP paths from vendor into workspace/sync-upstream/stash/
 *   2. rsync:   upstream → vendor with --delete (so files removed upstream
 *               disappear from vendor too) and --exclude for SKIP paths
 *   3. restore: copy stashed KEEP paths back into vendor
 *
 * Default is dry-run. Pass --apply to actually write.
 *
 * Usage:
 *   bun scripts/sync-upstream.ts                # dry-run (default)
 *   bun scripts/sync-upstream.ts --apply        # write
 *   bun scripts/sync-upstream.ts --ref <name>   # default: agentteam-os-future
 *   bun scripts/sync-upstream.ts --no-fetch     # reuse existing clone, skip git fetch
 *   bun scripts/sync-upstream.ts --upstream <path> --vendor <path>
 *   bun scripts/sync-upstream.ts --report <file>
 */

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ─── Config ───

const REPO_URL = 'git@github.com:ForgeaX-Games/forgeax-cli.git';
const DEFAULT_REF = 'agentteam-os-future';

/**
 * KEEP set — forgeax-specific files that survive the sync.
 * Paths are vendor-relative.
 *
 * Deliberately NOT in KEEP: src/fs/state-dir.ts.
 *   The FORGEAX_STATE_DIR patch was retired 2026-05-12 — run.sh now exports
 *   AGENTEAM_STATE_DIR directly (vanilla forgeax-cli reads that name). The
 *   first sync-upstream --apply drops the 4-line patch and brings in
 *   upstream's clean state-dir.ts; no further action required.
 */
const KEEP: readonly string[] = [
  'package.json',
  'mcp.config.json',
  'bun.lock',
  'pnpm-lock.yaml',
  'capabilities/mcp_bridge',
  'README.md',
  'UPSTREAM_AGENTEAM_README.md',
  '.gitignore',
];

/**
 * SKIP patterns — rsync --exclude. Runtime state / sensitive paths that
 * must never propagate from upstream to vendor. Leading slash anchors
 * the pattern to the rsync source root.
 */
const SKIP: readonly string[] = [
  '/.git/',
  '/node_modules/',
  '/dist/',
  '/.cache/',
  '/.forgeax/',
  '/.playwright-mcp/',
  '/team/',
  '/homes/',
  '/sessions/',
  '/logs/',
  '/shared-workspace/',
  '/mounts.json',
  '/key/',
];

// ─── Args ───

interface Args {
  apply: boolean;
  upstream: string;
  vendor: string;
  ref: string;
  noFetch: boolean;
  report: string | null;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const here = dirname(fileURLToPath(import.meta.url));
  const buildRoot = resolve(here, '..');
  const out: Args = {
    apply: false,
    upstream: join(buildRoot, 'workspace', 'sync-upstream', 'agentic-os2-upstream'),
    vendor: resolve(buildRoot, '..', 'forgeax-cli'),
    ref: DEFAULT_REF,
    noFetch: false,
    report: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--apply':    out.apply = true; break;
      case '--upstream': out.upstream = resolve(argv[++i] ?? ''); break;
      case '--vendor':   out.vendor = resolve(argv[++i] ?? ''); break;
      case '--ref':      out.ref = argv[++i] ?? DEFAULT_REF; break;
      case '--no-fetch': out.noFetch = true; break;
      case '--report':   out.report = resolve(argv[++i] ?? ''); break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      default:
        process.stderr.write(`unknown arg: ${a}\n`);
        printHelp();
        process.exit(2);
    }
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(
    `Usage: bun scripts/sync-upstream.ts [options]\n` +
    `  --apply              Actually write (default: dry-run)\n` +
    `  --upstream <path>    Upstream clone path (default: workspace/sync-upstream/agentic-os2-upstream)\n` +
    `  --vendor <path>      Vendor target path (default: ../forgeax-cli)\n` +
    `  --ref <name>         Upstream branch/tag (default: ${DEFAULT_REF})\n` +
    `  --no-fetch           Skip git fetch (reuse existing clone as-is)\n` +
    `  --report <file>      Write report to file (default: stdout)\n` +
    `  -h, --help           Show this message\n`
  );
}

// ─── Logging ───

function log(msg: string): void { process.stdout.write(`[sync-upstream] ${msg}\n`); }
function err(msg: string): void { process.stderr.write(`[sync-upstream] ${msg}\n`); }

// ─── Phase 1: ensure upstream clone ───

function ensureUpstream(path: string, ref: string, fetch: boolean): { head: string } {
  const gitDir = join(path, '.git');
  if (!existsSync(gitDir)) {
    log(`cloning ${REPO_URL} (branch=${ref}) → ${path}`);
    mkdirSync(dirname(path), { recursive: true });
    const r = spawnSync('git', ['clone', '--branch', ref, '--single-branch', REPO_URL, path], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`git clone failed (exit ${r.status})`);
  } else if (fetch) {
    log(`fetching origin ${ref} → ${path}`);
    const f = spawnSync('git', ['fetch', 'origin', ref], { cwd: path, stdio: 'inherit' });
    if (f.status !== 0) throw new Error(`git fetch failed (exit ${f.status})`);
    const r = spawnSync('git', ['reset', '--hard', `origin/${ref}`], { cwd: path, stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`git reset failed (exit ${r.status})`);
  } else {
    log(`reusing existing clone (--no-fetch)`);
  }
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: path });
  return { head: r.stdout.toString().trim() };
}

// ─── Phase 2: stash KEEP files ───

interface StashEntry {
  rel: string;          // vendor-relative path
  stashedAt: string;    // absolute path in stash dir, or '(dry-run)'
  type: 'file' | 'dir';
}

function planStash(vendor: string): StashEntry[] {
  const out: StashEntry[] = [];
  for (const k of KEEP) {
    const abs = join(vendor, k);
    if (!existsSync(abs)) {
      log(`  [skip] KEEP ${k} not present in vendor`);
      continue;
    }
    out.push({
      rel: k,
      stashedAt: '(dry-run)',
      type: statSync(abs).isDirectory() ? 'dir' : 'file',
    });
  }
  return out;
}

function stashKeep(vendor: string, stashDir: string, plan: StashEntry[]): StashEntry[] {
  if (existsSync(stashDir)) rmSync(stashDir, { recursive: true });
  mkdirSync(stashDir, { recursive: true });
  return plan.map(e => {
    const src = join(vendor, e.rel);
    const dst = join(stashDir, e.rel);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst, { recursive: true });
    return { ...e, stashedAt: dst };
  });
}

// ─── Phase 3: rsync ───

interface RsyncStat {
  created: number;
  updated: number;
  deleted: number;
  raw: string;
  /** Real deletions (vendor had these, upstream doesn't, NOT a KEEP path). */
  realDeletions: string[];
  /** Paths rsync would touch but KEEP stash/restore shields them — net no-op. */
  keepShielded: string[];
}

/** True if `path` is, or lives under, a KEEP entry. Path is vendor-relative. */
function isKeepPath(path: string): boolean {
  return KEEP.some(k => path === k || path.startsWith(k + '/'));
}

/** Parse rsync --itemize-changes output. Format: 11-char op code + space + path. */
function parseItemize(line: string): { op: string; path: string } | null {
  if (line.startsWith('*deleting')) {
    // "*deleting   <path>" — 9 chars + variable whitespace
    return { op: 'delete', path: line.substring(9).trim() };
  }
  if (line.length < 12) return null;
  const code = line.substring(0, 11);
  const path = line.substring(12).trim();
  if (!path) return null;
  if (code.startsWith('cd+++++++++')) return { op: 'mkdir', path };
  if (/^[>c<][fdL]\+{9}/.test(code)) return { op: 'create', path };
  if (/^\.[fdL]/.test(code)) return { op: 'noop', path };
  if (/^[>c<][fdL]/.test(code)) return { op: 'update', path };
  return null;
}

function runRsync(upstream: string, vendor: string, dryRun: boolean): RsyncStat {
  const excludes = SKIP.flatMap(p => ['--exclude', p]);
  const args = [
    '-a',
    '--delete',
    '--itemize-changes',
    ...(dryRun ? ['--dry-run'] : []),
    ...excludes,
    `${upstream}/`,
    `${vendor}/`,
  ];
  log(`rsync ${dryRun ? '(DRY)' : '(APPLY)'}: ${args.slice(0, 4).join(' ')} ... ${args.slice(-2).join(' ')}`);
  const r = spawnSync('rsync', args, { encoding: 'utf-8' });
  if (r.status !== 0) {
    throw new Error(`rsync failed (exit ${r.status}): ${r.stderr}`);
  }
  const raw = r.stdout;

  let created = 0, updated = 0, deleted = 0;
  const realDeletions: string[] = [];
  const keepShielded: string[] = [];

  for (const line of raw.split('\n')) {
    const parsed = parseItemize(line);
    if (!parsed) continue;
    const { op, path } = parsed;
    // KEEP-shielded: dry-run shows the file would be touched, but in apply mode
    // the stash → rsync → restore dance leaves the original bytes intact.
    if (op !== 'mkdir' && op !== 'noop' && isKeepPath(path)) {
      keepShielded.push(`${op}: ${path}`);
      continue;
    }
    switch (op) {
      case 'delete': realDeletions.push(path); deleted++; break;
      case 'create': created++; break;
      case 'update': updated++; break;
      // mkdir / noop: not counted
    }
  }
  return { created, updated, deleted, raw, realDeletions, keepShielded };
}

// ─── Phase 4: restore KEEP ───

function restoreKeep(vendor: string, entries: StashEntry[]): void {
  for (const e of entries) {
    const dst = join(vendor, e.rel);
    if (existsSync(dst)) rmSync(dst, { recursive: true });
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(e.stashedAt, dst, { recursive: true });
  }
}

// ─── Report ───

function makeReport(args: Args, upstream: { head: string }, stashed: StashEntry[], stat: RsyncStat): string {
  const lines: string[] = [];
  lines.push(`# sync-upstream report`);
  lines.push(``);
  lines.push(`- Date: ${new Date().toISOString()}`);
  lines.push(`- Mode: **${args.apply ? 'APPLY' : 'DRY-RUN'}**`);
  lines.push(`- Upstream: \`${args.upstream}\` @ \`${args.ref}\` (HEAD \`${upstream.head}\`)`);
  lines.push(`- Vendor:   \`${args.vendor}\``);
  lines.push(``);
  lines.push(`## Net stats (after stash → rsync → restore)`);
  lines.push(`- created:        **${stat.created}**`);
  lines.push(`- updated:        **${stat.updated}**`);
  lines.push(`- deleted (real): **${stat.deleted}**`);
  lines.push(`- KEEP-shielded:  **${stat.keepShielded.length}** (rsync touched, restored unchanged)`);
  lines.push(``);
  lines.push(`## KEEP paths preserved (${stashed.length})`);
  if (stashed.length === 0) lines.push(`_(none)_`);
  for (const e of stashed) lines.push(`- \`${e.rel}\` (${e.type})`);
  lines.push(``);
  if (stat.realDeletions.length > 0) {
    lines.push(`## Real deletions — ${stat.realDeletions.length} (vendor cleanup, files gone upstream)`);
    for (const p of stat.realDeletions) lines.push(`- \`${p}\``);
    lines.push(``);
  }
  if (stat.keepShielded.length > 0) {
    const sample = stat.keepShielded.slice(0, 20);
    lines.push(`## KEEP-shielded ops (visible in dry-run, no-op after restore)`);
    for (const op of sample) lines.push(`- ${op}`);
    if (stat.keepShielded.length > sample.length) lines.push(`- _(${stat.keepShielded.length - sample.length} more)_`);
    lines.push(``);
  }
  // Optional verbose tail — only include first N lines of NON-KEEP itemize so
  // the report stays readable. Full diff is reproducible by re-running --dry-run.
  const verbose = stat.raw
    .split('\n')
    .filter(l => {
      const p = parseItemize(l);
      return p && p.op !== 'noop' && p.op !== 'mkdir' && !isKeepPath(p.path);
    })
    .slice(0, 60);
  if (verbose.length > 0) {
    lines.push(`## Verbose itemize (first ${verbose.length} non-KEEP entries)`);
    lines.push('```');
    lines.push(verbose.join('\n'));
    lines.push('```');
  }
  return lines.join('\n');
}

// ─── Main ───

async function main(): Promise<void> {
  const args = parseArgs();
  if (!existsSync(args.vendor)) {
    err(`vendor path does not exist: ${args.vendor}`);
    process.exit(2);
  }

  log(args.apply ? '=== APPLY ===' : '=== DRY-RUN (use --apply to write) ===');

  // 1. upstream clone
  const upstream = ensureUpstream(args.upstream, args.ref, !args.noFetch);
  log(`upstream HEAD = ${upstream.head}`);

  // 2. plan stash (always — drives dry-run report) and stash if applying
  const plan = planStash(args.vendor);
  log(`KEEP candidates: ${plan.length}`);
  const stashDir = join(args.upstream, '..', 'stash');
  let stashed = plan;
  if (args.apply) {
    log(`stashing → ${stashDir}`);
    stashed = stashKeep(args.vendor, stashDir, plan);
  }

  // 3. rsync (dry-run unless --apply)
  let stat: RsyncStat;
  try {
    stat = runRsync(args.upstream, args.vendor, !args.apply);
  } catch (e) {
    if (args.apply && stashed.length > 0) {
      log(`rsync failed — attempting KEEP restore...`);
      try { restoreKeep(args.vendor, stashed); }
      catch (re) { err(`restore ALSO failed: ${(re as Error).message}`); }
    }
    throw e;
  }
  log(`rsync stats: +${stat.created} ~${stat.updated} -${stat.deleted}`);

  // 4. restore KEEP
  if (args.apply) {
    log(`restoring KEEP paths`);
    restoreKeep(args.vendor, stashed);
  }

  // 5. report
  const report = makeReport(args, upstream, stashed, stat);
  if (args.report) {
    mkdirSync(dirname(args.report), { recursive: true });
    writeFileSync(args.report, report);
    log(`report → ${args.report}`);
  } else {
    process.stdout.write('\n' + report + '\n');
  }

  log(args.apply ? 'DONE.' : 'dry-run complete — use --apply to write.');
}

main().catch((e) => {
  err(`FAILED: ${(e as Error).message}`);
  process.exit(1);
});
