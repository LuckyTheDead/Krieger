#!/data/data/com.termux/files/usr/bin/bash
# Endpoint reachability. Prints a status code, or CURL_FAIL plus the reason.
set -uo pipefail

URL="${HEALTH_URL:-https://openrouter.ai/api/v1/models}"

code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 20 "$URL" 2>/dev/null)
rc=$?

if [[ $rc -ne 0 ]]; then
  echo "CURL_FAIL rc=$rc url=${URL}"
  exit 1
fi

echo "HTTP $code ${URL}"

# 200 is healthy. 401/402 mean reachable but the key is wrong or out of credit,
# which is a different problem from the endpoint being down.
case "$code" in
  2*) exit 0 ;;
  401|402|403) echo "reachable but auth/credit problem (HTTP $code)"; exit 1 ;;
  *) echo "unexpected status"; exit 1 ;;
esac
