---
phase: 48-rt2-identity-and-korean-shell
plan: 02
subsystem: ui-shell-navigation
tags: [ui, navigation, korean, identity]
key-files:
  - ui/src/components/Sidebar.tsx
  - ui/src/components/SidebarAccountMenu.tsx
  - ui/src/components/SidebarCompanyMenu.tsx
  - ui/src/components/InstanceSidebar.tsx
  - ui/src/components/CompanySettingsSidebar.tsx
  - ui/src/components/MobileBottomNav.tsx
status: complete
---

# Plan 48-02 Summary

## What Changed

- Converted main sidebar navigation labels to Korean RT2 work terminology: 업무 추가, 운영 현황, 받은함, 업무, 루틴, 목표, 작업공간, 조직, 스킬, 비용, 활동, 설정.
- Replaced visible account menu Paperclip version/docs copy with RealTycoon2 version/help copy.
- Koreanized account menu and company menu labels/descriptions.
- Koreanized instance/company settings sidebars while preserving all routes.
- Koreanized mobile navigation aria label.
- Updated focused component tests for the new labels.

## Commits

| Commit | Description |
|--------|-------------|
| `350fbdfe` | Applied RT2 Korean shell identity changes |

## Verification

- Focused shell Vitest command — passed.
- `pnpm typecheck` — passed.
- Focused visible-copy scan — no legacy product names in target shell files.

## Deviations

- None.

## Self-Check

PASSED — navigation and account/company menus are Korean/RT2-first without route churn.
