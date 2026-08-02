# TSC-7179 Postiz Channel Inventory Blocker

Date: 2026-07-30
Issue: TSC-7179

## What was verified

- Authenticated into `https://social.thinkstack.ie/auth/login` with the existing Postiz admin credential and landed on `/launches`.
- Read the live `ThinkStack MC` org integration inventory from `GET /api/integrations/list`.
- Verified 11 connected integrations total:
  - Pinterest: `thearoidatlas`, `dastardlyprint`, `margaretashbridge`
  - Facebook: `Dastardly Print`, `The Aroid Atlas`
  - Instagram: `Dastardly Print`, `The Aroid Atlas`
  - Threads: `thearoidatlas`, `dastardlyprint`
  - Bluesky: `margaretashbridge.bsky.social`, `clarahatherleigh.bsky.social`
- Verified the inventory contains no ThinkStack Capital / TSC-owned channels, so there is no routable target for the 8 `TSC-7174` tiles.

## Artifact paths

- Inventory snapshot JSON: `work-products/TSC-7179/integrations-2026-07-30.json`
- This note: `work-products/TSC-7179/postiz-channel-inventory-blocker-2026-07-30.md`

## Blocking implication

- Auth is working.
- Queue staging is blocked specifically on missing TSC-routable channels in the live Postiz org, not on agent auth or local tooling.
