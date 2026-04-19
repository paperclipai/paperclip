---
name: CodeSM MaaS
description: Marketing operations delivery pod for managing CodeSM's 30-client portfolio with clean intake, fulfillment, QA, and reporting.
slug: codesm-maas
schema: agentcompanies/v1
version: 1.0.0
license: MIT
authors:
  - name: Robert Dawson
goals:
  - Deliver organized marketing operations for CodeSM's 30-client portfolio while preserving an easy off-ramp if the contract ends.
  - Keep all client-facing deliverables and communications in draft status until a human approves them.
tags:
  - marketing-ops
  - client-portfolio
  - delivery-pod
---

CodeSM MaaS is a delivery pod for managing marketing operations across a large client portfolio.

The operating model is portfolio-first: the Managing Director sets priorities, the Portfolio Ops Lead keeps the client queue clean, fulfillment and reporting specialists produce the work, and the QA Approval Editor checks client-facing material before human approval.

Client work is organized as one project per placeholder client. Rename `client-01` through `client-30` inside Paperclip when real client names are ready.
