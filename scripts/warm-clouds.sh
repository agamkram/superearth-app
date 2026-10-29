#!/bin/bash
# Ask for the eight cloud squares so they are cut and waiting.
# The globe requests this same address. A miss still cuts the new picture.
set -u
BASE="${CLOUD_BASE:-https://superearth.markmaga.com}"
STAMP=$(( $(date +%s) / 10800 ))
ok=0
fail=0
for r in 0 1; do
  for c in 0 1 2 3; do
    url="$BASE/api/cloud-square?c=${c}&r=${r}&cols=4&rows=2&t=${STAMP}&v=la"
    success=0
    for attempt in 1 2 3; do
      body=$(mktemp)
      hdr=$(mktemp)
      code=$(curl -sS -D "$hdr" -o "$body" -w '%{http_code}' --max-time 90 "$url" || echo "000")
      size=$(wc -c < "$body" | tr -d ' ')
      cache=$(grep -i '^x-vercel-cache:' "$hdr" | awk '{print $2}' | tr -d '\r')
      kind=$(grep -i '^content-type:' "$hdr" | awk '{print $2}' | tr -d '\r')
      rm -f "$body" "$hdr"
      echo "c${c}r${r} try ${attempt} ${code} ${size} ${cache:-none} ${kind:-}"
      if [ "$code" = "200" ] && [ "$size" -gt 100000 ] && [[ "$kind" == image/png* ]]; then
        success=1
        break
      fi
      sleep 5
    done
    if [ "$success" = 1 ]; then
      ok=$((ok + 1))
    else
      fail=$((fail + 1))
    fi
  done
done
echo "stamp ${STAMP} ready ${ok} failed ${fail}"
[ "$fail" = 0 ]
