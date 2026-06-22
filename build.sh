#!/bin/bash
# forgeax build orchestrator
# Usage:
#   ./build.sh release-source        # produce forgeax monorepo at ./output/
#   ./build.sh validate              # run validators against ./output/
#   ./build.sh publish               # rsync output/{apps,packages,games}/
#                                    # into ../forgeax/ (parent monorepo's
#                                    # forgeax submodule). Targeted subtree
#                                    # rsync only — never touches root
#                                    # scaffolding (run.sh / package.json /
#                                    # bun.lock / .env.example / README.md).
#   ./build.sh release               # release-source + validate + publish
#   ./build.sh clean                 # rm -rf workspace/ output/
#   ./build.sh help

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE="$ROOT/workspace"
OUTPUT="$ROOT/output"
# forgeax-build sits as a sibling of forgeax/ inside forgeax-studio (the
# monorepo parent). Resolve the publish target relative to this script.
FORGEAX_DIR="$(cd "$ROOT/.." && pwd)/forgeax"
CMD="${1:-help}"

cmd_install_deps() {
  if [ ! -d "$ROOT/node_modules" ]; then
    echo "[build] installing build orchestrator deps..."
    (cd "$ROOT" && bun install)
  fi
}

cmd_clean() {
  echo "[build] cleaning workspace + output"
  rm -rf "$WORKSPACE" "$OUTPUT"
}

cmd_release_source() {
  cmd_install_deps
  echo "[build] release-source -> $OUTPUT"
  rm -rf "$WORKSPACE" "$OUTPUT"
  mkdir -p "$WORKSPACE" "$OUTPUT"
  bun "$ROOT/scripts/orchestrate.ts" release-source
  echo "[build] release-source done."
}

cmd_validate() {
  cmd_install_deps
  if [ ! -d "$OUTPUT" ]; then
    echo "[build] no output/ yet; run release-source first" >&2
    exit 1
  fi
  bun "$ROOT/scripts/validate.ts"
}

cmd_publish() {
  if [ ! -d "$OUTPUT" ]; then
    echo "[build] no output/ yet; run release-source first" >&2
    exit 1
  fi
  if [ ! -d "$FORGEAX_DIR" ]; then
    echo "[build] target $FORGEAX_DIR not found — is this inside a forgeax-studio checkout?" >&2
    exit 1
  fi
  echo "[build] publish: $OUTPUT/{cli,server,interface,engine,harness} -> $FORGEAX_DIR/"
  # Targeted subtree rsync. `--delete` is safe for these subtrees because
  # each is owned entirely by recipes (no hand-maintained files); root
  # scaffolding (run.sh, package.json, bun.lock, .env.example,
  # tsconfig.base.json, README.md, .gitignore) lives in the forgeax repo's
  # own commits and is intentionally never rsynced.
  #
  # Post flat-layout (v2): recipes write output flat (cli/, server/, ...)
  # instead of nested apps/* + packages/*. Each name maps 1:1 to a forgeax/
  # subdir.
  #
  # `games/` is intentionally NOT in this loop and NO LONGER published at
  # all. After the .forgeax/games refactor (2026-05-13), game projects are
  # per-instance runtime data living at `<instance>/.forgeax/games/`, NOT
  # build artifacts. They're gitignored and created on-demand by the agent.
  # The forgeax.git repo should have NO games/ tracked content.
  for sub in cli server interface engine harness; do
    if [ -d "$OUTPUT/$sub" ]; then
      rsync -a --delete \
        --exclude='node_modules/' \
        --exclude='.env' \
        --exclude='.forgeax/' \
        "$OUTPUT/$sub/" "$FORGEAX_DIR/$sub/"
      echo "  ✓ $sub"
    fi
  done
  echo "[build] publish done. cd $FORGEAX_DIR && git status -sb"
}

cmd_release() {
  cmd_release_source
  cmd_validate
  cmd_publish
}

cmd_help() {
  cat <<EOF
forgeax-build orchestrator

Commands:
  release-source   produce forgeax monorepo at $OUTPUT/
  validate         run validators against $OUTPUT/
  publish          rsync $OUTPUT/{apps,packages,games}/ -> $FORGEAX_DIR/
  release          release-source + validate + publish (full pipeline)
  clean            rm -rf workspace/ output/
  help             show this message

Sources defined in config/sources.yaml.
Recipes in recipes/<name>.ts run in the order listed.
EOF
}

case "$CMD" in
  release-source) cmd_release_source ;;
  validate)       cmd_validate ;;
  publish)        cmd_publish ;;
  release)        cmd_release ;;
  clean)          cmd_clean ;;
  help|"")        cmd_help ;;
  *)
    echo "[build] unknown command: $CMD" >&2
    cmd_help
    exit 1
    ;;
esac
