#!/usr/bin/env bash
# Regenerate the README hero shots in docs/screenshots/.
#
# Usage:
#   ./scripts/screenshots.sh                 # all five shots
#   ./scripts/screenshots.sh --grep dark     # filter by spec title
#
# Pre-reqs:
#   - A real video at examples/react-demo/public/sample.mp4 (gitignored).
#     The screenshots spec seeds it as the source for the timeline so
#     the editor renders real cover-cropped thumbnails. Drop any short
#     mp4 in there before running.
#   - `pnpm install` already finished.
#
# Output:
#   docs/screenshots/{editor-dark,editor-light,toolbar-slots,frame-picker,
#                     export-progress}.png
#
# Diff the dir afterwards and `git add docs/screenshots/*.png` whatever
# changed.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SAMPLE="$ROOT/examples/react-demo/public/sample.mp4"
if [[ ! -f "$SAMPLE" ]]; then
  cat >&2 <<EOF
[screenshots] $SAMPLE is missing.

The spec seeds /sample.mp4 as the source for the timeline. Drop any
short mp4 there (gitignored, won't be committed) and re-run:

  cp /path/to/some-clip.mp4 examples/react-demo/public/sample.mp4
  ./scripts/screenshots.sh
EOF
  exit 1
fi

# Forward any extra args (e.g. --grep "dark") to playwright.
pnpm --filter @aicut/e2e exec playwright test screenshots.spec.ts "$@"

echo
echo "[screenshots] Wrote → docs/screenshots/"
ls -1 "$ROOT/docs/screenshots/" | sed 's/^/  /'
