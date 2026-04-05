#!/usr/bin/env bash
# Print a suggested PATH= line for LaunchAgent plist EnvironmentVariables.
# Run from a login/interactive shell where your agent CLIs already work, then
# merge the printed PATH with Homebrew (keep /opt/homebrew/bin or /usr/local/bin).

set -euo pipefail

echo "# Suggested PATH for ~/Library/LaunchAgents/io.paperclip.local.plist (merge with Homebrew):"
printf 'PATH=%q\n' "${PATH}"
