---
name: paperclip-ux-edit
description: >
  Implement Paperclip board UI/UX changes in this repo and push the result into
  the running local Paperclip service. Use when editing `ui/src/pages/*`,
  `ui/src/components/*`, or closely related client-side data flow and the
  request expects the change to be visible in the live local app, not just in
  the dev checkout.
---

# Paperclip Ux Edit

Use this skill for Paperclip-specific frontend work in this fork when the task is not complete until the running local app reflects the change.

## Use This Skill When

- changing Paperclip React pages, components, or UI-adjacent client data flow
- adjusting search, filtering, empty states, layout polish, or other board UX
- the user expects the local always-on Paperclip service to show the result after closeout

Do not use this skill for backend-only API work, plugin authoring, or generic websites outside the Paperclip board.

## Workflow

1. Ground in the existing Paperclip context.
- Read `AGENTS.md` plus the issue/project context first.
- Preserve existing company-scoped flows and reuse the current query/data path instead of inventing a parallel browse route.
- For UI quality and consistency, also use `frontend-design`, `design-guide`, and `web-design-guidelines`.

2. Implement in the development checkout.
- Default workspace is `Paperclip`.
- Prefer minimal edits to the current page/component over wider rewrites.
- Add focused tests when practical.
- Keep verification notes and API/UX tradeoffs for the issue closeout.

3. Push the change live before calling the task done.
- “Done” means the running local Paperclip app reflects the UX change, not just that the dev checkout was edited.
- Follow `references/live-push.md` to determine which checkout owns the running service, mirror the minimal validated diff if that service is not this repo, and restart only the checkout that actually serves the live app.

4. Close out with delivery details.
- Say which dev-checkout files changed.
- Say whether the live checkout was mirrored.
- Include verification plus any dependency or service-state blockers that affected the work.

## References

- `references/live-push.md` — fork-specific live-service tracing, mirror, restart, and confirmation steps for local Paperclip UX work.
