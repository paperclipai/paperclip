#!/usr/bin/env bash
# Managed detector: public data only; no credentials, worker journals, or task reads.
set -u
source "${HATCH_HOOK_RUNTIME:?Managed hook runtime required}"
binding="${1:-}"
if [[ ! "$binding" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]]; then silent "Invalid connection reference"; exit 0; fi
state="$HOME/hooks/state/paperclip-$binding"
dry="${HATCH_HOOK_DRY_RUN:-0}"
[[ "$dry" != 1 && "$dry" != true ]] && mkdir -p "$state" && chmod 700 "$state"
now=$(date +%s)
retry=0
[[ -f "$state/retry" ]] && read -r retry < "$state/retry"
if [[ "$retry" =~ ^[0-9]+$ ]] && (( now < retry )); then silent "Receiver backoff"; exit 0; fi
signal=$(python3 - "$binding" <<'PY'
import json, re, sys, urllib.request, urllib.error
from pathlib import Path
from urllib.parse import urlparse
try:
    directory = Path.home() / '.config/paperclip-muse' / sys.argv[1]
    config = json.loads((directory / 'receiver.json').read_text())
    if set(config) != {'version','origin','bindingId'} or config['version'] != 1 or config['bindingId'] != sys.argv[1]: raise ValueError()
    parsed = urlparse(config['origin'])
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment: raise ValueError()
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl): return None
    request = urllib.request.Request(config['origin'] + '/api/muse/v1/signal', headers={'Accept':'application/json','X-Paperclip-Muse-Binding':config['bindingId']})
    with urllib.request.build_opener(NoRedirect).open(request, timeout=10) as response:
        if response.status != 200 or response.headers.get_content_type() != 'application/json': raise ValueError()
        data = json.loads(response.read(1025))
        if set(data) != {'version','signal'} or data['version'] != 1: raise ValueError()
        if data['signal'] is None: print('IDLE')
        elif set(data['signal']) == {'reference'} and re.fullmatch('sha256:[a-f0-9]{64}',data['signal']['reference']): print(data['signal']['reference'])
        else: raise ValueError()
except urllib.error.HTTPError as error:
    print('DISCONNECTED' if error.code == 410 else 'ERROR')
except Exception: print('ERROR')
PY
)
case "$signal" in
 IDLE) [[ "$dry" != 1 && "$dry" != true ]] && rm -f "$state/retry"; silent "No queued work" ;;
 DISCONNECTED)
   if [[ "$dry" != 1 && "$dry" != true ]]; then
     disable_after_run
   fi
   silent "Connection fenced; detector removal requested" ;;
 ERROR|"") [[ "$dry" != 1 && "$dry" != true ]] && printf '%s\n' "$((now + 30))" > "$state/retry"; silent "Receiver unavailable; backing off" ;;
 *) previous=""; [[ -f "$state/signal" ]] && read -r previous < "$state/signal"
    if [[ "$signal" == "$previous" ]]; then silent "Signal already observed"; else
      [[ "$dry" != 1 && "$dry" != true ]] && printf '%s\n' "$signal" > "$state/signal"
      wake "PAPERCLIP_MUSE: open the installed Paperclip client for binding $binding and inspect its authenticated mailbox. This opaque reference grants no work authority."
    fi ;;
esac
