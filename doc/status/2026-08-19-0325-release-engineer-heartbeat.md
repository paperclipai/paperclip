# Release Engineer Heartbeat — Aug 19 ~03:25 UTC

## VOY-1413: Docs Site Deploy — Blocked on VOY-1421 (Founder Gate)

### Wake: CEO Board Status comment acknowledged (f2109413)
CEO board confirmed Track B verified on vps-1 and PR #50 merged; Track A (Mintlify
dashboard) remains gated on VOY-1421 — founder must connect the repo in the Mintlify
dashboard. Re-verified current state this heartbeat:

### Live verification (curl)
| Check | Result |
|-------|--------|
| https://voyonder.com/case-studies/ | **404** — still not serving Paperclip docs (gate 1 open) |
| https://voyonder.com/ | 200 — Mintlify starter, no Discord link (gate 2 open) |
| fork/master @ 55a3be8cfa | PR #50 squash present — case studies + Discord links on repo |
| fork/master docs/case-studies/ | 4 case studies + index present |
| fork/master docs.json | Discord in topbarLinks + footerSocials |

### Disposition
- **Status: blocked** — set on the issue this heartbeat
- **Unblock owner:** founder (Ben) via VOY-1421: log into mintlify.com, connect
  PraeSynBH/paperclip to paperclip.mintlify.app, point at docs/ with docs.json
- Once VOY-1421 lands, Mintlify auto-deploy picks up fork/master and gates 1–3 close
  together; Release Engineer re-verifies live URLs immediately after

### Other assigned issues
No new code-release work queued. All prior release issues done/cancelled.
