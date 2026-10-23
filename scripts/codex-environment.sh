#!/usr/bin/env bash
set -euo pipefail

mode="${1:-setup}"
if [[ "$mode" != "setup" && "$mode" != "maintenance" ]]; then
  printf 'usage: %s [setup|maintenance]\n' "$0" >&2
  exit 2
fi

root="$(git rev-parse --show-toplevel)"
config="$root/.repository-environment.toml"

if [[ ! -f "$config" ]]; then
  printf 'missing environment-v1 config: %s\n' "$config" >&2
  exit 2
fi

run_privileged() {
  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    "$@"
  fi
}

publish_path() {
  if [[ -n "${GITHUB_PATH:-}" ]]; then
    printf '%s\n' "$1" >> "$GITHUB_PATH"
  fi
}

if [[ "$mode" == "setup" ]] && command -v apt-get >/dev/null 2>&1; then
  mapfile -t apt_packages < <(python3 - "$config" <<'PY'
import sys, tomllib
with open(sys.argv[1], 'rb') as handle:
    data = tomllib.load(handle)
for package in data.get('system', {}).get('apt', []):
    print(package)
PY
  )
  if (( ${#apt_packages[@]} )); then
    run_privileged apt-get update
    run_privileged apt-get install -y --no-install-recommends "${apt_packages[@]}"
  fi
fi

desired_bun="$(python3 - "$root/package.json" <<'PY'
import json, pathlib, sys
path = pathlib.Path(sys.argv[1])
if path.is_file():
    value = json.loads(path.read_text()).get('packageManager', '')
    if value.startswith('bun@'):
        print(value.split('@', 1)[1])
PY
)"
# Toolchains track the latest stable release (owner decision 2026-10-23): declarations are
# minimums, so any installed Bun, Node or Rust release satisfies them.
if [[ -n "$desired_bun" ]]; then
  if ! command -v bun >/dev/null 2>&1; then
    printf 'Bun is required (packageManager bun@%s) but is not installed; install the latest stable Bun before running this script\n' "$desired_bun" >&2
    exit 2
  fi
  if [[ -d "$HOME/.bun/bin" ]]; then
    export PATH="$HOME/.bun/bin:$PATH"
    publish_path "$HOME/.bun/bin"
  fi
fi

desired_node="$(python3 - "$root/.node-version" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
if path.is_file():
    print(path.read_text().strip())
PY
)"
if [[ -n "$desired_node" ]] && ! command -v node >/dev/null 2>&1; then
  printf 'Node is required (.node-version %s) but is not installed; install the latest stable Node before running this script\n' "$desired_node" >&2
  exit 2
fi

rust_toolchain="$(python3 - "$root/rust-toolchain.toml" <<'PY'
import pathlib, sys, tomllib
path = pathlib.Path(sys.argv[1])
if path.is_file():
    value = tomllib.loads(path.read_text()).get('toolchain', {}).get('channel', '')
    print(value)
PY
)"
if [[ -n "$rust_toolchain" ]]; then
  if ! command -v rustup >/dev/null 2>&1; then
    printf 'rustup is required to provision Rust %s; install rustup before running this script\n' "$rust_toolchain" >&2
    exit 2
  fi
  if [[ -d "$HOME/.cargo/bin" ]]; then
    export PATH="$HOME/.cargo/bin:$PATH"
    publish_path "$HOME/.cargo/bin"
  fi
  rustup toolchain install "$rust_toolchain" --profile minimal
  mapfile -t rust_components < <(python3 - "$root/rust-toolchain.toml" <<'PY'
import pathlib, sys, tomllib
path = pathlib.Path(sys.argv[1])
if path.is_file():
    for component in tomllib.loads(path.read_text()).get('toolchain', {}).get('components', []):
        print(component)
PY
  )
  for component in "${rust_components[@]}"; do
    rustup component add --toolchain "$rust_toolchain" "$component"
  done
fi

mapfile -t environment_commands < <(python3 - "$config" "$mode" <<'PY'
import sys, tomllib
with open(sys.argv[1], 'rb') as handle:
    data = tomllib.load(handle)
for command in data.get(sys.argv[2], {}).get('commands', []):
    print(command)
PY
)
for command in "${environment_commands[@]}"; do
  (cd "$root" && bash -lc "$command")
done
