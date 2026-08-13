---
type: "decision"
title: "Adopt Postgres over DynamoDB for the orders service"
description: "Relational integrity and ad-hoc reporting outweighed DynamoDB's scaling story at our volume."
resource: "paperclip:issue:ACME-318"
tags:
  - "architecture"
  - "data"
timestamp: "2026-03-15T17:30:00Z"
---

# Adopt Postgres over DynamoDB for the orders service

Relational integrity and ad-hoc reporting outweighed DynamoDB's scaling story at our volume.

We evaluated DynamoDB and Postgres for the orders service. Order volume (~2M/day) fits comfortably in a single Postgres primary with read replicas, and finance needs ad-hoc SQL reporting that DynamoDB makes painful.

**Outcome:** Approved — migrate orders to Postgres by Q3.

# Citations
1. [Benchmark doc](https://example.com/bench)
