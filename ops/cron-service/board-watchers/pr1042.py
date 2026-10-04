#!/usr/bin/env python3
"""HELA-12359 (Juliet, fcd82af7): будит карту HELA-12359 на события во FE-PR круга 2 (ветка N2).

Поставлен 29.09.2026, ран 71d729aa. Круг 1 (#950) влит 27.09 17:02Z (squash d46aea85). Круг 2 перебазирован на
`main` и открыт отдельным PR (решение Hotel, документ `round2-n2`). Вливает человек (Саша ToryanikA / Денис ab7nt),
auto-merge в репо выключен. После мержа main сам выкатывается на dev (~/helloprint/fe-live/current — имя релиза
начинается с SHA main). Приёмка Hotel — D4-бис ПОСЛЕ выката, поэтому терминал сторожа — «влит И выкачен». Карта
запаркована `blocked` без рёбер; будит этот крон узким сервисным ключом и пишет ТОЛЬКО в неё (память
board-has-no-parking-status-for-external-waits). Каркас — ~/hela-12359-pr950-watch.py, guard v2 — ~/hela-4553-pr-watch.py.

События (каждое один раз):
  * PR влит И выкачен на dev (merge-коммит — предок SHA релиза fe-live/current) -> ФИНАЛЬНЫЙ вейк (D4-бис), разоружиться.
  * PR влит, но за DEPLOY_GRACE не выкачен -> вейк один раз (сторож ждёт выката дальше).
  * PR закрыт БЕЗ мержа          -> ФИНАЛЬНЫЙ вейк (выяснить причину), разоружиться.
  * новый отзыв ЧЕЛОВЕКА (коммент/ревью/строчный; не агентская учётка и не бот) -> вейк.
  * новая голова открытого PR -> вейк один раз на голову.
  * required-чек головы открытого PR завершился не success -> вейк один раз на (голова, чек, id).
  * READ_FAIL_LIMIT тиков подряд падает чтение GitHub -> вейк один раз на серию («сторож ослеп»).
  * DEADLINE                     -> ФИНАЛЬНЫЙ вейк, разоружиться.
Первый тик пишет baseline (существующие отзывы и текущая голова не будят).

Guard v2: перед вейком GET карты. done/cancelled — молча разоружиться. Чужой ассайни или in_review — HOLD: вейк не
отправлен, событие ждёт до возврата карты (на дедлайне HOLD = разоружиться). Так сторож #950 потерял вейк мержа:
27.09 17:03Z разоружился на `blocked/<recovery owner>`. Вейк: на `blocked` PATCH {status: in_progress, comment}
(fallback — голый POST /comments), иначе голый POST /comments. URLError/HTTPError — повтор на следующем тике; сырой
таймаут на чтении ответа — считать доставленным (память host-watchdog-wake-timeout-duplicates).
Живость: STAMP трогается каждый тик. `--dry-run`: всё читает, вместо записи печатает. Самотест:
~/hela-12359-r2-pr-watch.selftest.py.
"""
import datetime
import json
import os
import sys
import urllib.error

from github_api import get_json
from service_http import request as service_request
from verify_boundary import root_owned_chain

ISSUE = '02af846b-1399-4ba0-ba47-12831bb39024'      # HELA-12359
ASSIGNEE = 'fcd82af7-5cf9-48b8-b361-e43d9d9eaf17'   # Juliet (Builder)
REPO = 'HelloPrintERP/helloprint-frontend'
PR = 1042                                            # frontend#1042 — PR круга 2, открыт 29.09 ~07:1xZ
ROUND2_BRANCH = 'feat/HELA-12359-r2-n2-strategy'
REQUIRED = ('unit-and-static', 'contract-snapshots')  # required-чеки ruleset FE main
AGENT_LOGINS = ('dmitrynovikov21',)                  # общая агентская учётка
FE_RELEASE_SHA_FILE = '/etc/paperclip-cron/fe-release-sha'
DEPLOY_GRACE = datetime.timedelta(hours=3)
DEADLINE = datetime.datetime(2026, 10, 6, 9, 0, tzinfo=datetime.timezone.utc)
READ_FAIL_LIMIT = 6
HOME_DIR = os.path.expanduser('~/.hela-12359-r2-pr-watch')
STATE = os.path.join(HOME_DIR, 'state.json')
STAMP = os.path.join(HOME_DIR, 'stamp')
DISARM = os.path.join(HOME_DIR, 'disarmed')
CRON_TAG = 'hela-12359-r2-pr-watch.py'
DRY = '--dry-run' in sys.argv

SIGN = ('\n\n🔴 Текст поставлен машиной: root-owned host watcher pc-watch-12359; узкий сервисный ключ, только своя карта. Это **не** founder и не агент.')
TAIL = ('\n\n**Снять сторожа:** после финального события root-оператор отключает pc-watch-12359.timer и проверяет, что старый crontab entry не возвращён.')
KEEP = ' Сторож продолжает смотреть PR.'


def now():
    return datetime.datetime.now(datetime.timezone.utc)


def log(msg):
    print('%s %s' % (now().strftime('%Y-%m-%dT%H:%M:%SZ'), msg), flush=True)


def gh_json(path):
    return get_json(path)


def board_req(method, path, payload=None):
    return service_request(method, '/api' + path, payload)


def is_human(login):
    return bool(login) and login not in AGENT_LOGINS and not login.endswith('[bot]')


def release_sha():
    """Read a root-owned release attestation, never an agent-writable symlink."""
    root_owned_chain(FE_RELEASE_SHA_FILE)
    with open(FE_RELEASE_SHA_FILE, encoding='ascii') as source:
        sha = source.read().strip()
    if len(sha) < 7 or any(ch not in '0123456789abcdef' for ch in sha):
        raise RuntimeError('invalid root-owned FE release SHA attestation')
    return sha


def deployed(merge_sha):
    """(выкачен ли merge-коммит, SHA релиза). Предок ⇔ compare merge...release = ahead/identical."""
    rel = release_sha()
    cmp = gh_json('repos/%s/compare/%s...%s' % (REPO, merge_sha, rel))
    return cmp.get('status') in ('ahead', 'identical'), rel


def read_world():
    """Всё чтение GitHub по PR (подменяется в самотесте)."""
    p = gh_json('repos/%s/pulls/%d' % (REPO, PR))
    head = p['head']['sha']
    checks = gh_json('repos/%s/commits/%s/check-runs?per_page=100' % (REPO, head))['check_runs']
    feedback = []
    for kind, path, when in (
            ('коммент', 'repos/%s/issues/%d/comments?per_page=100' % (REPO, PR), 'created_at'),
            ('ревью', 'repos/%s/pulls/%d/reviews?per_page=100' % (REPO, PR), 'submitted_at'),
            ('строчный коммент', 'repos/%s/pulls/%d/comments?per_page=100' % (REPO, PR), 'created_at')):
        for x in gh_json(path):
            feedback.append({'key': '%s:%s' % (kind, x['id']), 'kind': kind, 'login': (x.get('user') or {}).get('login'),
                             'at': x.get(when), 'state': x.get('state'), 'url': x.get('html_url')})
    w = {'state': p['state'], 'merged': bool(p.get('merged')), 'merged_at': p.get('merged_at'),
         'merge_sha': p.get('merge_commit_sha'),
         'head': head,
         'checks': [{'name': c['name'], 'status': c['status'], 'conclusion': c.get('conclusion'),
                     'id': c['id'], 'url': c.get('html_url')} for c in checks],
         'feedback': feedback, 'deployed': False, 'release': None}
    if w['merged'] and w['merge_sha']:
        w['deployed'], w['release'] = deployed(w['merge_sha'])
    return w


def card():
    c = board_req('GET', '/issues/%s' % ISSUE)
    return c.get('issue') if isinstance(c.get('issue'), dict) else c


def wake(text, note):
    """Guard v2 по карте, затем PATCH{status,comment} на blocked / голый POST иначе.

    'woke' — доставлено (или считается доставленным); 'disarm' — карта закрыта, молча разоружиться;
    'hold' — карта не у меня или в in_review: не будить, событие ждёт; 'retry' — не доставлено, повтор.
    """
    body = text + SIGN
    try:
        c = card()
    except Exception as e:
        log('card read failed (%s): %s' % (note, str(e)[:160]))
        return 'retry'
    status = c.get('status')
    if status in ('done', 'cancelled'):
        log('DISARM silent (%s): card %s' % (note, status))
        if not DRY:
            open(DISARM, 'w').write('%s card closed: %s\n' % (now().isoformat(), status))
        return 'disarm'
    if c.get('assigneeAgentId') != ASSIGNEE or status == 'in_review':
        log('HOLD (%s): card %s/%s' % (note, status, (c.get('assigneeAgentId') or '-')[:8]))
        return 'hold'
    if DRY:
        print('DRY-RUN wake (%s, card %s):\n%s\n' % (note, status, body))
        return 'woke'
    try:
        if status == 'blocked':
            try:
                board_req('PATCH', '/issues/%s' % ISSUE, {'status': 'in_progress', 'comment': body})
            except urllib.error.HTTPError as e:
                log('PATCH wake failed HTTP %s (%s), fallback POST /comments' % (e.code, note))
                board_req('POST', '/issues/%s/comments' % ISSUE, {'body': body})
        else:
            board_req('POST', '/issues/%s/comments' % ISSUE, {'body': body})
    except urllib.error.URLError as e:          # в т.ч. HTTPError: запрос не ушёл или отбит — повтор на следующем тике
        log('WAKE FAILED (%s): %s %s' % (note, type(e).__name__, str(e)[:160]))
        return 'retry'
    except (OSError, ValueError) as e:          # таймаут/обрыв на чтении ответа: запрос ушёл, почти наверняка применён
        log('WAKE UNCERTAIN (%s), считаю доставленным: %s %s' % (note, type(e).__name__, str(e)[:160]))
        return 'woke'
    log('WOKE (%s)' % note)
    return 'woke'


def pr_line(w):
    if w is None:
        return 'состояние frontend#%d прочитать не удалось' % PR
    if w['merged']:
        return 'frontend#%d влит %s, merge-коммит `%s`, голова `%s` ([коммит](https://github.com/%s/commit/%s)); dev раздаёт `%s`' % (
            PR, w['merged_at'], (w['merge_sha'] or '?')[:10], w['head'][:9], REPO, w['head'],
            w.get('release') or '?')
    return 'frontend#%d `%s`, голова `%s`' % (PR, w['state'], w['head'][:9])


def once(state, tag, text, note):
    """Событие один раз. True — сторож должен разоружиться (карта закрыта)."""
    woken = state.setdefault('woken', [])
    if tag in woken:
        return False
    r = wake(text, note)
    if r == 'woke':
        woken.append(tag)
    return r == 'disarm'


def parse_ts(s):
    return datetime.datetime.strptime(s, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc)


def tick(state):
    """Один тик. Возвращает True, если сторож должен разоружиться."""
    try:
        w = read_world()
        state['read_fail'] = 0
    except Exception as e:
        w = None
        state['read_fail'] = state.get('read_fail', 0) + 1
        log('read frontend#%d failed #%d: %s' % (PR, state['read_fail'], str(e)[:200]))
    line = pr_line(w)

    if now() > DEADLINE:
        r = wake('⏰ **HELA-12359: дедлайн сторожа PR круга 2 (%s) истёк**; %s. Если PR не влит — спросить в PR '
                 '`@ToryanikA` (Саша) или `@ab7nt` (Денис), что держит мерж, и при необходимости поставить нового '
                 'сторожа. Если влит и выкачен — D4-бис (документ `round2-n2` §4). Этот сторож разоружён.%s'
                 % (DEADLINE.strftime('%Y-%m-%d %H:%MZ'), line, TAIL), 'deadline')
        return r != 'retry'
    if state.get('read_fail') == READ_FAIL_LIMIT:
        if once(state, 'blind:%s' % now().strftime('%Y%m%d%H%M'),
                '🙈 **HELA-12359: сторож PR круга 2 ослеп**: %d тиков подряд падает чтение GitHub/релиза. Проверить '
                'service-private GitHub credential, root-owned FE release attestation и лог '
                '`~/.hela-12359-r2-pr-watch/watch.log`; состояние frontend#%d проверить руками. Сторож продолжает попытки.'
                % (READ_FAIL_LIMIT, PR), 'blind'):
            return True
    if w is None:
        return False

    if 'seen' not in state:                                 # первый тик — baseline
        state['seen'] = [f['key'] for f in w['feedback']]
        state['head'] = w['head']
        log('baseline: feedback=%d head=%s' % (len(state['seen']), w['head'][:9]))
    seen = state['seen']

    if w['merged']:
        if w['deployed']:
            r = wake('✅ **HELA-12359: PR круга 2 влит и выкачен на dev**. %s.\n'
                     'Дальше — D4-бис (документ `round2-n2` §4):\n'
                     '1. root-owned FE release attestation содержит оба merge-коммита, #950 `d46aea85` и '
                     'круга 2 (`git merge-base --is-ancestor`).\n'
                     '2. Бандл `https://any.helloprint.ru/`: маркер строгой ветки и маркер ветки N2, доказанный на '
                     'двух сборках; старой группировки по `material_id` нет.\n'
                     '3. Браузер, `tenant_mdm`, без подмен: 16 и 73 → «по листам» доступна.\n'
                     '4. Браузер с подменой `GET /api/v1/products/sheet-formats?is_active=true…` будущим контрактом '
                     '(`future_contract_readonly.sql`): 16 → доступна, 90 → нет, 73 → доступна, а черновик на '
                     'реальном BE даёт деталь с пометкой `purchased_format_not_set`. `substituted: true`, sha256 SQL; '
                     'черновики снести.\n'
                     '5. Скрины — вложением. 6. `GET HELA-12118` содержит Р3-бис (HELA-12375).\n'
                     'Затем пересдача `in_review` на стадию Hotel. Сторож разоружён.%s' % (line, TAIL),
                     'merged+deployed')
            if r == 'hold':
                return False
            return r != 'retry'
        merged_at = parse_ts(w['merged_at']) if w['merged_at'] else now()
        if now() - merged_at > DEPLOY_GRACE:
            if once(state, 'undeployed:%s' % (w['merge_sha'] or '?')[:12],
                    '⚠️ **HELA-12359: PR круга 2 влит, но за %d ч не выкачен на dev**. %s. Проверить выкат FE '
                    '(root-owned FE release attestation, `https://any.helloprint.ru/version.json`) и, '
                    'если деплой встал, найти владельца выката. Сторож ждёт выката дальше.'
                    % (DEPLOY_GRACE.total_seconds() // 3600, line), 'undeployed'):
                return True
        log('tick: frontend#%d merged, not deployed yet (release %s)' % (PR, w.get('release')))
        return False
    if w['state'] == 'closed':
        r = wake('⛔ **HELA-12359: frontend#%d (круг 2) закрыт БЕЗ мержа** (голова `%s`). Выяснить в PR причину '
                 '(дубль? скоуп уехал в чужой PR?). Проверять по `origin/main` фронта (`git log origin/main -- '
                 'src/features/calculators/run-calc/lib/strategy-formats.ts`), а не по ветке `%s`. Сторож разоружён.%s'
                 % (PR, w['head'][:9], ROUND2_BRANCH, TAIL), 'closed')
        if r == 'hold':
            return False
        return r != 'retry'

    fresh = [f for f in w['feedback'] if f['key'] not in seen]
    human = [f for f in fresh if is_human(f['login'])]
    if human:
        text = '\n'.join('- %s `%s` %s%s — %s' % (f['kind'], f['login'], f['at'] or '',
                                                   (' (%s)' % f['state']) if f['state'] else '',
                                                   f['url'] or '') for f in human)
        r = wake('💬 **HELA-12359: в frontend#%d (круг 2) новый отзыв человека** (%s):\n%s\n\nОткрыть отзыв по ссылке в GitHub. Первым делом '
                 '`gh pr view %d --json state,mergedAt,headRefOid`: Саша вливает через минуты после своего отзыва. '
                 'Правки — пушем в `%s` из `fe-wt-HELA-12359-r2` в каталоге агента.%s'
                 % (PR, line, text, PR, ROUND2_BRANCH, KEEP), 'feedback')
        if r == 'disarm':
            return True
        if r == 'woke':
            seen.extend(f['key'] for f in fresh)
    else:
        seen.extend(f['key'] for f in fresh)   # агентские/ботовые — просто в baseline

    if w['state'] == 'open' and w['head'] != state.get('head'):
        htag = 'head:%s' % w['head'][:12]
        r = 'woke' if htag in state.setdefault('woken', []) else wake(
            '🔀 **HELA-12359: в frontend#%d (круг 2) новая голова `%s`**. '
            '[Коммит](https://github.com/%s/commit/%s). Прочитать дельту от `%s`: «Update branch» от человека — норма (сверить '
            '`git merge-tree`), чужая правка гарда — разобрать.%s'
            % (PR, w['head'][:9], REPO, w['head'],
               (state.get('head') or '?')[:9], KEEP), 'head')
        if r == 'disarm':
            return True
        if r == 'woke':
            if htag not in state['woken']:
                state['woken'].append(htag)
            state['head'] = w['head']

    if w['state'] == 'open':
        latest = {}
        for c in w['checks']:
            if c['name'] in REQUIRED and (c['name'] not in latest or c['id'] > latest[c['name']]['id']):
                latest[c['name']] = c
        for name, c in sorted(latest.items()):
            if c['status'] != 'completed' or c['conclusion'] in ('success', 'skipped', 'neutral'):
                continue
            if once(state, 'check:%s:%s:%s' % (w['head'][:12], name, c['id']),
                    '🟥 **HELA-12359: required `%s` на голове frontend#%d `%s` — `%s`** ([джоба](%s)). Развести по '
                    'упавшему шагу против `main`: красный main, дрейф или флейк раннера — не дефект PR. CI не отменять '
                    'и не перезапускать (приказ founder\'а 24.09).%s'
                    % (name, PR, w['head'][:9], c['conclusion'], c['url'], KEEP),
                    'check:%s' % name):
                return True
    log('tick: frontend#%d %s merged=%s head=%s fresh=%d human=%d' % (PR, w['state'], w['merged'], w['head'][:9],
                                                                       len(fresh), len(human)))
    return False


def save(state):
    tmp = STATE + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(state, f, indent=1)
    os.replace(tmp, STATE)


def main():
    if PR <= 0:
        raise SystemExit('PR не вписан')
    os.makedirs(HOME_DIR, exist_ok=True)
    if not DRY:
        open(STAMP, 'w').write(now().isoformat())
    if os.path.exists(DISARM):
        return
    try:
        state = json.load(open(STATE))
    except Exception:
        state = {}
    try:
        done = tick(state)
    finally:
        if not DRY:
            save(state)
    if DRY:
        return
    if done:
        open(DISARM, 'w').write(now().isoformat() + '\n')
        log('disarmed')


if __name__ == '__main__':
    main()
