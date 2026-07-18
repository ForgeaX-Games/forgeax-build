# ForgeaX Studio — forgeax-build

[English](./README.md) · [简体中文](./README.zh-CN.md) · [↑ studio](https://github.com/ForgeaX-Games/forgeax-studio)

> **The build & packaging orchestrator — a declarative recipe + validator pipeline that turns module sources into a validated release artifact.**

`forgeax-build` is the layer that assembles ForgeaX Studio for release. Rather than a pile of
ad-hoc shell, it is a small, explicit pipeline: each source module is transformed by its own
**recipe**, in a defined order, into an `output/` tree, which is then put through a chain of
**validators** that fail closed. The build never declares success on a tree that doesn't install,
type-check, and boot.

## Why it matters

Reproducible packaging is where most projects accumulate hidden, untestable glue. ForgeaX makes
the build *itself* legible and gated:

- **Declarative sources.** `config/sources.yaml` lists every module, the recipe that transforms
  it, and its target — one entry per module, in apply order. The pipeline reads this, it isn't
  hard-coded.
- **One recipe per module.** `recipes/*.ts` (`server`, `interface`, `cli`, `engine`, `harness`)
  each own a single source → output transform. Adding or changing how a module ships is a
  localized edit, not a sweep through a monolith.
- **Validators that gate, not decorate.** `validators/` runs in order and each step must pass:
  `01-deps` (a real dependency install in `output/`), `02-types` (`tsc --noEmit`), `03-smoke`
  (start the server and hit its health endpoint). A red gate stops the release.
- **Direct-boot dev source.** `engine-src/` ships the lightweight preview runtime as *real
  files*, so dev mode can boot Vite straight from it without running the build pipeline first —
  the same source the release recipe copies into the artifact.

## Architecture

```
config/sources.yaml   # the module list (module → recipe → target), in apply order
recipes/*.ts          # one source→output transform per module
validators/*.ts       # ordered, fail-closed post-build checks (deps → types → smoke)
scripts/orchestrate.ts# loads sources.yaml + runs recipes in order
scripts/validate.ts   # runs validators in order
engine-src/           # direct-boot preview runtime (real files, also copied at release)
build.sh              # bash → bun entry point
workspace/  output/   # transient (gitignored): staging + final artifact
```

The orchestrator is intentionally two-phase — **assemble** then **validate** — so a broken
module surfaces at the gate it breaks, with the failing check named.

## Usage

```bash
./build.sh release-source     # produce the assembled artifact at output/
./build.sh validate           # run the validator chain against output/
./build.sh clean              # rm -rf workspace/ output/
bun run sync-upstream         # refresh the vendored module snapshot (dry-run by default)
```

## How it fits the studio

The studio's dev launcher boots `engine-src/` directly for an instant preview; the release path
uses the same recipes to produce a validated artifact. Because assembly and validation are
explicit and ordered, a release is reproducible and provably bootable rather than
"works on my machine."

---

Part of the **ForgeaX Studio** monorepo. This repo is a submodule of
[`ForgeaX-Games/forgeax-studio`](https://github.com/ForgeaX-Games/forgeax-studio) — clone that
with `--recurse-submodules` to run the full studio. License: Apache-2.0.
