#!/usr/bin/env python3
# Widen the `paperclip` EspoCRM API user's role to FULL access on every ACL scope.
# Host has python3 + curl but no node, so this is stdlib-only (urllib).
# Alan runs it in his own session so the admin credential stays with him:
#   ! ESPO_ADMIN_PW=$(docker exec divino-crm-web printenv ESPOCRM_ADMIN_PASSWORD) \
#       python3 /home/ckhermes/paperclip/.ckshots/widen-espo-role.py
# Optional: NO_DELETE=1 to grant everything EXCEPT delete (keeps the safety rail).
# Idempotent + reversible (re-scope the role in the Espo UI anytime).
import base64, json, os, sys, urllib.request, urllib.error

BASE = "http://127.0.0.1:8085/api/v1"
PW = os.environ.get("ESPO_ADMIN_PW")
NO_DELETE = os.environ.get("NO_DELETE") == "1"
if not PW:
    sys.exit("Set ESPO_ADMIN_PW (see header).")
AUTH = "Espo-Authorization: " + base64.b64encode(("admin:" + PW).encode()).decode()
HDR = {"Espo-Authorization": base64.b64encode(("admin:" + PW).encode()).decode(),
       "Content-Type": "application/json"}

def api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers=HDR, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            t = r.read().decode()
            return json.loads(t) if t else {}
    except urllib.error.HTTPError as e:
        reason = e.headers.get("X-Status-Reason") or ""
        body = e.read().decode()[:400]
        sys.exit(f"{method} {path} -> {e.code}\n  X-Status-Reason: {reason}\n  body: {body}")

# 1) all ACL-controlled scopes — shape each correctly:
#    entity scopes take an object of ONLY their supported actions; non-entity acl
#    scopes (Calendar, GlobalStream, OpenApi, Activities, ...) take a plain "yes".
meta = api("GET", "/Metadata")
scopes = meta.get("scopes", {})
DEFAULT5 = ["create", "read", "edit", "delete", "stream"]
def grant_for(action):
    if action == "read":
        return "all"
    if action == "delete":
        return "no" if NO_DELETE else "yes"
    return "yes"
data, ent, nonent = {}, [], []
for name, s in scopes.items():
    if not (s and s.get("acl")):
        continue
    if s.get("entity"):
        actions = s.get("aclActionList") or DEFAULT5
        data[name] = {a: grant_for(a) for a in actions}
        ent.append(name)
    else:
        data[name] = True  # non-entity acl scope: JSON boolean, not a level string
        nonent.append(name)
print(f"ACL scopes{' (no delete)' if NO_DELETE else ''}: {len(data)} "
      f"({len(ent)} entity, {len(nonent)} non-entity)")

# 2) find the paperclip API user + its role
u = api("GET", "/User?where[0][type]=equals&where[0][attribute]=userName"
              "&where[0][value]=paperclip&select=id,userName,rolesIds&maxSize=1")
if not u.get("total"):
    sys.exit("API user 'paperclip' not found")
user = u["list"][0]
# Send ONLY name + data. The other permission scalars have restricted enums and
# aren't needed for entity API access; leaving them out keeps the role's current values.
role_full = {
    "name": "Paperclip Integration (FULL)",
    "data": data,
}
# PUT/POST that returns (ok, reason) instead of exiting, so we can self-heal levels.
def write_role(method, path, payload):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(),
                                 headers=HDR, method=method)
    try:
        with urllib.request.urlopen(req) as r:
            t = r.read().decode()
            return True, (json.loads(t) if t else {})
    except urllib.error.HTTPError as e:
        return False, (e.headers.get("X-Status-Reason") or e.read().decode()[:200])

# Espo level hierarchy (docs): yes, all, team, own, no. Default read=all; boolean
# scopes (e.g. Currency) reject "all" -> Espo names them, we downgrade that scope to "yes".
import re as _re
HEAL = _re.compile(r"Level `(\w+)` is not allowed for action \*(\w+)\* for \*(\w+)\*")
role_id = (user.get("rolesIds") or [None])[0]
heals = 0
while True:
    if role_id:
        ok, res = write_role("PUT", "/Role/" + role_id, role_full)
    else:
        ok, res = write_role("POST", "/Role", role_full)
    if ok:
        if not role_id:
            role_id = res["id"]
            api("PUT", "/User/" + user["id"], {"rolesIds": [role_id]})
            print(f"Created role {role_id} and assigned to paperclip user", end="")
        else:
            print(f"Updated existing role {role_id} -> FULL", end="")
        print(f" ({heals} boolean-scope level fixes)")
        break
    m = HEAL.search(res if isinstance(res, str) else "")
    if not m:
        sys.exit(f"Role write failed (unhandled): {res}")
    _lvl, action, scope = m.groups()
    if scope in data and data[scope] is not True:
        data[scope] = True  # not level-based: this is a boolean-ACL scope -> grant as boolean
        heals += 1
        if heals > 60:
            sys.exit("too many level fixes; aborting")
    else:
        sys.exit(f"cannot heal scope={scope} action={action}: {res}")

print("Role written. Tell Claude to clear the Espo cache and verify reachability.")
