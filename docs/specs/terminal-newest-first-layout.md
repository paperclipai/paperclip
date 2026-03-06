---
id: paperclip-feature-terminal-newest-first-layout
title: Terminal Newest-First Layout
doc_type: spec
owner: paperclip
status: active
version: 1.1.0
updated: 2026-03-06
applies_to:
  - ui/src/pages/IssueDetail.tsx
  - ui/src/pages/AgentDetail.tsx
  - ui/src/components/LiveRunWidget.tsx
related_docs:
  - /home/avi/projects/paperclip/AGENTS.md
toc: auto
---

# Terminal Newest-First Layout

## Summary

Terminal output in both the issue detail and agent detail views renders newest entries at the top so the user sees the latest output without scrolling.

## Changes

### Issue Detail — LiveRunWidget position

`LiveRunWidget` renders directly above the tab strip (Comments / Sub-issues / Activity), not inside the Comments tab. It is always visible regardless of which tab is selected.

### LiveRunWidget — reversed output

Output items are rendered in chronological DOM order inside a `flex flex-col-reverse gap-1` container. CSS reversal makes the newest (last DOM child) appear at the visual top without JS manipulation. The `slide-in-from-top-1` animation applies to `index === recent.length - 1` (the newest item). The scroll effect resets to `top: 0` (instant, not smooth) to snap back if the user has scrolled down.

Previous implementation used `[...feed].reverse()` + smooth `scrollTo({ top: 0 })`, which failed during rapid message streams: browser scroll anchoring shifted `scrollTop` upward faster than the async `useEffect` could reset it, causing newest messages to appear off-screen at the top.

### AgentDetail LogViewer — reversed output

`visibleTranscript` is reversed before rendering. The `logEndRef` sentinel div is placed at the top of the log container so `findScrollContainer` resolves correctly. Auto-follow tracks `distanceFromTop <= 32px` (was `distanceFromBottom`). `scrollToContainerTop` replaces `scrollToContainerBottom` for auto-follow and the "Jump to live" button.

## Behaviour contract

| Scenario | Expected |
|----------|----------|
| New run starts | LiveRunWidget appears above tabs immediately |
| New log line arrives (LiveRunWidget) | Entry animates in at visual top (flex-col-reverse); container snaps to scroll top:0 |
| New log line arrives (LogViewer, user at top) | Auto-follow maintains scroll position at top |
| User scrolls down in LogViewer | Auto-follow releases; "Jump to live" button appears |
| "Jump to live" clicked | Scrolls to top of container, auto-follow resumes |
