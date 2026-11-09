#!/bin/sh
# Build und Deploy auf den Pi (nginx :8090 liefert /home/admin/radar-station/www aus)
set -e
cd "$(dirname "$0")"
npm run test
npm run build
rsync -a --delete dist/ admin@192.168.0.100:/home/admin/radar-station/www/
echo "Deployed → http://192.168.0.100:8090/"
