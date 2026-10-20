#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"

runtime_zip=
runtime_version=32.2.0
upgrade_runtime_zip=
upgrade_runtime_version=33.3.1
shell_binary="$repo_root/shell/target/release/minitron"
new_shell_binary=
native_asar=
cargo_home=
report="$repo_root/dist/e2e-report.json"

usage() {
  cat <<'USAGE'
Usage: scripts/e2e-unix.sh --runtime-zip PATH --upgrade-runtime-zip PATH [options]

Options:
  --runtime-version VERSION          Initial Electron version (default: 32.2.0)
  --upgrade-runtime-version VERSION  Upgrade Electron version (default: 33.3.1)
  --shell PATH                      Launcher to test (default: shell/target/release/minitron)
  --new-shell PATH                  Updated launcher fixture; built from debug by default
  --native-asar PATH                Reuse a prebuilt native-addon fixture
  --cargo-home PATH                 Use this Cargo home to build the debug fixture
  --report PATH                     E2E JSON report (default: dist/e2e-report.json)
USAGE
}

take_value() {
  if (($# < 2)) || [[ -z "$2" || "$2" == --* ]]; then
    echo "Missing value for $1" >&2
    exit 2
  fi
}

while (($#)); do
  case "$1" in
    --runtime-zip)
      take_value "$@"; runtime_zip=$2; shift 2 ;;
    --runtime-version)
      take_value "$@"; runtime_version=$2; shift 2 ;;
    --upgrade-runtime-zip)
      take_value "$@"; upgrade_runtime_zip=$2; shift 2 ;;
    --upgrade-runtime-version)
      take_value "$@"; upgrade_runtime_version=$2; shift 2 ;;
    --shell)
      take_value "$@"; shell_binary=$2; shift 2 ;;
    --new-shell)
      take_value "$@"; new_shell_binary=$2; shift 2 ;;
    --native-asar)
      take_value "$@"; native_asar=$2; shift 2 ;;
    --cargo-home)
      take_value "$@"; cargo_home=$2; shift 2 ;;
    --report)
      take_value "$@"; report=$2; shift 2 ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2 ;;
  esac
done

for input in "$runtime_zip" "$upgrade_runtime_zip" "$shell_binary"; do
  if [[ -z "$input" || ! -f "$input" ]]; then
    echo "Missing E2E input: ${input:-<empty>}. Pass runtime ZIPs and build the launcher first." >&2
    exit 2
  fi
done

if [[ -z "$new_shell_binary" ]]; then
  if [[ -n "$cargo_home" ]]; then
    (cd "$repo_root/shell" && CARGO_HOME="$cargo_home" ERS_BUILD_VERSION=0.1.1 cargo build --locked)
  else
    (cd "$repo_root/shell" && ERS_BUILD_VERSION=0.1.1 cargo build --locked)
  fi
  tool_dir="$repo_root/dist/test-tools"
  mkdir -p "$tool_dir"
  new_shell_binary="$tool_dir/minitron-0.1.1"
  install -m 755 "$repo_root/shell/target/debug/minitron" "$new_shell_binary"
fi

if [[ ! -f "$new_shell_binary" ]]; then
  echo "Missing updated launcher fixture: $new_shell_binary" >&2
  exit 2
fi

e2e_args=(
  --runtime-zip "$runtime_zip"
  --runtime-version "$runtime_version"
  --upgrade-runtime-zip "$upgrade_runtime_zip"
  --upgrade-runtime-version "$upgrade_runtime_version"
  --shell "$shell_binary"
  --new-shell "$new_shell_binary"
  --report "$report"
)
if [[ -n "$native_asar" ]]; then e2e_args+=(--native-asar "$native_asar"); fi

node "$script_dir/e2e.mjs" "${e2e_args[@]}"
