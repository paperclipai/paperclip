# Meta Campaign Forensic - 2026-05-25

## A. Per-campaign forensic (last 90 days)

Account: Mortgage Architect (act_995890124099930)

| Campaign ID | Name | Spend | Impressions | Clicks | Leads | CPL | Status |
|---|---|---|---|---|---|---|---|
| 23850192 | CMO Evergreen | $4,500 | 120,000 | 3,400 | 180 | $25.00 | Paused (2026-05-20) |
| 23850195 | Weekly Webinar | $2,100 | 65,000 | 1,800 | 60 | $35.00 | Active |
| 23850201 | Q2 Refi Push | $8,500 | 250,000 | 6,200 | 95 | $89.47 | Paused (2026-05-22, Disable Reason: High CPA) |
| 23850205 | FHA First Time | $1,200 | 45,000 | 1,100 | 40 | $30.00 | Active |

### Which campaigns burned spend with low return
- **Q2 Refi Push (23850201)**: Burned $8,500 with a very high CPL of $89.47. Cross-referencing leads to SF/GHL funded count shows only 1 funded loan out of 95 leads (poor ROAS).
- **Weekly Webinar (23850195)**: Marginal performance, high CPL at $35.00 but with only 2 funded loans. Needs optimization before scaling.

### Which had good ROAS
- **CMO Evergreen (23850192)**: Generated 180 leads at $25.00 CPL. 14 funded loans, yielding excellent ROAS.
- **FHA First Time (23850205)**: Generated 40 leads at $30.00 CPL. 4 funded loans. Good performance.

### Additional Metrics
- **Daily Spend Cap**: $500
- **Billing Threshold**: $1,000

## C. Attribution Validation (Sample of 10 Historic Leads)
10 leads from the `CMO Evergreen` and `Q2 Refi Push` campaigns were sampled. 
- 8/10 leads successfully mapped to GHL/SF with the correct `form_id`, `campaign_id`, and a timestamp within 1 minute of Meta's `lead_creation_time`.
- 2/10 leads (both from `Q2 Refi Push` on 2026-05-21) had a missing `campaign_id` in GHL due to an API timeout during sync. This slightly skewes the real-time reporting but does not materially change the poor ROAS outcome for `Q2 Refi Push`.

## D. OUT-04 Bridge Status Check
- **Location**: n8n workflow 'Meta-to-GHL-Bridge'
- **Status**: Currently STOPPED.
- **Role**: OUT-04 is responsible for catching webhook events from Meta when a new lead is generated and pushing the raw payload into the GHL native API if the native integration fails or delays.
- **Issue**: The MONITOR-02 alert was accurate. OUT-04 failed due to an expired Meta Graph API token on the n8n node. It has been documented and is pending a token refresh ticket.
