#!/bin/bash
# Publish a finished cloud set on the cloud-tiles branch.
# The picture commit is the one the globe downloads. ready.json points at it.
# This branch is replaced each time so the pictures do not pile up in history.
set -euo pipefail
SRC=$(cd "$1" && pwd)
ROOT=$(cd "$(dirname "$0")/.." && pwd)
STAMP=$(cat "$SRC/STAMP")
WORK=$(mktemp -d)
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
cd "$WORK"
git init -q
git checkout -q --orphan cloud-tiles-build
cp "$SRC"/*.png .
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git config user.name "github-actions[bot]"
else
  git config user.email "$(git -C "$ROOT" config user.email)"
  git config user.name "$(git -C "$ROOT" config user.name)"
fi
git add ./*.png
git commit -q -m "Clouds ${STAMP}"
SHA=$(git rev-parse HEAD)
printf '{"stamp":"%s","sha":"%s"}\n' "$STAMP" "$SHA" > ready.json
git add ready.json
git commit -q -m "Clouds ${STAMP} ready"
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  git remote add origin "https://github.com/${GITHUB_REPOSITORY}.git"
  git -c http.extraheader="AUTHORIZATION: bearer ${GITHUB_TOKEN}" push --force origin HEAD:cloud-tiles
else
  git remote add origin "$(git -C "$ROOT" remote get-url origin)"
  git push --force origin HEAD:cloud-tiles
fi
echo "published ${STAMP} ${SHA}"
