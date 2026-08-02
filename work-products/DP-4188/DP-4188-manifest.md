# DP-4188 bank manifest

Model: grok-imagine-image-quality (xAI)
Governed root: `/Users/glad0s/paperclip/work-products/DP-4188/listing-visuals/`
Rule: zero readable text; digital-only life-admin mood tiles; no merch mockups; no planner page layouts; no AI-redrawn marks.
Resolution: explicit `resolution: "2k"` on every call; measured via `sips`.

| # | filename | WxH (sips) | aspect | SHA-256 | text-free | product-truth | status |
|---|----------|------------|--------|---------|-----------|---------------|--------|
| 1 | DP-4188-001-morning-desk-blank-v2-2k.png | 2816x1584 | landscape | `1be6db113ed0a904a404b7ffaea47f16a6fe5f2db4b6b4d950aceaae8435d891` | PASS | PASS | COUNTED |
| 2 | DP-4188-002-sunday-citrus-flatlay-v2-2k.png | 2048x2048 | square | `eef98ec656a84ea0ba31f2f0d636c2adef32c5ca90120bbd6a705b3471034a5d` | PASS | PASS | COUNTED |
| 3 | DP-4188-003-herb-windowsill-2k.png | 2816x1584 | landscape | `7764e5c6ad86f40d06a6b9afcdae6630bf20854e0fd9f0dbde39b45b29129a67` | PASS | PASS | COUNTED |
| 4 | DP-4188-004-morning-desk-calm-2k.png | 2816x1584 | landscape | `3eca48aba8809dc1b25ecc5aaf71b0a82752bf7a2cb30083f7191600e1520e57` | PASS | PASS | COUNTED |
| 5 | DP-4188-005-sunday-reset-flatlay-2k.png | 2048x2048 | square | `fca57063bef8e91955d6489a43c9fa81ec56960c253ed6b81ecdf32f68d331da` | PASS | PASS | COUNTED |
| 6 | DP-4188-006-hygge-rain-nook-v2-2k.png | 2816x1584 | landscape | `aa8a33a0e19f4933ea154bd02019edc553c68acff35935bb8b05776d039e5780` | PASS | PASS | COUNTED |
| 7 | DP-4188-007-japandi-entryway-2k.png | 2048x2048 | square | `fcdd8a37722fb645c8d371be75801597f908592c41ec746393a991ceb5d9bbb8` | PASS | PASS | COUNTED |
| 8 | DP-4188-008-linen-side-table-2k.png | 2048x2048 | square | `41da6afd610beee16d2911f9ed86a683a46c88a8d1c3341f93cdcbb2a425cd33` | PASS | PASS | COUNTED |
| 9 | DP-4188-009-kitchen-herbs-counter-2k.png | 2048x2048 | square | `a137406af210f5bacba049121c33993692621b0a13bec1bd7f54b16414057b64` | PASS | PASS | COUNTED |
| 10 | DP-4188-010-open-shelf-sunbeam-2k.png | 2816x1584 | landscape | `833fdf8a5579f29ab3be024414b24e48096416d41822d993b48265ba966bb9d5` | PASS | PASS | COUNTED |

## Quarantined (not counted)

- FAIL | 2816x1584 | DP-4188-001-golden-hour-workspace-2k.png — product-truth fail (readable text / planner grids / AI mark / spine lettering)
- FAIL | 2048x2048 | DP-4188-002-dark-academia-study-2k.png — product-truth fail (readable text / planner grids / AI mark / spine lettering)
- FAIL | 2816x1584 | DP-4188-003-brass-lamp-plain-v2-2k.png — product-truth fail (readable text / planner grids / AI mark / spine lettering)
- FAIL | 2816x1584 | DP-4188-003-cottagecore-kitchen-2k.png — product-truth fail (readable text / planner grids / AI mark / spine lettering)
- FAIL | 2816x1584 | DP-4188-006-brass-lamp-evening-desk-2k.png — product-truth fail (readable text / planner grids / AI mark / spine lettering)
- FAIL | 2816x1584 | DP-4188-008-hygge-window-nook-2k.png — product-truth fail (readable text / planner grids / AI mark / spine lettering)

## Prompts (governed set)
1. 001 morning-desk-blank-v2: closed blank cream journal, tea mug, pencils tray, pothos; zero text
2. 002 sunday-citrus-flatlay-v2: bowl, linen, spoon, lemons, rosemary; zero text
3. 003 herb-windowsill: plain terracotta basil/rosemary/thyme + copper can; zero text
4. 004 morning-desk-calm: closed cream notebook, mug, pencils, plant, linen; zero text
5. 005 sunday-reset-flatlay: bowl, towel, spoon, citrus, rosemary; zero text
6. 006 hygge-rain-nook-v2: window seat, blank book, cocoa, rain glass; zero text
7. 007 japandi-entryway: mirror, eucalyptus vase, empty dish; zero text
8. 008 linen-side-table: eucalyptus vase, plain candle, two blank linen journals; zero text
9. 009 kitchen-herbs-counter: board, herb bundle, salt cellar; zero text
10. 010 open-shelf-sunbeam: stacked blank notebooks, flower vase, basket; zero text

Locked mark consulted (not redrawn): /Users/glad0s/scripts/brand/dastardly-print/mark.png
No TSKB delta (process already covered by product-truth standing rules).
