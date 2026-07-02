#!/usr/bin/env python3
"""Generate PRA1-PRA12 wireframes for PAP-11046 (Rules / Health / Activity redesign)."""
from __future__ import annotations

import os
import xml.etree.ElementTree as ET
from pathlib import Path
from textwrap import dedent

OUT = Path(__file__).parent / "wireframes"
OUT.mkdir(parents=True, exist_ok=True)

# ---------- house-style constants ----------
FONT = '-apple-system, system-ui, sans-serif'
INK = '#000'
MUTED = '#666'
PLACEHOLDER = '#e6e6e6'
PANEL = '#fff'

W = 1280

# ---------- helpers ----------

def svg_open(height: int) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{height}" '
        f'viewBox="0 0 {W} {height}" font-family="{FONT}" '
        f'fill="{PANEL}" stroke="{INK}" stroke-width="1.5">'
        f'\n  <rect x="0" y="0" width="{W}" height="{height}" />'
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
    """Render a single text line with mixed bold/regular tspans.
    segments is list of (text, bold) tuples. Spaces in text are preserved."""
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
    return (
        f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" '
        f'rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"{d} />'
    )


def line(x1, y1, x2, y2, stroke=INK, sw=1.5, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ''
    return (
        f'  <line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" '
        f'stroke="{stroke}" stroke-width="{sw}"{d} />'
    )


def chip(x, y, label, w=None, h=24, filled=False, bold=False):
    """Outcome / status chip — rounded rect with label, monochrome."""
    if w is None:
        w = max(56, 16 + len(label) * 7)
    fill = INK if filled else PANEL
    txt_fill = PANEL if filled else INK
    weight = 'bold' if bold else 'normal'
    out = [
        f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" '
        f'fill="{fill}" stroke="{INK}" stroke-width="1.5" />',
        f'  <text x="{x + w/2}" y="{y + h/2 + 4}" font-size="12" stroke="none" '
        f'fill="{txt_fill}" text-anchor="middle" font-weight="{weight}">{esc(label)}</text>',
    ]
    return '\n'.join(out)


def button(x, y, label, w=None, h=36, primary=False):
    if w is None:
        w = max(96, 24 + len(label) * 8)
    fill = INK if primary else PANEL
    txt_fill = PANEL if primary else INK
    return (
        f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" '
        f'fill="{fill}" stroke="{INK}" stroke-width="1.5" />\n'
        f'  <text x="{x + w/2}" y="{y + h/2 + 5}" font-size="14" stroke="none" '
        f'fill="{txt_fill}" text-anchor="middle">{esc(label)}</text>'
    )


def small_button(x, y, label, w=None, h=28):
    if w is None:
        w = max(72, 20 + len(label) * 7)
    return (
        f'  <rect x="{x}" y="{y}" width="{w}" height="{h}" rx="4" '
        f'fill="{PANEL}" stroke="{INK}" stroke-width="1.5" />\n'
        f'  <text x="{x + w/2}" y="{y + h/2 + 4}" font-size="12" stroke="none" '
        f'fill="{INK}" text-anchor="middle">{esc(label)}</text>'
    )


def drag_handle(x, y):
    """Two columns of dots."""
    out = []
    for col in (0, 4):
        for row in range(3):
            cy = y + row * 6
            out.append(
                f'  <circle cx="{x + col}" cy="{cy}" r="1.4" fill="{MUTED}" stroke="none" />'
            )
    return '\n'.join(out)


def toggle_on(x, y, on=True):
    """Toggle switch ~ 40x20."""
    if on:
        return (
            f'  <rect x="{x}" y="{y}" width="40" height="20" rx="10" '
            f'fill="{INK}" stroke="{INK}" stroke-width="1.5" />\n'
            f'  <circle cx="{x + 30}" cy="{y + 10}" r="6.5" fill="{PANEL}" stroke="none" />'
        )
    return (
        f'  <rect x="{x}" y="{y}" width="40" height="20" rx="10" '
        f'fill="{PANEL}" stroke="{INK}" stroke-width="1.5" />\n'
        f'  <circle cx="{x + 10}" cy="{y + 10}" r="6.5" fill="{INK}" stroke="none" />'
    )


def menu_dots(x, y):
    out = []
    for i in range(3):
        out.append(
            f'  <circle cx="{x + i*5}" cy="{y}" r="1.6" fill="{INK}" stroke="none" />'
        )
    return '\n'.join(out)


def page_chrome(title: str, subtitle: str = '', height: int = 880, breadcrumb: str = 'Apps · Advanced'):
    """Standard top chrome: breadcrumb, title, tabs."""
    out = [svg_open(height)]
    # top bar
    out.append(rect(0, 0, W, 56, fill=PANEL))
    out.append(line(0, 56, W, 56))
    out.append(t(32, 35, 'Paperclip', size=14, weight='bold'))
    out.append(t(W - 32, 35, 'Dotta', size=12, fill=MUTED, anchor='end'))
    # sidebar stub
    out.append(rect(0, 56, 200, height - 56, fill='#fafaf8'))
    out.append(line(200, 56, 200, height))
    nav_items = ['Inbox', 'Tasks', 'Documents', 'Apps', 'Settings']
    for i, item in enumerate(nav_items):
        y = 96 + i * 36
        is_active = item == 'Apps'
        if is_active:
            out.append(rect(12, y - 18, 176, 32, rx=6, fill=PANEL))
        out.append(t(28, y, item, size=14, weight='bold' if is_active else 'normal',
                     fill=INK if is_active else MUTED))
    # main top: breadcrumb + title
    out.append(t(232, 92, breadcrumb, size=12, fill=MUTED))
    out.append(t(232, 124, title, size=28, weight='bold'))
    if subtitle:
        out.append(t(232, 148, subtitle, size=14, fill=MUTED))
    # tabs (Rules / Health / Activity)
    tab_y = 180
    tabs = ['Rules', 'Health', 'Activity']
    active_tab = title.split()[0] if title.split()[0] in tabs else tabs[0]
    tx = 232
    for tab in tabs:
        is_active = tab == active_tab
        tw = 16 + len(tab) * 9
        if is_active:
            out.append(line(tx, tab_y + 24, tx + tw, tab_y + 24, sw=2.5))
        out.append(t(tx + tw / 2, tab_y + 8, tab, size=14,
                     weight='bold' if is_active else 'normal',
                     fill=INK if is_active else MUTED, anchor='middle'))
        tx += tw + 24
    out.append(line(232, tab_y + 24, W - 32, tab_y + 24, sw=1, stroke='#ccc'))
    return out


# ---------- frames ----------

def frame_pra1():
    """PRA1 — Rules index, populated."""
    h = 960
    parts = page_chrome('Rules', 'Checked top to bottom — the first one that matches decides', height=h)
    # header row
    parts.append(t(232, 240, '5 rules', size=14, fill=MUTED))
    parts.append(button(W - 32 - 120, 224, '+ New rule', w=120, primary=True))
    parts.append(button(W - 32 - 120 - 16 - 132, 224, 'Test a rule', w=132))
    # column headers
    parts.append(t(232 + 36, 280, 'Rule', size=12, fill=MUTED, weight='bold'))
    parts.append(t(696, 280, 'Outcome', size=12, fill=MUTED, weight='bold'))
    parts.append(t(W - 32 - 220, 280, 'Last 24h', size=12, fill=MUTED, weight='bold'))
    parts.append(t(W - 32 - 100, 280, 'On', size=12, fill=MUTED, weight='bold'))
    parts.append(line(232, 296, W - 32, 296))

    rows = [
        ('any agent', 'destructive Gmail actions', 'Ask first', '3 times', True),
        ('Fable', 'web search', 'Limit to 50/hour', '12 times', True),
        ('everyone', 'Sheets actions that change data', 'Ask first', '1 time', True),
        ('CodexCoder', 'any action', 'Allow', '47 times', True),
        ('everyone', 'Send email', 'Hide sensitive details', '0 times', False),
    ]
    y = 304
    chip_x = 696
    count_x = W - 32 - 220
    toggle_x = W - 32 - 100
    menu_x = W - 32 - 32
    for who, what, outcome, hits, on in rows:
        parts.append(rect(232, y, W - 32 - 232, 48, fill=PANEL))
        parts.append(drag_handle(248, y + 18))
        parts.append(inline(280, y + 30, [
            ('When ', False),
            (who, True),
            (' uses ', False),
            (what, True),
            ('  →', False),
        ], size=13, fill=INK))
        parts.append(chip(chip_x, y + 14, outcome))
        parts.append(t(count_x, y + 30, hits, size=13, fill=MUTED))
        parts.append(toggle_on(toggle_x, y + 14, on=on))
        parts.append(menu_dots(menu_x, y + 24))
        y += 48
    # divider then Remembered approvals
    y += 32
    parts.append(t(232, y, 'Remembered approvals', size=18, weight='bold'))
    parts.append(t(232, y + 22, 'When you approve an Ask-first request, Paperclip can remember the decision.',
                   size=13, fill=MUTED))
    y += 48
    rem_rows = [
        ('Gmail · Send email', 'remembered for Fable', 'approved by Dotta · Jun 3'),
        ('Google Sheets · Edit cell', 'remembered for Fable', 'approved by Dotta · Jun 8'),
    ]
    for label, who, meta in rem_rows:
        parts.append(rect(232, y, W - 32 - 232, 48, fill=PANEL))
        parts.append(t(252, y + 22, label, size=13, weight='bold'))
        parts.append(t(252, y + 38, who + ' · ' + meta, size=12, fill=MUTED))
        parts.append(small_button(W - 32 - 80, y + 10, 'Forget', w=72))
        y += 48
    parts.append('</svg>')
    return '\n'.join(parts)


def frame_pra2():
    """PRA2 — Rules empty state."""
    h = 880
    parts = page_chrome('Rules', 'Checked top to bottom — the first one that matches decides', height=h)
    parts.append(t(232, 240, '0 rules', size=14, fill=MUTED))
    parts.append(button(W - 32 - 120, 224, '+ New rule', w=120, primary=True))
    parts.append(button(W - 32 - 120 - 16 - 132, 224, 'Test a rule', w=132))
    # empty pane
    parts.append(rect(232, 288, W - 32 - 232, 480, fill='#fafaf8', dash='4 4'))
    parts.append(t(W / 2 + 116, 336, 'No rules yet', size=20, weight='bold', anchor='middle'))
    parts.append(t(W / 2 + 116, 360, 'Start from a template, or build your own.',
                   size=14, fill=MUTED, anchor='middle'))
    # 2x2 templates
    cards = [
        ('Block destructive actions everywhere',
         ['Stop sends, deletes, and other irreversible',
          'actions across every app.']),
        ('Ask first before anything sends or deletes',
         ['Pause any outgoing message or delete until',
          'you tap Allow.']),
        ('Limit a noisy action',
         ['Cap how many times an action can run',
          'per hour, or per day.']),
        ('Start from scratch',
         ['Open an empty rule builder. You pick who,',
          'what, and the outcome.']),
    ]
    card_x0 = 280
    card_y0 = 408
    card_w = 416
    card_h = 152
    gap = 24
    for i, (title, lines) in enumerate(cards):
        col, row = i % 2, i // 2
        x = card_x0 + col * (card_w + gap)
        y = card_y0 + row * (card_h + gap)
        parts.append(rect(x, y, card_w, card_h, rx=8))
        parts.append(t(x + 24, y + 36, title, size=15, weight='bold'))
        parts.append(t(x + 24, y + 64, lines[0], size=13, fill=MUTED))
        if len(lines) > 1:
            parts.append(t(x + 24, y + 84, lines[1], size=13, fill=MUTED))
        parts.append(small_button(x + 24, y + card_h - 44, 'Use this', w=88))
    parts.append('</svg>')
    return '\n'.join(parts)


def frame_pra3():
    """PRA3 — Rule builder, sentence form."""
    h = 960
    parts = page_chrome('New rule', 'Build a rule in plain words. Preview updates as you go.',
                        height=h, breadcrumb='Apps · Advanced · Rules · New')
    # Live preview band
    parts.append(rect(232, 220, W - 32 - 232, 72, rx=8, fill='#fafaf8'))
    parts.append(t(248, 244, 'Preview', size=11, fill=MUTED, weight='bold'))
    parts.append(inline(248, 274, [
        ('When ', False),
        ('Fable', True),
        (' uses ', False),
        ('Gmail actions that make changes', True),
        (', ', False),
        ('ask first', True),
        ('.', False),
    ], size=16))
    # Three sentence sections
    sec_x = 232
    sec_w = W - 32 - 232
    # WHEN
    y = 320
    parts.append(t(sec_x, y, 'When', size=18, weight='bold'))
    parts.append(t(sec_x, y + 20, 'Who does the rule apply to?', size=12, fill=MUTED))
    opts = [('Everyone', False), ('Specific agents', True), ('Agents in a project', False)]
    ox = sec_x
    for label, on in opts:
        rw = 16 + len(label) * 8 + 32
        parts.append(rect(ox, y + 40, rw, 36, rx=6, fill=PANEL))
        # radio
        parts.append(f'  <circle cx="{ox + 14}" cy="{y + 58}" r="6" fill="{PANEL}" stroke="{INK}" stroke-width="1.5"/>')
        if on:
            parts.append(f'  <circle cx="{ox + 14}" cy="{y + 58}" r="3" fill="{INK}" stroke="none"/>')
        parts.append(t(ox + 28, y + 62, label, size=13))
        ox += rw + 8
    # picker for chosen agents
    parts.append(rect(sec_x, y + 88, 360, 40, rx=6))
    parts.append(t(sec_x + 12, y + 113, 'Fable ×   Add agent…', size=13))
    parts.append(line(sec_x + 360 - 24, y + 100, sec_x + 360 - 16, y + 116, sw=1.5))
    # USES
    y = 480
    parts.append(t(sec_x, y, 'uses', size=18, weight='bold'))
    parts.append(t(sec_x, y + 20, 'Which apps or actions?', size=12, fill=MUTED))
    opts = [('Anything', False), ('A specific app', False), ('Specific actions', True), ('Actions by capability', False)]
    ox = sec_x
    for label, on in opts:
        rw = 16 + len(label) * 8 + 32
        parts.append(rect(ox, y + 40, rw, 36, rx=6))
        parts.append(f'  <circle cx="{ox + 14}" cy="{y + 58}" r="6" fill="{PANEL}" stroke="{INK}" stroke-width="1.5"/>')
        if on:
            parts.append(f'  <circle cx="{ox + 14}" cy="{y + 58}" r="3" fill="{INK}" stroke="none"/>')
        parts.append(t(ox + 28, y + 62, label, size=13))
        ox += rw + 8
    # tree picker preview
    parts.append(rect(sec_x, y + 88, 600, 88, rx=6))
    parts.append(t(sec_x + 16, y + 110, '▾ Gmail', size=13, weight='bold'))
    parts.append(t(sec_x + 36, y + 130, '☑ Send email', size=12))
    parts.append(t(sec_x + 36, y + 148, '☑ Delete email', size=12))
    parts.append(t(sec_x + 200, y + 130, '☐ Search messages', size=12))
    parts.append(t(sec_x + 200, y + 148, '☐ List labels', size=12))
    parts.append(t(sec_x + 380, y + 130, '2 of 4 selected', size=12, fill=MUTED))
    # THEN
    y = 700
    parts.append(t(sec_x, y, 'then', size=18, weight='bold'))
    parts.append(t(sec_x, y + 20, 'What should happen?', size=12, fill=MUTED))
    chips = [('Allow', False), ('Block', False), ('Ask first', True),
             ('Limit how often', False), ('Hide sensitive details', False)]
    ox = sec_x
    for label, on in chips:
        cw = 16 + len(label) * 8
        # rect chip
        fill = INK if on else PANEL
        txt_fill = PANEL if on else INK
        parts.append(
            f'  <rect x="{ox}" y="{y + 40}" width="{cw}" height="36" rx="18" '
            f'fill="{fill}" stroke="{INK}" stroke-width="1.5"/>'
        )
        parts.append(
            f'  <text x="{ox + cw/2}" y="{y + 62}" font-size="13" stroke="none" '
            f'fill="{txt_fill}" text-anchor="middle">{esc(label)}</text>'
        )
        ox += cw + 8
    # Advanced collapse closed
    parts.append(rect(sec_x, y + 96, W - 32 - 232, 40, rx=6, fill='#fafaf8'))
    parts.append(t(sec_x + 16, y + 122, '▸ Advanced', size=13, weight='bold'))
    parts.append(t(sec_x + 130, y + 122, 'Wildcards, raw selectors, JSON conditions, priority', size=12, fill=MUTED))
    # bottom actions
    parts.append(button(W - 32 - 120, h - 64, 'Save rule', w=120, primary=True))
    parts.append(button(W - 32 - 120 - 16 - 96, h - 64, 'Cancel', w=96))
    parts.append('</svg>')
    return '\n'.join(parts)


def frame_pra4():
    """PRA4 — Rule builder, Advanced expanded."""
    h = 1100
    parts = page_chrome('New rule', 'Build a rule in plain words. Preview updates as you go.',
                        height=h, breadcrumb='Apps · Advanced · Rules · New')
    # Live preview band (compressed: just title + collapsed sentence)
    parts.append(rect(232, 220, W - 32 - 232, 56, rx=8, fill='#fafaf8'))
    parts.append(t(248, 244, 'Preview', size=11, fill=MUTED, weight='bold'))
    parts.append(t(248, 264, 'When Fable uses gmail.send_*, ask first  ·  priority 250', size=14, weight='bold'))
    # Summary of When/uses/then collapsed
    parts.append(rect(232, 296, W - 32 - 232, 96, rx=8))
    parts.append(t(248, 320, 'When', size=12, fill=MUTED, weight='bold'))
    parts.append(t(248, 340, 'Fable', size=13, weight='bold'))
    parts.append(t(440, 320, 'uses', size=12, fill=MUTED, weight='bold'))
    parts.append(t(440, 340, 'Gmail · actions that make changes', size=13, weight='bold'))
    parts.append(t(840, 320, 'then', size=12, fill=MUTED, weight='bold'))
    parts.append(t(840, 340, 'Ask first', size=13, weight='bold'))
    parts.append(t(248, 372, 'Click any of the three above to edit', size=11, fill=MUTED))

    # Advanced expanded
    sec_x = 232
    sec_w = W - 32 - 232
    parts.append(rect(sec_x, 416, sec_w, h - 416 - 96, rx=8))
    parts.append(t(sec_x + 16, 444, '▾ Advanced', size=15, weight='bold'))
    parts.append(t(sec_x + 16, 464, 'For power users — most rules don\'t need any of this.',
                   size=12, fill=MUTED))
    parts.append(line(sec_x + 16, 480, sec_x + sec_w - 16, 480))

    # 2-column form layout
    col1_x = sec_x + 24
    col2_x = sec_x + sec_w / 2 + 12
    field_w = (sec_w / 2) - 36
    y0 = 504

    # Field 1: Wildcard action names (col1)
    parts.append(t(col1_x, y0, 'Wildcard action names', size=12, weight='bold'))
    parts.append(rect(col1_x, y0 + 12, field_w, 40, rx=6))
    parts.append(t(col1_x + 12, y0 + 37, 'gmail.send_*, gmail.delete_*', size=13))
    parts.append(t(col1_x, y0 + 70, 'Comma-separated. Use * as a wildcard.', size=11, fill=MUTED))

    # Field 2: Raw selectors (col2)
    parts.append(t(col2_x, y0, 'Raw selectors', size=12, weight='bold'))
    parts.append(rect(col2_x, y0 + 12, field_w, 96, rx=6))
    parts.append(t(col2_x + 12, y0 + 32, 'connectionId', size=12, fill=MUTED))
    parts.append(t(col2_x + 12, y0 + 50, 'cn_2c5e…fable-gmail', size=13))
    parts.append(t(col2_x + 12, y0 + 76, 'catalogId', size=12, fill=MUTED))
    parts.append(t(col2_x + 12, y0 + 94, 'cat_g…workspace-actions', size=13))

    # Field 3: Conditions JSON (full width)
    y1 = y0 + 116
    parts.append(t(col1_x, y1, 'Conditions JSON', size=12, weight='bold'))
    parts.append(rect(col1_x, y1 + 12, sec_w - 48, 132, rx=6, fill='#fafaf8'))
    json_lines = [
        '{',
        '  "actorRiskLevel": ["medium", "high"],',
        '  "params.to.domain": { "$nin": ["magicmachine.co"] },',
        '  "time.window": { "after": "08:00", "before": "20:00" }',
        '}',
    ]
    for i, ln in enumerate(json_lines):
        parts.append(t(col1_x + 16, y1 + 36 + i * 20, ln, size=12))

    # Field 4: Custom check config (col1) + Priority (col2)
    y2 = y1 + 168
    parts.append(t(col1_x, y2, 'Custom check (validate) config', size=12, weight='bold'))
    parts.append(rect(col1_x, y2 + 12, field_w, 64, rx=6, fill='#fafaf8'))
    parts.append(t(col1_x + 16, y2 + 36, '{ "checker": "no-external-recipients" }', size=12))
    parts.append(t(col1_x + 16, y2 + 56, 'Runs your check function before the action.', size=11, fill=MUTED))

    parts.append(t(col2_x, y2, 'Priority', size=12, weight='bold'))
    parts.append(rect(col2_x, y2 + 12, 120, 40, rx=6))
    parts.append(t(col2_x + 16, y2 + 37, '250', size=14))
    parts.append(t(col2_x, y2 + 70, 'Lower numbers run first. Leave blank to use drag order.',
                   size=11, fill=MUTED))

    # bottom actions
    parts.append(button(W - 32 - 120, h - 64, 'Save rule', w=120, primary=True))
    parts.append(button(W - 32 - 120 - 16 - 96, h - 64, 'Cancel', w=96))
    parts.append('</svg>')
    return '\n'.join(parts)


def frame_pra5():
    """PRA5 — Forget confirm + Delete confirm modals over Rules index."""
    h = 880
    parts = page_chrome('Rules', 'Checked top to bottom — the first one that matches decides', height=h)
    # dimmed list behind
    parts.append(t(232, 240, '5 rules', size=14, fill=MUTED))
    parts.append(button(W - 32 - 120, 224, '+ New rule', w=120, primary=True))
    parts.append(button(W - 32 - 120 - 16 - 132, 224, 'Test a rule', w=132))
    # ghost rows
    for i in range(4):
        y = 304 + i * 48
        parts.append(rect(232, y, W - 32 - 232, 48, fill='#fafaf8'))
        parts.append(t(280, y + 30, '— rule row —', size=13, fill='#bbb'))
    # overlay dimmer
    parts.append(f'  <rect x="0" y="0" width="{W}" height="{h}" fill="rgba(0,0,0,0.4)" stroke="none" />')

    # MODAL 1 — Forget approval (left)
    mw = 400
    mh = 240
    mx = 160
    my = (h - mh) / 2
    parts.append(rect(mx, my, mw, mh, rx=12))
    parts.append(t(mx + 24, my + 36, 'Forget this approval?', size=18, weight='bold'))
    parts.append(t(mx + 24, my + 76, 'Gmail · Send email', size=14, weight='bold'))
    parts.append(t(mx + 24, my + 98, 'Remembered for Fable · approved by Dotta on Jun 3',
                   size=12, fill=MUTED))
    parts.append(rect(mx + 24, my + 116, mw - 48, 56, rx=6, fill='#fafaf8'))
    parts.append(t(mx + 36, my + 138, 'Next time Fable tries Send email, Paperclip will',
                   size=13))
    parts.append(t(mx + 36, my + 156, 'ask you again instead of letting it through.', size=13))
    parts.append(button(mx + mw - 24 - 96, my + mh - 56, 'Forget', w=96, primary=True))
    parts.append(button(mx + mw - 24 - 96 - 12 - 88, my + mh - 56, 'Cancel', w=88))

    # MODAL 2 — Delete rule (right)
    mx2 = W - 160 - mw
    parts.append(rect(mx2, my, mw, mh, rx=12))
    parts.append(t(mx2 + 24, my + 36, 'Delete this rule?', size=18, weight='bold'))
    parts.append(t(mx2 + 24, my + 70, 'When any agent uses destructive Gmail', size=13))
    parts.append(t(mx2 + 24, my + 88, 'actions → Ask first', size=13))
    parts.append(rect(mx2 + 24, my + 108, mw - 48, 56, rx=6, fill='#fafaf8'))
    parts.append(t(mx2 + 36, my + 130, 'Heads up — this rule fired 3 times in the last',
                   size=13))
    parts.append(t(mx2 + 36, my + 148, '24 hours. Deleting it will let those through next time.',
                   size=13))
    parts.append(button(mx2 + mw - 24 - 108, my + mh - 56, 'Delete rule', w=108, primary=True))
    parts.append(button(mx2 + mw - 24 - 108 - 12 - 88, my + mh - 56, 'Cancel', w=88))
    parts.append('</svg>')
    return '\n'.join(parts)


def frame_pra6():
    """PRA6 — Test-a-rule slide-over."""
    h = 880
    parts = page_chrome('Rules', 'Checked top to bottom — the first one that matches decides', height=h)
    parts.append(t(232, 240, '5 rules', size=14, fill=MUTED))
    parts.append(button(W - 32 - 120, 224, '+ New rule', w=120, primary=True))
    parts.append(button(W - 32 - 120 - 16 - 132, 224, 'Test a rule', w=132))
    # ghost rows behind
    for i in range(4):
        y = 304 + i * 48
        parts.append(rect(232, y, W - 32 - 232, 48, fill='#fafaf8'))
        parts.append(t(280, y + 30, '— rule row —', size=13, fill='#bbb'))
    # dimmer
    parts.append(f'  <rect x="0" y="0" width="{W}" height="{h}" fill="rgba(0,0,0,0.32)" stroke="none" />')

    # slide-over from right
    sx = W - 520
    sw = 520
    parts.append(rect(sx, 0, sw, h, fill=PANEL))
    parts.append(line(sx, 0, sx, h))
    # header
    parts.append(t(sx + 24, 48, 'Test a rule', size=22, weight='bold'))
    parts.append(t(sx + sw - 24, 48, '×', size=22, anchor='end', fill=MUTED))
    parts.append(t(sx + 24, 72, 'See what happens before saving — pick a who and a what.',
                   size=12, fill=MUTED))

    # Agent picker
    y = 112
    parts.append(t(sx + 24, y, 'Agent', size=12, fill=MUTED, weight='bold'))
    parts.append(rect(sx + 24, y + 8, sw - 48, 40, rx=6))
    parts.append(t(sx + 40, y + 33, 'Fable', size=14, weight='bold'))
    parts.append(t(sx + sw - 48, y + 31, '▾', size=12, fill=MUTED))

    # App picker
    y = 176
    parts.append(t(sx + 24, y, 'App', size=12, fill=MUTED, weight='bold'))
    parts.append(rect(sx + 24, y + 8, sw - 48, 40, rx=6))
    parts.append(t(sx + 40, y + 33, 'Gmail', size=14, weight='bold'))
    parts.append(t(sx + sw - 48, y + 31, '▾', size=12, fill=MUTED))

    # Action picker
    y = 240
    parts.append(t(sx + 24, y, 'Action', size=12, fill=MUTED, weight='bold'))
    parts.append(rect(sx + 24, y + 8, sw - 48, 40, rx=6))
    parts.append(t(sx + 40, y + 33, 'Delete email', size=14, weight='bold'))
    parts.append(t(sx + sw - 48, y + 31, '▾', size=12, fill=MUTED))

    parts.append(button(sx + 24, y + 64, 'Run check', w=120, primary=True))

    # Verdict
    vy = 380
    parts.append(rect(sx + 24, vy, sw - 48, 132, rx=8))
    parts.append(chip(sx + 40, vy + 20, 'Blocked', w=80, filled=True, bold=True))
    parts.append(t(sx + 40, vy + 72, 'Rule 2: destructive Gmail actions', size=14, weight='bold'))
    parts.append(t(sx + 40, vy + 92, '→ Block', size=14, weight='bold'))
    parts.append(t(sx + 40, vy + 116, 'Open this rule →', size=12, fill=MUTED))

    # Details collapse
    dy = 532
    parts.append(rect(sx + 24, dy, sw - 48, 40, rx=6, fill='#fafaf8'))
    parts.append(t(sx + 40, dy + 25, '▸ Details', size=13, weight='bold'))
    parts.append(t(sx + 130, dy + 25, 'reason code, matched policy IDs, raw selectors',
                   size=12, fill=MUTED))
    parts.append('</svg>')
    return '\n'.join(parts)


def frame_pra7():
    """PRA7 — Health, all good."""
    h = 880
    parts = page_chrome('Health', 'How your apps are doing right now', height=h)
    # Live pill + auto-refresh hint
    parts.append(rect(W - 32 - 80, 224, 80, 28, rx=14))
    parts.append(f'  <circle cx="{W - 32 - 64}" cy="{238}" r="4" fill="{INK}" stroke="none" />')
    parts.append(t(W - 32 - 52, 242, 'Live', size=12))
    parts.append(t(W - 32 - 80 - 12, 242, 'updates every 15s', size=11, fill=MUTED, anchor='end'))

    # Summary strip — 3 stat cards
    y = 280
    card_w = (W - 32 - 232 - 32) / 3
    stats = [
        ('Apps running', '8 of 8', 'All connected'),
        ('Typical response time', 'about 1.2s', 'across the last hour'),
        ('Errors in the last hour', '0', 'last error: yesterday 3:14 PM'),
    ]
    for i, (label, big, meta) in enumerate(stats):
        x = 232 + i * (card_w + 16)
        parts.append(rect(x, y, card_w, 112, rx=8))
        parts.append(t(x + 20, y + 28, label, size=12, fill=MUTED, weight='bold'))
        parts.append(t(x + 20, y + 64, big, size=28, weight='bold'))
        parts.append(t(x + 20, y + 92, meta, size=12, fill=MUTED))

    # status table
    ty = 432
    parts.append(t(232, ty, 'Running apps', size=18, weight='bold'))
    parts.append(t(232, ty + 22, 'One row per running app — click any row to see details.',
                   size=12, fill=MUTED))
    # column headers
    ch_y = ty + 56
    parts.append(t(232 + 24, ch_y, 'App', size=12, fill=MUTED, weight='bold'))
    parts.append(t(560, ch_y, 'Status', size=12, fill=MUTED, weight='bold'))
    parts.append(t(800, ch_y, 'Last used', size=12, fill=MUTED, weight='bold'))
    parts.append(t(W - 32 - 100, ch_y, 'Actions', size=12, fill=MUTED, weight='bold'))
    parts.append(line(232, ch_y + 12, W - 32, ch_y + 12))
    rows = [
        ('Gmail', 'Working', '5 minutes ago'),
        ('Google Sheets', 'Working', '12 minutes ago'),
        ('Slack', 'Working', '1 hour ago'),
        ('Notion', 'Working', '8 minutes ago'),
        ('Linear', 'Working', '22 minutes ago'),
        ('GitHub', 'Working', '3 minutes ago'),
    ]
    y = ch_y + 24
    for app, status, last in rows:
        parts.append(rect(232, y, W - 32 - 232, 40, fill=PANEL))
        parts.append(f'  <circle cx="{248}" cy="{y + 20}" r="5" fill="{INK}" stroke="none" />')
        parts.append(t(266, y + 25, app, size=13, weight='bold'))
        parts.append(t(560, y + 25, status, size=13))
        parts.append(t(800, y + 25, last, size=13, fill=MUTED))
        parts.append(small_button(W - 32 - 88, y + 6, 'Restart', w=80))
        y += 40
    parts.append('</svg>')
    return '\n'.join(parts)


def frame_pra8():
    """PRA8 — Health, needs attention + restart confirm."""
    h = 960
    parts = page_chrome('Health', 'How your apps are doing right now', height=h)
    # Live pill
    parts.append(rect(W - 32 - 80, 224, 80, 28, rx=14))
    parts.append(f'  <circle cx="{W - 32 - 64}" cy="{238}" r="4" fill="{INK}" stroke="none" />')
    parts.append(t(W - 32 - 52, 242, 'Live', size=12))

    # summary strip
    y = 280
    card_w = (W - 32 - 232 - 32) / 3
    stats = [
        ('Apps running', '7 of 8', '1 needs attention'),
        ('Typical response time', 'about 2.4s', 'slower than usual'),
        ('Errors in the last hour', '14', 'mostly from Gmail'),
    ]
    for i, (label, big, meta) in enumerate(stats):
        x = 232 + i * (card_w + 16)
        parts.append(rect(x, y, card_w, 96, rx=8))
        parts.append(t(x + 20, y + 26, label, size=12, fill=MUTED, weight='bold'))
        parts.append(t(x + 20, y + 58, big, size=24, weight='bold'))
        parts.append(t(x + 20, y + 82, meta, size=12, fill=MUTED))

    # Needs-attention alert card
    ay = 408
    parts.append(rect(232, ay, W - 32 - 232, 120, rx=8))
    # left bar
    parts.append(rect(232, ay, 6, 120, fill=INK))
    parts.append(t(256, ay + 28, '▲ Gmail stopped responding', size=18, weight='bold'))
    parts.append(t(256, ay + 54, 'Last successful call was 6 minutes ago. The process is still running but',
                   size=13))
    parts.append(t(256, ay + 72, 'not answering. Restarting usually clears this.', size=13))
    parts.append(button(256, ay + 88, 'Restart Gmail', w=160, primary=True))
    parts.append(t(440, ay + 110, '▸ Technical details', size=12, fill=MUTED))

    # status table
    ty = 560
    parts.append(t(232, ty, 'Running apps', size=18, weight='bold'))
    ch_y = ty + 32
    parts.append(t(232 + 24, ch_y, 'App', size=12, fill=MUTED, weight='bold'))
    parts.append(t(560, ch_y, 'Status', size=12, fill=MUTED, weight='bold'))
    parts.append(t(800, ch_y, 'Last used', size=12, fill=MUTED, weight='bold'))
    parts.append(t(W - 32 - 100, ch_y, 'Actions', size=12, fill=MUTED, weight='bold'))
    parts.append(line(232, ch_y + 12, W - 32, ch_y + 12))
    rows = [
        ('Gmail', 'Needs attention', '6 minutes ago', 'attn'),
        ('Google Sheets', 'Working', '4 minutes ago', 'ok'),
        ('Slack', 'Working', '18 minutes ago', 'ok'),
        ('GitHub', 'Working', '1 minute ago', 'ok'),
    ]
    y = ch_y + 24
    for app, status, last, state in rows:
        parts.append(rect(232, y, W - 32 - 232, 40, fill=PANEL))
        if state == 'attn':
            parts.append(t(244, y + 27, '▲', size=14))
        else:
            parts.append(f'  <circle cx="{248}" cy="{y + 20}" r="5" fill="{INK}" stroke="none" />')
        parts.append(t(266, y + 25, app, size=13, weight='bold'))
        parts.append(t(560, y + 25, status, size=13, weight='bold' if state == 'attn' else 'normal'))
        parts.append(t(800, y + 25, last, size=13, fill=MUTED))
        parts.append(small_button(W - 32 - 88, y + 6, 'Restart', w=80))
        y += 40

    # dimmer + restart confirm modal in corner
    parts.append(f'  <rect x="0" y="0" width="{W}" height="{h}" fill="rgba(0,0,0,0.4)" stroke="none" />')
    mw, mh = 440, 200
    mx, my = (W - mw) / 2, (h - mh) / 2
    parts.append(rect(mx, my, mw, mh, rx=12))
    parts.append(t(mx + 24, my + 36, 'Restart Gmail?', size=18, weight='bold'))
    parts.append(t(mx + 24, my + 72, 'Anything in progress will stop. Agents using Gmail right now', size=13))
    parts.append(t(mx + 24, my + 90, 'will see a Failed result on their action.', size=13))
    parts.append(t(mx + 24, my + 124, 'Restart usually takes 2–3 seconds.', size=12, fill=MUTED))
    parts.append(button(mx + mw - 24 - 96, my + mh - 56, 'Restart', w=96, primary=True))
    parts.append(button(mx + mw - 24 - 96 - 12 - 88, my + mh - 56, 'Cancel', w=88))
    parts.append('</svg>')
    return '\n'.join(parts)


def frame_pra9():
    """PRA9 — Health, row expanded with technical details."""
    h = 920
    parts = page_chrome('Health', 'How your apps are doing right now', height=h)
    parts.append(rect(W - 32 - 80, 224, 80, 28, rx=14))
    parts.append(f'  <circle cx="{W - 32 - 64}" cy="{238}" r="4" fill="{INK}" stroke="none" />')
    parts.append(t(W - 32 - 52, 242, 'Live', size=12))
    # status table only
    ty = 280
    parts.append(t(232, ty, 'Running apps', size=18, weight='bold'))
    parts.append(t(232, ty + 22, 'Click any row to see how the connection is wired up.',
                   size=12, fill=MUTED))
    ch_y = ty + 56
    parts.append(t(232 + 24, ch_y, 'App', size=12, fill=MUTED, weight='bold'))
    parts.append(t(560, ch_y, 'Status', size=12, fill=MUTED, weight='bold'))
    parts.append(t(800, ch_y, 'Last used', size=12, fill=MUTED, weight='bold'))
    parts.append(t(W - 32 - 100, ch_y, 'Actions', size=12, fill=MUTED, weight='bold'))
    parts.append(line(232, ch_y + 12, W - 32, ch_y + 12))
    rows = [
        ('Gmail', 'Working', '5 minutes ago', False),
        ('Google Sheets', 'Working', '12 minutes ago', True),  # expanded
        ('Slack', 'Working', '1 hour ago', False),
        ('Notion', 'Working', '8 minutes ago', False),
    ]
    y = ch_y + 24
    for app, status, last, expanded in rows:
        if expanded:
            # row header
            parts.append(rect(232, y, W - 32 - 232, 40, fill='#fafaf8'))
            parts.append(t(244, y + 25, '▾', size=14))
            parts.append(f'  <circle cx="{262}" cy="{y + 20}" r="5" fill="{INK}" stroke="none" />')
            parts.append(t(280, y + 25, app, size=13, weight='bold'))
            parts.append(t(560, y + 25, status, size=13))
            parts.append(t(800, y + 25, last, size=13, fill=MUTED))
            parts.append(small_button(W - 32 - 88, y + 6, 'Restart', w=80))
            # expanded body
            ey = y + 40
            eh = 220
            parts.append(rect(232, ey, W - 32 - 232, eh, fill='#fafaf8'))
            # left column: facts
            fx = 280
            parts.append(t(fx, ey + 32, 'Slot key', size=11, fill=MUTED, weight='bold'))
            parts.append(t(fx, ey + 52, 'sheets-stdio-local', size=13))
            parts.append(t(fx, ey + 84, 'How it runs', size=11, fill=MUTED, weight='bold'))
            parts.append(t(fx, ey + 104, 'Runs on this machine', size=13))
            parts.append(t(fx, ey + 136, 'Process ID', size=11, fill=MUTED, weight='bold'))
            parts.append(t(fx, ey + 156, '41832', size=13))
            parts.append(t(fx, ey + 188, 'Scope', size=11, fill=MUTED, weight='bold'))
            parts.append(t(fx, ey + 208, 'This project', size=13))
            # right column
            fx2 = 640
            parts.append(t(fx2, ey + 32, 'Trust tier', size=11, fill=MUTED, weight='bold'))
            parts.append(t(fx2, ey + 52, 'Provider-verified', size=13))
            parts.append(t(fx2, ey + 84, 'Started', size=11, fill=MUTED, weight='bold'))
            parts.append(t(fx2, ey + 104, '2h 14m ago', size=13))
            parts.append(t(fx2, ey + 136, 'Calls in last hour', size=11, fill=MUTED, weight='bold'))
            parts.append(t(fx2, ey + 156, '37 — none failed', size=13))
            parts.append(t(fx2, ey + 188, 'Owner', size=11, fill=MUTED, weight='bold'))
            parts.append(t(fx2, ey + 208, 'You (dotta@magicmachine.co)', size=13))
            # actions row at bottom of expander
            parts.append(small_button(W - 32 - 88 - 12 - 72, ey + eh - 44, 'Stop', w=72))
            parts.append(small_button(W - 32 - 88, ey + eh - 44, 'Restart', w=80))
            y = ey + eh
        else:
            parts.append(rect(232, y, W - 32 - 232, 40, fill=PANEL))
            parts.append(t(244, y + 25, '▸', size=14, fill=MUTED))
            parts.append(f'  <circle cx="{262}" cy="{y + 20}" r="5" fill="{INK}" stroke="none" />')
            parts.append(t(280, y + 25, app, size=13, weight='bold'))
            parts.append(t(560, y + 25, status, size=13))
            parts.append(t(800, y + 25, last, size=13, fill=MUTED))
            parts.append(small_button(W - 32 - 88, y + 6, 'Restart', w=80))
            y += 40

    # remote-row hint
    parts.append(t(232, y + 24, 'Tip: rows for apps that "connect over the internet" hide Stop/Restart — those run on the provider\'s side.',
                   size=12, fill=MUTED))
    parts.append('</svg>')
    return '\n'.join(parts)


def frame_pra10():
    """PRA10 — Activity feed populated with filters."""
    h = 980
    parts = page_chrome('Activity', 'What agents actually did with your apps', height=h)
    # Filter row
    y = 224
    # search
    parts.append(rect(232, y, 320, 36, rx=18))
    parts.append(t(252, y + 23, '🔍   Search', size=13, fill=MUTED))
    # chips
    chips = [('App', 'Gmail'), ('Agent', 'All'), ('Outcome', 'All'), ('Time', '24 hours')]
    cx = 568
    for label, val in chips:
        cw = 16 + len(f'{label}: {val}') * 7 + 20
        parts.append(rect(cx, y, cw, 36, rx=18))
        parts.append(t(cx + 14, y + 23, f'{label}: ', size=12, fill=MUTED))
        parts.append(t(cx + 14 + len(label) * 7 + 12, y + 23, val, size=12, weight='bold'))
        parts.append(t(cx + cw - 16, y + 23, '▾', size=11, fill=MUTED))
        cx += cw + 8
    # feed header
    fy = 296
    parts.append(t(232, fy, '12 results in the last 24 hours', size=12, fill=MUTED))
    # feed rows
    feed = [
        ('Fable', 'Send email', 'Gmail', 'Allowed', '5m ago'),
        ('Codex', 'Delete email', 'Gmail', 'Blocked', '12m ago'),
        ('Fable', 'Search messages', 'Gmail', 'Allowed', '18m ago'),
        ('Claude', 'Compose draft', 'Gmail', 'Asked first', '32m ago'),
        ('Codex', 'Read folder', 'Gmail', 'Allowed', '1h ago'),
        ('Fable', 'Send email', 'Gmail', 'Failed', '1h ago'),
        ('Codex', 'Forward email', 'Gmail', 'Waiting', '2h ago'),
        ('Fable', 'List labels', 'Gmail', 'Allowed', '2h ago'),
        ('Claude', 'Send email', 'Gmail', 'Blocked', '3h ago'),
    ]
    y = fy + 24
    for who, what, app, outcome, when in feed:
        parts.append(rect(232, y, W - 32 - 232, 44, fill=PANEL))
        parts.append(t(248, y + 27, '▸', size=12, fill=MUTED))
        parts.append(inline(268, y + 27, [
            (who, True),
            (' used ', False),
            (what, True),
            (' in ', False),
            (app, True),
        ], size=13, fill=INK))
        parts.append(chip(W - 32 - 220, y + 12, outcome))
        parts.append(t(W - 32 - 8, y + 27, when, size=12, fill=MUTED, anchor='end'))
        y += 44
    # load more
    parts.append(small_button(W / 2 - 60, y + 16, 'Load more', w=120))
    # footer note
    parts.append(t(232, h - 32, 'Recorded by Paperclip — entries can\'t be edited. Sensitive values are never stored.',
                   size=11, fill=MUTED))
    parts.append('</svg>')
    return '\n'.join(parts)


def frame_pra11():
    """PRA11 — Activity row expanded."""
    h = 960
    parts = page_chrome('Activity', 'What agents actually did with your apps', height=h)
    # Filter row condensed
    y = 224
    parts.append(rect(232, y, 320, 36, rx=18))
    parts.append(t(252, y + 23, '🔍   Search', size=13, fill=MUTED))
    chips = [('App', 'Gmail'), ('Agent', 'Codex'), ('Outcome', 'Blocked'), ('Time', '24 hours')]
    cx = 568
    for label, val in chips:
        cw = 16 + len(f'{label}: {val}') * 7 + 20
        parts.append(rect(cx, y, cw, 36, rx=18))
        parts.append(t(cx + 14, y + 23, f'{label}: ', size=12, fill=MUTED))
        parts.append(t(cx + 14 + len(label) * 7 + 12, y + 23, val, size=12, weight='bold'))
        parts.append(t(cx + cw - 16, y + 23, '▾', size=11, fill=MUTED))
        cx += cw + 8

    fy = 296
    parts.append(t(232, fy, '3 results', size=12, fill=MUTED))
    y = fy + 24
    # one collapsed row above
    parts.append(rect(232, y, W - 32 - 232, 44))
    parts.append(t(248, y + 27, '▸', size=12, fill=MUTED))
    parts.append(inline(268, y + 27, [
        ('Codex', True), (' used ', False), ('Delete inbox', True),
        (' in ', False), ('Gmail', True),
    ], size=13))
    parts.append(chip(W - 32 - 220, y + 12, 'Blocked'))
    parts.append(t(W - 32 - 8, y + 27, '8m ago', size=12, fill=MUTED, anchor='end'))
    y += 44

    # expanded row
    parts.append(rect(232, y, W - 32 - 232, 44, fill='#fafaf8'))
    parts.append(t(248, y + 27, '▾', size=12))
    parts.append(inline(268, y + 27, [
        ('Codex', True), (' used ', False), ('Delete email', True),
        (' in ', False), ('Gmail', True),
    ], size=13))
    parts.append(chip(W - 32 - 220, y + 12, 'Blocked'))
    parts.append(t(W - 32 - 8, y + 27, '12m ago', size=12, fill=MUTED, anchor='end'))
    y += 44
    # expanded body
    eh = 280
    parts.append(rect(232, y, W - 32 - 232, eh, fill='#fafaf8'))
    bx = 280
    by = y + 24
    parts.append(t(bx, by, 'Why', size=11, fill=MUTED, weight='bold'))
    parts.append(rect(bx, by + 12, W - 32 - 232 - 96, 48, rx=6, fill=PANEL))
    parts.append(t(bx + 16, by + 30, 'Blocked by rule:', size=13, fill=MUTED))
    parts.append(t(bx + 130, by + 30, 'destructive Gmail actions → Block', size=13, weight='bold'))
    parts.append(t(bx + 16, by + 50, 'Open this rule →', size=12, fill=MUTED))

    parts.append(t(bx, by + 88, 'What it was doing', size=11, fill=MUTED, weight='bold'))
    parts.append(t(bx, by + 108, 'Task:', size=12, fill=MUTED))
    parts.append(t(bx + 40, by + 108, 'Clean up promotions folder', size=12, weight='bold'))
    parts.append(t(bx + 240, by + 108, '→ PAP-9921', size=11, fill=MUTED))
    parts.append(t(bx, by + 130, 'Run:', size=12, fill=MUTED))
    parts.append(t(bx + 40, by + 130, 'r-2c4e1f', size=12, weight='bold'))
    parts.append(t(bx + 140, by + 130, '→ open run', size=11, fill=MUTED))

    # Details sub-collapse
    parts.append(rect(bx, by + 168, W - 32 - 232 - 96, 40, rx=6, fill=PANEL))
    parts.append(t(bx + 16, by + 193, '▸ Details', size=13, weight='bold'))
    parts.append(t(bx + 110, by + 193, 'reason: policy_block · actor: agent · run UUID · raw action: gmail.delete_message',
                   size=12, fill=MUTED))
    y += eh

    # one collapsed row below
    parts.append(rect(232, y, W - 32 - 232, 44))
    parts.append(t(248, y + 27, '▸', size=12, fill=MUTED))
    parts.append(inline(268, y + 27, [
        ('Claude', True), (' used ', False), ('Send email', True),
        (' in ', False), ('Gmail', True),
    ], size=13))
    parts.append(chip(W - 32 - 220, y + 12, 'Blocked'))
    parts.append(t(W - 32 - 8, y + 27, '3h ago', size=12, fill=MUTED, anchor='end'))

    parts.append(t(232, h - 32, 'Recorded by Paperclip — entries can\'t be edited. Sensitive values are never stored.',
                   size=11, fill=MUTED))
    parts.append('</svg>')
    return '\n'.join(parts)


def frame_pra12():
    """PRA12 — Activity empty + filtered-empty."""
    h = 880
    parts = page_chrome('Activity', 'What agents actually did with your apps', height=h)
    # === Top: blank empty (no filters applied)
    parts.append(t(232, 232, 'Empty state — no activity has happened yet', size=12, fill=MUTED, weight='bold'))
    # filter row (none active)
    y = 252
    parts.append(rect(232, y, 320, 36, rx=18))
    parts.append(t(252, y + 23, '🔍   Search', size=13, fill=MUTED))
    chips = [('App', 'All'), ('Agent', 'All'), ('Outcome', 'All'), ('Time', '24 hours')]
    cx = 568
    for label, val in chips:
        cw = 16 + len(f'{label}: {val}') * 7 + 20
        parts.append(rect(cx, y, cw, 36, rx=18))
        parts.append(t(cx + 14, y + 23, f'{label}: ', size=12, fill=MUTED))
        parts.append(t(cx + 14 + len(label) * 7 + 12, y + 23, val, size=12, weight='bold'))
        parts.append(t(cx + cw - 16, y + 23, '▾', size=11, fill=MUTED))
        cx += cw + 8

    # empty panel
    parts.append(rect(232, 304, W - 32 - 232, 200, rx=8, dash='4 4', fill='#fafaf8'))
    parts.append(t((232 + W - 32) / 2, 360, 'No activity yet', size=22, weight='bold', anchor='middle'))
    parts.append(t((232 + W - 32) / 2, 388, 'Once an agent uses any of your apps, it\'ll show up here.',
                   size=14, fill=MUTED, anchor='middle'))
    parts.append(t((232 + W - 32) / 2, 408, 'You don\'t have to set anything up for this — Paperclip records everything by default.',
                   size=13, fill=MUTED, anchor='middle'))
    parts.append(small_button((232 + W - 32) / 2 - 88, 444, 'See your rules', w=176))

    # === Bottom: filtered empty
    parts.append(t(232, 552, 'Filtered empty — filters match nothing', size=12, fill=MUTED, weight='bold'))
    y = 572
    parts.append(rect(232, y, 320, 36, rx=18))
    parts.append(t(252, y + 23, '🔍   urgent', size=13))
    chips = [('App', 'Slack'), ('Agent', 'Claude'), ('Outcome', 'Failed'), ('Time', '1 hour')]
    cx = 568
    for label, val in chips:
        cw = 16 + len(f'{label}: {val}') * 7 + 20
        parts.append(rect(cx, y, cw, 36, rx=18, fill=INK))
        parts.append(t(cx + 14, y + 23, f'{label}: ', size=12, fill=PANEL))
        parts.append(t(cx + 14 + len(label) * 7 + 12, y + 23, val, size=12, weight='bold', fill=PANEL))
        parts.append(t(cx + cw - 16, y + 23, '▾', size=11, fill=PANEL))
        cx += cw + 8

    parts.append(rect(232, 624, W - 32 - 232, 200, rx=8, dash='4 4', fill='#fafaf8'))
    parts.append(t((232 + W - 32) / 2, 680, 'No matches', size=22, weight='bold', anchor='middle'))
    parts.append(t((232 + W - 32) / 2, 708, 'No actions in the last hour matched these filters.',
                   size=14, fill=MUTED, anchor='middle'))
    parts.append(t((232 + W - 32) / 2, 728, 'Try widening the time window, or clear the filters and start over.',
                   size=13, fill=MUTED, anchor='middle'))
    parts.append(button((232 + W - 32) / 2 - 64, 760, 'Clear filters', w=128, primary=True))
    parts.append('</svg>')
    return '\n'.join(parts)


FRAMES = [
    ('PRA1-rules-index-populated.svg', frame_pra1),
    ('PRA2-rules-empty-templates.svg', frame_pra2),
    ('PRA3-rule-builder-sentence.svg', frame_pra3),
    ('PRA4-rule-builder-advanced.svg', frame_pra4),
    ('PRA5-forget-and-delete-confirms.svg', frame_pra5),
    ('PRA6-test-a-rule-slideover.svg', frame_pra6),
    ('PRA7-health-all-good.svg', frame_pra7),
    ('PRA8-health-needs-attention.svg', frame_pra8),
    ('PRA9-health-row-expanded.svg', frame_pra9),
    ('PRA10-activity-populated-filters.svg', frame_pra10),
    ('PRA11-activity-row-expanded.svg', frame_pra11),
    ('PRA12-activity-empty-states.svg', frame_pra12),
]


def main():
    for name, fn in FRAMES:
        svg = fn()
        path = OUT / name
        path.write_text(svg)
        # validate XML
        try:
            ET.fromstring(svg)
        except ET.ParseError as e:
            raise SystemExit(f'XML parse error in {name}: {e}')
        print(f'wrote {name} ({len(svg)} bytes)')
    print(f'\nAll {len(FRAMES)} frames written to {OUT}')


if __name__ == '__main__':
    main()
