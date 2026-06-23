#!/usr/bin/env bash
# One-shot publisher for @aicut/* to npmjs.com.
#
# Usage:
#   NPM_TOKEN=npm_xxx ./scripts/publish.sh
#   NPM_TOKEN=npm_xxx ./scripts/publish.sh --otp 123456
#   NPM_TOKEN=npm_xxx ./scripts/publish.sh --dry-run
#
# Behaviour:
#   - Reads version from each packages/*/package.json.
#   - Idempotent: skips any @aicut/<pkg>@<version> that's already on
#     the registry. Re-run after a 2FA timeout / network failure and
#     only the still-unpublished packages get pushed.
#   - Writes auth to a TEMP npmrc outside the repo so the token never
#     touches the working tree. Cleaned up on EXIT (even on errors).
#   - Forces registry=https://registry.npmjs.org/ to override a
#     globally-configured mirror like registry.npmmirror.com.
#   - Publishes core → react → vue so the dependants resolve their
#     workspace:* peer the moment they hit the registry.
#   - On full success, tags `v<core-version>` locally + remotely.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGES=(core react vue)
REGISTRY="https://registry.npmjs.org/"

# --- arg parsing ---------------------------------------------------------
DRY_RUN=""
OTP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN="--dry-run" ;;
    --otp)     OTP="$2"; shift ;;
    --otp=*)   OTP="${1#*=}" ;;
    -h|--help)
      grep -E '^# ' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

# --- preconditions -------------------------------------------------------
if [ -z "${NPM_TOKEN:-}" ]; then
  echo "✗ NPM_TOKEN env var is required (e.g. NPM_TOKEN=npm_xxx ./scripts/publish.sh)" >&2
  exit 1
fi

echo "==> validating token against $REGISTRY"
WHOAMI=$(curl -sf -H "Authorization: Bearer $NPM_TOKEN" "${REGISTRY}-/whoami" || true)
if [ -z "$WHOAMI" ]; then
  echo "✗ token rejected by registry. Check that:" >&2
  echo "    1) the token is from npmjs.com (not a mirror)," >&2
  echo "    2) it hasn't expired," >&2
  echo "    3) it has read+write scope on @aicut packages." >&2
  exit 1
fi
USER=$(echo "$WHOAMI" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
echo "    authenticated as: $USER"

# --- temp npmrc ----------------------------------------------------------
# Keep the token out of the repo and out of $HOME entirely. mktemp is
# 0600 by default so no other user on the box can read it.
TMP_NPMRC=$(mktemp /tmp/aicut-publish.npmrc.XXXXXX)
trap 'rm -f "$TMP_NPMRC"' EXIT
chmod 600 "$TMP_NPMRC"
cat > "$TMP_NPMRC" <<EOF
registry=$REGISTRY
//registry.npmjs.org/:_authToken=$NPM_TOKEN
EOF
export NPM_CONFIG_USERCONFIG="$TMP_NPMRC"

# --- helpers -------------------------------------------------------------
already_published() {
  # Returns 0 (success) if <pkg>@<version> exists on the registry.
  local pkg="$1" ver="$2"
  curl -sf -o /dev/null \
    "https://registry.npmjs.org/${pkg//\//%2f}/${ver}"
}

# --- build ---------------------------------------------------------------
echo "==> building all packages fresh"
( cd "$ROOT" && pnpm -r --filter "./packages/*" build >/dev/null )

# --- publish loop --------------------------------------------------------
PUBLISHED=()
SKIPPED=()
for name in "${PACKAGES[@]}"; do
  pkg_dir="$ROOT/packages/$name"
  pkg_name=$(node -p "require('$pkg_dir/package.json').name")
  pkg_ver=$(node -p "require('$pkg_dir/package.json').version")
  echo
  echo "==> $pkg_name@$pkg_ver"

  if [ -z "$DRY_RUN" ] && already_published "$pkg_name" "$pkg_ver"; then
    echo "    already on registry, skipping"
    SKIPPED+=("$pkg_name@$pkg_ver")
    continue
  fi

  cmd=(pnpm publish --access public --no-git-checks)
  [ -n "$DRY_RUN" ] && cmd+=("$DRY_RUN")
  [ -n "$OTP" ]    && cmd+=(--otp "$OTP")

  ( cd "$pkg_dir" && "${cmd[@]}" )
  PUBLISHED+=("$pkg_name@$pkg_ver")
done

echo
echo "==> summary"
printf '   published:   %s\n' "${PUBLISHED[@]:-(none)}"
printf '   skipped:     %s\n' "${SKIPPED[@]:-(none)}"

# --- git tag (real publishes only, and only when core actually shipped) --
if [ -z "$DRY_RUN" ] && [ ${#PUBLISHED[@]} -gt 0 ]; then
  core_ver=$(node -p "require('$ROOT/packages/core/package.json').version")
  tag="v$core_ver"
  if git -C "$ROOT" rev-parse "$tag" >/dev/null 2>&1; then
    echo "==> tag $tag already exists, leaving alone"
  else
    echo "==> tagging $tag"
    git -C "$ROOT" tag -a "$tag" -m "Release $tag"
    git -C "$ROOT" push origin "$tag"
  fi
fi

echo
echo "done."
