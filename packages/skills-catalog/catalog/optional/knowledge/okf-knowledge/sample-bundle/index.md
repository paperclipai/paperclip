# Acme Robotics knowledge

Open Knowledge Format (OKF) v0.1 bundle exported from Paperclip. Each entry below is a markdown concept document with YAML frontmatter.

## Agent memory

- [Production deploy window policy](/memory/deploy-window-policy.md) — Deploys ship Tue/Thu 14:00-16:00 UTC only.
- [Release checklist](/memory/release-checklist.md) — Steps every release must complete before going live.

## Skills

- [Incident postmortem](/skills/incident-postmortem.md) — Write a blameless postmortem within 48h of a Sev1/Sev2 incident.

## Issue decisions

- [Adopt Postgres over DynamoDB for the orders service](/decisions/acme-318.md) — Relational integrity and ad-hoc reporting outweighed DynamoDB's scaling story at our volume.

## Documents

- [Orders → Postgres migration plan](/docs/acme-318-plan.md)

## Content Machine sources

- [Warehouse Automation Trends 2026](/sources/warehouse-automation-trends-2026.md) — Industry whitepaper feeding the Content Machine.
