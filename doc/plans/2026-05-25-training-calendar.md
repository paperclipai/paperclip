# Training Calendar Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a TrainingPeaks-inspired training calendar surface to Paperclip, with an embedded chat widget and a separate settings page for OAuth/provider/model/integration configuration.

**Architecture:** Keep this first iteration UI-first and company-scoped in the Paperclip board shell. Use typed React components and local UI state/localStorage so the product surface is usable immediately without introducing secrets or unfinished OAuth backends. Leave OAuth actions as explicit provider connect affordances that can later call server routes.

**Tech Stack:** React 19, Vite, TypeScript, Tailwind utility classes, lucide-react icons, existing Paperclip router/nav/layout.

---

## Task 1: Build the training calendar page

- Create `ui/src/pages/TrainingCalendar.tsx`.
- Render a TrainingPeaks-like week calendar with athlete/workload summary, workout cards, planned/completed status, intensity zones, TSS/duration metrics, and right-side embedded chat widget.
- The chat widget must live inside the page, not replace Paperclip comments globally.

## Task 2: Build the training configuration page

- Create `ui/src/pages/TrainingSettings.tsx`.
- Include separate sections for AI providers (OpenAI, Anthropic, Google/Gemini, OpenRouter, Other), OAuth connect buttons, post-login model selection, Garmin and Strava OAuth connect toggles, sync preferences, and clear security copy: no API keys shown/stored in UI.

## Task 3: Wire routes and navigation

- Modify `ui/src/App.tsx` to import and route `/training` and `/training/settings`.
- Modify `ui/src/components/Sidebar.tsx` to add a Fitness/Training nav section or item.
- Optionally update mobile nav only if it remains clean.

## Task 4: Verify

- Run `pnpm --filter @paperclipai/ui typecheck`.
- If feasible, run `pnpm --filter @paperclipai/ui build`.
