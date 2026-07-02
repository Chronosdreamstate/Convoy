#!/usr/bin/env bash
set -euo pipefail

# Write Mapbox download credentials to ~/.netrc so CocoaPods can authenticate
# when fetching the Mapbox Maps SDK for iOS during pod install.
# MAPBOX_DOWNLOADS_TOKEN is set as an EAS secret environment variable.

if [ -n "${MAPBOX_DOWNLOADS_TOKEN:-}" ]; then
  echo "Writing Mapbox credentials to ~/.netrc"
  cat >> ~/.netrc << EOF
machine api.mapbox.com
  login mapboxuser
  password ${MAPBOX_DOWNLOADS_TOKEN}
EOF
  chmod 600 ~/.netrc
else
  echo "WARNING: MAPBOX_DOWNLOADS_TOKEN is not set — pod install may fail"
fi
