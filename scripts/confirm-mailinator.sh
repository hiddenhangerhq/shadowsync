#!/usr/bin/env bash
# Test helper: confirm a Supabase signup sent to a public mailinator inbox. Usage: confirm-mailinator.sh <inbox-name>
# Uses only the public mailinator web UI + the Supabase verify link. Needs google-chrome.
set -euo pipefail
inbox="$1"
for i in $(seq 1 6); do
  html=$(timeout 60 google-chrome --headless=new --no-sandbox --disable-gpu --virtual-time-budget=20000 --dump-dom "https://www.mailinator.com/v4/public/inboxes.jsp?to=$inbox" 2>/dev/null || true)
  msgid=$(printf '%s' "$html" | grep -o "showTheMessage('[^']*')" | head -1 | sed "s/showTheMessage('//;s/')//" || true)
  [ -n "$msgid" ] && break
  sleep 5
done
[ -n "${msgid:-}" ] || { echo "no mail for $inbox"; exit 1; }
link=$(curl -s "https://www.mailinator.com/fetch_public?msgid=$msgid" | python3 -c "
import sys,json,re
s=json.dumps(json.load(sys.stdin))
m=re.findall(r'https://[a-z0-9]+\.supabase\.co/auth/v1/verify\?token=[a-z0-9]+&type=signup', s.replace('&amp;','&'))
print(m[0] if m else '')")
[ -n "$link" ] || { echo "no verify link"; exit 1; }
curl -s -o /dev/null -w 'verify http %{http_code}\n' "$link"
