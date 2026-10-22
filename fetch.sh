#!/bin/bash
# fetch.sh <url> — DS_TOKEN must hold the bearer token.
#
# The token travels in the environment, never in argv: a 0600 curl config in the
# user-only runtime dir carries the header and is removed on exit.
set -u

f=$(mktemp "${XDG_RUNTIME_DIR:-/tmp}/ds-usage.XXXXXX") || exit 1
chmod 600 "$f"
trap 'rm -f "$f"' EXIT
printf 'header = "Authorization: Bearer %s"\n' "${DS_TOKEN:-}" >"$f"
curl -fsS --max-time 20 -K "$f" "$1"
