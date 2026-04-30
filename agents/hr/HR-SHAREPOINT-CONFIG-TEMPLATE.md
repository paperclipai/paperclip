# HR-Onboarding/config.md — SharePoint Config File

> **Instructions:** Upload this file to SharePoint at:
> `HR-Onboarding/config.md`
> on site: `https://medicodio.sharepoint.com/sites/MedicodioMarketing`
>
> The HR agent reads this file on startup as a fallback for env vars.

---

## Routine IDs

```
ONBOARDING_ROUTINE_ID: ddedecdb-871a-4ad1-980b-5935a2ecda75
```

---

## SharePoint Paths

```
SHAREPOINT_BASE_PATH: HR-Onboarding
AUDIT_LOG_PATH: HR-Onboarding/audit-log.csv
```

---

## Default HR Contact

```
DEFAULT_HR_NAME: Karthik
DEFAULT_HR_EMAIL: karthik.r@medicodio.ai
DEFAULT_HUMAN_IN_LOOP_EMAIL: karthik.r@medicodio.ai
```

---

## Nudge Timing (hours)

```
NUDGE_1_THRESHOLD_HOURS: 24
NUDGE_2_THRESHOLD_HOURS: 48
STALL_THRESHOLD_HOURS: 72
```

---

## Notes

- All values here are fallbacks. Env vars take precedence.
- Update `ONBOARDING_ROUTINE_ID` if the routine is redeployed.
- This file is read by the agent via `sharepoint_read_file path="HR-Onboarding/config.md"`.
