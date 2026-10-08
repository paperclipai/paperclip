#!/usr/bin/env python3
"""HELA-12320 (Hotel, 1e95ea6e): будит пост-мерж карту HELA-12380, когда frontend#923 вольют/закроют или в PR
что-то случится.

Поставлен 26.09.2026 ~10Z. frontend#923 — `AppliedStepKind`/`AppliedStepSource` догнали бэк, касты `kind as string`
сняты, мок берёт DTO напрямую, шаг контрагента в снапшоте позиции мока несёт `source` (REQ-1…8 HELA-12320).
Арх-APPROVE Hotel (круг 2) подан ДО мержа на голове `f457f05fc`; стадия одна, поэтому HELA-12320 ушла в `done`
раньше мержа. Мерж делает человек (ToryanikA / ab7nt). Этот крон — единственный будильник HELA-12380 (карта
`blocked` без рёбер). Образец — ~/hela-12331-pr924-watch.py (логика та же, сменены константы и тексты).

«Одобренная голова» — APPROVED. Сам Hotel в ветку не пушит, поэтому любая новая голова (ребейз исполнителя,
«Update branch» или ревизия мержера) будит один раз. На мерже сторож сравнивает блобы файлов PR на merge-коммите
с одобренной головой и перечисляет коммиты после неё.

События (каждое один раз; все про frontend#923):
  * PR влит            -> вейк с блобами и коммитами после одобренной головы; финал.
  * PR закрыт без мержа -> вейк; финал.
  * новый отзыв ЧЕЛОВЕКА (коммент/ревью/строчный; не агентская учётка и не бот) -> вейк.
  * новая голова -> вейк один раз на голову.
  * PR стал конфликтным (`mergeable_state: dirty`) -> вейк один раз на голову.
  * PR снова draft -> вейк один раз на голову.
  * required-чек текущей головы завершился не success -> вейк один раз на (голова, чек, id).
  * DEADLINE -> финал.  * READ_FAIL_LIMIT чтений подряд упали -> вейк один раз на серию («сторож ослеп»).
Первый тик пишет baseline (уже существующие отзывы и текущая голова не будят).

Вейк: карта `blocked` -> service-PATCH {status: todo, comment} (при отказе — голый POST /comments); иначе
POST /comments. Guard перед записью: GET карты; `done`/`cancelled` или ассайни не Hotel -> молча
разоружиться. Живость: STAMP трогается каждый тик. `--dry-run`: всё читает, вместо записи печатает текст.
Самотест: ~/hela-12320-pr923-watch.selftest.py.
"""
import datetime
import json
import os
import sys
import urllib.error

from github_api import get_json
from service_http import request as service_request

ISSUE = '9118f56f-3e9c-48e1-86b8-dea7488cfe71'      # HELA-12380 (пост-мерж хвост HELA-12320)
ME = '1e95ea6e-1965-4df3-8a3b-4bb26b5231f1'         # Hotel (Architect)
REPO = 'HelloPrintERP/helloprint-frontend'
PR = 923
APPROVED = 'f457f05fce6f5b5a37ea028de0cadd5ced9f6ca2'  # голова, одобренная Hotel 26.09 (круг 2)
FILES = ('src/entities/pricing/lib/applied-step.test.ts',
         'src/features/calculators/run-calc/lib/order-adjust.ts',
         'src/features/calculators/run-calc/lib/price-adjust.ts',
         'src/shared/api/contract/calc-discount-chain-msw.spec.ts',
         'src/shared/api/contract/calc-discount-inputs-msw.spec.ts',
         'src/shared/api/contract/order-item-applied-steps-msw.spec.ts',
         'src/shared/api/types.ts',
         'src/shared/config/i18n/common.en.json',
         'src/shared/config/i18n/common.ru.json',
         'tests/mocks/calc-discounts.ts',
         'tests/mocks/fixtures.ts',
         'tests/mocks/handlers.ts')
CHECKS = ('unit-and-static', 'contract-snapshots')   # required ruleset FE main (26.09.2026)
AGENT_LOGINS = ('dmitrynovikov21',)                  # общая агентская учётка
DEADLINE = datetime.datetime(2026, 10, 3, 9, 0, tzinfo=datetime.timezone.utc)
READ_FAIL_LIMIT = 6
HOME_DIR = os.path.expanduser('~/.hela-12320-pr923-watch')
STATE = os.path.join(HOME_DIR, 'state.json')
STAMP = os.path.join(HOME_DIR, 'stamp')
DISARM = os.path.join(HOME_DIR, 'disarmed')
CRON_TAG = 'hela-12320-pr923-watch.py'
DRY = '--dry-run' in sys.argv

SIGN = ('\n\n🔴 Текст поставлен машиной: root-owned host watcher pc-watch-12320; узкий сервисный ключ, только своя карта. Это **не** founder и не агент.')
TAIL = ('\n\n**Снять сторожа:** после финального события root-оператор отключает pc-watch-12320.timer и проверяет, что старый crontab entry не возвращён.')
KEEP = ' Сторож продолжает смотреть frontend#923.'
POSTMERGE = ('\n\n**Пост-мерж сверка — по описанию HELA-12380, п.1:** предок `main` (`compare/<merge>...main` '
             '`behind_by` = 0); `git merge-tree --write-tree %s <merge>^` == `<merge>^{tree}` в одноразовом worktree '
             '(`-c rerere.enabled=false`); коммиты после одобренной головы — полным diff (вернули касты `kind as string`, '
             'обёртку `MockAppliedStep` или сняли `source` у шага контрагента в `buildOrderItemDetail` ⇒ регресс REQ-4/5/8 '
             'на `main`); на `main` — `git grep -n "kind as string" -- src tests` пусто и `order-item-applied-steps-msw.spec.ts` '
             '+ `applied-step.test.ts` зелёные; merge-SHA комментом в HELA-12320; снять крон; HELA-12380 → `done`.' % APPROVED[:9])


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
    """Всё чтение GitHub одним местом."""
    pr = gh_json('repos/%s/pulls/%d' % (REPO, PR))
    head = pr['head']['sha']
    commits = [{'sha': c['sha']}
               for c in gh_json('repos/%s/pulls/%d/commits?per_page=100' % (REPO, PR))]
    checks = gh_json('repos/%s/commits/%s/check-runs?per_page=100' % (REPO, head))['check_runs']
    feedback = []
    for kind, path, when in (
            ('коммент', 'repos/%s/issues/%d/comments?per_page=100' % (REPO, PR), 'created_at'),
            ('ревью', 'repos/%s/pulls/%d/reviews?per_page=100' % (REPO, PR), 'submitted_at'),
            ('строчный коммент', 'repos/%s/pulls/%d/comments?per_page=100' % (REPO, PR), 'created_at')):
        for x in gh_json(path):
            feedback.append({'key': '%s:%s' % (kind, x['id']), 'kind': kind, 'login': (x.get('user') or {}).get('login'),
                             'at': x.get(when), 'state': x.get('state'), 'url': x.get('html_url')})
    return {'state': pr['state'], 'draft': bool(pr.get('draft')), 'merged': bool(pr.get('merged')),
            'merged_at': pr.get('merged_at'),
            'merge_sha': pr.get('merge_commit_sha'), 'mergeable_state': pr.get('mergeable_state'),
            'head': head, 'commits': commits,
            'checks': [{'name': c['name'], 'status': c['status'], 'conclusion': c.get('conclusion'),
                        'id': c['id'], 'url': c.get('html_url')} for c in checks],
            'feedback': feedback}


def blob(path, ref):
    return gh_json('repos/%s/contents/%s?ref=%s' % (REPO, path, ref))['sha']


def merge_report(w):
    """Текст сверки влитого с одобренной головой: блобы файлов PR и коммиты после неё."""
    lines = []
    for f in FILES:
        try:
            a, b = blob(f, APPROVED), blob(f, w['merge_sha'])
            lines.append('- `%s`: одобренная `%s` → блоб `%s`; merge `%s` → `%s` — %s'
                         % (f, APPROVED[:9], a[:12], w['merge_sha'][:9], b[:12], 'РАВНЫ' if a == b else '**РАЗНЫЕ**'))
        except Exception as e:
            lines.append('- `%s`: блоб не прочитан (%s) — сверить руками' % (f, type(e).__name__))
    lines.append('- «РАЗНЫЕ» ещё не дефект: до мержа в `main` могли влить соседей, правящих те же файлы (`handlers.ts`, '
                 '`fixtures.ts`, `types.ts` — общие). Решает `merge-tree` из пост-мерж сверки.')
    shas = [c['sha'] for c in w['commits']]
    after = w['commits'][shas.index(APPROVED) + 1:] if APPROVED in shas else w['commits']
    if APPROVED not in shas:
        lines.append('- **Одобренной головы `%s` нет в коммитах PR** (ветку переписали): читать дельту полным diff.'
                     % APPROVED[:9])
    if after:
        lines.append('- **Коммиты после одобренной головы (ревьюить полным diff):** ' + '; '.join(
            '[`%s`](https://github.com/%s/commit/%s)' % (c['sha'][:9], REPO, c['sha']) for c in after))
    else:
        lines.append('- Коммитов после одобренной головы нет (голова PR `%s`).' % w['head'][:9])
    return '\n'.join(lines)


def card():
    c = board_req('GET', '/issues/%s' % ISSUE)
    return c.get('issue') if isinstance(c.get('issue'), dict) else c


def guard(note):
    """None — разоружиться молча (карта закрыта или не моя); False — не прочиталась; иначе dict карты."""
    try:
        c = card()
    except Exception as e:
        log('card read failed (%s): %s' % (note, str(e)[:160]))
        return False
    status, assignee = c.get('status'), c.get('assigneeAgentId')
    if status in ('done', 'cancelled') or assignee != ME:
        log('DISARM silent (%s): card %s assignee %s' % (note, status, (assignee or '-')[:8]))
        if not DRY:
            open(DISARM, 'w').write('%s card %s assignee %s\n' % (now().isoformat(), status, assignee))
        return None
    return c


def wake(text, note):
    """Вейк карты. True — событие отработано (или карта не наша), False — повторить на следующем тике."""
    body = text + SIGN
    c = guard(note)
    if c is None:
        return True
    if c is False:
        return False
    status = c.get('status')
    if DRY:
        print('DRY-RUN wake (%s, card %s):\n%s\n' % (note, status, body))
        return True
    if status == 'blocked':
        try:
            board_req('PATCH', '/issues/%s' % ISSUE, {'status': 'todo', 'comment': body})
            log('WOKE via PATCH todo+comment (%s)' % note)
            return True
        except (urllib.error.URLError, OSError, ValueError) as e:
            # A lost response can follow a committed PATCH. Re-read the card
            # before falling back, or the same wake is posted twice.
            log('PATCH response uncertain (%s): %s — checking card' % (note, str(e)[:160]))
            after = guard(note + ': after PATCH')
            if after is None:
                return True
            if after is False:
                return False
            if after.get('status') != 'blocked':
                log('PATCH changed card status (%s); no duplicate comment' % note)
                return True
            log('card remains blocked (%s); fallback comment' % note)
    try:
        board_req('POST', '/issues/%s/comments' % ISSUE, {'body': body})
    except (urllib.error.URLError, OSError, ValueError) as e:
        log('WAKE FAILED (%s): %s %s' % (note, type(e).__name__, str(e)[:160]))
        return False
    log('WOKE via comment (%s, card %s)' % (note, status))
    return True


def pr_line(w):
    return 'PR на этом тике: `%s`%s, голова `%s`, mergeable_state `%s`' % (
        w['state'], ' draft' if w['draft'] else '', w['head'][:9], w.get('mergeable_state'))


def tick(state):
    """Один тик. Возвращает True, если сторож должен разоружиться."""
    if now() > DEADLINE:
        return wake('⏰ **HELA-12380: дедлайн сторожа frontend#923 (%s) истёк**, а PR так и не влит и не закрыт. '
                    'Выяснить у мержера (ToryanikA) в беседе PR, что держит мерж; при необходимости '
                    'перевзвести сторожа с новым DEADLINE.%s'
                    % (DEADLINE.strftime('%Y-%m-%d %H:%MZ'), TAIL), 'deadline')
    try:
        w = read_world()
        state['read_fail'] = 0
    except Exception as e:
        state['read_fail'] = state.get('read_fail', 0) + 1
        log('read failed #%d: %s' % (state['read_fail'], str(e)[:200]))
        if state['read_fail'] == READ_FAIL_LIMIT:
            wake('🙈 **HELA-12380: сторож frontend#923 ослеп**: %d чтений GitHub подряд упали (последнее: `%s`). '
                 'Проверить service-private GitHub credential и лог `~/hela-12320-pr923-watch.log`; состояние '
                 'frontend#923 проверить руками.' % (READ_FAIL_LIMIT, str(e)[:120]), 'blind')
        return False

    if 'seen' not in state:                       # первый тик — baseline
        state['seen'] = [f['key'] for f in w['feedback']]
        state['head'] = w['head']
        log('baseline: head=%s draft=%s mergeable=%s feedback=%d' % (
            w['head'][:9], w['draft'], w.get('mergeable_state'), len(state['seen'])))

    if w['merged']:
        return wake('✅ **HELA-12380: frontend#923 влит** (%s, merge-коммит `%s`, финальная голова `%s`, '
                    'одобренная `%s`). [Голова](https://github.com/%s/commit/%s).\n\n**Сверка сторожа:**\n%s%s%s'
                    % (w['merged_at'], (w['merge_sha'] or '?')[:10], w['head'][:9],
                       APPROVED[:9], REPO, w['head'], merge_report(w), POSTMERGE, TAIL), 'merged')
    if w['state'] == 'closed':
        return wake('⛔ **HELA-12380: frontend#923 закрыт БЕЗ мержа** (голова `%s`). Прочитать последний коммент '
                    'закрывшего: дубль — сверить названный PR в `main`; иначе выяснить причину — контракт типов на `main` '
                    'всё равно нужен (правило 3 FE `CLAUDE.md`, п.5 описания HELA-12380).%s' % (w['head'][:9], TAIL), 'closed')

    woken = state.setdefault('woken', [])
    fresh = [f for f in w['feedback'] if f['key'] not in state['seen']]
    human = [f for f in fresh if is_human(f['login'])]
    if human:
        lines = '\n'.join('- %s `%s` %s%s — %s' % (f['kind'], f['login'], f['at'] or '',
                                                    (' (%s)' % f['state']) if f['state'] else '',
                                                    f['url'] or '') for f in human)
        if wake('💬 **HELA-12380: в frontend#923 новый отзыв человека** (%s):\n%s\n\nОткрыть отзыв по ссылке в GitHub. Разобрать: вердикт '
                'мержера (`MERGE` — мерж за минуты, сначала `gh pr view 923 --json state,mergedAt`; `FIX` — он '
                'сам пушит правку, дельту читать ревью; п.4 описания карты) или '
                'вопрос — ответить в PR.%s' % (pr_line(w), lines, KEEP), 'feedback'):
            state['seen'].extend(f['key'] for f in fresh)
    else:
        state['seen'].extend(f['key'] for f in fresh)   # агентские/ботовые — просто в baseline

    if w['head'] != state.get('head') and ('head:' + w['head']) not in woken:
        if wake('🔀 **HELA-12380: голова frontend#923 сменилась на `%s`** (была `%s`, одобрена `%s`). '
                '[Коммит](https://github.com/%s/commit/%s). '
                'Прочитать дельту `git diff %s..%s`: кодовые файлы равны одобренным (`git rev-parse <sha>:<f>`) — '
                'принять замером; иначе ревью дельты (п.3 описания карты).%s'
                % (w['head'][:9], (state.get('head') or '?')[:9], APPROVED[:9], REPO, w['head'],
                   APPROVED[:9], w['head'][:9], KEEP), 'head'):
            woken.append('head:' + w['head'])
            state['head'] = w['head']

    if w.get('mergeable_state') == 'dirty' and ('dirty:' + w['head']) not in woken:
        if wake('🧱 **HELA-12380: frontend#923 стал конфликтным** (`mergeable_state: dirty`, голова `%s`). Найти файл: '
                '`git merge-tree --write-tree origin/main %s` (с `-c rerere.enabled=false`). Ребейз — карта на Pixel-4 '
                '«ребейз fe#923», разрешение руками (п.2 описания карты).%s' % (w['head'][:9], w['head'][:9], KEEP), 'dirty'):
            woken.append('dirty:' + w['head'])

    if w['draft'] and ('draft:' + w['head']) not in woken:
        if wake('📝 **HELA-12380: frontend#923 снова draft** (голова `%s`). Кто-то снял готовность — прочитать '
                'беседу PR, почему; мерж при draft невозможен.%s' % (w['head'][:9], KEEP), 'draft'):
            woken.append('draft:' + w['head'])

    latest = {}
    for c in w['checks']:
        if c['name'] in CHECKS and (c['name'] not in latest or c['id'] > latest[c['name']]['id']):
            latest[c['name']] = c
    for name, c in sorted(latest.items()):
        if c['status'] != 'completed' or c['conclusion'] in ('success', 'skipped', 'neutral'):
            continue
        tag = 'check:%s:%s:%s' % (w['head'][:12], name, c['id'])
        if tag in woken:
            continue
        if wake('🟥 **HELA-12380: required `%s` на голове frontend#923 `%s` — `%s`** ([джоба](%s)). Разобрать по '
                'упавшему шагу (п.6 описания карты); CI не отменять и не выключать.%s'
                % (name, w['head'][:9], c['conclusion'], c['url'], KEEP), 'check:' + name):
            woken.append(tag)
    log('tick: #%d %s draft=%s mergeable=%s head=%s checks=%s fresh=%d human=%d' % (
        PR, w['state'], w['draft'], w.get('mergeable_state'), w['head'][:9],
        {k: '%s/%s' % (v['status'], v['conclusion']) for k, v in latest.items()}, len(fresh), len(human)))
    return False


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
    done = tick(state)
    if DRY:
        return
    json.dump(state, open(STATE, 'w'), indent=1)
    if done:
        open(DISARM, 'w').write(now().isoformat() + '\n')
        log('disarmed')


if __name__ == '__main__':
    main()
