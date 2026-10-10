#!/usr/bin/env bash
# Managed detector: reads only its narrow receiver capability; wakes contain references alone.
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
import fcntl, json, os, re, sys, urllib.request, urllib.error
from pathlib import Path
from urllib.parse import urlparse
try:
    directory = Path.home() / '.config/paperclip-muse' / sys.argv[1]
    lock = open(directory / 'client.lock', 'a'); os.chmod(directory / 'client.lock', 0o600)
    try: fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
    except BlockingIOError:
        print('BUSY'); sys.exit(0)
    # Never inspect worker or rotation contents. The client repairs publication.
    if (directory / 'signal-suspended.json').exists() or (directory / 'credential-commit.json').exists():
        print('BUSY'); sys.exit(0)
    config = json.loads((directory / 'signal.json').read_text())
    parsed = urlparse(config['origin'])
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment: raise ValueError()
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl): return None
    request = urllib.request.Request(config['origin'] + '/api/muse/v1/signal', headers={'Accept':'application/json','Authorization':'Bearer '+config['signalToken']})
    with urllib.request.build_opener(NoRedirect).open(request, timeout=10) as response:
        if response.status != 200 or response.headers.get_content_type() != 'application/json': raise ValueError()
        data = json.loads(response.read(1025))
        if set(data) != {'version','signal'} or data['version'] != 1: raise ValueError()
        if data['signal'] is None: print('IDLE')
        elif set(data['signal']) == {'reference'} and re.fullmatch('[a-f0-9-]{36}:[1-9][0-9]*:[1-9][0-9]*:[1-9][0-9]*',data['signal']['reference']): print(data['signal']['reference'])
        else: raise ValueError()
except urllib.error.HTTPError as error:
    print('DISCONNECTED' if error.code in (401,403,410) else 'ERROR')
except Exception: print('ERROR')
PY
)
case "$signal" in
 BUSY) silent "Credential handoff in progress" ;;
 IDLE) [[ "$dry" != 1 && "$dry" != true ]] && rm -f "$state/retry"; silent "No queued work" ;;
 DISCONNECTED)
   if [[ "$dry" != 1 && "$dry" != true ]]; then
     disable_after_run
     python3 - "$binding" <<'PY'
import json,sys,urllib.request
from pathlib import Path
import uuid
try:
    value=json.loads((Path.home()/'.config/paperclip-muse'/sys.argv[1]/'signal.json').read_text())
    body=json.dumps({'version':1,'requestId':str(uuid.uuid4()),'bindingId':value['bindingId'],'generation':value['generation'],'detectorRemovalRequested':True}).encode()
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,req,fp,code,msg,headers,newurl):return None
    request=urllib.request.Request(value['origin']+'/api/muse/v1/detector-cleanup',body,{'Content-Type':'application/json','Authorization':'Bearer '+value['detectorCleanupToken']})
    urllib.request.build_opener(NoRedirect).open(request,timeout=10).close()
except Exception:pass
PY
   fi
   silent "Connection fenced; detector removal requested" ;;
 ERROR|"") [[ "$dry" != 1 && "$dry" != true ]] && printf '%s\n' "$((now + 30))" > "$state/retry"; silent "Receiver unavailable; backing off" ;;
 *) previous=""; [[ -f "$state/signal" ]] && read -r previous < "$state/signal"
    if [[ "$signal" == "$previous" ]]; then silent "Signal already observed"; else
      [[ "$dry" != 1 && "$dry" != true ]] && printf '%s\n' "$signal" > "$state/signal"
      wake "PAPERCLIP_MUSE: open the installed Paperclip client for binding $binding and inspect its authenticated mailbox. This opaque reference grants no work authority."
    fi ;;
esac
