# Uptime Monitoring

Automated uptime monitoring for the Paperclip production and preview instances.

## How It Works

The GitHub Actions workflow `.github/workflows/uptime-monitor.yml` runs every 5 minutes and checks the `/api/health` endpoint on both production and preview.

### What it checks

- HTTP GET to `${PRODUCTION_URL}/api/health` and `${PREVIEW_URL}/api/health`
- Expects HTTP 200 with `{"status": "ok"}` response
- Timeout: 30s (10s connect)

### On failure

- **Production**: Creates a GitHub issue labeled `downtime` with details. Subsequent failures add comments to the existing open issue (no duplicates).
- **Preview**: Logs a warning in the workflow run (no issue created).

## Setup

### 1. Add repository secrets

Go to **Settings → Secrets and variables → Actions** in the GitHub repo and add:

| Secret           | Description                                    | Example                         |
| ---------------- | ---------------------------------------------- | ------------------------------- |
| `PRODUCTION_URL` | Production instance base URL (no trailing `/`) | `https://app.paperclip.ing`     |
| `PREVIEW_URL`    | Preview/staging instance base URL (optional)   | `https://preview.paperclip.ing` |

### 2. Create the `downtime` label

Create a GitHub label named `downtime` (color suggestion: `#d73a4a`) so alerts are easy to filter.

### 3. Verify

Run the workflow manually: **Actions → Uptime Monitor → Run workflow**.

## Responding to Alerts

1. Check the GitHub issue for the HTTP status code and timestamp.
2. Verify with: `curl -v https://<domain>/api/health`
3. If the health endpoint returns `{"status": "degraded"}` (HTTP 503), the database is unreachable — check the Postgres container.
4. Close the downtime issue once the service is restored.

## SLA Tracking

Uptime history is tracked via workflow run history in GitHub Actions. To calculate uptime percentage:

- Each run is a 5-minute window
- Successful runs = uptime, failed runs = downtime
- Monthly uptime = (successful runs / total runs) × 100

View history: **Actions → Uptime Monitor → filter by status**.
