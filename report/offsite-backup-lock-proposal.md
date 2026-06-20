# Offsite Backup Duplicate-Scheduler Lock Proposal

This report captures a safe proposal for repairing a self-hosted offsite backup
job that can be scheduled by both an internal cron registry and a macOS
LaunchAgent at the same minute. The concrete machine-specific change should be
reviewed and approved before applying it to any live backup host.

## Problem

A restic-backed offsite backup can fail with an exclusive repository lock when
two schedulers start the same backup script concurrently. If the health monitor
only checks the scheduler's last-run freshness, it can report the backup as
healthy even when the backup log contains a recent `failed rc=11` line.

## Recommended Repair

Use the internal cron job as the authoritative scheduler and disable the
duplicate LaunchAgent after approval.

Reasons:

- The backup script is already modeled as an internal no-agent cron job, with
  run metadata and output retained in the cron registry.
- The automation status monitor already evaluates cron job freshness, so it is
  the smaller integration point for surfacing backup failures.
- Keeping one scheduler removes the root race instead of relying on restic's
  repository lock as the first line of defense.

## Hardening Changes To Apply After Approval

1. Disable the duplicate LaunchAgent with a reversible backup of the plist.
2. Add a script-level single-run guard so future duplicate schedule drift fails
   before restic starts.
3. Make the backup script exit non-zero when restic backup or retention pruning
   fails, instead of printing an alert and returning success.
4. Extend the automation status monitor to flag the backup RED when the latest
   backup terminal log line is a failure, especially `failed rc=11`.
5. Add duplicate-schedule detection in the monitor for jobs that point to the
   same script at the same calendar minute across cron and LaunchAgent.

## Acceptance Criteria

- Only one scheduler remains active for the offsite backup script.
- A single manual approved run finishes with a terminal `offsite-backup ok`
  line.
- No second `restic` or backup-script process is active during or after the run.
- The automation status monitor reports the backup healthy after a clean run.
- A synthetic or historical terminal `offsite-backup failed rc=11` line is
  surfaced as RED by the monitor.
- The monitor flags a reintroduced same-minute duplicate schedule before it can
  cause another repository lock race.

## Verification Commands

These commands are intentionally read-only except for the approved one-time
backup run.

```sh
tail -n 80 ~/.hermes/logs/offsite-backup.log
pgrep -fl 'restic|offsite-backup' || true
python3 ~/.paperclip/bin/hermes-automations-status.py
```

After approval, run the selected scheduler once or wait for the next scheduled
fire, then repeat the commands above.

## Rollback

Keep the disabled LaunchAgent plist as a timestamped backup. If the internal
cron path fails independently, restore the plist, reload it through launchd, and
pause the cron job until the monitor and script exit semantics are fixed.
