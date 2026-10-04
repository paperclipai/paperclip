#!/usr/bin/env python3
"""HELA-12343 (Database Engineer, c281b1e9): будит пост-мерж карту HELA-12340 на события в BE-PR #1198.

Поставлен 25.09.2026 ~10:4xZ, ран 87e5646e. PR #1198 (фикс двери округления, HELA-12340) вливает человек
(ToryanikA/Саша), доска о мерже не узнаёт, а монитор доски на `blocked` не стреляет (память
board-has-no-parking-status-for-external-waits). Карта HELA-12343 запаркована `blocked` без рёбер, будит этот
крон узким сервисным ключом. Образец — ~/hela-11453-merge-watch.py (except-ветки и атомарный save оттуда).

Отличие от образца: мерж НЕ финальное событие. Заказ REQ-4 (прод-перепись) лежит в беседе PR, и ответ Саши
может прийти после мержа. Поэтому сторож после мержа продолжает смотреть беседу PR до дедлайна или до guard.

События (каждое один раз):
  * PR влит                                   -> вейк (пост-мерж шаги из описания карты).
  * PR закрыт БЕЗ мержа                       -> вейк (выяснить причину).
  * новый отзыв ЧЕЛОВЕКА (коммент/ревью/строчный; не агентская учётка и не бот) -> вейк. Сюда же ответ по REQ-4.
  * новая голова открытого PR -> вейк один раз на голову.
  * required-чек головы открытого PR завершился не success -> вейк один раз на (голова, чек, id).
  * READ_FAIL_LIMIT тиков подряд падает чтение GitHub -> вейк один раз на серию («сторож ослеп»).
  * DEADLINE                                  -> ФИНАЛЬНЫЙ вейк, разоружиться.
Первый тик пишет baseline (уже существующие отзывы и текущая голова не будят).

Guard: перед вейком GET карты. Будить, только если ассайни = Database Engineer и статус не in_review/done/cancelled,
иначе молча разоружиться. Вейк: на `blocked` PATCH {status: in_progress, comment} (fallback — голый
POST /comments), иначе голый POST /comments. URLError/HTTPError — запрос не ушёл или отбит: повтор на следующем
тике. Сырой таймаут/обрыв на чтении ответа — запрос ушёл и почти наверняка применён: считать доставленным
(память host-watchdog-wake-timeout-duplicates). State пишется атомарно и даже при падении тика.
Живость: STAMP трогается каждый тик. `--dry-run`: всё читает, вместо записи печатает текст вейка.
"""
import datetime
import json
import os
import sys
import urllib.error

from github_api import get_json
from service_http import request as service_request

ISSUE = '94118e6a-ac24-4b15-b35b-3123310ff219'      # HELA-12343
ASSIGNEE = 'c281b1e9-fa48-4f67-aed0-e8f8757c5b61'   # Database Engineer
REPO = 'HelloPrintERP/helloprint-backend'
PR = 1198
APPROVED_HEAD = 'b2ac096d4'                          # голова, одобренная Security Auditor (b20fde14)
REQUIRED = ('quality', 'test')
AGENT_LOGINS = ('dmitrynovikov21',)                  # общая агентская учётка
DEADLINE = datetime.datetime(2026, 10, 3, 9, 0, tzinfo=datetime.timezone.utc)
READ_FAIL_LIMIT = 6
HOME_DIR = os.path.expanduser('~/.hela-12340-watch')
STATE = os.path.join(HOME_DIR, 'state.json')
STAMP = os.path.join(HOME_DIR, 'stamp')
DISARM = os.path.join(HOME_DIR, 'disarmed')
CRON_TAG = 'hela-12340-postmerge-watch.py'
DRY = '--dry-run' in sys.argv

SIGN = ('\n\n🔴 Текст поставлен машиной: root-owned host watcher pc-watch-12340; узкий сервисный ключ, только своя карта. Это **не** founder и не агент.')
TAIL = ('\n\n**Снять сторожа:** после финального события root-оператор отключает pc-watch-12340.timer и проверяет, что старый crontab entry не возвращён.')
KEEP = ' Сторож продолжает смотреть беседу PR.'


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
    return {'state': p['state'], 'merged': bool(p.get('merged')), 'merged_at': p.get('merged_at'),
            'merge_sha': p.get('merge_commit_sha'),
            'head': head,
            'checks': [{'name': c['name'], 'status': c['status'], 'conclusion': c.get('conclusion'),
                        'id': c['id'], 'url': c.get('html_url')} for c in checks],
            'feedback': feedback}


def card():
    c = board_req('GET', '/issues/%s' % ISSUE)
    return c.get('issue') if isinstance(c.get('issue'), dict) else c


def wake(text, note):
    """Guard по карте, затем PATCH{status,comment} на blocked / голый POST иначе.

    Возвращает 'woke' (доставлено или считается доставленным), 'disarm' (карта ушла — молча разоружиться)
    или 'retry' (не доставлено — повтор на следующем тике).
    """
    body = text + SIGN
    try:
        c = card()
    except Exception as e:
        log('card read failed (%s): %s' % (note, str(e)[:160]))
        return 'retry'
    status = c.get('status')
    if c.get('assigneeAgentId') != ASSIGNEE or status in ('in_review', 'done', 'cancelled'):
        log('DISARM silent (%s): card %s/%s' % (note, status, (c.get('assigneeAgentId') or '-')[:8]))
        if not DRY:
            open(DISARM, 'w').write('%s card moved on: %s\n' % (now().isoformat(), status))
        return 'disarm'
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
        return 'состояние backend#%d прочитать не удалось' % PR
    if w['merged']:
        return 'backend#%d влит %s, merge-коммит `%s`, голова `%s` ([коммит](https://github.com/%s/commit/%s))' % (
            PR, w['merged_at'], (w['merge_sha'] or '?')[:10], w['head'][:9], REPO, w['head'])
    return 'backend#%d `%s`, голова `%s`' % (PR, w['state'], w['head'][:9])


def once(state, tag, text, note):
    """Событие один раз. True — сторож должен разоружиться (guard)."""
    woken = state.setdefault('woken', [])
    if tag in woken:
        return False
    r = wake(text, note)
    if r == 'woke':
        woken.append(tag)
    return r == 'disarm'


def tick(state):
    """Один тик. Возвращает True, если сторож должен разоружиться."""
    try:
        w = read_world()
        state['read_fail'] = 0
    except Exception as e:
        w = None
        state['read_fail'] = state.get('read_fail', 0) + 1
        log('read backend#%d failed #%d: %s' % (PR, state['read_fail'], str(e)[:200]))
    line = pr_line(w)

    if now() > DEADLINE:
        r = wake('⏰ **HELA-12343: дедлайн сторожа (%s) истёк**; %s. Не влит — спросить Сашу (ToryanikA) в PR, что '
                 'держит мерж. Влит — проверить, закрыты ли REQ-5 и REQ-4 (ответ Саши в беседе PR). При '
                 'необходимости поставить нового сторожа. Этот сторож разоружён.%s'
                 % (DEADLINE.strftime('%Y-%m-%d %H:%MZ'), line, TAIL), 'deadline')
        return r != 'retry'
    if state.get('read_fail') == READ_FAIL_LIMIT:
        if once(state, 'blind:%s' % now().strftime('%Y%m%d%H%M'),
                '🙈 **HELA-12343: сторож PR ослеп**: %d тиков подряд падает чтение GitHub. Проверить '
                'service-private GitHub credential и лог `~/.hela-12340-watch/watch.log`; состояние backend#%d '
                'проверить руками. Сторож продолжает попытки.' % (READ_FAIL_LIMIT, PR), 'blind'):
            return True
    if w is None:
        return False

    if 'seen' not in state:                                 # первый тик — baseline
        state['seen'] = [f['key'] for f in w['feedback']]
        state['head'] = w['head']
        log('baseline: feedback=%d head=%s' % (len(state['seen']), w['head'][:9]))
    seen = state['seen']

    if w['merged']:
        if once(state, 'merged',
                '✅ **HELA-12343: backend#%d влит.** %s. Действовать по разделу «Что делать на вейке «влит»» '
                'описания карты: git-truth и дерево против одобренной `%s`, порядок typed-гейта, выкат на dev, '
                'REQ-5, активация FE-карты HELA-12344 одним PATCH, REQ-4.%s%s'
                % (PR, line, APPROVED_HEAD, KEEP, TAIL), 'merged'):
            return True
    elif w['state'] == 'closed':
        if once(state, 'closed:%s' % w['head'][:12],
                '⛔ **HELA-12343: backend#%d закрыт БЕЗ мержа** (голова `%s`). Выяснить у Саши (ToryanikA) причину '
                'в PR: дубль, правка уехала в чужой PR? Git-truth по `origin/main` бэка '
                '(`git log origin/main --grep=HELA-12340`), а не по ветке.%s%s' % (PR, w['head'][:9], KEEP, TAIL),
                'closed'):
            return True

    fresh = [f for f in w['feedback'] if f['key'] not in seen]
    human = [f for f in fresh if is_human(f['login'])]
    if human:
        text = '\n'.join('- %s `%s` %s%s — %s' % (f['kind'], f['login'], f['at'] or '',
                                                   (' (%s)' % f['state']) if f['state'] else '',
                                                   f['url'] or '') for f in human)
        r = wake('💬 **HELA-12343: в backend#%d новый отзыв человека** (%s):\n%s\n\nОткрыть отзыв по ссылке в GitHub. Ревизия Саши (MERGE / FIX / '
                 'OWNER) — действовать по ней. Ответ по REQ-4 (строки `SCHEMAS` / `CONFIGS` / `SCHEMES`) — разобрать '
                 'по разделу «REQ-4 + N1» описания карты.%s' % (PR, line, text, KEEP), 'feedback')
        if r == 'disarm':
            return True
        if r == 'woke':
            seen.extend(f['key'] for f in fresh)
    else:
        seen.extend(f['key'] for f in fresh)   # агентские/ботовые — просто в baseline

    if w['state'] == 'open' and w['head'] != state.get('head'):
        htag = 'head:%s' % w['head'][:12]
        r = 'woke' if htag in state.setdefault('woken', []) else wake(
            '🔀 **HELA-12343: в backend#%d новая голова `%s`**. '
            '[Коммит](https://github.com/%s/commit/%s). Прочитать дельту от `%s` (одобрена `%s`), перемерить зону и мутации '
            '(`/dev/shm/hela12340/run-final.sh`) и ответить в PR. Если дельта трогает прод-код, сообщить Security '
            'Auditor.%s' % (PR, w['head'][:9], REPO, w['head'],
                            (state.get('head') or '?')[:9], APPROVED_HEAD, KEEP), 'head')
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
                    '🟥 **HELA-12343: required `%s` на голове backend#%d `%s` — `%s`** ([джоба](%s)). Развести по '
                    'упавшему шагу против `main` (красный main, дрейф, флейк раннера — не дефект PR). CI не отменять и '
                    'не перезапускать.%s' % (name, PR, w['head'][:9], c['conclusion'], c['url'], KEEP),
                    'check:%s' % name):
                return True
    log('tick: backend#%d %s merged=%s head=%s fresh=%d human=%d' % (PR, w['state'], w['merged'], w['head'][:9],
                                                                       len(fresh), len(human)))
    return False


def save(state):
    tmp = STATE + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(state, f, indent=1)
    os.replace(tmp, STATE)


def main():
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
