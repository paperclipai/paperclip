#!/usr/bin/env python3
"""Generate AG1-AG15 wireframes for PAP-11178 (Apps/Gateways setup + debug).

Style matches PAP-11046-pra-series (monochrome, 1280-wide, board-readable
defaults first, raw protocol/log detail under Advanced).
"""
from __future__ import annotations

import os
import xml.etree.ElementTree as ET
from pathlib import Path

OUT = Path(__file__).parent / "wireframes"
OUT.mkdir(parents=True, exist_ok=True)

FONT = '-apple-system, system-ui, sans-serif'
INK = '#000'
MUTED = '#666'
PLACEHOLDER = '#e6e6e6'
SOFT = '#f4f4f1'
PANEL = '#fff'
W = 1280


def svg_open(height: int, width: int = W) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" font-family="{FONT}" '
        f'fill="{PANEL}" stroke="{INK}" stroke-width="1.5">'
        f'\n  <rect x="0" y="0" width="{width}" height="{height}" />'
    )


def esc(s: str) -> str:
    return (
        s.replace('&', '&amp;')
        .replace('<', '&lt;')
        .replace('>', '&gt;')
    )


def t(x, y, txt, size=14, fill=INK, anchor='start', weight='normal'):
    fw = f' font-weight="{weight}"' if weight != 'normal' else ''
    return (
        f'  <text x="{x}" y="{y}" font-size="{size}" stroke="none" '
        f'fill="{fill}" text-anchor="{anchor}"{fw}>{esc(txt)}</text>'
    )


def inline(x, y, segments, size=13, fill=INK):
    spans = []
    for txt, bold in segments:
        if bold:
            spans.append(f'<tspan font-weight="bold">{esc(txt)}</tspan>')
        else:
            spans.append(esc(txt))
    body = ''.join(spans)
    return (
        f'  <text x="{x}" y="{y}" font-size="{size}" stroke="none" '
        f'fill="{fill}" xml:space="preserve">{body}</text>'
    )


def rect(x, y, w, h, rx=0, fill=PANEL, stroke=INK, sw=1.5, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ''
    s = f' stroke="{stroke}"' if stroke else ' stroke="none"'
    return (
        f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" '
        f'rx="{rx}" fill="{fill}"{s} stroke-width="{sw}"{d} />'
    )


def line(x1, y1, x2, y2, stroke=INK, sw=1.5, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ''
    return (
        f'  <line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" '
        f'stroke="{stroke}" stroke-width="{sw}"{d} />'
    )


def chip(x, y, label, w=None, h=22, filled=False):
    if w is None:
        w = max(50, 14 + len(label) * 6.6)
    fill_c = INK if filled else PANEL
    txt_fill = PANEL if filled else INK
    return (
        f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="11" '
        f'fill="{fill_c}" stroke="{INK}" stroke-width="1.2" />\n'
        f'  <text x="{x + w/2}" y="{y + h/2 + 4}" font-size="11" stroke="none" '
        f'fill="{txt_fill}" text-anchor="middle">{esc(label)}</text>'
    )


def button(x, y, label, w=None, h=34, primary=False):
    if w is None:
        w = max(96, 24 + len(label) * 7.5)
    fill_c = INK if primary else PANEL
    txt_fill = PANEL if primary else INK
    return (
        f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" '
        f'fill="{fill_c}" stroke="{INK}" stroke-width="1.5" />\n'
        f'  <text x="{x + w/2}" y="{y + h/2 + 5}" font-size="13" stroke="none" '
        f'fill="{txt_fill}" text-anchor="middle">{esc(label)}</text>'
    )


def small_button(x, y, label, w=None, h=26):
    if w is None:
        w = max(64, 18 + len(label) * 6.8)
    return (
        f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="4" '
        f'fill="{PANEL}" stroke="{INK}" stroke-width="1.2" />\n'
        f'  <text x="{x + w/2}" y="{y + h/2 + 4}" font-size="12" stroke="none" '
        f'fill="{INK}" text-anchor="middle">{esc(label)}</text>'
    )


def toggle(x, y, on=True):
    if on:
        return (
            f'  <rect x="{x}" y="{y}" width="36" height="18" rx="9" '
            f'fill="{INK}" stroke="{INK}" stroke-width="1.5" />\n'
            f'  <circle cx="{x + 27}" cy="{y + 9}" r="5.5" fill="{PANEL}" stroke="none" />'
        )
    return (
        f'  <rect x="{x}" y="{y}" width="36" height="18" rx="9" '
        f'fill="{PANEL}" stroke="{INK}" stroke-width="1.5" />\n'
        f'  <circle cx="{x + 9}" cy="{y + 9}" r="5.5" fill="{INK}" stroke="none" />'
    )


def kbd(x, y, label, w=None, h=22):
    if w is None:
        w = max(28, 12 + len(label) * 6.5)
    return (
        f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="4" '
        f'fill="{SOFT}" stroke="{INK}" stroke-width="1" />\n'
        f'  <text x="{x + w/2}" y="{y + h/2 + 4}" font-size="11" stroke="none" '
        f'fill="{INK}" text-anchor="middle" font-family="ui-monospace, Menlo, monospace">{esc(label)}</text>'
    )


def menu_dots(x, y):
    out = []
    for i in range(3):
        out.append(
            f'  <circle cx="{x + i*5}" cy="{y}" r="1.6" fill="{INK}" stroke="none" />'
        )
    return '\n'.join(out)


def page_chrome(title: str, subtitle: str = '', height: int = 880,
                breadcrumb: str = 'Apps', tabs=None, active_tab: str = '',
                active_nav: str = 'Apps'):
    out = [svg_open(height)]
    # top bar
    out.append(rect(0, 0, W, 56, fill=PANEL))
    out.append(line(0, 56, W, 56))
    out.append(t(32, 35, 'Paperclip', size=14, weight='bold'))
    out.append(t(W - 32, 35, 'Dotta', size=12, fill=MUTED, anchor='end'))
    # sidebar
    out.append(rect(0, 56, 200, height - 56, fill=SOFT))
    out.append(line(200, 56, 200, height))
    nav_items = ['Inbox', 'Tasks', 'Documents', 'Apps', 'Settings']
    for i, item in enumerate(nav_items):
        y = 96 + i * 36
        is_active = item == active_nav
        if is_active:
            out.append(rect(12, y - 18, 176, 32, rx=6, fill=PANEL))
        out.append(t(28, y, item, size=14, weight='bold' if is_active else 'normal',
                     fill=INK if is_active else MUTED))
    # main top: breadcrumb + title
    out.append(t(232, 92, breadcrumb, size=12, fill=MUTED))
    out.append(t(232, 124, title, size=26, weight='bold'))
    if subtitle:
        out.append(t(232, 150, subtitle, size=13, fill=MUTED))
    if tabs:
        tab_y = 184
        tx = 232
        for tab in tabs:
            is_active = tab == active_tab
            tw = 16 + len(tab) * 8.5
            if is_active:
                out.append(line(tx, tab_y + 24, tx + tw, tab_y + 24, sw=2.5))
            out.append(t(tx + tw / 2, tab_y + 8, tab, size=14,
                         weight='bold' if is_active else 'normal',
                         fill=INK if is_active else MUTED, anchor='middle'))
            tx += tw + 24
        out.append(line(232, tab_y + 24, W - 32, tab_y + 24, sw=1, stroke='#ccc'))
    return out


# ---------- frames ----------

def save(name: str, parts):
    parts.append('</svg>')
    body = '\n'.join(parts)
    # sanity-check the SVG parses
    try:
        ET.fromstring(body)
    except ET.ParseError as exc:
        raise SystemExit(f'{name}: bad SVG — {exc}')
    (OUT / f'{name}.svg').write_text(body)
    print(f'wrote {name}.svg ({len(body)} bytes)')


# =====================================================================
# AG1 — Apps shell with Gateways tab (board-readable)
# =====================================================================
def frame_ag1():
    h = 960
    parts = page_chrome(
        'Apps',
        'Connect tools your agents can use. Group them into named Gateways for clients you trust.',
        height=h,
        breadcrumb='Apps',
        tabs=['Connected', 'Gallery', 'Gateways', 'Activity'],
        active_tab='Connected',
        active_nav='Apps',
    )
    parts.append(button(W - 32 - 162, 226, '+ Connect an app', w=162, primary=True))
    parts.append(button(W - 32 - 162 - 12 - 138, 226, 'Paste config', w=138))

    # summary strip
    summary_y = 282
    parts.append(rect(232, summary_y, W - 232 - 32, 64, rx=10, fill=SOFT, stroke='#ccc'))
    items = [
        ('5', 'Connected'),
        ('1', 'Needs attention'),
        ('3', 'Gateways'),
        ('12', 'Approvals today'),
    ]
    bx = 264
    for n, label in items:
        parts.append(t(bx, summary_y + 28, n, size=22, weight='bold'))
        parts.append(t(bx, summary_y + 50, label, size=12, fill=MUTED))
        bx += 220

    # column headers
    parts.append(t(232 + 16, 376, 'App', size=12, fill=MUTED, weight='bold'))
    parts.append(t(232 + 360, 376, 'Where it runs', size=12, fill=MUTED, weight='bold'))
    parts.append(t(232 + 560, 376, 'In gateways', size=12, fill=MUTED, weight='bold'))
    parts.append(t(232 + 760, 376, 'Last used', size=12, fill=MUTED, weight='bold'))
    parts.append(t(W - 32 - 100, 376, 'Status', size=12, fill=MUTED, weight='bold'))
    parts.append(line(232, 388, W - 32, 388))

    rows = [
        ('GitHub', 'github · Allowed', 'Connects over the web', 'CTO agents, Eng team', '2 min ago', 'Healthy', True),
        ('Sheets', 'sheets · Allowed', 'Connects over the web', 'CTO agents', '12 min ago', 'Healthy', True),
        ('Linear', 'linear · Ask first', 'Connects over the web', 'CTO agents', '1 hr ago', 'Healthy', True),
        ('KV demo', 'kv-demo · Allowed', 'Runs in your workspace', '—', '3 hr ago', 'Needs attention', False),
        ('Slack', 'slack · Allowed', 'Connects over the web', 'Eng team', 'Never', 'Healthy', True),
    ]
    ry = 408
    for name, sub, where, gws, used, status, healthy in rows:
        parts.append(line(232, ry + 56, W - 32, ry + 56, sw=1, stroke='#e6e6e6'))
        # logo placeholder
        parts.append(rect(232 + 16, ry + 12, 32, 32, rx=6, fill=PLACEHOLDER, stroke='#ccc', sw=1))
        parts.append(t(232 + 16 + 44, ry + 24, name, size=14, weight='bold'))
        parts.append(t(232 + 16 + 44, ry + 42, sub, size=12, fill=MUTED))
        parts.append(t(232 + 360, ry + 32, where, size=13))
        parts.append(t(232 + 560, ry + 32, gws, size=13))
        parts.append(t(232 + 760, ry + 32, used, size=13, fill=MUTED))
        parts.append(chip(W - 32 - 124, ry + 18, status, w=108, filled=not healthy))
        ry += 56

    # footer hint
    parts.append(t(232, h - 28, 'Advanced  ·  Profiles, Rules, Runtime, Audit', size=12, fill=MUTED))
    save('AG1-apps-shell-with-gateways-tab', parts)


# =====================================================================
# AG2 — Paste config: empty modal (mcp.json import)
# =====================================================================
def frame_ag2():
    h = 880
    parts = page_chrome(
        'Apps',
        '',
        height=h,
        breadcrumb='Apps',
        tabs=['Connected', 'Gallery', 'Gateways', 'Activity'],
        active_tab='Connected',
    )
    # dim main content
    parts.append(rect(200, 56, W - 200, h - 56, fill='#000', stroke=None))
    parts.append(f'  <rect x="200" y="56" width="{W-200}" height="{h-56}" fill="#000" opacity="0.35" stroke="none" />')

    # modal
    mx, my, mw, mh = 280, 132, 720, 660
    parts.append(rect(mx, my, mw, mh, rx=14, fill=PANEL))
    parts.append(t(mx + 24, my + 36, 'Paste a config', size=20, weight='bold'))
    parts.append(t(mx + 24, my + 60, 'Drop your mcp.json or copy one from Cursor / Claude Desktop / VS Code.', size=13, fill=MUTED))
    parts.append(t(mx + mw - 36, my + 36, '✕', size=18, fill=MUTED, anchor='end'))

    # tabs
    tab_y = my + 90
    parts.append(line(mx + 24, tab_y + 24, mx + mw - 24, tab_y + 24, sw=1, stroke='#ddd'))
    parts.append(t(mx + 24 + 50, tab_y + 8, 'Paste JSON', size=13, weight='bold', anchor='middle'))
    parts.append(line(mx + 24, tab_y + 24, mx + 24 + 100, tab_y + 24, sw=2.5))
    parts.append(t(mx + 24 + 100 + 60, tab_y + 8, 'Upload file', size=13, fill=MUTED, anchor='middle'))

    # textarea
    ta_y = tab_y + 44
    parts.append(rect(mx + 24, ta_y, mw - 48, 280, rx=8, fill=SOFT, stroke='#ccc', sw=1))
    sample = [
        '{',
        '  "mcpServers": {',
        '    "github": {',
        '      "command": "npx -y @modelcontextprotocol/server-github",',
        '      "env": { "GITHUB_TOKEN": "ghp_..." }',
        '    },',
        '    "linear": {',
        '      "url": "https://mcp.linear.app/v1/sse",',
        '      "headers": { "Authorization": "Bearer lin_api_..." }',
        '    }',
        '  }',
        '}',
    ]
    for i, ln in enumerate(sample):
        parts.append(f'  <text x="{mx + 40}" y="{ta_y + 22 + i*18}" font-size="12" stroke="none" fill="#444" font-family="ui-monospace, Menlo, monospace">{esc(ln)}</text>')

    # helper rows
    info_y = ta_y + 304
    parts.append(inline(mx + 24, info_y, [('Sensitive values stay in your secret service. ', False), ('Paperclip never stores raw secrets in this draft.', True)], size=12, fill=MUTED))
    parts.append(inline(mx + 24, info_y + 22, [('Stdio entries must map to an ', False), ('approved template', True), (' before they can be activated.', False)], size=12, fill=MUTED))

    # footer actions
    parts.append(line(mx, my + mh - 64, mx + mw, my + mh - 64, sw=1, stroke='#e6e6e6'))
    parts.append(small_button(mx + 24, my + mh - 48, 'Use sample', w=110))
    parts.append(button(mx + mw - 24 - 130, my + mh - 50, 'Preview', w=130, primary=True))
    parts.append(button(mx + mw - 24 - 130 - 12 - 110, my + mh - 50, 'Cancel', w=110))

    save('AG2-paste-config-modal', parts)


# =====================================================================
# AG3 — Import preview with secret replacement
# =====================================================================
def frame_ag3():
    h = 1100
    parts = page_chrome(
        'Paste config · Preview',
        'Fill in the keys we found. You can still pick which to import.',
        height=h,
        breadcrumb='Apps · Paste config',
        tabs=None,
    )
    # left column: list of imports
    lx, ly = 232, 200
    parts.append(t(lx, ly, '2 servers found', size=14, weight='bold'))
    parts.append(t(W - 32, ly, '2 selected · 3 keys missing', size=12, fill=MUTED, anchor='end'))

    # Card 1: github (stdio)
    cx, cy, cw = lx, ly + 24, W - 32 - lx
    parts.append(rect(cx, cy, cw, 340, rx=10))
    parts.append(rect(cx + 16, cy + 16, 28, 28, rx=4, fill=PLACEHOLDER, stroke='#ccc', sw=1))
    parts.append(t(cx + 56, cy + 28, 'github', size=15, weight='bold'))
    parts.append(t(cx + 56, cy + 46, 'Runs in your workspace · stdio template required', size=12, fill=MUTED))
    parts.append(chip(cx + cw - 16 - 88, cy + 20, 'Needs review', w=88))

    # blocked banner inside card
    parts.append(rect(cx + 16, cy + 64, cw - 32, 56, rx=8, fill=SOFT, stroke='#ccc', sw=1))
    parts.append(inline(cx + 28, cy + 84, [('No matching approved template. ', True), ('Stdio imports must map to an approved Paperclip template before activation.', False)], size=12))
    parts.append(small_button(cx + cw - 16 - 144, cy + 80, 'Request template', w=144))

    # collapsed raw
    parts.append(t(cx + 16, cy + 152, 'Command', size=11, fill=MUTED, weight='bold'))
    parts.append(rect(cx + 16, cy + 162, cw - 32, 36, rx=6, fill=SOFT, stroke='#ccc', sw=1))
    parts.append(f'  <text x="{cx + 28}" y="{cy + 186}" font-size="12" stroke="none" fill="#444" font-family="ui-monospace, Menlo, monospace">npx -y @modelcontextprotocol/server-github</text>')

    # keys
    parts.append(t(cx + 16, cy + 224, 'Keys we need', size=11, fill=MUTED, weight='bold'))
    # row 1
    fr_y = cy + 236
    parts.append(t(cx + 16, fr_y + 14, 'GitHub token', size=13))
    parts.append(rect(cx + 220, fr_y, 320, 30, rx=6, fill=SOFT, stroke='#ccc', sw=1))
    parts.append(t(cx + 232, fr_y + 20, '•••••••••••• ghp', size=12, fill=MUTED))
    parts.append(small_button(cx + 552, fr_y + 2, 'Use existing…', w=124))
    parts.append(chip(cx + 552 + 124 + 8, fr_y + 4, 'Required', w=80))

    # Card 2: linear (remote_http)
    cx, cy = lx, cy + 360
    parts.append(rect(cx, cy, cw, 360, rx=10))
    parts.append(rect(cx + 16, cy + 16, 28, 28, rx=4, fill=PLACEHOLDER, stroke='#ccc', sw=1))
    parts.append(t(cx + 56, cy + 28, 'linear', size=15, weight='bold'))
    parts.append(t(cx + 56, cy + 46, 'Connects over the web · https://mcp.linear.app/v1/sse', size=12, fill=MUTED))
    parts.append(chip(cx + cw - 16 - 92, cy + 20, 'Ready', w=92, filled=True))

    parts.append(t(cx + 16, cy + 84, 'URL', size=11, fill=MUTED, weight='bold'))
    parts.append(rect(cx + 16, cy + 94, cw - 32, 30, rx=6, fill=SOFT, stroke='#ccc', sw=1))
    parts.append(f'  <text x="{cx + 28}" y="{cy + 114}" font-size="12" stroke="none" fill="#444" font-family="ui-monospace, Menlo, monospace">https://mcp.linear.app/v1/sse</text>')

    parts.append(t(cx + 16, cy + 144, 'Keys we need', size=11, fill=MUTED, weight='bold'))
    fr_y = cy + 158
    parts.append(t(cx + 16, fr_y + 14, 'Authorization header', size=13))
    parts.append(rect(cx + 220, fr_y, 320, 30, rx=6, fill=PANEL, stroke=INK, sw=1.5))
    parts.append(t(cx + 232, fr_y + 20, 'Bearer lin_api_...', size=12, fill=MUTED))
    parts.append(small_button(cx + 552, fr_y + 2, 'Save as secret', w=124))

    # second row: connect with OAuth instead
    parts.append(rect(cx + 16, fr_y + 50, cw - 32, 64, rx=8, fill=SOFT, stroke='#ccc', sw=1))
    parts.append(inline(cx + 28, fr_y + 78, [('This server supports ', False), ('Sign in with Linear', True), ('. Use it instead of pasting a token to let each agent connect as itself.', False)], size=12))
    parts.append(small_button(cx + cw - 16 - 156, fr_y + 62, 'Use Sign in instead', w=156))

    # bottom toolbar
    parts.append(line(0, h - 80, W, h - 80, sw=1, stroke='#e6e6e6'))
    parts.append(t(232, h - 50, '1 of 2 ready. After activation we’ll run a health + catalog check.', size=12, fill=MUTED))
    parts.append(button(W - 32 - 184, h - 60, 'Activate ready (1)', w=184, primary=True))
    parts.append(button(W - 32 - 184 - 12 - 132, h - 60, 'Save drafts', w=132))
    save('AG3-import-preview-secret-replacement', parts)


# =====================================================================
# AG4 — Activation review (post-import: health + catalog + risk)
# =====================================================================
def frame_ag4():
    h = 960
    parts = page_chrome(
        'Activating · linear',
        'We check the server is reachable, list its tools, and flag risky ones before anything is exposed.',
        height=h,
        breadcrumb='Apps · linear · Activation',
    )
    # stepper
    stepper_y = 200
    steps = [('Health', True, True), ('Catalog', True, True), ('Review tools', True, False), ('Activate', False, False)]
    sx = 232
    for i, (label, done, _last) in enumerate(steps):
        # circle
        circ_fill = INK if done else PANEL
        parts.append(f'  <circle cx="{sx + 12}" cy="{stepper_y + 12}" r="11" fill="{circ_fill}" stroke="{INK}" stroke-width="1.5" />')
        if done:
            parts.append(f'  <path d="M {sx + 6} {stepper_y + 13} L {sx + 11} {stepper_y + 18} L {sx + 20} {stepper_y + 7}" stroke="{PANEL}" stroke-width="2" fill="none" />')
        else:
            parts.append(t(sx + 12, stepper_y + 16, str(i+1), size=11, anchor='middle'))
        parts.append(t(sx + 32, stepper_y + 16, label, size=13, weight='bold' if i == 2 else 'normal'))
        sx += 32 + 100
        if i < len(steps) - 1:
            parts.append(line(sx - 80, stepper_y + 12, sx - 32, stepper_y + 12, sw=1.5, stroke='#ccc'))

    # status panel
    parts.append(rect(232, 252, W - 232 - 32, 84, rx=10, fill=SOFT, stroke='#ccc', sw=1))
    parts.append(t(232 + 20, 282, 'Reachable · Sign in with Linear required', size=14, weight='bold'))
    parts.append(t(232 + 20, 304, '11 tools discovered · 2 flagged as destructive · 0 unsupported', size=12, fill=MUTED))
    parts.append(t(232 + 20, 322, 'Response time 184 ms · last checked 4s ago', size=12, fill=MUTED))
    parts.append(small_button(W - 32 - 16 - 132, 280, 'Re-run checks', w=132))

    # table
    parts.append(t(232, 372, '11 tools discovered', size=14, weight='bold'))
    parts.append(t(232, 392, 'Pick what your agents can use. Risky ones default to Ask first.', size=12, fill=MUTED))

    parts.append(t(232 + 16, 432, 'Tool', size=12, fill=MUTED, weight='bold'))
    parts.append(t(232 + 360, 432, 'What it does', size=12, fill=MUTED, weight='bold'))
    parts.append(t(232 + 720, 432, 'Risk', size=12, fill=MUTED, weight='bold'))
    parts.append(t(W - 32 - 180, 432, 'Default access', size=12, fill=MUTED, weight='bold'))
    parts.append(line(232, 442, W - 32, 442))

    rows = [
        ('list_issues', 'read', 'Read', 'Allowed', False),
        ('get_issue', 'read', 'Read', 'Allowed', False),
        ('search_issues', 'read', 'Read', 'Allowed', False),
        ('create_issue', 'write', 'Write', 'Ask first', True),
        ('update_issue', 'write', 'Write', 'Ask first', True),
        ('delete_issue', 'destructive', 'Destructive', 'Off', True),
        ('add_comment', 'write', 'Write', 'Ask first', False),
    ]
    ry = 462
    for name, kind, risk, access, dest in rows:
        parts.append(line(232, ry + 40, W - 32, ry + 40, sw=1, stroke='#eee'))
        parts.append(t(232 + 16, ry + 24, name, size=13, weight='bold'))
        parts.append(t(232 + 360, ry + 24, kind, size=12, fill=MUTED))
        parts.append(chip(232 + 720, ry + 12, risk, w=92, filled=dest))
        parts.append(t(W - 32 - 180, ry + 24, access, size=12))
        parts.append(chip(W - 32 - 60, ry + 12, '▾', w=24))
        ry += 40

    # banner re: 7 tools shown of 11
    parts.append(rect(232, h - 132, W - 232 - 32, 44, rx=8, fill=SOFT, stroke='#ccc', sw=1))
    parts.append(t(232 + 16, h - 104, '4 more · Show all', size=12, fill=MUTED))
    # footer
    parts.append(line(0, h - 80, W, h - 80, sw=1, stroke='#e6e6e6'))
    parts.append(button(W - 32 - 174, h - 60, 'Activate connection', w=174, primary=True))
    parts.append(button(W - 32 - 174 - 12 - 120, h - 60, 'Back', w=120))
    save('AG4-activation-review-catalog-risk', parts)


# =====================================================================
# AG5 — Bulk new-tool review (when a connection adds tools)
# =====================================================================
def frame_ag5():
    h = 880
    parts = page_chrome(
        'New tools to review',
        'github added 4 tools since your last review. Approve what your agents can use.',
        height=h,
        breadcrumb='Apps · github · Catalog',
    )
    # batch action bar
    parts.append(rect(232, 200, W - 232 - 32, 60, rx=10, fill=SOFT, stroke='#ccc', sw=1))
    parts.append(t(232 + 16, 222, '4 new tools · added Jun 16, 10:21 AM', size=14, weight='bold'))
    parts.append(t(232 + 16, 240, 'Changes detected: schema hash differs from last activation.', size=12, fill=MUTED))
    parts.append(small_button(W - 32 - 16 - 156, 216, 'Approve all (4)', w=156))
    parts.append(small_button(W - 32 - 16 - 156 - 8 - 132, 216, 'Mark as read', w=132))

    # column headers
    parts.append(t(232 + 16, 296, 'Tool', size=12, fill=MUTED, weight='bold'))
    parts.append(t(232 + 360, 296, 'Schema', size=12, fill=MUTED, weight='bold'))
    parts.append(t(232 + 540, 296, 'Detected risk', size=12, fill=MUTED, weight='bold'))
    parts.append(t(232 + 720, 296, 'Status', size=12, fill=MUTED, weight='bold'))
    parts.append(t(W - 32 - 220, 296, 'Default access', size=12, fill=MUTED, weight='bold'))
    parts.append(line(232, 308, W - 32, 308))

    rows = [
        ('create_branch', '5 fields', 'Write', 'Quarantined', 'Off', True, True),
        ('merge_pull_request', '3 fields', 'Destructive', 'Quarantined', 'Off', True, True),
        ('add_label', '2 fields', 'Write', 'New', 'Ask first', True, False),
        ('list_releases', '0 fields', 'Read', 'New', 'Allowed', False, False),
    ]
    ry = 320
    for name, schema, risk, status, access, write, dest in rows:
        parts.append(line(232, ry + 50, W - 32, ry + 50, sw=1, stroke='#eee'))
        # checkbox
        parts.append(rect(232 + 16, ry + 18, 18, 18, rx=3, fill=PANEL, stroke=INK, sw=1.2))
        if dest:
            parts.append(f'  <path d="M {232 + 19} {ry + 27} L {232 + 23} {ry + 31} L {232 + 31} {ry + 22}" stroke="{INK}" stroke-width="2" fill="none" />')
        parts.append(t(232 + 16 + 40, ry + 30, name, size=13, weight='bold'))
        parts.append(t(232 + 360, ry + 30, schema, size=12, fill=MUTED))
        parts.append(chip(232 + 540, ry + 18, risk, w=92, filled=dest))
        parts.append(chip(232 + 720, ry + 18, status, w=110))
        parts.append(t(W - 32 - 220, ry + 30, access, size=12))
        parts.append(chip(W - 32 - 60, ry + 18, '▾', w=24))
        ry += 50

    parts.append(t(232, h - 100, 'Tip: ', size=12, fill=MUTED, weight='bold'))
    parts.append(t(232 + 30, h - 100, 'Quarantined tools cannot run until you decide. They are not exposed to agents in the meantime.', size=12, fill=MUTED))
    parts.append(line(0, h - 80, W, h - 80, sw=1, stroke='#e6e6e6'))
    parts.append(button(W - 32 - 174, h - 60, 'Approve selected', w=174, primary=True))
    parts.append(button(W - 32 - 174 - 12 - 120, h - 60, 'Cancel', w=120))
    save('AG5-bulk-new-tool-review', parts)


# =====================================================================
# AG6 — Gateways list (NEW concept)
# =====================================================================
def frame_ag6():
    h = 880
    parts = page_chrome(
        'Apps',
        'A gateway is one safe MCP endpoint that exposes only the apps you assign. Hand it to a client like Cursor or Claude Desktop.',
        height=h,
        breadcrumb='Apps',
        tabs=['Connected', 'Gallery', 'Gateways', 'Activity'],
        active_tab='Gateways',
    )
    parts.append(button(W - 32 - 160, 226, '+ New gateway', w=160, primary=True))
    parts.append(button(W - 32 - 160 - 12 - 124, 226, 'Test gateway', w=124))

    # search
    parts.append(rect(232, 230, 320, 32, rx=6, fill=SOFT, stroke='#ccc', sw=1))
    parts.append(t(232 + 16, 252, '⌕  Search by name, app, or owner', size=12, fill=MUTED))

    # column headers
    parts.append(t(232 + 16, 304, 'Gateway', size=12, fill=MUTED, weight='bold'))
    parts.append(t(232 + 360, 304, 'Scope', size=12, fill=MUTED, weight='bold'))
    parts.append(t(232 + 560, 304, 'Apps', size=12, fill=MUTED, weight='bold'))
    parts.append(t(232 + 720, 304, 'Tokens', size=12, fill=MUTED, weight='bold'))
    parts.append(t(232 + 840, 304, 'Last used', size=12, fill=MUTED, weight='bold'))
    parts.append(t(W - 32 - 80, 304, 'On', size=12, fill=MUTED, weight='bold'))
    parts.append(line(232, 316, W - 32, 316))

    rows = [
        ('CTO agents', 'mcp.paperclip.dev/g/cto-agents', 'Company · CTO agents', '6 apps · 23 tools', '2 active · 1 expiring', '12s ago', True),
        ('Customer triage', 'mcp.paperclip.dev/g/triage', 'Project · Support', '3 apps · 9 tools', '1 active', '4h ago', True),
        ('External · client-x sandbox', 'mcp.paperclip.dev/g/client-x', 'External · scoped', '2 apps · 4 tools', '1 active · 1 revoked', '2d ago', False),
    ]
    ry = 332
    for name, url, scope, apps, tokens, used, on in rows:
        parts.append(line(232, ry + 64, W - 32, ry + 64, sw=1, stroke='#eee'))
        parts.append(t(232 + 16, ry + 24, name, size=14, weight='bold'))
        parts.append(t(232 + 16, ry + 44, url, size=12, fill=MUTED))
        parts.append(t(232 + 360, ry + 32, scope, size=13))
        parts.append(t(232 + 560, ry + 32, apps, size=13))
        parts.append(t(232 + 720, ry + 32, tokens, size=13))
        parts.append(t(232 + 840, ry + 32, used, size=13, fill=MUTED))
        parts.append(toggle(W - 32 - 80, ry + 24, on=on))
        ry += 64

    # bottom hint
    parts.append(rect(232, 620, W - 232 - 32, 76, rx=10, fill=SOFT, stroke='#ccc', sw=1))
    parts.append(t(232 + 20, 648, 'Why a gateway?', size=14, weight='bold'))
    parts.append(t(232 + 20, 670, 'You pick which apps go through it, who can use it, and how. Revoke the token, the whole gateway goes silent — no app-by-app cleanup.', size=12, fill=MUTED))
    save('AG6-gateways-list', parts)


# =====================================================================
# AG7 — Gateway detail (overview + apps + tokens + activity)
# =====================================================================
def frame_ag7():
    h = 1100
    parts = page_chrome(
        'CTO agents',
        'mcp.paperclip.dev/g/cto-agents · Company · Created Jun 12 by Dotta',
        height=h,
        breadcrumb='Apps · Gateways',
        tabs=['Overview', 'Apps & tools', 'Tokens', 'Activity', 'Advanced'],
        active_tab='Overview',
    )

    # top action row
    parts.append(button(W - 32 - 160, 134, 'Show snippet', w=160, primary=True))
    parts.append(small_button(W - 32 - 160 - 8 - 120, 138, 'Test gateway', w=120))
    parts.append(small_button(W - 32 - 160 - 8 - 120 - 8 - 96, 138, 'Edit', w=96))

    # summary cards
    sy = 252
    cards = [
        ('On', 'Toggle the whole gateway off here.', True, 'toggle'),
        ('Apps', '6 apps · 23 tools', False, 'text'),
        ('Tokens', '2 active · 1 expiring', False, 'text'),
        ('Health', 'All green · checked 4s ago', False, 'text'),
    ]
    cx = 232
    cw = (W - 232 - 32 - 36) / 4
    for label, body, on, kind in cards:
        parts.append(rect(cx, sy, cw, 88, rx=10, fill=PANEL, stroke=INK))
        parts.append(t(cx + 16, sy + 24, label, size=12, fill=MUTED, weight='bold'))
        if kind == 'toggle':
            parts.append(toggle(cx + 16, sy + 38, on=True))
            parts.append(t(cx + 16, sy + 78, body, size=11, fill=MUTED))
        else:
            parts.append(t(cx + 16, sy + 48, body, size=14, weight='bold'))
        cx += cw + 12

    # who can use this
    parts.append(rect(232, 364, W - 232 - 32, 152, rx=10))
    parts.append(t(248, 388, 'Who can use it', size=14, weight='bold'))
    parts.append(t(248, 408, 'Anyone holding an active token below, restricted by the rules in your Default profile.', size=12, fill=MUTED))
    parts.append(chip(248, 426, 'Scope · CTO agents', w=148))
    parts.append(chip(248 + 156, 426, 'Profile · Default', w=128))
    parts.append(chip(248 + 156 + 136, 426, 'Rules · 5 active', w=120))
    parts.append(chip(248 + 156 + 136 + 128, 426, 'Ask-first queue · in your Inbox', w=216))
    parts.append(small_button(W - 32 - 16 - 132, 384, 'Change scope', w=132))
    parts.append(small_button(W - 32 - 16 - 132 - 8 - 132, 384, 'Open profile', w=132))

    # apps & tools summary
    parts.append(rect(232, 532, W - 232 - 32, 240, rx=10))
    parts.append(t(248, 556, 'Apps in this gateway', size=14, weight='bold'))
    parts.append(small_button(W - 32 - 16 - 120, 552, '+ Add app', w=120))
    parts.append(line(248, 580, W - 48, 580, sw=1, stroke='#eee'))

    apps_rows = [
        ('GitHub', '7 tools · 0 ask first', 'Healthy'),
        ('Sheets', '5 tools · 1 ask first', 'Healthy'),
        ('Linear', '6 tools · 3 ask first', 'Healthy'),
        ('Slack', '4 tools · 0 ask first', 'Healthy'),
        ('KV demo', '1 tool · 0 ask first', 'Needs attention'),
    ]
    ry = 594
    for name, sub, status in apps_rows:
        parts.append(line(248, ry + 32, W - 48, ry + 32, sw=1, stroke='#f3f3f3'))
        parts.append(rect(264, ry + 6, 22, 22, rx=4, fill=PLACEHOLDER, stroke='#ccc', sw=1))
        parts.append(t(264 + 32, ry + 22, name, size=13, weight='bold'))
        parts.append(t(264 + 32 + 80, ry + 22, sub, size=12, fill=MUTED))
        parts.append(chip(W - 32 - 16 - 124, ry + 8, status, w=108, filled=status != 'Healthy'))
        ry += 32

    # bottom: client snippet preview
    parts.append(rect(232, 788, W - 232 - 32, 220, rx=10, fill=SOFT, stroke='#ccc', sw=1))
    parts.append(t(248, 812, 'How clients connect', size=14, weight='bold'))
    parts.append(small_button(W - 32 - 16 - 110, 802, 'Copy', w=110))
    parts.append(rect(248, 832, W - 248 - 48, 156, rx=8, fill=PANEL))
    code_lines = [
        '{',
        '  "mcpServers": {',
        '    "paperclip-cto-agents": {',
        '      "url": "https://mcp.paperclip.dev/g/cto-agents/mcp",',
        '      "headers": { "Authorization": "Bearer pcgk_•••_REVEAL" }',
        '    }',
        '  }',
        '}',
    ]
    for i, ln in enumerate(code_lines):
        parts.append(f'  <text x="{264}" y="{856 + i*16}" font-size="12" stroke="none" fill="#222" font-family="ui-monospace, Menlo, monospace">{esc(ln)}</text>')
    save('AG7-gateway-detail-overview', parts)


# =====================================================================
# AG8 — Client snippets dialog (Cursor / Claude Desktop / VS Code / OpenCode)
# =====================================================================
def frame_ag8():
    h = 880
    parts = page_chrome(
        'CTO agents',
        '',
        height=h,
        breadcrumb='Apps · Gateways',
        tabs=['Overview', 'Apps & tools', 'Tokens', 'Activity', 'Advanced'],
        active_tab='Overview',
    )
    # dim main
    parts.append(f'  <rect x="200" y="56" width="{W-200}" height="{h-56}" fill="#000" opacity="0.35" stroke="none" />')

    # modal
    mx, my, mw, mh = 200, 132, 880, 660
    parts.append(rect(mx, my, mw, mh, rx=14, fill=PANEL))
    parts.append(t(mx + 24, my + 36, 'Connect a client', size=20, weight='bold'))
    parts.append(t(mx + 24, my + 60, 'Pick how you’ll point your client at this gateway. A new token is minted on copy.', size=13, fill=MUTED))
    parts.append(t(mx + mw - 36, my + 36, '✕', size=18, fill=MUTED, anchor='end'))

    # left tabs
    tabs = ['Cursor', 'Claude Desktop', 'VS Code', 'OpenCode / Claude Code', 'Raw URL']
    ty = my + 100
    for i, name in enumerate(tabs):
        is_active = i == 1
        if is_active:
            parts.append(rect(mx + 24, ty + i*44 - 4, 232, 36, rx=6, fill=SOFT, stroke=INK, sw=1))
        parts.append(t(mx + 40, ty + i*44 + 18, name, size=13, weight='bold' if is_active else 'normal',
                       fill=INK if is_active else MUTED))

    # right pane
    rx0 = mx + 24 + 232 + 24
    parts.append(t(rx0, ty + 16, 'Add to your Claude Desktop config', size=14, weight='bold'))
    parts.append(inline(rx0, ty + 36, [
        ('macOS · ', True), ('~/Library/Application Support/Claude/claude_desktop_config.json', False)
    ], size=12, fill=MUTED))

    # code block
    parts.append(rect(rx0, ty + 56, mw - 24 - 232 - 24 - 24, 220, rx=8, fill=SOFT, stroke='#ccc', sw=1))
    code = [
        '{',
        '  "mcpServers": {',
        '    "paperclip-cto-agents": {',
        '      "url": "https://mcp.paperclip.dev/g/cto-agents/mcp",',
        '      "headers": {',
        '        "Authorization": "Bearer pcgk_live_8x4Pa…RAg"',
        '      }',
        '    }',
        '  }',
        '}',
    ]
    for i, ln in enumerate(code):
        parts.append(f'  <text x="{rx0 + 16}" y="{ty + 80 + i*18}" font-size="12" stroke="none" fill="#222" font-family="ui-monospace, Menlo, monospace">{esc(ln)}</text>')
    parts.append(small_button(rx0 + (mw - 24 - 232 - 24 - 24) - 16 - 110, ty + 64, 'Copy', w=110))

    # token block
    parts.append(t(rx0, ty + 304, 'Token', size=12, fill=MUTED, weight='bold'))
    parts.append(rect(rx0, ty + 318, mw - 24 - 232 - 24 - 24, 50, rx=8, fill=PANEL, stroke=INK))
    parts.append(t(rx0 + 16, ty + 346, 'pcgk_live_8x4Pa…RAg', size=13, weight='bold'))
    parts.append(t(rx0 + 16, ty + 346 + 16, 'Mints a new token on copy · expires in 90 days · revocable any time', size=11, fill=MUTED))
    parts.append(small_button(rx0 + (mw - 24 - 232 - 24 - 24) - 16 - 110, ty + 326, 'Show', w=110))

    # warnings
    parts.append(rect(rx0, ty + 384, mw - 24 - 232 - 24 - 24, 76, rx=8, fill=SOFT, stroke='#ccc', sw=1))
    parts.append(inline(rx0 + 16, ty + 410, [
        ('Treat this like a password. ', True),
        ('Anyone with this token can call exactly the tools this gateway allows. If a laptop is lost, revoke from the Tokens tab.', False),
    ], size=12))
    parts.append(inline(rx0 + 16, ty + 432, [
        ('Test it: ', True),
        ('Quit Claude Desktop, replace the file, relaunch. The gateway should show in the picker as `paperclip-cto-agents`.', False),
    ], size=12))

    # footer
    parts.append(line(mx, my + mh - 64, mx + mw, my + mh - 64, sw=1, stroke='#e6e6e6'))
    parts.append(button(mx + mw - 24 - 132, my + mh - 50, 'Done', w=132, primary=True))
    parts.append(button(mx + mw - 24 - 132 - 12 - 160, my + mh - 50, 'Send to teammate', w=160))
    save('AG8-client-snippets-dialog', parts)


# =====================================================================
# AG9 — Tokens tab (mint, reveal-once, revoke, audit)
# =====================================================================
def frame_ag9():
    h = 980
    parts = page_chrome(
        'CTO agents · Tokens',
        'Each token is a separate way in. Revoke any one without breaking the others.',
        height=h,
        breadcrumb='Apps · Gateways · CTO agents',
        tabs=['Overview', 'Apps & tools', 'Tokens', 'Activity', 'Advanced'],
        active_tab='Tokens',
    )
    parts.append(button(W - 32 - 160, 226, '+ Mint token', w=160, primary=True))

    # banner about the just-minted token (reveal once)
    parts.append(rect(232, 270, W - 232 - 32, 100, rx=10, fill=SOFT, stroke=INK, sw=1.2))
    parts.append(t(232 + 20, 296, 'New token — copy now', size=14, weight='bold'))
    parts.append(t(232 + 20, 316, 'You won’t see the full value again. Store it in your client’s config or your secret manager.', size=12, fill=MUTED))
    parts.append(rect(232 + 20, 328, W - 232 - 32 - 40 - 220, 30, rx=6, fill=PANEL, stroke=INK))
    parts.append(t(232 + 32, 348, 'pcgk_live_8x4Pa_fSlRPDmnYqU3oVdK5BzAh9TbN4LiHvKtZjEgWfMcQxRAg', size=12, fill=INK))
    parts.append(small_button(W - 32 - 20 - 220, 330, 'Copy', w=104))
    parts.append(small_button(W - 32 - 20 - 220 + 112, 330, 'Send to client', w=108))

    # column headers
    parts.append(t(232 + 16, 416, 'Token', size=12, fill=MUTED, weight='bold'))
    parts.append(t(232 + 360, 416, 'Owner', size=12, fill=MUTED, weight='bold'))
    parts.append(t(232 + 520, 416, 'Created', size=12, fill=MUTED, weight='bold'))
    parts.append(t(232 + 640, 416, 'Last used', size=12, fill=MUTED, weight='bold'))
    parts.append(t(232 + 760, 416, 'Expires', size=12, fill=MUTED, weight='bold'))
    parts.append(t(W - 32 - 140, 416, 'Status', size=12, fill=MUTED, weight='bold'))
    parts.append(line(232, 428, W - 32, 428))

    tokens = [
        ('cto-cursor', 'pcgk_live_•••RAg', 'Dotta', 'Jun 16, 11:04 AM', '12s ago', 'in 90d', 'Active', True),
        ('cto-claude-desktop', 'pcgk_live_•••H7n', 'Dotta', 'Jun 14', '4h ago', 'in 88d', 'Active', True),
        ('client-x sandbox', 'pcgk_live_•••Xa1', 'External · ClientX', 'May 20', '2d ago', 'in 14d', 'Expiring', True),
        ('legacy-fable', 'pcgk_live_•••0aZ', 'Fable', 'Apr 02', '—', 'Apr 02', 'Revoked', False),
    ]
    ry = 442
    for label, val, owner, created, used, expires, status, active in tokens:
        parts.append(line(232, ry + 56, W - 32, ry + 56, sw=1, stroke='#eee'))
        parts.append(t(232 + 16, ry + 24, label, size=13, weight='bold'))
        parts.append(t(232 + 16, ry + 42, val, size=12, fill=MUTED))
        parts.append(t(232 + 360, ry + 32, owner, size=13))
        parts.append(t(232 + 520, ry + 32, created, size=13, fill=MUTED))
        parts.append(t(232 + 640, ry + 32, used, size=13, fill=MUTED))
        parts.append(t(232 + 760, ry + 32, expires, size=13, fill=MUTED))
        parts.append(chip(W - 32 - 140, ry + 22, status, w=86, filled=status in ('Expiring', 'Revoked')))
        parts.append(t(W - 32 - 24, ry + 28, '⋯', size=18, anchor='end'))
        ry += 56

    # footer panel about audit
    parts.append(rect(232, h - 124, W - 232 - 32, 64, rx=10, fill=SOFT, stroke='#ccc', sw=1))
    parts.append(t(232 + 20, h - 100, 'Every mint, reveal, copy, and revoke is recorded in Activity → Audit.', size=13))
    parts.append(small_button(W - 32 - 20 - 168, h - 110, 'Open audit', w=168))
    save('AG9-tokens-tab', parts)


# =====================================================================
# AG10 — Pending approvals / Ask-first queue (consolidated)
# =====================================================================
def frame_ag10():
    h = 960
    parts = page_chrome(
        'Inbox · Approvals',
        '12 agents and clients are waiting on you. Most are routine, a few are destructive — keep an eye on those.',
        height=h,
        breadcrumb='Inbox',
        tabs=['All', 'Approvals', 'Replies', 'Mentions', 'Snoozed'],
        active_tab='Approvals',
        active_nav='Inbox',
    )

    # filter chips
    parts.append(rect(232, 226, W - 232 - 32, 44, rx=8, fill=PANEL, stroke='#ccc', sw=1))
    chips = [('All gateways', True), ('Read', False), ('Write', False), ('Destructive', True), ('External clients', False)]
    cx = 248
    for label, on in chips:
        parts.append(chip(cx, 234, label, filled=on))
        cx += max(72, 16 + len(label) * 7) + 8
    parts.append(small_button(W - 32 - 16 - 132, 232, 'Approve all safe', w=132))

    # group: oldest first
    gy = 294
    parts.append(t(232, gy, 'Waiting · oldest first', size=12, fill=MUTED, weight='bold'))
    parts.append(line(232, gy + 8, W - 32, gy + 8))

    cards = [
        ('Fable', 'GitHub · create_branch', 'PAP-11178 · Apps/Gateways design', '4 min', 'Write', True),
        ('Cursor · client-x', 'Linear · update_issue', 'name=“Fix nav”, state=“done”', '2 min', 'Write', False),
        ('Claude Desktop · Dotta', 'Sheets · clear_range', 'spreadsheet=Q3 OKRs, range=A1:Z200', '12 min', 'Destructive', True),
        ('CodexCoder', 'Slack · post_message', 'channel=#eng-leads, text=“Merge plan…”', 'Just now', 'Write', False),
    ]
    cy = gy + 24
    for who, what, args, ago, risk, ack in cards:
        parts.append(rect(232, cy, W - 232 - 32, 112, rx=10))
        parts.append(rect(248, cy + 16, 32, 32, rx=16, fill=PLACEHOLDER, stroke='#ccc', sw=1))
        parts.append(t(248 + 44, cy + 32, who, size=14, weight='bold'))
        parts.append(t(248 + 44, cy + 50, what, size=13))
        parts.append(t(248 + 44, cy + 70, args, size=12, fill=MUTED))
        parts.append(t(248 + 44, cy + 90, ago + ' ago · via gateway CTO agents', size=11, fill=MUTED))

        # right column
        parts.append(chip(W - 32 - 16 - 112, cy + 16, risk, w=96, filled=risk == 'Destructive'))
        parts.append(small_button(W - 32 - 16 - 96, cy + 50, 'Approve', w=96))
        parts.append(small_button(W - 32 - 16 - 96 - 8 - 80, cy + 50, 'Deny', w=80))
        parts.append(small_button(W - 32 - 16 - 96, cy + 82, 'Always allow', w=96))
        cy += 124

    save('AG10-pending-approvals-queue', parts)


# =====================================================================
# AG11 — Audit timeline with policy-explanation card
# =====================================================================
def frame_ag11():
    h = 1020
    parts = page_chrome(
        'Activity',
        'Every call through your gateways and apps, with why it was allowed, blocked, or paused.',
        height=h,
        breadcrumb='Apps · Activity',
        tabs=['Connected', 'Gallery', 'Gateways', 'Activity'],
        active_tab='Activity',
    )

    # filter row
    parts.append(rect(232, 220, W - 232 - 32, 44, rx=8, fill=PANEL, stroke='#ccc', sw=1))
    chips = [('Last 24h', True), ('All gateways', False), ('All apps', False), ('All outcomes', False), ('Destructive only', False)]
    cx = 248
    for label, on in chips:
        parts.append(chip(cx, 228, label, filled=on))
        cx += max(72, 16 + len(label) * 7) + 8
    parts.append(small_button(W - 32 - 16 - 110, 226, 'Export', w=110))

    # left list
    list_x, list_y, list_w = 232, 286, 540
    parts.append(rect(list_x, list_y, list_w, h - list_y - 40, rx=10))
    parts.append(t(list_x + 16, list_y + 28, '127 events', size=13, weight='bold'))
    parts.append(line(list_x, list_y + 44, list_x + list_w, list_y + 44, sw=1, stroke='#eee'))

    events = [
        ('11:12:08', 'Fable', 'Linear · create_issue', 'Ask first', False, False),
        ('11:11:53', 'Cursor · client-x', 'Sheets · read_range', 'Allowed', True, False),
        ('11:10:21', 'Claude Desktop · Dotta', 'Sheets · clear_range', 'Blocked', False, True),
        ('11:09:44', 'Fable', 'GitHub · merge_pr', 'Approved', True, False),
        ('11:08:00', 'CodexCoder', 'Slack · post_message', 'Allowed', True, False),
        ('11:06:31', 'Fable', 'KV demo · set', 'Rate-limited', False, False),
    ]
    ry = list_y + 56
    selected = 2
    for i, (ts, who, what, outcome, ok, danger) in enumerate(events):
        is_sel = i == selected
        if is_sel:
            parts.append(rect(list_x + 4, ry - 4, list_w - 8, 56, rx=8, fill=SOFT, stroke=INK, sw=1.2))
        parts.append(t(list_x + 16, ry + 18, ts, size=11, fill=MUTED, weight='bold'))
        parts.append(t(list_x + 80, ry + 18, who, size=13, weight='bold'))
        parts.append(t(list_x + 80, ry + 36, what, size=12, fill=MUTED))
        parts.append(chip(list_x + list_w - 16 - 100, ry + 12, outcome, w=92, filled=danger or not ok))
        ry += 60

    # right detail panel
    dx, dy, dw = 232 + 540 + 16, 286, W - 32 - (232 + 540 + 16)
    parts.append(rect(dx, dy, dw, h - dy - 40, rx=10))
    parts.append(t(dx + 20, dy + 32, 'Sheets · clear_range — Blocked', size=16, weight='bold'))
    parts.append(t(dx + 20, dy + 54, '11:10:21 · Claude Desktop · Dotta · via gateway CTO agents', size=12, fill=MUTED))
    parts.append(line(dx, dy + 80, dx + dw, dy + 80, sw=1, stroke='#eee'))

    # policy explanation card
    py = dy + 96
    parts.append(rect(dx + 20, py, dw - 40, 152, rx=10, fill=SOFT, stroke=INK, sw=1))
    parts.append(t(dx + 36, py + 28, 'Why it was blocked', size=14, weight='bold'))
    parts.append(inline(dx + 36, py + 50, [
        ('Rule ', False), ('Sheets actions that change data', True), (' → Ask first.', False),
    ], size=13))
    parts.append(inline(dx + 36, py + 70, [
        ('Then ', False), ('Destructive scope (>50 cells)', True), (' → Off.', False),
    ], size=13))
    parts.append(t(dx + 36, py + 100, 'First match wins. The destructive scope is stricter, so it overrode Ask first.', size=12, fill=MUTED))
    parts.append(small_button(dx + 36, py + 116, 'Open rule', w=110))
    parts.append(small_button(dx + 36 + 118, py + 116, 'Forget this rule', w=140))

    # args
    py2 = py + 172
    parts.append(t(dx + 20, py2, 'Arguments', size=12, fill=MUTED, weight='bold'))
    parts.append(rect(dx + 20, py2 + 8, dw - 40, 96, rx=8, fill=PANEL, stroke='#ccc', sw=1))
    arg_lines = [
        'spreadsheet  =  Q3 OKRs',
        'range        =  A1:Z200',
        'count        =  10,400 cells',
    ]
    for i, ln in enumerate(arg_lines):
        parts.append(f'  <text x="{dx + 36}" y="{py2 + 32 + i*22}" font-size="12" stroke="none" fill="#222" font-family="ui-monospace, Menlo, monospace">{esc(ln)}</text>')

    # follow-ups
    py3 = py2 + 130
    parts.append(t(dx + 20, py3, 'Follow-up', size=12, fill=MUTED, weight='bold'))
    parts.append(small_button(dx + 20, py3 + 10, 'Approve this once', w=160))
    parts.append(small_button(dx + 20 + 168, py3 + 10, 'Always allow this', w=160))
    parts.append(small_button(dx + 20 + 168 + 168, py3 + 10, 'Show as JSON', w=140))

    save('AG11-audit-timeline-policy-explanation', parts)


# =====================================================================
# AG12 — Connection / Gateway test console
# =====================================================================
def frame_ag12():
    h = 1000
    parts = page_chrome(
        'CTO agents · Test',
        'Run a tool against this gateway from the board. No agent is involved.',
        height=h,
        breadcrumb='Apps · Gateways · CTO agents',
        tabs=['Overview', 'Apps & tools', 'Tokens', 'Activity', 'Advanced'],
        active_tab='Apps & tools',
    )

    # left: tool picker
    lx, ly, lw = 232, 232, 360
    parts.append(rect(lx, ly, lw, h - ly - 40, rx=10))
    parts.append(t(lx + 16, ly + 28, 'Pick a tool', size=13, weight='bold'))
    parts.append(rect(lx + 16, ly + 48, lw - 32, 32, rx=6, fill=SOFT, stroke='#ccc', sw=1))
    parts.append(t(lx + 32, ly + 70, '⌕  Search tools', size=12, fill=MUTED))

    sections = [
        ('GitHub', ['list_issues', 'create_branch', 'merge_pr']),
        ('Sheets', ['read_range', 'append_row', 'clear_range']),
        ('Linear', ['search_issues', 'create_issue', 'update_issue']),
    ]
    sy = ly + 96
    for name, tools in sections:
        parts.append(t(lx + 16, sy, name, size=12, fill=MUTED, weight='bold'))
        sy += 12
        for tool in tools:
            sel = tool == 'append_row'
            if sel:
                parts.append(rect(lx + 12, sy + 2, lw - 24, 26, rx=6, fill=SOFT, stroke=INK, sw=1))
            parts.append(t(lx + 24, sy + 20, tool, size=13, weight='bold' if sel else 'normal'))
            sy += 30
        sy += 8

    # right: editor
    rx0, ry0, rw = lx + lw + 16, 232, W - 32 - (lx + lw + 16)
    parts.append(rect(rx0, ry0, rw, h - ry0 - 40, rx=10))
    parts.append(t(rx0 + 20, ry0 + 32, 'Sheets · append_row', size=18, weight='bold'))
    parts.append(t(rx0 + 20, ry0 + 56, 'Acts as a board test actor. Goes through rules and approvals like a real client.', size=12, fill=MUTED))

    # arguments
    parts.append(t(rx0 + 20, ry0 + 100, 'Arguments', size=12, fill=MUTED, weight='bold'))
    parts.append(rect(rx0 + 20, ry0 + 110, rw - 40, 140, rx=8, fill=SOFT, stroke='#ccc', sw=1))
    args = [
        '{',
        '  "spreadsheet": "Sandbox · Hello world",',
        '  "row": ["Hello from Test console", "2026-06-16"]',
        '}',
    ]
    for i, ln in enumerate(args):
        parts.append(f'  <text x="{rx0 + 36}" y="{ry0 + 134 + i*20}" font-size="12" stroke="none" fill="#222" font-family="ui-monospace, Menlo, monospace">{esc(ln)}</text>')

    parts.append(button(rx0 + 20, ry0 + 264, 'Run as board', w=160, primary=True))
    parts.append(small_button(rx0 + 20 + 168, ry0 + 268, 'Run dry', w=120))
    parts.append(small_button(rx0 + 20 + 168 + 128, ry0 + 268, 'Copy as curl', w=140))

    # result
    parts.append(rect(rx0 + 20, ry0 + 320, rw - 40, 320, rx=10, fill=PANEL, stroke=INK))
    parts.append(t(rx0 + 36, ry0 + 348, 'Result · Allowed', size=14, weight='bold'))
    parts.append(t(rx0 + 36, ry0 + 368, '204 OK · 212 ms · profile Default · 0 ask-first triggered', size=12, fill=MUTED))
    parts.append(line(rx0 + 20, ry0 + 384, rx0 + rw - 20, ry0 + 384, sw=1, stroke='#eee'))

    res = [
        '{',
        '  "ok": true,',
        '  "appended": {',
        '    "row": 47,',
        '    "valuesPreview": ["Hello from Test console", "2026-06-16"]',
        '  },',
        '  "auditId": "evt_01HX9V7XJK…",',
        '  "policyExplanation": "Rule Sheets · safe → Allowed"',
        '}',
    ]
    for i, ln in enumerate(res):
        parts.append(f'  <text x="{rx0 + 36}" y="{ry0 + 408 + i*18}" font-size="12" stroke="none" fill="#222" font-family="ui-monospace, Menlo, monospace">{esc(ln)}</text>')
    save('AG12-connection-test-console', parts)


# =====================================================================
# AG13 — Missing-credential error + reconnect
# =====================================================================
def frame_ag13():
    h = 880
    parts = page_chrome(
        'GitHub',
        'Sign-in expired — your agents can’t use this app until it’s reconnected.',
        height=h,
        breadcrumb='Apps · GitHub',
        tabs=['Overview', 'Tools', 'Approvals', 'Activity', 'Advanced'],
        active_tab='Overview',
    )

    # big banner
    parts.append(rect(232, 220, W - 232 - 32, 132, rx=12, fill=SOFT, stroke=INK, sw=1.5))
    parts.append(t(232 + 24, 256, 'Reconnect to GitHub', size=18, weight='bold'))
    parts.append(t(232 + 24, 280, 'The OAuth token expired at 11:02 AM. 3 agents tried to use GitHub since then; their calls were paused, not lost.', size=13, fill=MUTED))
    parts.append(button(232 + 24, 302, 'Sign in with GitHub', w=200, primary=True))
    parts.append(button(232 + 24 + 208, 302, 'Use a token instead', w=180))
    parts.append(small_button(W - 32 - 16 - 132, 232, 'Dismiss', w=132))

    # what was paused
    parts.append(rect(232, 376, W - 232 - 32, 256, rx=10))
    parts.append(t(232 + 20, 400, 'Paused calls (3)', size=14, weight='bold'))
    parts.append(t(232 + 20, 420, 'These resume automatically once you reconnect.', size=12, fill=MUTED))
    parts.append(line(232 + 20, 432, W - 32 - 20, 432, sw=1, stroke='#eee'))

    rows = [
        ('Fable · PAP-11178', 'list_pulls', '11:08', 'Will retry'),
        ('Cursor · client-x', 'create_issue', '11:09', 'Will retry'),
        ('CodexCoder', 'merge_pr', '11:10', 'Will ask first'),
    ]
    ry = 446
    for who, tool, ts, action in rows:
        parts.append(t(232 + 32, ry + 18, who, size=13, weight='bold'))
        parts.append(t(232 + 32, ry + 36, tool + ' · ' + ts, size=12, fill=MUTED))
        parts.append(chip(W - 32 - 24 - 132, ry + 14, action, w=120))
        parts.append(line(232 + 20, ry + 56, W - 32 - 20, ry + 56, sw=1, stroke='#f3f3f3'))
        ry += 56

    # bottom: clients pointing here
    parts.append(rect(232, 660, W - 232 - 32, 84, rx=10, fill=SOFT, stroke='#ccc', sw=1))
    parts.append(t(232 + 20, 686, 'Clients pointing here', size=14, weight='bold'))
    parts.append(t(232 + 20, 706, 'CTO agents gateway · 2 active tokens. They’ll be told to ask first until reconnect.', size=12, fill=MUTED))
    parts.append(small_button(W - 32 - 16 - 168, 668, 'Open gateway', w=168))
    save('AG13-missing-credential-reconnect', parts)


# =====================================================================
# AG14 — Elicitation passthrough card (tool asks for more info)
# =====================================================================
def frame_ag14():
    h = 820
    parts = page_chrome(
        'PAP-11178 · Apps/Gateways design',
        'A tool needs one more thing before it can run.',
        height=h,
        breadcrumb='Tasks · PAP-11178',
        active_nav='Tasks',
    )

    # main "thread" panel
    parts.append(rect(232, 232, W - 232 - 32, 80, rx=10, fill=SOFT, stroke='#ccc', sw=1))
    parts.append(t(232 + 20, 258, 'Fable · 1 min ago', size=13, weight='bold'))
    parts.append(t(232 + 20, 280, 'Calling Linear · create_issue with title “Rebuild settings page”…', size=12, fill=MUTED))

    # elicitation card
    parts.append(rect(232, 332, W - 232 - 32, 380, rx=14, stroke=INK))
    parts.append(rect(232, 332, 6, 380, rx=3, fill=INK, stroke=None))
    parts.append(t(232 + 28, 364, 'Linear is asking a follow-up', size=18, weight='bold'))
    parts.append(t(232 + 28, 386, '“Which team should this issue belong to?” · via gateway CTO agents', size=12, fill=MUTED))
    parts.append(chip(W - 32 - 16 - 116, 348, 'Ask user', w=104))

    # question
    parts.append(t(232 + 28, 432, 'Team', size=12, fill=MUTED, weight='bold'))
    parts.append(rect(232 + 28, 444, W - 232 - 32 - 56, 40, rx=6, fill=PANEL, stroke=INK))
    parts.append(t(232 + 44, 470, 'Design', size=14, weight='bold'))
    parts.append(t(W - 32 - 32, 470, '▾', size=16, anchor='end'))

    # additional context
    parts.append(t(232 + 28, 514, 'Why is this being asked?', size=12, fill=MUTED, weight='bold'))
    parts.append(t(232 + 28, 532, 'Linear has no default team for this token. The tool returned an `elicitation` so Paperclip can ask you instead of guessing.', size=13))

    # show raw
    parts.append(small_button(232 + 28, 564, 'Show raw request', w=160))
    parts.append(small_button(232 + 28 + 168, 564, 'Open audit', w=140))

    # action buttons
    parts.append(line(232, 644, W - 32, 644, sw=1, stroke='#eee'))
    parts.append(t(232 + 28, 672, 'Fable will receive your answer and continue the call.', size=12, fill=MUTED))
    parts.append(button(W - 32 - 24 - 132, 660, 'Send answer', w=132, primary=True))
    parts.append(button(W - 32 - 24 - 132 - 12 - 132, 660, 'Skip & block', w=132))

    save('AG14-elicitation-passthrough', parts)


# =====================================================================
# AG15 — Responsive states (mobile + empty/loading/error)
# =====================================================================
def frame_ag15():
    h = 1000
    width = W
    parts = [svg_open(h, width)]
    # top bar
    parts.append(rect(0, 0, width, 56, fill=PANEL))
    parts.append(line(0, 56, width, 56))
    parts.append(t(32, 35, 'Paperclip · Responsive & state checklist', size=14, weight='bold'))
    parts.append(t(width - 32, 35, 'AG15', size=12, fill=MUTED, anchor='end'))

    # 4 phones, each 240 wide
    panel_w = 240
    panel_h = 460
    margin = 24
    panels = [
        ('Empty · Gateways', 'No gateways yet. Connect an app first, then group it.'),
        ('Loading · Gateway detail', 'Skeleton rows for apps + tokens.'),
        ('Error · Reachability', 'We can’t reach mcp.linear.app. Your agents will get “service paused”.'),
        ('Mobile · Approvals', 'Inbox approvals stacked, single-action default.'),
    ]
    for i, (label, body) in enumerate(panels):
        x = 64 + i * (panel_w + margin)
        y = 96
        # phone frame
        parts.append(rect(x, y, panel_w, panel_h, rx=22, fill=PANEL))
        parts.append(rect(x + 10, y + 16, panel_w - 20, 28, rx=6, fill=SOFT, stroke='#ccc', sw=1))
        parts.append(t(x + panel_w/2, y + 34, label, size=12, weight='bold', anchor='middle'))
        # body specific
        if i == 0:
            parts.append(rect(x + 16, y + 64, panel_w - 32, panel_h - 96, rx=10, fill=PANEL, stroke='#ccc', sw=1))
            parts.append(t(x + panel_w/2, y + 200, 'No gateways yet', size=13, weight='bold', anchor='middle'))
            parts.append(t(x + panel_w/2, y + 222, 'Group your connected apps', size=11, fill=MUTED, anchor='middle'))
            parts.append(t(x + panel_w/2, y + 238, 'into one safe endpoint.', size=11, fill=MUTED, anchor='middle'))
            parts.append(small_button(x + 32, y + 300, '+ New gateway', w=panel_w - 64))
        elif i == 1:
            cy = y + 64
            for j in range(5):
                parts.append(rect(x + 16, cy, panel_w - 32, 50, rx=8, fill=PLACEHOLDER, stroke=None))
                cy += 56
            parts.append(t(x + 16, y + 384, 'Loading apps & tokens…', size=11, fill=MUTED))
        elif i == 2:
            parts.append(rect(x + 16, y + 64, panel_w - 32, 110, rx=10, fill=SOFT, stroke=INK, sw=1))
            parts.append(t(x + 28, y + 86, 'Linear is unreachable', size=12, weight='bold'))
            parts.append(t(x + 28, y + 104, '6 failed pings in 2 min.', size=11, fill=MUTED))
            parts.append(t(x + 28, y + 120, 'Agents see service paused.', size=11, fill=MUTED))
            parts.append(small_button(x + 28, y + 138, 'Run health check', w=160))
            parts.append(t(x + 16, y + 200, 'Last successful call', size=11, fill=MUTED, weight='bold'))
            parts.append(t(x + 16, y + 218, '11:01 AM · list_issues', size=12))
        else:
            cy = y + 64
            for j in range(3):
                parts.append(rect(x + 16, cy, panel_w - 32, 96, rx=10, fill=PANEL, stroke=INK))
                parts.append(t(x + 28, cy + 22, 'Fable · 4m ago', size=11, weight='bold'))
                parts.append(t(x + 28, cy + 40, 'GitHub · create_branch', size=11))
                parts.append(chip(x + 28, cy + 50, 'Write', w=64))
                parts.append(small_button(x + 28, cy + 72, 'Approve', w=panel_w - 56))
                cy += 108
        # body caption
        parts.append(t(x + 16, y + panel_h + 24, body, size=11, fill=MUTED))

    # spec table at bottom
    sy = 96 + panel_h + 96
    parts.append(t(64, sy, 'Spec checklist', size=14, weight='bold'))
    parts.append(line(64, sy + 8, width - 64, sy + 8))
    lines = [
        '· Mobile: stack to a single column < 720px. Sidebar collapses to a sheet under a Menu button.',
        '· Empty: every list view ships with an explicit empty state explaining what the surface is for and one primary action.',
        '· Loading: never blank — prefer skeleton rows; spinner only on inline buttons / mutations.',
        '· Error: reachability/reconnect errors get a banner with one fix action, not a toast.',
        '· Permission errors: read-only viewers see the same surface with all destructive actions hidden, not disabled.',
        '· Tokens: reveal-once banner replaces the secret with masked dots on next view. No copy of the full value persists in DOM.',
        '· Destructive copy: “Revoke token”, “Forget rule”, “Delete gateway” need a typed confirm input matching the resource name.',
    ]
    ly2 = sy + 32
    for ln in lines:
        parts.append(t(80, ly2, ln, size=12, fill=INK))
        ly2 += 22
    save('AG15-responsive-and-states', parts)


if __name__ == '__main__':
    frame_ag1()
    frame_ag2()
    frame_ag3()
    frame_ag4()
    frame_ag5()
    frame_ag6()
    frame_ag7()
    frame_ag8()
    frame_ag9()
    frame_ag10()
    frame_ag11()
    frame_ag12()
    frame_ag13()
    frame_ag14()
    frame_ag15()
    print('All AG frames generated in', OUT)
