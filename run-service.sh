#!/bin/zsh
set -euo pipefail

cd "/Users/ryan/Services/scan-bridge"
export NODE_ENV=production
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
exec ./node_modules/.bin/tsx server/index.ts
