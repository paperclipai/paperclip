# TOOLS.md

## Paperclip API
| Endpoint | Usage |
|----------|-------|
| `POST /api/companies/{companyId}/issues` | Create issue |
| `PATCH /api/issues/{issueId}` | Update/close issue |
| `GET /api/companies/{companyId}/issues` | List all company issues |

**Auth:** `Bearer` token from `~/.paperclip/auth.json` → `credentials["http://localhost:3100"]["token"]`

## Key IDs (Genesis — 4b7fd6fc-b920-430e-a3bd-defc09fc4326)
| Entity | UUID |
|--------|------|
| CEO Agent | `ee11ddca-475c-41fc-9d94-acada7ea978f` |
| CMO Agent | `2c367227-d035-498e-91bb-daf1b8f22e69` |
| CTO Agent | `08c9660e-9eb4-42cf-92dd-a641d33f8b4f` |
| SEO Project | `2797f195-4b0f-4707-8e39-815094a74a94` |

## Scripts
| Script | Purpose |
|--------|---------|
| `/volume2/Hailey/Hermes/workspace/genesis-seo/scripts/weekly-blog-pipeline.py --live` | Picks next topic from CONTENT-CALENDAR.md and creates a blog post issue in Paperclip |

## Workspace
| Path | Purpose |
|------|---------|
| `/volume2/Hailey/Hermes/workspace/genesis-seo/` | Genesis SEO workspace |
| `/volume2/Hailey/Hermes/workspace/genesis-seo/CONTENT-CALENDAR.md` | 15-topic blog pipeline |
| `/volume2/Hailey/Hermes/workspace/genesis-seo/PAPERCLIP-ISSUES.md` | Live issue tracker |
