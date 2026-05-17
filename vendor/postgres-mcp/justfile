#!/usr/bin/env just --justfile
set shell := ["zsh", "-cu"]
set fallback

default:
  just -u --list

test:
  npx @wong2/mcp-cli uv run python -m crystaldba.postgres_mcp

dev:
  uv run mcp dev -e . crystaldba/postgres_mcp/server.py

nix-claude-desktop:
  NIXPKGS_ALLOW_UNFREE=1 nix run "github:k3d3/claude-desktop-linux-flake#claude-desktop-with-fhs" --impure

release-help:
  @echo "- update version in pyproject.toml"
  @echo "- uv sync"
  @echo "- git commit"
  @echo "- git push && merge to main"
  @echo '- just release 0.0.0 "note"'
  @echo 'OR'
  @echo '- just prerelease 0.0.0 1 "note"'

release version note extra="": # ="Release v{{version}}" extra="": # NOTE version format should be 0.0.0
  #!/usr/bin/env bash
  if [[ "{{version}}" == v* ]]; then
    echo "Error: Do not include 'v' prefix in version. It will be added automatically."
    exit 1
  fi
  uv build && git tag -a "v{{version}}" -m "Release v{{version}}" || true && git push --tags && gh release create "v{{version}}" --title "PostgreSQL MCP v{{version}}" --notes "{{note}}" {{extra}} dist/*.whl dist/*.tar.gz

prerelease version rc note: #="Release candidate {{rc}} for version {{version}}":
  just release "{{version}}rc{{rc}}" "{{note}}" "--prerelease"
