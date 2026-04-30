# LinkedIn Profile Enrichment Routine

**Trigger:** On-demand — fired by creating a Paperclip issue assigned to `marketing-specialist` with the Excel filename in the issue description  
**Concurrency policy:** `always_enqueue` — each run is independent (different files may run in parallel)  
**Catch-up policy:** `skip_missed`

---

## Overview

Given an Excel file containing people's contact details, this routine locates each person's LinkedIn profile URL using a DuckDuckGo → Apify fallback chain and writes the URL back into the same file under a new `linkedin_url` column. Rows that already have a URL are skipped unless explicitly configured to overwrite.

---

## Global Conventions

- **Timestamps:** ISO-8601 UTC (`2026-04-24T17:00:00Z`)
- **SharePoint site (hardcoded):** `https://medicodio.sharepoint.com/sites/MedicodioMarketing`
- **Hardcoded folder path:** SharePoint root of that site — files are accessed directly by filename with no subfolder prefix
- **Dynamic input:** Excel filename read from the Paperclip issue description at runtime
- **Full SharePoint file path:** `{dynamic_filename}` (root of MedicodioMarketing site)
- **LinkedIn URL validity:** Must contain `linkedin.com/in/` — reject `linkedin.com/company/`, `/jobs/`, `/posts/`, `/pulse/`, `/learning/`, `/sales/`
- **Overwrite policy:** Default `false` — skip rows that already have a `linkedin_url` value
- **Retry policy:** Apify calls — up to 3 retries with exponential backoff (2s → 4s → 8s)
- **Run log:** Written to `Marketing-Specialist/run-logs/{YYYY-MM-DD}-linkedin-enrichment.md` at end of each run

---

## Inputs — Where to Read Them

| Input | Source | Example |
|-------|--------|---------|
| Excel filename | Paperclip issue description — extracted at checkout | `apollo-contacts-export.xlsx` |
| Overwrite existing URLs | Issue description — look for "overwrite" keyword | default: `false` |
| Sheet name | Issue description — look for "sheet:" prefix | default: `Sheet1` |
| Row limit (test mode) | Issue description — look for "limit:" prefix | default: all rows |

**The filename comes from the issue description.** Whoever creates the issue must include the filename. The agent reads the issue description during Phase 0 checkout and extracts it before doing any work.

**Parsing rules:**
- Scan the full issue description for any word ending in `.xlsx` or `.xls`
- Strip surrounding whitespace, backticks, and quotes
- If no extension is found, append `.xlsx` and try that name
- If "overwrite" appears anywhere in the issue description → set `overwrite_existing = true`
- If `sheet:{name}` appears → use that sheet name; otherwise default to `Sheet1`
- If `limit:{N}` appears (e.g. `limit:10`) → process only the first N unprocessed rows; used for test runs

**SharePoint access for this file:**
```
Site:  https://medicodio.sharepoint.com/sites/MedicodioMarketing
Path:  {filename}   ← root of MedicodioMarketing site, no subfolder
```


---

## Column Name Mappings (Flex Headers)

Detect which columns exist in the Excel header row. Map to canonical names:

| Canonical | Accepted header variants (case-insensitive) |
|-----------|---------------------------------------------|
| `first_name` | `first name`, `firstname`, `first_name`, `fname`, `given name` |
| `last_name` | `last name`, `lastname`, `last_name`, `lname`, `surname`, `family name` |
| `full_name` | `full name`, `fullname`, `full_name`, `name`, `contact name`, `person name` |
| `company` | `company`, `company name`, `company name for emails`, `organization`, `organisation`, `employer`, `account name`, `firm` |
| `title` | `title`, `job title`, `jobtitle`, `position`, `role`, `designation` |
| `email` | `email`, `email address`, `work email`, `e-mail` |
| `linkedin_url` | `linkedin_url`, `linkedin url`, `linkedin`, `linkedin profile` |

**Resolution order for person name:**
1. If `full_name` column exists → use it directly
2. If `first_name` + `last_name` both exist → concatenate
3. If only `first_name` exists → use it alone (flag as low-confidence)
4. If none of the above → mark row as `skipped` with reason `"no name columns found"`

---

## Search Query Construction

Build the most specific query possible for each row using available columns.

**Priority order:**

```
1. first_name + last_name + company + title   (highest confidence)
   → '"{first_name} {last_name}" "{company}" "{title}" site:linkedin.com/in/'

2. first_name + last_name + company            (standard)
   → '"{first_name} {last_name}" "{company}" site:linkedin.com/in/'

3. full_name + company
   → '"{full_name}" "{company}" site:linkedin.com/in/'

4. first_name + last_name only (no company)    (low confidence — flag result)
   → '"{first_name} {last_name}" LinkedIn profile'

5. full_name only                              (low confidence — flag result)
   → '"{full_name}" LinkedIn profile'
```

**Sanitisation rules before query build:**
- Strip HTML entities and special characters from name fields
- Trim whitespace from all values
- If company name contains "Inc", "LLC", "Ltd", "Corp" suffixes → include them (they help precision)
- Never include email addresses in the LinkedIn search query

---

## PHASE 0 — Checkout and Parse Input

```
0a. Invoke Paperclip skill → Step 5 (Checkout)
    POST /api/issues/{issueId}/checkout
    { "agentId": "{your-agent-id}", "expectedStatuses": ["todo", "backlog"] }

    → On 409: another agent owns this issue — STOP, do not retry

0b. GET /api/issues/{issueId}/heartbeat-context
    → Read issue description

0c. Parse issue description:
    - Extract Excel filename (first .xlsx/.xls filename found, or first line of description)
    - Detect "overwrite" keyword → set overwrite_existing = true/false
    - Detect "sheet:{name}" → set target_sheet_name
    - If no filename found:
        PATCH /api/issues/{issueId}
        { "status": "blocked",
          "comment": "Cannot start: no Excel filename found in issue description.\n\nPlease update the issue description with the filename, e.g.:\n\n`apollo-contacts-export.xlsx`\n\nAnd reassign to me." }
        STOP

0d. Set constants:
    SHAREPOINT_SITE    = "https://medicodio.sharepoint.com/sites/MedicodioMarketing"   ← hardcoded, never changes
    FILE_PATH          = "{parsed_filename}"    ← root of MedicodioMarketing site; no subfolder prefix
    OVERWRITE_EXISTING = {parsed_overwrite}
    TARGET_SHEET       = "{parsed_sheet_name}"  ← default "Sheet1"
    ROW_LIMIT          = {parsed_limit}         ← null = process all rows; integer = cap at first N unprocessed rows

    All sharepoint_* calls use SHAREPOINT_SITE implicitly via the MCP server config.
    Pass FILE_PATH as the `path` or `filePath` parameter directly — it is just the filename.

0e. Post initial comment:
    "Starting LinkedIn enrichment for `{FILE_PATH}`.
     Overwrite existing URLs: {OVERWRITE_EXISTING}
     Target sheet: {TARGET_SHEET}"
```

---

## PHASE 1 — File Resolution and Validation

```
1a. sharepoint_get_file_info path="{FILE_PATH}"
    → SharePoint site: https://medicodio.sharepoint.com/sites/MedicodioMarketing (resolved by MCP server)
    → On success: confirm file exists, note file size and last modified date
    → On 404 / not found:
        PATCH /api/issues/{issueId}
        { "status": "blocked",
          "comment": "File not found in SharePoint.\n\nSite: `https://medicodio.sharepoint.com/sites/MedicodioMarketing`\nFile: `{FILE_PATH}`\n\nPlease verify the filename in the issue description and ensure the file is uploaded to the root of the MedicodioMarketing SharePoint site." }
        STOP

1b. Validate extension:
    - Must end with .xlsx or .xls
    - If neither → block with "Unsupported file type. Only .xlsx and .xls are supported."

1c. Log: "File confirmed: {FILE_PATH} ({file_size}, last modified {last_modified})"
```

---

## PHASE 2 — Excel Read and Column Detection

```
2a. sharepoint_excel_read_range
    → filePath: "{FILE_PATH}"
    → sheetName: "{TARGET_SHEET}"
    → address: ""         ← reads all data

    On error (sheet not found):
    - If TARGET_SHEET is not "Sheet1", retry with "Sheet1"
    - If still fails → block with "Could not read sheet '{TARGET_SHEET}' from {FILE_PATH}"

2b. Extract header row (row index 0)
    → Apply column name mappings from the table above (case-insensitive match)
    → Build column_map: { canonical_name → column_index }

    Log detected mappings, e.g.:
    "Column map: first_name→col 0, last_name→col 1, company→col 3, title→col 4, linkedin_url→col 8 (existing)"

2c. Validate required columns:
    - Must have at least ONE of: full_name, first_name, (first_name + last_name)
    - If none found:
        PATCH /api/issues/{issueId}
        { "status": "blocked",
          "comment": "Cannot find any name columns in `{FILE_PATH}` sheet `{TARGET_SHEET}`.\n\nHeaders found: {header_row}\n\nExpected at least one of: `Full Name`, `First Name`, `Last Name`, `Name`." }
        STOP

2d. Count rows:
    total_rows = total data rows (excluding header)
    empty_rows = rows where all name/company fields are blank
    already_enriched = rows where linkedin_url column has a non-empty value (only counted if OVERWRITE_EXISTING = false)
    eligible_rows = total_rows - empty_rows - (already_enriched if not overwriting)
    rows_to_process = if ROW_LIMIT is set → min(ROW_LIMIT, eligible_rows); else → eligible_rows

    If ROW_LIMIT is set:
      Log: "TEST MODE: ROW_LIMIT={ROW_LIMIT} — processing first {rows_to_process} eligible rows only"

    Log: "Total rows: {total_rows} | Empty: {empty_rows} | Already enriched: {already_enriched} | Eligible: {eligible_rows} | To process: {rows_to_process}"

2e. Post progress comment:
    "File read: {rows_to_process} rows to process out of {total_rows} total{if ROW_LIMIT: ' (test mode — limit: {ROW_LIMIT})'}."
```

---

## PHASE 3 — Row Processing Loop

Process each row sequentially. Track results in memory.

**Result tracking object per row:**
```
{
  row_index:     int,
  name:          string,
  company:       string,
  query_used:    string,
  search_method: "duckduckgo" | "apify" | "none",
  linkedin_url:  string | null,
  confidence:    "high" | "medium" | "low" | null,
  status:        "enriched" | "not_found" | "skipped" | "error",
  skip_reason:   string | null,
  error_detail:  string | null
}
```

For each data row (skip header row):

### 3.1 — Pre-flight checks

```
a. Skip if row is empty (all name/company fields blank)
   → status = "skipped", skip_reason = "empty row"
   → continue to next row

b. If linkedin_url column exists and cell has a value AND OVERWRITE_EXISTING = false:
   → status = "skipped", skip_reason = "already enriched"
   → continue to next row

c. Extract name fields using column_map:
   - first_name = row[column_map.first_name] if exists, else ""
   - last_name  = row[column_map.last_name]  if exists, else ""
   - full_name  = row[column_map.full_name]  if exists, else "{first_name} {last_name}".trim()
   - company    = row[column_map.company]    if exists, else ""
   - title      = row[column_map.title]      if exists, else ""

d. If full_name is blank after step c → status = "skipped", skip_reason = "no name data"
```

### 3.2 — Build search query

```
e. Apply query construction priority order (see Search Query Construction section above)
   → query = best query string for this row
   → log: "Row {row_index}: searching for [{full_name}] at [{company}]"
   → log: "Query: {query}"
```

### 3.3 — DuckDuckGo search (primary)

```
f. duckduckgo_search query="{query}" count=5

g. Scan all result URLs:
   - Filter for URLs containing "linkedin.com/in/"
   - Exclude URLs containing: "linkedin.com/company/", "/jobs/", "/posts/", "/pulse/", "/learning/", "/sales/navigator/"
   - Normalise URL: strip query params, strip trailing slash, lowercase scheme+domain
   - Collect: linkedin_candidates = list of qualifying URLs

h. If linkedin_candidates is not empty:
   → Select best match (see 3.5 Matching Logic below)
   → If confident match found:
       linkedin_url = selected URL
       search_method = "duckduckgo"
       → skip Apify call, go to 3.6

i. If linkedin_candidates is empty OR no confident match:
   → proceed to 3.4 (Apify fallback)
```

### 3.4 — Apify fallback (if DuckDuckGo returned no usable URL)

```
j. apify_call_actor
   → actorId: "apify/rag-web-browser"
   → input: {
       "query": "{query}",
       "maxResults": 5,
       "outputFormats": ["markdown"]
     }
   → async: false (inline call; if connection times out, recover using runId — see 3.4b)

   On Apify call failure (non-timeout):
   - If attempt < 3: wait {2^attempt} seconds, retry (exponential backoff: 2s, 4s, 8s)
   - If all retries exhausted:
       status = "error"
       error_detail = "Apify call failed after 3 retries: {error message}"
       log: "APIFY ERROR row {row_index}: {error_detail}"
       → continue to next row (do not block entire run)

3.4b — Handle MCP timeout (-32000: Connection closed):
   - Extract runId from original call response
   - Wait 10 seconds
   - get-actor-output runId="{runId}" limit=10
   - If still empty after recovery → treat as no results

k. ALWAYS call get-actor-output after every apify_call_actor:
   get-actor-output datasetId="{datasetId from response}" limit=10

l. Parse Apify output:
   - Scan all result text/URLs for "linkedin.com/in/" patterns
   - Extract full profile URLs using regex: https?://(?:www\.)?linkedin\.com/in/[A-Za-z0-9_%-]+
   - Apply same exclusion rules as step g
   - Collect: linkedin_candidates from Apify results

m. If linkedin_candidates found:
   → Select best match (see 3.5)
   → search_method = "apify"
   → If still no confident match after Apify:
       linkedin_url = null
       status = "not_found"
       log: "NOT FOUND row {row_index}: [{full_name}] at [{company}] — no confident match after DuckDuckGo + Apify"
       → continue to next row
```

### 3.5 — Matching Logic (shared by DuckDuckGo and Apify paths)

When `linkedin_candidates` has one or more URLs, select the best match:

```
For each candidate URL:
  score = 0

  a. Name match (weight: 3)
     - Extract slug from URL: linkedin.com/in/{slug}
     - Normalise slug: replace hyphens with spaces, strip digits
     - If full_name words all appear in slug → score += 3
     - If first_name appears in slug → score += 1
     - If last_name appears in slug → score += 2

  b. Company match (weight: 2)
     - If company name words appear in the search result snippet/title → score += 2
     - Partial match (≥ 50% of words) → score += 1

  c. Title match (weight: 1)
     - If title words appear in search result snippet → score += 1

  d. Confidence classification:
     - score ≥ 4 → confidence = "high"
     - score 2–3 → confidence = "medium"
     - score 0–1 → confidence = "low"

Select the candidate with the highest score.

Acceptance threshold:
  - If best score ≥ 2 (medium or high) → accept URL as the match
  - If best score < 2 (low confidence) → do NOT write the URL
      linkedin_url = null
      status = "not_found"
      log: "LOW CONFIDENCE row {row_index}: best score {score} — skipping to avoid false positive"
```

### 3.6 — Record result

```
n. Store row result:
   {
     row_index,
     name: full_name,
     company,
     query_used: query,
     search_method,
     linkedin_url,
     confidence,
     status: ("enriched" if linkedin_url found, else "not_found")
   }

o. Progress log every 10 rows:
   "Progress: {processed}/{rows_to_process} rows done. Found: {enriched_count} | Not found: {not_found_count} | Skipped: {skipped_count}"
```

---

## PHASE 4 — Excel Write-Back

```
4a. Determine linkedin_url column index:
    - If column_map.linkedin_url exists → use that column index
    - Else → append new column after last existing column
      (Header value: "linkedin_url")

4b. Build write operations:
    - For each row result with status = "enriched":
        cell = row[column_map.linkedin_url or new_column_index]
        value = result.linkedin_url
    - For rows with status = "not_found" or "skipped" → do not write (leave cell as-is)

4c. sharepoint_excel_write_range
    → filePath: "{FILE_PATH}"
    → sheetName: "{TARGET_SHEET}"
    → Write header "linkedin_url" to new column header cell (if column is new)
    → Write each linkedin_url value to corresponding row cell

    On write error:
    - Retry once after 3 seconds
    - If second attempt fails → post error comment and mark issue blocked:
        "Excel write failed after retry: {error}. File may be locked or permission denied.
         Manual intervention required."
        PATCH issue → blocked
        STOP

4d. Verify write:
    - sharepoint_excel_read_range → read back the linkedin_url column
    - Spot-check 3 random enriched rows to confirm values persisted
    - Log: "Write verified — {N} linkedin_url values confirmed in file"
```

---

## PHASE 5 — Run Log and Summary

```
5a. Build summary object:
    {
      file_name:        string,
      file_path:        string,
      sheet_name:       string,
      total_rows:       int,
      empty_rows:       int,
      already_enriched: int,
      processed:        int,
      enriched:         int,         ← linkedin_url found and written
      not_found:        int,         ← searched but no confident match
      skipped:          int,         ← empty rows + already enriched
      api_errors:       int,
      search_methods:   { duckduckgo: int, apify: int },
      confidence_breakdown: { high: int, medium: int }
    }

5b. Write run log to SharePoint:
    sharepoint_write_file
    → path: "Marketing-Specialist/run-logs/{YYYY-MM-DD}-linkedin-enrichment.md"
    → content:
    ---
    # LinkedIn Enrichment Run — {YYYY-MM-DD HH:MM UTC}

    **File:** {file_path}
    **Sheet:** {sheet_name}

    ## Summary
    | Metric | Count |
    |--------|-------|
    | Total rows | {total_rows} |
    | Empty rows (skipped) | {empty_rows} |
    | Already enriched (skipped) | {already_enriched} |
    | Rows processed | {processed} |
    | LinkedIn URLs found | {enriched} |
    | Not found (no confident match) | {not_found} |
    | Errors (API failures) | {api_errors} |

    ## Search Methods
    - DuckDuckGo resolved: {duckduckgo_count}
    - Apify resolved: {apify_count}

    ## Confidence Breakdown
    - High confidence: {high_count}
    - Medium confidence: {medium_count}

    ## Rows Not Found
    {table of name + company for not_found rows}

    ## Errors
    {list of row index + error detail for error rows, if any}
    ---

5c. Post final comment on issue:
    scripts/paperclip-issue-update.sh --issue-id "$PAPERCLIP_TASK_ID" --status done <<'MD'
    LinkedIn enrichment complete.

    **File:** `{file_path}` (sheet: `{sheet_name}`)

    | Metric | Count |
    |--------|-------|
    | Total rows | {total_rows} |
    | Processed | {processed} |
    | LinkedIn URLs found | {enriched} |
    | Not found | {not_found} |
    | Skipped | {skipped} |
    | API errors | {api_errors} |

    Run log saved to SharePoint: `Marketing-Specialist/run-logs/{YYYY-MM-DD}-linkedin-enrichment.md`
    MD

5c-notify. Teams notification (non-blocking):
  teams_send_channel_message
    teamId    = $TEAMS_MARKETING_TEAM_ID
    channelId = $TEAMS_MARKETING_CHANNEL_ID
    contentType = "html"
    content:
      ✅ LinkedIn Enrichment Complete<br>
      <br>
      File: {file_path} (sheet: {sheet_name})<br>
      Processed: {processed} rows<br>
      LinkedIn URLs found: {enriched}<br>
      Not found: {not_found} | Skipped: {skipped} | Errors: {api_errors}<br>
      Run log: Marketing-Specialist/run-logs/{YYYY-MM-DD}-linkedin-enrichment.md<br>
      Issue: {PAPERCLIP_TASK_ID}
  If it fails → add "⚠️ Teams notification failed: {error_message}" to issue comment and continue.

5d. PATCH /api/issues/{issueId}
    { "status": "done" }
```

---

## Error Handling Reference

| Situation | Action |
|-----------|--------|
| No filename in issue description | Block issue with instructions to add filename |
| File not found in SharePoint | Block issue with exact path tried |
| Unsupported file extension | Block issue with supported types |
| Sheet not found | Retry with `Sheet1`; if still fails, block |
| No name columns in Excel | Block issue with headers found |
| Empty row | Skip row, note in run log |
| No name data after column resolve | Skip row, note in run log |
| DuckDuckGo returns no LinkedIn URL | Fall through to Apify |
| Apify MCP timeout (-32000) | Recover via `get-actor-output runId=...` |
| Apify call error | Retry up to 3× with exponential backoff (2s/4s/8s); mark row as error after exhaustion |
| Low-confidence match (score < 2) | Do not write URL; mark row as `not_found` |
| Excel write failure | Retry once after 3s; block issue if both fail |
| All rows already enriched | Post comment "All rows already have LinkedIn URLs. Nothing to do." → mark done |

**Teams failure notification (non-blocking) — send when the routine encounters an unrecoverable error or sets issue → blocked:**
  teams_send_channel_message
    teamId    = $TEAMS_MARKETING_TEAM_ID
    channelId = $TEAMS_MARKETING_CHANNEL_ID
    contentType = "html"
    content:
      🔴 LinkedIn Enrichment — Technical Failure<br>
      <br>
      File: {file_path}<br>
      Error: {error_message}<br>
      Issue: {PAPERCLIP_TASK_ID}<br>
      <br>
      Routine stopped. Check issue for details.
  If it fails → add "⚠️ Teams notification failed: {error_message}" to issue comment and continue.

---

## SharePoint Folder Structure

**Site:** `https://medicodio.sharepoint.com/sites/MedicodioMarketing`

```
(site root)/
├── {excel-file}.xlsx                          ← updated in-place with linkedin_url column
└── Marketing-Specialist/
    └── run-logs/
        └── YYYY-MM-DD-linkedin-enrichment.md  ← per-run summary log
```

The Excel file lives at the **root** of the MedicodioMarketing site (same location as Apollo export files). The run log is written under `Marketing-Specialist/run-logs/` to keep it consistent with the daily-lead-outreach routine's log structure.

---

## How to Trigger This Routine

Create a Paperclip issue assigned to `marketing-specialist` with the **Excel filename in the issue description**. The file must already be uploaded to the root of `https://medicodio.sharepoint.com/sites/MedicodioMarketing`.

**Minimal description:**
```
apollo-contacts-export.xlsx
```

**With options:**
```
Enrich: apollo-contacts-export.xlsx
Sheet: in
Overwrite existing URLs
```

The agent reads the filename from the issue description at checkout and resolves it against the hardcoded SharePoint site. No manual input or approval gate is required — it runs fully automated and marks the issue `done` upon completion.
