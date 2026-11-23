#!/bin/bash
# Aqar demo — one-command activation. Run from a terminal OUTSIDE Hermes.
# Does: stops the ad-hoc demo processes, installs the two KeepAlive LaunchAgents, verifies both halves.
set -uo pipefail
UID_NUM=$(id -u)
AGENTS="$HOME/Library/LaunchAgents"
LABEL_WEB=com.syntaxlabs.aqar-demo-web
LABEL_TUN=com.syntaxlabs.aqar-demo-tunnel

echo "== 1/3 stopping ad-hoc demo processes =="
pkill -f "next start -p 3110" 2>/dev/null && echo "  stopped ad-hoc next" || echo "  no ad-hoc next"
pkill -f "cloudflared tunnel --no-autoupdate run --token" 2>/dev/null && echo "  stopped ad-hoc cloudflared" || echo "  no ad-hoc cloudflared"
sleep 2

echo "== 2/3 installing supervisors =="
for L in "$LABEL_WEB" "$LABEL_TUN"; do
  launchctl bootout "gui/$UID_NUM/$L" 2>/dev/null
  launchctl bootstrap "gui/$UID_NUM" "$AGENTS/$L.plist" && echo "  bootstrapped $L"
done
sleep 8

echo "== 3/3 verifying =="
launchctl list | grep -E "aqar-demo" || echo "  NOT REGISTERED (see logs below)"
curl -s -o /dev/null -m 10 -w "  origin  http://127.0.0.1:3110/login -> %{http_code}\n" http://127.0.0.1:3110/login
curl -s -o /dev/null -m 15 -w "  public  https://aqar.thesyntaxlabs.com/login -> %{http_code} (302 = Access gate live)\n" https://aqar.thesyntaxlabs.com/login
echo
echo "logs: $HOME/HERMES/aqar-demo/logs/{web,tunnel}.{out,err}.log"
echo
echo "ROLLBACK (stop the demo, keep the site):"
echo "  launchctl bootout gui/$UID_NUM/$LABEL_WEB; launchctl bootout gui/$UID_NUM/$LABEL_TUN"
