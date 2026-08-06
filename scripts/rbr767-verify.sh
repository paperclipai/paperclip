#!/usr/bin/env bash
# RBR-767 live verification: proves POST /api/companies/{id}/issues and
# POST /api/issues/{id}/children can no longer mint an invisible (unassigned) issue.
#
# Runs against a throwaway verification instance, NOT production.
set -euo pipefail

L="${RBR767_API:-http://127.0.0.1:3199/api}"
KEY="${PAPERCLIP_API_KEY:?PAPERCLIP_API_KEY must be set}"
VC="${RBR767_COMPANY:?RBR767_COMPANY must be set}"

hdr=(-H "Authorization: Bearer $KEY" -H "Content-Type: application/json")

post() { curl -sS -m 20 -X POST "$L$1" "${hdr[@]}" --data-binary "$2"; }

mkagent() { # name reportsTo(json)
  post "/companies/$VC/agents" "$(jq -n --arg n "$1" --argjson r "$2" \
    '{name:$n, adapterType:"http", adapterConfig:{url:"http://127.0.0.1:9/never-invoked"}, reportsTo:$r}')"
}

echo "### 0. Org chart"
CEO=$(mkagent "Verify CEO" null | jq -r .id)
CTO=$(mkagent "Verify CTO" "\"$CEO\"" | jq -r .id)
CISO=$(mkagent "Verify CISO" "\"$CEO\"" | jq -r .id)
STAFF=$(mkagent "Verify Staff Engineer" "\"$CTO\"" | jq -r .id)
echo "CEO=$CEO"; echo "CTO=$CTO"; echo "CISO=$CISO"; echo "STAFF=$STAFF"

mkissue() { post "/companies/$VC/issues" "$1"; }

echo
echo "### 1. BEFORE-equivalent: create with assigneeAgentId:null, assigneeUserId:null"
echo "###    (this is the exact payload shape that produced RBR-217 / RBR-756 / RBR-757)"
R1=$(mkissue "$(jq -n '{title:"RBR-767 probe: unassigned, no parent", priority:"high",
                        status:"todo", assigneeAgentId:null, assigneeUserId:null}')")
echo "$R1" | jq '{identifier, status, priority, assigneeAgentId, assigneeUserId}'
A1=$(echo "$R1" | jq -r .assigneeAgentId)
I1=$(echo "$R1" | jq -r .id)

echo
echo "### 2. Omit the assignee fields entirely (the one-field-omission failure mode)"
R2=$(mkissue "$(jq -n '{title:"RBR-767 probe: assignee fields omitted", priority:"critical", status:"todo"}')")
echo "$R2" | jq '{identifier, status, priority, assigneeAgentId}'
A2=$(echo "$R2" | jq -r .assigneeAgentId)

echo
echo "### 3. backlog status is NOT excluded -- it gets an owner too"
R3=$(mkissue "$(jq -n '{title:"RBR-767 probe: unassigned backlog item", priority:"low",
                        status:"backlog", assigneeAgentId:null, assigneeUserId:null}')")
echo "$R3" | jq '{identifier, status, assigneeAgentId}'
A3=$(echo "$R3" | jq -r .assigneeAgentId)

echo
echo "### 4. Rung 1 (parent): child of an issue owned by CISO inherits CISO"
PARENT=$(mkissue "$(jq -n --arg a "$CISO" '{title:"RBR-767 probe: parent owned by CISO",
                        status:"todo", assigneeAgentId:$a}')")
PID=$(echo "$PARENT" | jq -r .id)
echo "parent assignee: $(echo "$PARENT" | jq -r .assigneeAgentId)  (CISO=$CISO)"
R4=$(post "/issues/$PID/children" "$(jq -n '{title:"RBR-767 probe: unassigned child",
                        status:"todo", assigneeAgentId:null, assigneeUserId:null}')")
echo "$R4" | jq '{identifier, status, assigneeAgentId}'
A4=$(echo "$R4" | jq -r .assigneeAgentId)

echo
echo "### 5. Explicit assignee is untouched (no behaviour change on the normal path)"
R5=$(mkissue "$(jq -n --arg a "$STAFF" '{title:"RBR-767 probe: explicit assignee",
                        status:"todo", assigneeAgentId:$a}')")
echo "$R5" | jq '{identifier, assigneeAgentId}'
A5=$(echo "$R5" | jq -r .assigneeAgentId)

echo
echo "### 6. Determinism: same payload three times -> same owner"
D=()
for _ in 1 2 3; do
  D+=("$(mkissue "$(jq -n '{title:"RBR-767 probe: determinism", status:"todo", assigneeAgentId:null}')" | jq -r .assigneeAgentId)")
done
echo "owners: ${D[0]} ${D[1]} ${D[2]}"

echo
echo "### 7. Activity log records the fallback decision (auditable, not silent)"
curl -sS -m 20 "$L/companies/$VC/activity?limit=80" "${hdr[@]}" \
  | jq '[.[]? | select(.entityId=="'"$I1"'" and .action=="issue.created")
        | .details | {assigneeFallbackApplied, assigneeFallbackReason, assigneeFallbackAgentId}] | .[0]'

echo
echo "### 8. Board-wide invariant: zero unassigned issues in this company"
curl -sS -m 20 "$L/companies/$VC/issues?limit=200" "${hdr[@]}" \
  | jq '{total: length,
         unassigned: [.[] | select(.assigneeAgentId==null and .assigneeUserId==null)] | length,
         unassignedNonTerminal: [.[] | select(.assigneeAgentId==null and .assigneeUserId==null
                                   and (.status|IN("done","cancelled")|not))] | length}'

echo
echo "=========== ASSERTIONS ==========="
fail=0
chk() { if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1 (got '$2', want '$3')"; fail=1; fi; }
chk "1 unassigned+no-parent -> creator_manager/root, not null" "$([ "$A1" != "null" ] && echo ok)" "ok"
chk "2 omitted fields       -> owned"                          "$([ "$A2" != "null" ] && echo ok)" "ok"
chk "3 backlog              -> owned (not excluded)"           "$([ "$A3" != "null" ] && echo ok)" "ok"
chk "4 child inherits parent assignee (CISO)"                  "$A4" "$CISO"
chk "5 explicit assignee preserved (STAFF)"                    "$A5" "$STAFF"
chk "6 deterministic across repeats"                           "$([ "${D[0]}" = "${D[1]}" ] && [ "${D[1]}" = "${D[2]}" ] && echo ok)" "ok"
echo "=================================="
exit $fail
