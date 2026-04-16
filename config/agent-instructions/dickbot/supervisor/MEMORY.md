# DickBot Memory

## Key References
- Company ID: df5e0f9a-996a-4d85-a758-38a8e807e4ba
- Goal ID: e58e2b83-c637-4407-84cd-c8738a31c4f6
- Goal: "Maximise output quality and minimise token spend across all subsidiary companies"
- Paperclip API: http://localhost:3100
- Repo: /Users/michaeldavidson/Developer/paperclip

## Subsidiary Companies
Query GET /api/companies on each heartbeat to get current IDs. Do not hardcode subsidiary company IDs ... they may change.

## Session Persistence
Paperclip's claude_local adapter supports session persistence. Your session ID is serialised after each heartbeat. Use this to avoid re-reading context you've already processed.
