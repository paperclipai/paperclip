# ZAI-244: QA Screenshot Sweep - Projects List

**Date**: 2026-05-08  
**URL Tested**: http://127.0.0.1:3105/ZAI/projects  
**Language**: Russian (Русский)  
**Device**: 1568x675 viewport

## Summary

Sweep of Projects list page (Russian locale) completed. **2 hardcoded English strings found** that should be localized.

## English Strings Identified

| # | English Text | Location | CSS/Selector | Element | Status |
|---|---|---|---|---|---|
| 1 | `planned` | Localization project status badge | `span.inline-flex.items-center.rounded-full.px-2.5.py-0.5.text-xs.font-medium` | status badge | **NEEDS TRANSLATION** |
| 2 | `Board` | Bottom-left account menu | `span.min-w-0.flex-1.truncate` | generic span in account menu | **NEEDS TRANSLATION** |
| 3 | `Change language` | Top-right language switcher button | `button[type="button"]` | button (but label is "Русский" visually) | Label visible as "Русский" but button `aria-label` is English |

## Page Content Analysis

### ✅ Properly Localized (Russian)
- Main heading: "Проекты" (Projects)
- Project card 1: "Onboarding" → status "В прогрессе" (In progress) 
- Project card 2: "Localization" → status `"planned"` ❌ English
- Sidebar navigation all in Russian:
  - "Панель управления" (Dashboard)
  - "Входящие" (Inbox)
  - "Проблемы" (Issues)
  - "Поиск" (Search)
  - "Процедуры" (Routines)
  - "Цели" (Goals)
  - "Проекты" (Projects)
  - "АГЕНТЫ" (Agents)
  - "Оргструктура" (Organization)
  - "Навыки" (Skills)
  - "Затраты" (Costs)
  - "Активность" (Activity)
  - "Параметры" (Settings)

### ⚠️ User Data / Proper Nouns (Not hardcoded UI strings)
- Project names: "Onboarding", "Localization"
- Agent names: "CEO", "CTO", "Browser Tester Agent", "Localization Agent"
- These are user-created/configured and not UI strings

### Note on Description Text
The Localization project description includes: `"**Project Goal** Replace hardcoded English text in UI with localization variables..."`

This appears to be user-created documentation, not a hardcoded UI string. The `**Project Goal**` text formatting is part of the content description, not a UI element label.

## Localization Coverage

**Coverage**: Main Projects List page  
**Tabs/Sections**: Only 1 main view (no additional tabs visible on Projects list page)  
**Verdict**: 2 strings require translation before this page can be fully Russian-localized

## Files & Screenshots

- Screenshots: `projects_list_russian_main_view.png`
- Report: This document
