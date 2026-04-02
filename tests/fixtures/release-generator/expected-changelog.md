# v2026.090.1

> Released: 2026-03-31

## Features Shipped

- **Dashboard Redesign** (PAP-1234) — Modern grid-based layout with drag-and-drop widget positioning, dark mode toggle with system theme detection, and full responsive design. ([#2847](https://github.com/paperclipai/paperclip/pull/2847), @alice, @bob)
- **Real-Time Metrics Integration** (PAP-1245) — WebSocket-based bi-directional connection for metric streaming with automatic reconnection, live chart updates with 1-second frequency, and 24-hour historical data retention. ([#2851](https://github.com/paperclipai/paperclip/pull/2851), @alice, @bob)

## Features Dropped (v2026.091)

- **User Preferences and Settings** (PAP-1256) — QA evaluation did not meet acceptance threshold (22/40). Requires architectural redesign with proper state management pattern, accessibility audit for WCAG 2.1 AA compliance, and comprehensive test coverage.

## QA Results Summary

| Feature | Functionality | Product Depth | Visual Design | Code Quality | Overall |
|---------|---------------|---------------|---------------|--------------|---------|
| Dashboard Redesign | 9/10 | 8/10 | 9/10 | 8/10 | **34/40 PASS** |
| Real-Time Metrics Integration | 8/10 | 7/10 | 7/10 | 8/10 | **30/40 PASS** |

## Contributors

@alice, @bob, @charlie

---

**Sprint Duration**: 3 hours 7 minutes  
**Production URL**: https://dashboard.paperclipai.dev  
**Release Type**: Cloudflare Pages  
