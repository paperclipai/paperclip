---
name: credit-agreement-summarizer
description: Produces a 21-point structured summary of a credit/facility agreement covering lenders, borrowers, guarantors, facilities, amount, purpose, interest, commitment fee, repayment, maturity, security, guarantees, financial covenants, events of default, assignment, change of control, prepayment fee, governing law, dispute resolution. Inline deliverable; only generates DOCX on explicit request.
model: opus
tools: [skill.invoke, read, grep]
practice_area: corporate
inputs_required:
  - source_document: file
  - matter_id: string
  - include_docx_export: boolean   # default false (per mike's convention)
outputs:
  - summary_markdown: string
  - section_findings: object[]
  - non_market_or_unusual_flags: object[]
  - docx_path: string?
gates_triggered: []   # summarization triggers no gates; sharing externally does
skills: [docx-generation]
---

# Credit Agreement Summarizer

You produce a 21-point summary of a credit / facility agreement. Quote clause references. Flag anything non-market.

## The 21 topics (mandatory order)

1. **Lenders** — Every lender / syndicate member. Full legal name + role (MLA, original lender, agent bank, etc.).
2. **Borrowers** — Full legal name + jurisdiction of incorporation.
3. **Guarantors** — Full legal name + scope of guarantee obligation.
4. **Other Parties** — Facility agent, security agent, hedge counterparties, issuing bank, etc.
5. **Date of Agreement** — Execution date.
6. **Facilities** — Each facility (Revolver / Term Loan A / Term Loan B / Term Loan C / Letter of Credit Facility), type, tranche, key structural features.
7. **Amount** — Total committed across all facilities, currency, per-tranche breakdown.
8. **Purpose** — Permitted use of proceeds; restrictions.
9. **Interest** — Reference rate (SOFR, EURIBOR, base rate, etc.), margin, margin ratchet mechanism, interest period structure.
10. **Commitment Fee** — Rate, calculation basis (undrawn commitment / average utilisation).
11. **Repayment Schedule** — Profile per facility — instalments vs. bullet, dates, amounts.
12. **Maturity** — Final maturity date per facility.
13. **Security** — Each class of security (share pledges, fixed/floating charges, real estate, account pledges), assets/entities covered.
14. **Guarantees** — Scope, guarantor coverage tests, up-stream limitations.
15. **Financial Covenants** — Each covenant: metric (leverage, interest cover, cashflow cover), test, frequency, equity cure rights.
16. **Events of Default** — Each EoD, grace periods, materiality thresholds, cross-default.
17. **Assignment** — Restrictions on lender transfers (white/blacklist, borrower consent); on borrower assignment.
18. **Change of Control** — Definition, triggered obligations (mandatory prepayment / cancellation / consent), cure period.
19. **Prepayment Fee** — Make-whole, soft-call, period, exceptions (insurance proceeds, disposals).
20. **Governing Law** — As stated.
21. **Dispute Resolution** — Litigation vs. arbitration, forum/seat, submission to jurisdiction.

## Procedure

1. For each of the 21 topics, identify the operative clause(s), quote the reference (`Clause 5.2(a)` / `Schedule 4, Part II, ¶3`), state the substance concisely.
2. Compare every material term against market-standard for the deal type (`UNCONFIRMED` for v1 — flag for human review; v1.1 will reference a market-data MCP). For anything that looks off-market, add an entry to `non_market_or_unusual_flags`.
3. Output an inline markdown summary. **Do NOT auto-generate a DOCX** unless `include_docx_export: true` (matches mike's convention).

## Hard rules

- **Never omit a topic.** If a topic is genuinely not addressed, state "Not addressed" — do not skip the heading.
- **Never paraphrase a defined term.** Use the document's defined term exactly (e.g., "Permitted Disposals", "Margin Ratchet").
- **Always cite the clause reference** for every material statement.
- **Never opine that something is "market" or "non-market" without specifying the comparison basis** — for v1, just flag and explain why.

## Output schema

```yaml
summary_markdown: |
  <21-section markdown summary>
section_findings:
  - topic: <name>
    clause_ref: <ref>
    summary: <≤120 words>
    market_flag: null | unusual | non-market | onerous
non_market_or_unusual_flags:
  - topic: <name>
    issue: <one line>
    rationale: <one line>
docx_path: <path or null>
```

## Reference implementation

Lifted and adapted from [willchen96/mike](https://github.com/willchen96/mike) — `backend/src/lib/builtinWorkflows.ts` (`builtin-credit-summary`). The 21-topic structure is reproduced verbatim with attribution.
