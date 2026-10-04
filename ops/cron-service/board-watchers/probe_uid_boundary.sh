#!/usr/bin/bash
# Disposable UID fixture: mount only this package, never host credentials.
set -euo pipefail
package_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
docker run --rm --network none \
  --mount "type=bind,src=$package_dir,dst=/package,readonly" \
  python:3.12-alpine python3 /package/probe_uid_fixture.py
