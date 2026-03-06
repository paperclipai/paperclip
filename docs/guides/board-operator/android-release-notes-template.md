---
title: Android Release Notes Template
summary: Template for internal Paperclip Android release announcements
---

Copy and fill this template for each Android internal release.

```md
# Paperclip Android — Internal Release Notes

## Release Metadata

- Version:
- Build ID:
- Release date (YYYY-MM-DD):
- Owner:
- Environment target: (dev/staging/prod-internal)
- Artifact location:
- Expo SDK / RN version:

## Scope

- Purpose of this release:
- In-scope user flows:
- Out-of-scope user flows:

## What Changed

### Added
- 

### Changed
- 

### Fixed
- 

## Test Summary

- Smoke suite status: (pass/fail)
- Config validated:
  - `EXPO_PUBLIC_PAPERCLIP_API_URL`
  - `EXPO_PUBLIC_PAPERCLIP_COMPANY_ID`
  - `EXPO_PUBLIC_PAPERCLIP_AGENT_ID`
- Devices tested:
  - 
- Android versions tested:
  - 
- Known failures:
  - 

## Known Issues

- Issue:
  - Severity:
  - Workaround:
  - Tracking link:

## Upgrade / Install Notes

- Fresh install notes:
- Upgrade notes:
- Required config changes:
- Token scope expectation: bearer token must match configured company + agent

## Rollback Plan

- Previous stable version:
- Rollback trigger:
- Rollback owner:

## Links

- QA report:
- Project issue:
- Related tickets:
```
