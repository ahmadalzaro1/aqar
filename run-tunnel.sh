#!/bin/zsh
# Cloudflare tunnel connector for aqar.thesyntaxlabs.com — supervised by com.syntaxlabs.aqar-demo-tunnel
set -euo pipefail
export HOME=/Users/syntaxstudio
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
TOKEN_FILE=/Users/syntaxstudio/.cloudflared/aqar-demo.token
[ -r "$TOKEN_FILE" ] || { echo "missing tunnel token file"; exit 78; }
exec /opt/homebrew/bin/cloudflared tunnel --no-autoupdate run --token "$(cat "$TOKEN_FILE")"
