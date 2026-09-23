#!/usr/bin/env bash
set -uo pipefail

attempts=4
last_status=1
for attempt in $(seq 1 "$attempts"); do
  if npm "$@"; then
    exit 0
  else
    last_status=$?
  fi
  if [ "$attempt" -lt "$attempts" ]; then
    echo "::warning::npm setup attempt $attempt failed; retrying"
    sleep $((attempt * 3))
  fi
done

echo "::error::npm setup failed after $attempts attempts"
exit "$last_status"
