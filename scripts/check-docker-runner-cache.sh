#!/usr/bin/env bash
# Build the real Docker target twice in a disposable copy of tracked source.
# Export only metadata, avoiding a multi-gigabyte test image in the daemon.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-runner-cache.XXXXXX")"
trap 'rm -rf "$probe_dir"' EXIT
mkdir "$probe_dir/context"
cd "$repo_root"
git ls-files -z | tar -cf - --null -T - | tar -xf - -C "$probe_dir/context"
cd "$probe_dir/context"
export PROBE_DIR="$probe_dir"
cp Dockerfile "$probe_dir/cache-probe.Dockerfile"
cat >> "$probe_dir/cache-probe.Dockerfile" <<'DOCKER'
FROM runner-build AS cache-proof
RUN ./runner/target/release/paperclip-runnerd --build-metadata > /metadata.json
FROM scratch AS cache-proof-export
COPY --from=cache-proof /metadata.json /metadata.json
COPY --from=runner-plan /tmp/runner-recipe.json /recipe.json
FROM scratch AS recipe-proof-export
COPY --from=runner-plan /tmp/runner-recipe.json /recipe.json
DOCKER
build_proof() {
  docker buildx build --file "$probe_dir/cache-probe.Dockerfile" --target cache-proof-export --output "type=local,dest=$probe_dir/$1" --progress plain . 2>&1 | tee "$probe_dir/$1.log"
}
build_proof baseline
python3 - <<'CHECK'
from pathlib import Path
p=Path('packages/paperclip-runner/runner/crates/runner-core/src/bin/paperclip-runnerd.rs')
s=p.read_text(); needle='paperclip-runner/runnerd-build-metadata/v1'
assert s.count(needle)==1
p.write_text(s.replace(needle,needle+'-cache-probe'))
CHECK
build_proof source-change
python3 - <<'CHECK'
import os,json,re
from pathlib import Path
root=Path(os.environ['PROBE_DIR'])
before=json.loads((root/'baseline/metadata.json').read_text())
after=json.loads((root/'source-change/metadata.json').read_text())
assert before['schema']=='paperclip-runner/runnerd-build-metadata/v1'
assert after['schema']==before['schema']+'-cache-probe'
assert (root/'baseline/recipe.json').read_bytes()==(root/'source-change/recipe.json').read_bytes()
log=(root/'source-change.log').read_text()
step=re.search(r'#(\d+) \[runner-deps[^\n]+ RUN cargo chef cook',log)[1]
assert f'#{step} CACHED' in log
assert 'Compiling paperclip-runner-core' in log
print('PASS: unchanged dependency recipe and cached cook layer; real binary changed.')
p=Path('packages/paperclip-runner/runner/Cargo.toml')
s=p.read_text(); assert 'serde_json = "1.0"' in s
p.write_text(s.replace('serde_json = "1.0"','serde_json = ">=1.0.0, <2.0.0"'))
CHECK
docker buildx build --file "$probe_dir/cache-probe.Dockerfile" --target recipe-proof-export --output "type=local,dest=$probe_dir/manifest-change" --progress plain .
python3 - <<'CHECK'
from pathlib import Path
import os
root=Path(os.environ['PROBE_DIR'])
assert (root/'source-change/recipe.json').read_bytes()!=(root/'manifest-change/recipe.json').read_bytes()
print('PASS: dependency declaration change invalidates the recipe.')
CHECK
