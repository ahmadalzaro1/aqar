#!/bin/zsh
# Aqar demo web origin — supervised by com.syntaxlabs.aqar-demo-web
set -euo pipefail
export HOME=/Users/syntaxstudio
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
cd /Users/syntaxstudio/HERMES/aqar-demo/apps/web
set -a
. /Users/syntaxstudio/HERMES/aqar/.env
set +a
export PORT=3110
export NODE_ENV=production
exec /Users/syntaxstudio/HERMES/aqar-demo/apps/web/node_modules/.bin/next start -p 3110
