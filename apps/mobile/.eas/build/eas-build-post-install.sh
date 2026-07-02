#!/usr/bin/env bash
set -euo pipefail

echo "=== EAS post-install hook running ==="
echo "MAPBOX_DOWNLOADS_TOKEN set: $([ -n "${MAPBOX_DOWNLOADS_TOKEN:-}" ] && echo YES || echo NO)"

# Write Mapbox download credentials to ~/.netrc so CocoaPods can authenticate
# when fetching the Mapbox Maps SDK for iOS during pod install.
# MAPBOX_DOWNLOADS_TOKEN is set as an EAS secret environment variable.

if [ -n "${MAPBOX_DOWNLOADS_TOKEN:-}" ]; then
  echo "Writing Mapbox credentials to ~/.netrc"
  printf 'machine api.mapbox.com\n  login mapboxuser\n  password %s\n' "${MAPBOX_DOWNLOADS_TOKEN}" >> ~/.netrc
  chmod 600 ~/.netrc
  echo "~/.netrc written successfully"
  grep "api.mapbox.com" ~/.netrc && echo "Verified entry exists" || echo "WARNING: entry not found"
else
  echo "WARNING: MAPBOX_DOWNLOADS_TOKEN is not set — pod install may fail"
fi

echo "=== EAS post-install hook complete ==="
