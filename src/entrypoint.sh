#!/bin/sh
# Runs nginx on the config devproxy generates, and reloads it whenever that config changes, only after `nginx -t` passes.
# The verdict of every test goes to .status beside nginx.conf, which `devproxy apply` waits on.
set -eu

CONF=${DEVPROXY_CONF:?DEVPROXY_CONF names the nginx.conf to run}
ROOT=$(dirname "$CONF")
STATUS="$ROOT/.status"
INTERVAL=${DEVPROXY_POLL_INTERVAL:-2}

report() {
  printf '%s %s\n%s\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" > "$STATUS"
}

fingerprint() {
  find "$ROOT" -type f \( -name '*.conf' -o -name '.reload' \) -exec stat -c '%n %s %Y' {} + 2>/dev/null | sort
  find "$ROOT/../certs" -type f -name '*.pem' -exec stat -c '%n %s %Y' {} + 2>/dev/null | sort
}

while [ ! -f "$CONF" ]; do
  report waiting "no $CONF yet, run devproxy apply"
  sleep "$INTERVAL"
done

until out=$(nginx -c "$CONF" -t 2>&1); do
  report error "$out"
  echo "$out" >&2
  sleep "$INTERVAL"
done

report ok ""
nginx -c "$CONF" -g 'daemon off;' &
pid=$!

last=$(fingerprint)
refused=0

# A refused config is tested again every round, not only on the next change: one naming an upstream that failed to resolve passes once it is back.
while kill -0 "$pid" 2>/dev/null; do
  sleep "$INTERVAL"
  now=$(fingerprint)

  [ "$now" = "$last" ] && [ "$refused" = 0 ] && continue
  last=$now
  refused=1

  if out=$(nginx -c "$CONF" -t 2>&1); then
    if nginx -c "$CONF" -s reload; then
      refused=0
      report ok ""
    else
      report error "nginx -t passed but the reload failed"
    fi
  else
    report error "$out"
  fi
done

wait "$pid"
