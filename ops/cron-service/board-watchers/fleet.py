#!/usr/bin/env python3
"""HELA-6783 hourly fleet watch (founder ask 31.07: check status hourly, relaunch stalls).
Host cron, no LLM tokens. Detects: STALLED open cards without live runs, FAILED last runs,
BLOCKLAG (blocked cards whose blockers are all done/cancelled), STUCK agents.
On NEW findings (vs state file) — or any findings older than REWAKE_HOURS — posts a snapshot
comment on HELA-6783 and creates a narrowly scoped Bravo-2 triage issue.
Quiet hours are logged only."""
import json, os, subprocess, datetime

from service_http import request as service_request

COMPANY = 'ac917a45-e6ea-4696-a85c-991147084939'
ASSIGNEE = '4da0f0c7-471f-4ca6-9f13-3998fab8473e'  # Bravo-2
ISSUE_6783 = '3018b33b-1cf0-4255-9820-617915f8099e'
PG_SERVICE = 'pc_fleet_watch'
STATE = os.path.expanduser('~/fleet-hourly-watch.state.json')
LOG = os.path.expanduser('~/fleet-hourly-watch.log')
REWAKE_HOURS = 6
STALL_MIN = 45

def sql(q):
    result = subprocess.run(
        ['/usr/bin/psql', '-X', '-v', 'ON_ERROR_STOP=1', '-d', PG_SERVICE,
         '-t', '-A', '-F', '\t', '-c', q],
        capture_output=True, text=True, timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError('fleet DB read failed')
    return [line.split('\t') for line in result.stdout.strip().splitlines() if line.strip()]


def findings():
    out = []
    # STALLED: open assigned cards, no live run, quiet > STALL_MIN
    for row in sql(f"""
        SELECT i.identifier, i.status, a.name FROM issues i
        JOIN agents a ON a.id = i.assignee_agent_id
        WHERE i.company_id='{COMPANY}' AND i.hidden_at IS NULL
          AND i.status IN ('todo','in_progress')
          AND i.updated_at BETWEEN now() - interval '10 days'
                                AND now() - interval '{STALL_MIN} minutes'
          AND NOT EXISTS (SELECT 1 FROM heartbeat_runs hr
                          WHERE hr.id = i.execution_run_id AND hr.status='running')"""):
        out.append(('STALLED', row[0], f"{row[1]} @{row[2]}, тихо >{STALL_MIN}м без живого рана"))
    # FAILED: last execution run failed on an open card
    for row in sql(f"""
        SELECT i.identifier FROM issues i
        JOIN heartbeat_runs hr ON hr.id = i.execution_run_id
        WHERE i.company_id='{COMPANY}' AND i.hidden_at IS NULL
          AND i.status IN ('todo','in_progress','in_review') AND hr.status='failed'"""):
        out.append(('FAILED', row[0], 'last run failed'))
    # BLOCKLAG: blocked but every blocker is done/cancelled (stored-status lag) or none linked
    for row in sql(f"""
        SELECT i.identifier FROM issues i
        WHERE i.company_id='{COMPANY}' AND i.hidden_at IS NULL AND i.status='blocked'
          AND i.updated_at BETWEEN now() - interval '36 hours'
                                AND now() - interval '{STALL_MIN} minutes'
          AND NOT EXISTS (SELECT 1 FROM issue_relations r JOIN issues b ON b.id=r.issue_id
                          WHERE r.type='blocks' AND r.related_issue_id=i.id
                            AND b.status NOT IN ('done','cancelled'))"""):
        out.append(('BLOCKLAG', row[0], 'blocked, но открытых блокеров нет (лаг/ручной blocked)'))
    # STUCK agents (watchdog auto-clears, but report if seen)
    for row in sql(f"SELECT name, status FROM agents WHERE company_id='{COMPANY}' AND status IN ('error','offline','crashed')"):
        out.append(('AGENT', row[0], row[1]))
    return out

def main():
    now = datetime.datetime.utcnow()
    f = findings()
    try:
        st = json.load(open(STATE))
    except Exception:
        st = {'seen': [], 'lastWake': None}
    keys = sorted(f'{c}:{k}' for c, k, _ in f)
    new = [x for x in keys if x not in st.get('seen', [])]
    last_wake = st.get('lastWake')
    stale_hours = 999
    if last_wake:
        stale_hours = (now - datetime.datetime.fromisoformat(last_wake)).total_seconds() / 3600
    wake = bool(new) or (bool(f) and stale_hours >= REWAKE_HOURS)
    with open(LOG, 'a') as lg:
        lg.write(f"{now.isoformat()} findings={len(f)} new={len(new)} wake={wake}\n")
    if not wake:
        return
    lines = '\n'.join(f"- **{c}** {k}: {d}" for c, k, d in f) or '- пусто'
    body = (f"## ⏰ Hourly fleet watch (автомат, host-cron)\n\n"
            f"Найдено {len(f)} (новых {len(new)}):\n{lines}\n\n"
            f"Bravo-2: триажируй, перезапусти стойла, закрой ложные и эту карту.")
    if len(body) > 6000:
        body = body[:5900] + "\n\n[Отчёт сокращён; ключи находок сохраняются в state.]"
    # visibility comment on HELA-6783 (self-comment, no wake)
    try:
        service_request('POST', f'/api/issues/{ISSUE_6783}/comments', {'body': body})
    except Exception as e:
        with open(LOG, 'a') as lg:
            lg.write(f"{now.isoformat()} comment POST failed: {e}\n")
    # Wake lever: create a bounded triage card for the process owner.
    card_id = None
    try:
        stamp = now.strftime('%d.%m %H:%MZ')
        resp = service_request('POST', f'/api/companies/{COMPANY}/issues', {
            'title': f'[watch][hourly] {stamp}: {len(f)} находок ({len(new)} новых) — триаж и перезапуск',
            'description': body, 'status': 'todo', 'priority': 'high',
            'assigneeAgentId': ASSIGNEE, 'parentId': ISSUE_6783})
        card_id = (resp.get('issue') or resp).get('identifier')
    except Exception as e:
        with open(LOG, 'a') as lg:
            lg.write(f"{now.isoformat()} card POST failed: {e}\n")
        return
    st = {'seen': keys, 'lastWake': now.isoformat()}
    json.dump(st, open(STATE, 'w'))
    with open(LOG, 'a') as lg:
        lg.write(f"{now.isoformat()} WAKE card={card_id}\n")

if __name__ == '__main__':
    main()
