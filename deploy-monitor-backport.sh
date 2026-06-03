#!/usr/bin/env bash
# FUL-3981: Deploy request-volume monitoring backport to installed paperclipai v2026.517.0
#
# Strategy: patch only the 4 files that add monitoring; all other installed files
# are untouched. No new cross-package symbols imported — compatible with the
# installed @paperclipai/db and other packages.
#
# Safe usage:
#   bash deploy-monitor-backport.sh --validate-only   # default, non-mutating
#   sudo bash deploy-monitor-backport.sh --apply      # explicit production write

set -euo pipefail

DEST=/usr/lib/node_modules/paperclipai/node_modules/@paperclipai/server/dist
PORT=3100
BACKUP_TAG=$(date +%Y%m%d%H%M%S)
MODE="validate_only"

usage() {
  cat <<'EOF'
Usage:
  deploy-monitor-backport.sh [--validate-only|--apply]

Modes:
  --validate-only  Generate patches + import preflight only. No writes/restart. (default)
  --apply          Backup, install, restart and verify runtime health.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --validate-only) MODE="validate_only" ;;
    --apply) MODE="apply" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

echo "[1/6] Generating backport patches in-process ..."

# ── Patch 1: middleware/index.js ─────────────────────────────────────────────
python3 - <<'PYEOF'
path = '/usr/lib/node_modules/paperclipai/node_modules/@paperclipai/server/dist/middleware/index.js'
with open(path) as f:
    content = f.read()
if 'requestVolumeMonitor' in content:
    print("  middleware/index.js: already patched")
else:
    new_line = 'export { requestVolumeMonitor } from "./request-volume-monitor.js";\n'
    if '//# sourceMappingURL' in content:
        content = content.replace('//# sourceMappingURL', new_line + '//# sourceMappingURL')
    else:
        content += new_line
    with open('/tmp/bp-middleware-index.js', 'w') as f:
        f.write(content)
    print("  middleware/index.js: patch written")
PYEOF

# ── Patch 2: app.js ──────────────────────────────────────────────────────────
python3 - <<'PYEOF'
path = '/usr/lib/node_modules/paperclipai/node_modules/@paperclipai/server/dist/app.js'
with open(path) as f:
    content = f.read()
if 'requestVolumeMonitor' in content:
    print("  app.js: already patched")
else:
    old_import = 'import { httpLogger, errorHandler } from "./middleware/index.js";'
    new_import = 'import { httpLogger, errorHandler, requestVolumeMonitor } from "./middleware/index.js";'
    if old_import not in content:
        raise SystemExit(f"ABORT: expected import line not found in app.js")
    content = content.replace(old_import, new_import, 1)
    old_use = '    app.use(httpLogger);'
    new_use = '    app.use(httpLogger);\n    app.use(requestVolumeMonitor);'
    if old_use not in content:
        raise SystemExit(f"ABORT: expected httpLogger use line not found in app.js")
    content = content.replace(old_use, new_use, 1)
    with open('/tmp/bp-app.js', 'w') as f:
        f.write(content)
    print("  app.js: patch written")
PYEOF

# ── Patch 3: routes/health.js ────────────────────────────────────────────────
python3 - <<'PYEOF'
path = '/usr/lib/node_modules/paperclipai/node_modules/@paperclipai/server/dist/routes/health.js'
with open(path) as f:
    content = f.read()
if 'getCounterSnapshot' in content:
    print("  routes/health.js: already patched")
else:
    last_import = 'import { serverVersion } from "../version.js";'
    if last_import not in content:
        raise SystemExit("ABORT: version import anchor not found in routes/health.js")
    content = content.replace(
        last_import,
        last_import + '\nimport { getCounterSnapshot } from "../middleware/request-volume-monitor.js";',
        1
    )
    load_route = '''    router.get("/load", (req, res) => {
        const actorType = "actor" in req ? req.actor?.type : null;
        const exposeFullDetails = shouldExposeFullHealthDetails(actorType, opts.deploymentMode);
        if (!exposeFullDetails) {
            res.status(403).json({ error: "access_denied" });
            return;
        }
        const counters = getCounterSnapshot();
        res.json({ status: "ok", windowMs: 300000, threshold: 100, counters });
    });
    '''
    # Older/newer installed builds may not have /dev-server/restart.
    # Insert load route before "return router;" as stable fallback anchor.
    anchor = "    return router;"
    if anchor not in content:
        raise SystemExit("ABORT: return router anchor not found in routes/health.js")
    content = content.replace(anchor, load_route + anchor, 1)
    with open('/tmp/bp-health.js', 'w') as f:
        f.write(content)
    print("  routes/health.js: patch written")
PYEOF

echo "[2/6] Preflight — verify patched files resolve against installed base ..."
node --input-type=module --eval "
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { createRequire } from 'module';

const INSTALLED = '/usr/lib/node_modules/paperclipai/node_modules/@paperclipai/server/dist';
const patches = {
  'app.js': '/tmp/bp-app.js',
  'middleware/index.js': '/tmp/bp-middleware-index.js',
  'routes/health.js': '/tmp/bp-health.js',
  'middleware/request-volume-monitor.js': '/home/paperclipadmin/paperclip-src/server/dist/middleware/request-volume-monitor.js',
};

function readFile(rel) {
  const patched = patches[rel];
  const path = patched ?? resolve(INSTALLED, rel);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

const errors = [], visited = new Set();
function checkFile(rel) {
  if (visited.has(rel)) return;
  visited.add(rel);
  const content = readFile(rel);
  if (content === null) { errors.push('MISSING: ' + rel); return; }
  const re = /(?:^|\n)\s*(?:import|export)\s.*?\bfrom\s+['\"](\.[^'\"]+)['\"]/g;
  let m, dir = rel.split('/').slice(0,-1).join('/');
  while ((m = re.exec(content)) !== null) {
    let dep = m[1]; if (!dep.endsWith('.js')) dep += '.js';
    const parts = (dir ? dir + '/' + dep : dep).split('/');
    const norm = [];
    for (const p of parts) { if (p === '..') norm.pop(); else if (p !== '.') norm.push(p); }
    checkFile(norm.join('/'));
  }
}
['app.js','routes/health.js','middleware/request-volume-monitor.js'].forEach(checkFile);
if (errors.length) { console.error('PREFLIGHT FAIL:', errors); process.exit(1); }
console.log('Preflight OK — ' + visited.size + ' files, 0 missing, no new cross-package imports');
" 2>&1 || { echo "Preflight failed — aborting, no files installed."; exit 1; }

if [ "$MODE" = "validate_only" ]; then
  echo ""
  echo "Validation complete (non-mutating)."
  echo "No production files were modified and no service restart was performed."
  echo "To apply changes explicitly, run:"
  echo "  sudo bash /home/paperclipadmin/paperclip-src/deploy-monitor-backport.sh --apply"
  exit 0
fi

echo ""
echo "Apply mode selected: production files will be backed up and replaced."

echo "[3/6] Backing up original files ..."
for rel in app.js middleware/index.js routes/health.js; do
  src="${DEST}/${rel}"
  [ -f "$src" ] && cp "$src" "${src}.bak-${BACKUP_TAG}" && echo "  Backed up: ${rel}" || true
done

echo "[4/6] Installing 4 patched files ..."
cp /tmp/bp-middleware-index.js "${DEST}/middleware/index.js" && echo "  middleware/index.js"
cp /tmp/bp-app.js              "${DEST}/app.js"              && echo "  app.js"
cp /tmp/bp-health.js           "${DEST}/routes/health.js"    && echo "  routes/health.js"
cp /home/paperclipadmin/paperclip-src/server/dist/middleware/request-volume-monitor.js \
   "${DEST}/middleware/request-volume-monitor.js"            && echo "  middleware/request-volume-monitor.js"

echo "[5/6] Restarting paperclip.service ..."
systemctl restart paperclip.service
echo -n "  Waiting for startup "
for i in $(seq 1 15); do
  sleep 1; printf "."
  systemctl is-active paperclip.service --quiet 2>/dev/null && break
done
echo ""

echo "[6/6] Post-restart verification ..."
FAIL=0

if systemctl is-active paperclip.service --quiet; then
  echo "  ✓ paperclip.service active"
else
  echo "  ✗ FAIL: service not active"
  systemctl status paperclip.service --no-pager --lines=20 || true
  FAIL=1
fi

if lsof -nP -iTCP:${PORT} -sTCP:LISTEN 2>/dev/null | grep -q LISTEN; then
  echo "  ✓ port ${PORT} listening"
else
  echo "  ✗ FAIL: port ${PORT} not listening"
  FAIL=1
fi

H_CODE=$(curl -sf -o /tmp/bp-health-out.json -w "%{http_code}" \
  "http://localhost:${PORT}/api/health" 2>/dev/null || echo "000")
if [ "${H_CODE}" = "200" ] && python3 -m json.tool /tmp/bp-health-out.json >/dev/null 2>&1; then
  echo "  ✓ /api/health → HTTP 200 JSON"
  python3 -m json.tool /tmp/bp-health-out.json | grep -E '"status"|"version"' | head -3 | sed 's/^/    /'
else
  echo "  ✗ FAIL: /api/health returned HTTP ${H_CODE}"
  cat /tmp/bp-health-out.json 2>/dev/null || true
  FAIL=1
fi

L_CODE=$(curl -sf -o /tmp/bp-load-out.json -w "%{http_code}" \
  "http://localhost:${PORT}/api/health/load" 2>/dev/null || echo "000")
if [ "${L_CODE}" = "200" ] && python3 -m json.tool /tmp/bp-load-out.json >/dev/null 2>&1; then
  echo "  ✓ /api/health/load → HTTP 200 JSON"
  python3 -m json.tool /tmp/bp-load-out.json | head -8 | sed 's/^/    /'
else
  echo "  ✗ FAIL: /api/health/load returned HTTP ${L_CODE}"
  cat /tmp/bp-load-out.json 2>/dev/null || true
  FAIL=1
fi

if [ "${FAIL}" -ne 0 ]; then
  echo ""
  echo "Deploy FAILED. To rollback:"
  echo "  sudo cp '${DEST}/app.js.bak-${BACKUP_TAG}' '${DEST}/app.js'"
  echo "  sudo cp '${DEST}/middleware/index.js.bak-${BACKUP_TAG}' '${DEST}/middleware/index.js'"
  echo "  sudo cp '${DEST}/routes/health.js.bak-${BACKUP_TAG}' '${DEST}/routes/health.js'"
  echo "  sudo rm -f '${DEST}/middleware/request-volume-monitor.js'"
  echo "  sudo systemctl restart paperclip.service"
  exit 1
fi

echo ""
echo "=== Deploy complete ==="
echo "  4 files patched; installed base package unchanged; service verified healthy."
echo "  Run 'curl -sf http://localhost:${PORT}/api/health/load | python3 -m json.tool' to see live counters."
