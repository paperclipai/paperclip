# Paperclip Custom v1 upgrades (Pelergy)

## Included upgrades

1. **Project roadmap strip** on project pages (`/projects/:id`) showing:
   - Live now (`in_progress`)
   - Next up (`todo`)
   - Waiting approval (`blocked`)
   - Done this week (`done` with completion in last 7 days)

2. **One-click Approve + Move** on issue detail pages:
   - If an issue has a linked pending approval, a button approves it from the issue flow.
   - Existing approval workflow then moves linked issues to `in_review` (scheduled-stage mapping).

3. **Launch checklist widget** for launch-like issues:
   - Checks: copy final, image attached, links valid, approval received, scheduled time set, proof captured.
   - Checklist metadata persists as an issue work product (`externalId=launch_checklist_v1`).

4. **Proof-link validator before Done**:
   - On done transition for launch-related issues, backend enforces complete checklist + proof metadata.
   - Required proof fields: URL/post ID, timestamp, platform/channel.

5. **RAG Ops control panel** replacing static registry behavior on Ops Health:
   - Pulls live plugin job rows (RAG, last/next run, blocker, next action).
   - Includes **Run now** action where trigger endpoint is available.

## Usage notes

- If done transition is rejected, complete launch checklist and save it on issue detail first.
- Checklist currently auto-detects launch issues from title/description keywords or existing checklist data.
- Ops Health job panel uses plugin jobs API and trigger endpoint (`POST /api/plugins/:pluginId/jobs/:jobId/trigger`).
