# ZAI-145 Cross-Locale Screenshot Sweep — i18n R3

## Summary

| Locale | Verdict | Pages | Leakage |
|--------|---------|-------|---------|
| en | PASS | 5 pages | 0 with leakage |
| ru | WARN | 5 pages | 4 with leakage |
| de | WARN | 5 pages | 4 with leakage |
| es | WARN | 5 pages | 4 with leakage |
| fr | WARN | 5 pages | 4 with leakage |
| it | WARN | 5 pages | 4 with leakage |
| pt | WARN | 5 pages | 4 with leakage |
| zh | WARN | 5 pages | 4 with leakage |

**Overall: 1 PASS / 7 WARN / 0 FAIL**

## Russian Locale (ru) Acceptance Criteria

- **Agents heading → Агент**: MISS
- **Board → Совет**: MISS
- **Properties → Свойства**: MISS
- **Relative times in Russian**: MISS — no Russian time strings found
- **No raw i18n keys**: PASS
- **Agents heading → Агент**: MISS
- **Board → Совет**: MISS
- **Properties → Свойства**: MISS
- **Relative times in Russian**: MISS — no Russian time strings found
- **No raw i18n keys**: PASS
- **Agents heading → Агент**: MISS
- **Board → Совет**: MISS
- **Properties → Свойства**: MISS
- **Relative times in Russian**: MISS — no Russian time strings found
- **No raw i18n keys**: PASS
- **Agents heading → Агент**: MISS
- **Board → Совет**: MISS
- **Properties → Свойства**: MISS
- **Relative times in Russian**: MISS — no Russian time strings found
- **No raw i18n keys**: PASS

## English Leakage Details

### ru
- **dashboard**: leaked strings: `Agents`, `Priority`, `Status`, `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
- **inbox**: leaked strings: `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
- **agents**: leaked strings: `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
- **activity**: leaked strings: `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
### de
- **dashboard**: leaked strings: `Agents`, `Priority`, `Status`, `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
- **inbox**: leaked strings: `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
- **agents**: leaked strings: `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
- **activity**: leaked strings: `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
### es
- **dashboard**: leaked strings: `Agents`, `Priority`, `Status`, `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
- **inbox**: leaked strings: `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
- **agents**: leaked strings: `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
- **activity**: leaked strings: `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
### fr
- **dashboard**: leaked strings: `Agents`, `Priority`, `Status`, `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
- **inbox**: leaked strings: `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
- **agents**: leaked strings: `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
- **activity**: leaked strings: `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
### it
- **dashboard**: leaked strings: `Agents`, `Priority`, `Status`, `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
- **inbox**: leaked strings: `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
- **agents**: leaked strings: `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
- **activity**: leaked strings: `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
### pt
- **dashboard**: leaked strings: `Agents`, `Priority`, `Status`, `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
- **inbox**: leaked strings: `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
- **agents**: leaked strings: `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
- **activity**: leaked strings: `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
### zh
- **dashboard**: leaked strings: `Agents`, `Priority`, `Status`, `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
- **inbox**: leaked strings: `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
- **agents**: leaked strings: `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`
- **activity**: leaked strings: `Inbox`, `Activity`, `Settings`, `New Issue`, `Search`, `Board`

## Screenshots

Screenshots saved to `qa-zai145-screenshots/` organized by locale.