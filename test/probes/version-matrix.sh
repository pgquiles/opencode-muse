#!/usr/bin/env bash
# version-matrix.sh — fetch, cache, probe, and prune Muse CLI / OpenCode versions.
#
# Purpose: make the compatibility record reproducible. New Muse CLI versions
# arrive through autoupdate; this harness pins any version on demand, runs the
# repo's gate battery against it, and records sanitized results. OpenCode
# versions come from GitHub releases the same way.
#
# Subcommands:
#   fetch-muse <full-version>        ensure a Muse CLI binary is cached (e.g. 1.4.14-R7309.1).
#     Discovery: no public CLI version index exists; `npm view @muse-code/sdk
#     versions` (+ `time`) lists SDK generations that imply same-numbered CLI
#     generations, but downloads need the full R-suffixed string from the
#     ledger, release notes, or `muse --version` before upgrade.
#   fetch-opencode [--local PATH] <version>
#       ensure an OpenCode binary is cached (e.g. 2.3.0);
#       --local caches an installed binary for versions no channel serves
#   probe-muse <full-version> [--live] [--results-dir DIR]
#       Gate battery on the pinned OpenCode: schema export + snapshot classify,
#       catalog probe, and with --live: lifecycle/fork probe plus one live turn
#       per tool backend (muse backend is the control; the opencode turn is
#       expected to fail closed with the #58 gate message on unverified CLIs).
#       Approval-mode selection stays manual: it needs a user permission
#       profile (:unrestricted) that automation cannot provide.
#   probe-opencode <version> [--live] [--results-dir DIR]
#       Correlation probe, provider-list smoke, and with --live one turn per
#       backend, on the pinned Muse CLI.
#   prune [--keep-opencode N]        delete cached versions nothing references
#   matrix --muse "v1 v2" --opencode "a b" [--live] [--results-dir DIR] [--prune]
#
# Cache: ${XDG_CACHE_HOME:-$HOME/.cache}/opencode-muse/version-matrix/
#   muse-cli/<full-version>/muse  (sha256 from the release manifest, verified
#                                  on download and on every reuse)
#   opencode/<version>/bin/opencode
# Retention: Muse versions referenced by etc/msp-schema/snapshots.json or
# serving as the current channel version are kept; everything else is pruned.
# OpenCode keeps the newest N fetched (default 3).
#
# Hygiene: probe output is captured to files, never printed. Only statuses,
# booleans, fingerprints, and counts leave this script — no prompts, no
# generated text, no media payloads, no diagnostics. Isolated workspaces per
# run; the user's Muse config is never read or written (auth stays in the
# official CLI; the opencode backend symlink farm lives in temp dirs).
#
# Retired CLIs: a cached old binary always supports offline classification
# (schema export never needs the backend), but live probes may degrade — e.g.
# 1.4.14 serves only the bundled catalog against a current account, so live
# turns fail at model resolution. The harness records that faithfully; it is
# a backend-servicing limit, not a harness bug. Backfill accordingly: schema
# always, live behavior only while a CLI is current.
#
# Live probes (--live) spend inference budget on the active billing lane and
# take minutes per version. Omit --live for offline/schema-only classification.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
# Override for CI or unstable-HOME sandboxes; otherwise the XDG cache home.
CACHE_ROOT="${MATRIX_CACHE_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/opencode-muse/version-matrix}"
readonly ROOT CACHE_ROOT
MUSE_CACHE="$CACHE_ROOT/muse-cli"
OPENCODE_CACHE="$CACHE_ROOT/opencode"
# Pinned OpenCode for the Muse gate battery. Must be fetchable: the 2.0/2.1
# line never appeared on GitHub releases (or npm), so the repo's historical
# 2.1.4 pin cannot be fetched; 2.3.0 is verified live on both backends.
PINNED_OPENCODE="2.3.0"
LEDGER="$ROOT/etc/msp-schema/snapshots.json"
readonly MUSE_CACHE OPENCODE_CACHE PINNED_OPENCODE LEDGER

if command -v bun >/dev/null 2>&1; then
  BUN_BIN="bun"
else
  BUN_BIN="npx --yes bun"
fi
readonly BUN_BIN

log() { printf '%s\n' "$*" >&2; }
die() { log "version-matrix: $*"; exit 1; }

# ---------- Muse CLI download channel (mirrors the official launcher) ----------

channel_version() {
  curl -fsSL --max-time 30 "https://api.meta.ai/muse-code/channels/muse-stable" \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['version'])"
}

muse_platform() {
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) printf 'x86_linux' ;;
    Linux-aarch64|Linux-arm64) printf 'aarch64_linux' ;;
    Darwin-arm64) printf 'aarch64_macos' ;;
    Darwin-x86_64) printf 'x86_macos' ;;
    *) die "unsupported platform $(uname -s)-$(uname -m)" ;;
  esac
}

# ensure_muse <full-version>: print cached binary path, downloading + verifying first.
ensure_muse() {
  local version="$1" dir="$MUSE_CACHE/$1" bin="$MUSE_CACHE/$1/muse"
  if [[ -x "$bin" && -f "$dir/checksum" ]]; then
    if (cd "$dir" && printf '%s  muse\n' "$(cat checksum)" | sha256sum -c - >/dev/null 2>&1); then
      printf '%s\n' "$bin"
      return 0
    fi
    log "checksum mismatch for cached $version; re-downloading"
    rm -rf "$dir"
  fi
  mkdir -p "$dir"
  local manifest
  manifest="$(curl -fsSL --max-time 60 "https://lookaside.facebook.com/lookaside/muse/download/?channel=muse&version=${version}&file=manifest.json")" \
    || die "no release manifest for Muse $version (retired? check the version string)"
  local platform parsed
  platform="$(muse_platform)"
  parsed="$(printf '%s' "$manifest" | python3 -c "
import json,sys
a = json.load(sys.stdin)['artifacts']['$platform']
print(a['url']); print(a['checksum']); print(a['size'])")"
  local url checksum size
  url="$(printf '%s' "$parsed" | sed -n 1p)"
  checksum="$(printf '%s' "$parsed" | sed -n 2p)"
  size="$(printf '%s' "$parsed" | sed -n 3p)"
  log "downloading Muse $version ($platform, ~$((size / 1048576)) MiB)..."
  curl -fSL --max-time 900 -o "$dir/muse.part" "$url" \
    || die "Muse binary download failed (network or login-gated URL; partial file removed)"
  [[ "$(stat -c%s "$dir/muse.part" 2>/dev/null || stat -f%z "$dir/muse.part")" == "$size" ]] \
    || die "size mismatch for Muse $version"
  printf '%s  muse.part\n' "$checksum" | (cd "$dir" && sha256sum -c -) >/dev/null \
    || die "checksum mismatch for Muse $version"
  mv "$dir/muse.part" "$bin"
  chmod +x "$bin"
  printf '%s' "$checksum" >"$dir/checksum"
  printf '%s\n' "$bin"
}

# ---------- OpenCode releases ----------

opencode_asset() {
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) printf 'opencode-linux-x64.tar.gz' ;;
    Linux-aarch64|Linux-arm64) printf 'opencode-linux-arm64.tar.gz' ;;
    Darwin-arm64) printf 'opencode-darwin-arm64.zip' ;;
    Darwin-x86_64) printf 'opencode-darwin-x64.zip' ;;
    *) die "unsupported platform $(uname -s)-$(uname -m)" ;;
  esac
}

# ensure_opencode <version>: print cached bin dir, downloading first.
# ensure_opencode --local <path> <version>: cache an already-installed binary
# (escape hatch for versions no channel serves, e.g. the 2.0/2.1 line).
ensure_opencode() {
  if [[ "${1:-}" == "--local" ]]; then
    local src="$2" version="$3" bindir="$OPENCODE_CACHE/$3/bin"
    [[ -x "$src" ]] || die "not executable: $src"
    mkdir -p "$bindir"
    cp -f "$src" "$bindir/opencode"
    chmod +x "$bindir/opencode"
    printf '%s\n' "$bindir"
    return 0
  fi
  local version="$1" dir="$OPENCODE_CACHE/$1" bindir="$OPENCODE_CACHE/$1/bin"
  if [[ -x "$bindir/opencode" ]]; then
    printf '%s\n' "$bindir"
    return 0
  fi
  command -v gh >/dev/null 2>&1 || die "gh is required to fetch OpenCode $version"
  local asset tmp
  asset="$(opencode_asset)"
  mkdir -p "$dir"
  tmp="$(mktemp "$dir.XXXXXX.tgz")"
  local tag=""
  for candidate in "$version" "v$version"; do
    if gh release view "$candidate" --repo sst/opencode --json tagName >/dev/null 2>&1; then tag="$candidate"; break; fi
  done
  [[ -n "$tag" ]] || die "no GitHub release for OpenCode $version"
  mkdir -p "$bindir"
  gh release download "$tag" --repo sst/opencode --pattern "$asset" --output "$tmp" --clobber \
    || die "no $asset asset for OpenCode $version"
  case "$asset" in
    *.zip) (cd "$bindir" && unzip -q -o "$tmp") ;;
    *.tar.gz) tar -xzf "$tmp" -C "$bindir" ;;
  esac
  rm -f "$tmp"
  if [[ ! -x "$bindir/opencode" ]]; then
    local found
    found="$(find "$bindir" -name 'opencode*' -type f | head -n 1)"
    [[ -n "$found" ]] && { mkdir -p "$bindir/top"; mv "$found" "$bindir/top/"; }
    [[ -x "$bindir/top/opencode" ]] && mv "$bindir/top/opencode" "$bindir/opencode"
  fi
  [[ -x "$bindir/opencode" ]] || die "extracted OpenCode $version has no runnable binary"
  chmod +x "$bindir/opencode"
  printf '%s\n' "$bindir"
}

# ---------- prune ----------

ledger_versions() {
  python3 -c "import json; print('\n'.join(e['cli_version'] for e in json.load(open('$LEDGER'))['entries']))"
}

cmd_prune() {
  local keep_opencode=3
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --keep-opencode) keep_opencode="$2"; shift 2 ;;
      *) die "prune: unknown flag $1" ;;
    esac
  done
  local keep_muse current
  keep_muse="$(ledger_versions)"
  current="$(channel_version)" || die "cannot read Muse channel version"
  log "keeping Muse: $(printf '%s %s' "$keep_muse" "$current" | tr '\n' ' ')"
  local d name keep=0 drop=0
  for d in "$MUSE_CACHE"/*/; do
    [[ -d "$d" ]] || continue
    name="$(basename "$d")"
    if [[ "$name" == "$current" ]] || printf '%s\n' "$keep_muse" | grep -qxF "$name"; then
      keep=$((keep + 1))
    else
      log "pruning Muse $name"
      rm -rf "$d"
      drop=$((drop + 1))
    fi
  done
  mapfile -t all_opencode < <(ls "$OPENCODE_CACHE" 2>/dev/null | sort -V || true)
  local total="${#all_opencode[@]}" i=0
  for name in "${all_opencode[@]}"; do
    i=$((i + 1))
    if [[ $i -le $((total - keep_opencode)) ]]; then
      log "pruning OpenCode $name"
      rm -rf "$OPENCODE_CACHE/$name"
    fi
  done
  log "prune done: kept $keep Muse version(s)"
}

# ---------- backend live turn (sanitized: booleans, counts, error names only) ----------

ensure_dist() {
  if [[ ! -f "$ROOT/dist/index.js" ]] || find "$ROOT/src" -name '*.ts' -newer "$ROOT/dist/index.js" | grep -q .; then
    log "rebuilding plugin dist..."
    (cd "$ROOT" && npm run build >/dev/null) || die "plugin build failed"
  fi
}

# backend_live_turn <muse|opencode> <opencode-bin-dir> <work-dir> [muse-binary]
# The plugin resolves `muse` from PATH, so an explicit binary is exposed
# through a shim dir prepended to PATH. Prints a one-line JSON summary.
backend_live_turn() {
  local backend="$1" opencode_bin="$2" work="$3" muse_bin="${4:-}"
  local project="$work/project-$backend"
  local shimdir=""
  if [[ -n "$muse_bin" ]]; then
    shimdir="$work/musebin"
    mkdir -p "$shimdir"
    ln -sf "$muse_bin" "$shimdir/muse"
  fi
  mkdir -p "$project/.opencode/plugins"
  (cd "$project" && git init -q -b main 2>/dev/null || true)
  (cd "$project" && git config user.name probe && git config user.email probe@example.invalid)
  echo probe >"$project/README.md"
  (cd "$project" && git add README.md && git commit -qm probe)
  cat >"$project/.opencode/plugins/muse-plugin.js" <<EOF
export { default } from "file://$ROOT/dist/index.js";
EOF
  local model
  model="$(cd "$project" && PATH="$opencode_bin:$PATH" opencode models --standalone 2>/dev/null | grep -o 'muse/[^ ]*muse-spark-1\.3[^ ]*' | head -n 1)"
  [[ -n "$model" ]] || { printf '{"backend":"%s","outcome":"no-model"}\n' "$backend"; return 0; }
  local out="$work/turn-$backend.out" err="$work/turn-$backend.err"
  local status=0
  local run_path="$opencode_bin:$PATH"
  [[ -n "$shimdir" ]] && run_path="$shimdir:$run_path"
  # shellcheck disable=SC2086
  PATH="$run_path" OPENCODE_MUSE_TOOL_BACKEND="$backend" \
    timeout 240 opencode run --standalone --model "$model" \
    "Run this shell command and report its output: echo matrix-$backend" >"$out" 2>"$err" || status=$?
  local hits
  hits="$(grep -c "matrix-$backend" "$out" 2>/dev/null || true)"
  local errclass errfiles=("$out" "$err")
  # The gate message quotes the underlying failure, so check the gate's own
  # marker first: a bare "configError" match would mislabel a gate rejection.
  local outcome
  if grep -q "issues/58" "${errfiles[@]}" 2>/dev/null; then
    outcome="gate-rejected"; errclass="MuseInvalidConfigError(gate)"
  else
    errclass="$(grep -h -o -m1 -E 'Muse[A-Za-z]*Error(\([^)]*\))?|already_terminal|configError|unknown tool|Model unavailable' "$out" "$err" 2>/dev/null | head -n 1 || true)"
    if [[ "$hits" -gt 0 ]]; then outcome="ok";
    elif [[ "$status" -eq 0 ]]; then outcome="empty";
    else outcome="failed"; fi
  fi
  printf '{"backend":"%s","outcome":"%s","exit":%d,"tokenHits":%s,"error":"%s"}\n' \
    "$backend" "$outcome" "$status" "${hits:-0}" "$errclass"
}

# ---------- probe-muse ----------

# probe_muse <full-version> [--live] [--results-dir DIR]
probe_muse() {
  local version="$1"; shift
  local live=0 results=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --live) live=1; shift ;;
      --results-dir) results="$2"; shift 2 ;;
      *) die "probe-muse: unknown flag $1" ;;
    esac
  done
  local bin opencode_bin="" work
  bin="$(ensure_muse "$version")"
  if [[ -z "$results" ]]; then work="$(mktemp -d /tmp/opencode/matrix-muse.XXXXXX)"; else work="$results"; mkdir -p "$work"; fi
  log "probing Muse $version (work: $work)"
  "$bin" schema generate-json-schema --out "$work/export" >/dev/null \
    || die "schema export failed for $version"
  $BUN_BIN run test/probes/msp-schema-diff.ts snapshot --export "$work/export" \
    --cli-version "$version" --provenance "version-matrix harness" >"$work/snapshot.json"
  local prev diff_out diff_status=0
  prev="$(python3 -c "
import json
es = json.load(open('$LEDGER'))['entries']
vs = [e['cli_version'] for e in es]
print(vs[vs.index('$version') - 1] if '$version' in vs else vs[-1])")"
  diff_out="$($BUN_BIN run test/probes/msp-schema-diff.ts diff --export "$work/export" \
    --ledger "$LEDGER" --from-version "$prev")" || diff_status=$?
  printf '%s' "$diff_out" | python3 -c "
import json,sys
d = json.load(sys.stdin)
print(json.dumps({'additive': d['ok'], 'base': d['base'], 'findingCount': len(d['findings'])}))" >"$work/diff-summary.json"
  MUSE_BIN="$bin" $BUN_BIN test/probes/msp-catalog.ts >"$work/catalog.json"
  python3 - "$work/catalog.json" "$work/catalog-summary.json" <<'EOF'
import json,sys
c = json.load(open(sys.argv[1]))
json.dump({"status": c.get("status"), "fingerprint": c.get("schemaFingerprint"),
  "source": c.get("source"), "modelCount": len(c.get("models", []))}, open(sys.argv[2], "w"))
EOF
  local lifecycle="skipped" turn_muse="skipped" turn_opencode="skipped"
  if [[ "$live" == 1 ]]; then
    opencode_bin="$(ensure_opencode "$PINNED_OPENCODE")"
    ensure_dist
    MUSE_PROBE_PROVIDER=meta MUSE_BIN="$bin" $BUN_BIN test/probes/msp-lifecycle.ts >"$work/lifecycle.json" || true
    python3 - "$work/lifecycle.json" "$work/lifecycle-summary.json" <<'EOF'
import json,sys
try: c = json.load(open(sys.argv[1]))
except Exception: c = {"status": "PROBE_FAILED"}
json.dump({"status": c.get("status"), "forkCutExplicit": c.get("forkCutExplicit"),
  "resumedMatches": c.get("resumedSessionMatches")}, open(sys.argv[2], "w"))
EOF
    lifecycle="$(python3 -c "import json; print(json.load(open('$work/lifecycle-summary.json')).get('status','?'))")"
    turn_muse="$(PATH="$opencode_bin:$PATH" backend_live_turn muse "$opencode_bin" "$work/muse-backend" "$bin")"
    turn_opencode="$(PATH="$opencode_bin:$PATH" backend_live_turn opencode "$opencode_bin" "$work/opencode-backend" "$bin")"
    printf '%s\n' "$turn_muse" >"$work/turn-muse.json"
    printf '%s\n' "$turn_opencode" >"$work/turn-opencode.json"
  fi
  python3 - "$work" "$version" "$live" "$lifecycle" <<'EOF'
import json,sys
work, version, live, lifecycle = sys.argv[1], sys.argv[2], sys.argv[3] == "1", sys.argv[4]
r = {"version": version,
     "snapshot": version + "-snapshot.json",
     "diff": json.load(open(work + "/diff-summary.json")),
     "catalog": json.load(open(work + "/catalog-summary.json"))}
if live:
    r["lifecycle"] = json.load(open(work + "/lifecycle-summary.json"))
    r["turnMuseBackend"] = json.load(open(work + "/turn-muse.json"))
    r["turnOpencodeBackend"] = json.load(open(work + "/turn-opencode.json"))
    r["note"] = "lifecycle run: " + lifecycle
json.dump(r, open(work + "/result.json", "w"), indent=1)
EOF
  cp "$work/snapshot.json" "$work/$version-snapshot.json"
  log "Muse $version done: $(python3 -c "import json; r=json.load(open('$work/result.json')); print(r['catalog'].get('status'), '| diff additive:', r['diff'].get('additive'))")"
  suggest_muse_row "$work/result.json"
}

suggest_muse_row() {
  python3 - "$1" <<'EOF'
import json,sys
r = json.load(open(sys.argv[1]))
v, c, d = r["version"], r["catalog"], r["diff"]
print("Suggested compatibility.md row (paste after review):")
n = c.get("modelCount")
print(f'| `{v}` | `{c.get("fingerprint")}` | catalog {c.get("status")} ({n} model{"s" if n != 1 else ""}) | diff vs {d.get("base")}: {"additive" if d.get("additive") else "BREAKING"} |')
if c.get("source") != "providerCatalog":
    print(f'NOTE: catalog source is "{c.get("source")}", not providerCatalog — live probes on this retired CLI are limited (schema classification still valid offline).')
if "turnOpencodeBackend" in r:
    t = r["turnOpencodeBackend"]
    print(f'backend live turn (opencode): {t.get("outcome")}; muse backend: {r["turnMuseBackend"].get("outcome")}')
EOF
}

# ---------- probe-opencode ----------

# probe_opencode <version> [--live] [--results-dir DIR]
probe_opencode() {
  local version="$1"; shift
  local live=0 results=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --live) live=1; shift ;;
      --results-dir) results="$2"; shift 2 ;;
      *) die "probe-opencode: unknown flag $1" ;;
    esac
  done
  local opencode_bin work
  opencode_bin="$(ensure_opencode "$version")"
  if [[ -z "$results" ]]; then work="$(mktemp -d /tmp/opencode/matrix-opencode.XXXXXX)"; else work="$results"; mkdir -p "$work"; fi
  log "probing OpenCode $version (work: $work)"
  export PATH="$opencode_bin:$PATH"
  # Cold first launches can exceed the smoke script's 30s default; be generous.
  export OPENCODE_MUSE_MODELS_TIMEOUT=120s
  bash test/probes/provider-list-smoke.sh >"$work/provider-list.json" 2>"$work/provider-list.err" || true
  bash test/probes/correlation-run.sh >"$work/correlation.json" 2>"$work/correlation.err" || true
  local turn_muse="skipped" turn_opencode="skipped"
  if [[ "$live" == 1 ]]; then
    ensure_dist
    turn_muse="$(backend_live_turn muse "$opencode_bin" "$work/muse-backend")"
    turn_opencode="$(backend_live_turn opencode "$opencode_bin" "$work/opencode-backend")"
    printf '%s\n' "$turn_muse" >"$work/turn-muse.json"
    printf '%s\n' "$turn_opencode" >"$work/turn-opencode.json"
  fi
  python3 - "$work" "$version" "$live" <<'EOF'
import json,sys
work, version, live = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
def first_json(path):
    try:
        for line in open(path):
            line = line.strip()
            if line.startswith("{"):
                return json.loads(line)
    except Exception:
        pass
    return {"status": "NO_RESULT"}
r = {"version": version,
     "providerList": first_json(work + "/provider-list.json"),
     "correlation": first_json(work + "/correlation.json")}
if live:
    r["turnMuseBackend"] = json.load(open(work + "/turn-muse.json"))
    r["turnOpencodeBackend"] = json.load(open(work + "/turn-opencode.json"))
json.dump(r, open(work + "/result.json", "w"), indent=1)
print(json.dumps({"providerList": r["providerList"].get("status"), "correlation": r["correlation"].get("status")}))
EOF
}

# ---------- main ----------

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed 's/^# \?//'
  exit "${1:-0}"
}

main() {
  local cmd="${1:-}"; [[ -n "$cmd" ]] || usage 1
  shift || true
  case "$cmd" in
    fetch-muse) [[ $# -eq 1 ]] || die "usage: fetch-muse <full-version>"; ensure_muse "$1" ;;
    fetch-opencode) [[ $# -ge 1 ]] || die "usage: fetch-opencode [--local PATH] <version>"; ensure_opencode "$@" ;;
    probe-muse) [[ $# -ge 1 ]] || die "usage: probe-muse <full-version> [--live] [--results-dir DIR]"; probe_muse "$@" ;;
    probe-opencode) [[ $# -ge 1 ]] || die "usage: probe-opencode <version> [--live] [--results-dir DIR]"; probe_opencode "$@" ;;
    prune) cmd_prune "$@" ;;
    matrix)
      local muses="" opencodes="" live="" results="" do_prune=0
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --muse) muses="$2"; shift 2 ;;
          --opencode) opencodes="$2"; shift 2 ;;
          --live) live="--live"; shift ;;
          --results-dir) results="$2"; shift 2 ;;
          --prune) do_prune=1; shift ;;
          *) die "matrix: unknown flag $1" ;;
        esac
      done
      local v rdir
      # shellcheck disable=SC2086
      for v in $muses; do
        rdir=""; [[ -n "$results" ]] && rdir="$results/muse-$v"
        # shellcheck disable=SC2086
        probe_muse "$v" $live ${rdir:+--results-dir "$rdir"}
      done
      # shellcheck disable=SC2086
      for v in $opencodes; do
        rdir=""; [[ -n "$results" ]] && rdir="$results/opencode-$v"
        # shellcheck disable=SC2086
        probe_opencode "$v" $live ${rdir:+--results-dir "$rdir"}
      done
      [[ "$do_prune" == 1 ]] && cmd_prune
      ;;
    -h|--help|help) usage 0 ;;
    *) die "unknown subcommand $cmd (try: fetch-muse, fetch-opencode, probe-muse, probe-opencode, prune, matrix)" ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
