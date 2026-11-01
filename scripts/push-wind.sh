#!/bin/bash
# Publish one wind forecast on the wind-data branch.
# The file commit is the one the globe downloads. ready.json points at it.
# This branch is replaced each time so old forecasts do not pile up.
set -euo pipefail
SRC=$(cd "$1" && pwd)
ROOT=$(cd "$(dirname "$0")/.." && pwd)
CYCLE=$(cat "$SRC/CYCLE")
RUN=$(cat "$SRC/RUN")
FHOUR=$(cat "$SRC/FHOUR")
FORMAT=$(cat "$SRC/FORMAT")
SOFT=$(cat "$SRC/SOFT")
WORK=$(mktemp -d)
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
cd "$WORK"
git init -q
git checkout -q --orphan wind-data-build
cp "$SRC"/wind-*.bin .
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git config user.name "github-actions[bot]"
else
  git config user.email "$(git -C "$ROOT" config user.email)"
  git config user.name "$(git -C "$ROOT" config user.name)"
fi
git add ./wind-*.bin
git commit -q -m "Wind ${CYCLE}"
SHA=$(git rev-parse HEAD)
printf '{"cycle":"%s","sha":"%s","run":"%s","fhour":"%s","v":"%s","soft":"%s"}\n' "$CYCLE" "$SHA" "$RUN" "$FHOUR" "$FORMAT" "$SOFT" > ready.json
git add ready.json
git commit -q -m "Wind ${CYCLE} ready"
if [ -n "${GITHUB_ACTIONS:-}" ]; then
  git remote add origin "https://github.com/${GITHUB_REPOSITORY}.git"
  basic=$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')
  git -c http.extraheader="AUTHORIZATION: basic ${basic}" push --force origin HEAD:wind-data
else
  git remote add origin "$(git -C "$ROOT" remote get-url origin)"
  git push --force origin HEAD:wind-data
fi
echo "published ${CYCLE} ${SHA}"
