# Genesis SEO Operating Model

## Reporting hierarchy

```text
Ben — Founder / Business Owner
└── Hailey (`default`) — Head of Staff across companies
    └── Genesis SEO CEO — strategy, KPI and business quality
        └── Genesis SEO Director / deterministic controller — bounded cycle routing
            ├── Intelligence
            ├── Technical
            └── Content

Independent Reviewer ─┐
Read-only Compliance ─┴─> CEO closeout + Hailey judgement
```

There is no separate company Chief of Staff. Reviewer and compliance independence must not be collapsed into the delivery chain.

## Cycle entry gate

A cycle may start only when all are true:

- no active cycle exists for `genesis-seo`;
- fresh valid evidence, a due measurement or an owner/Hailey-approved objective exists;
- the proposed objective maps to the constitution;
- the project inventory shows no active duplicate;
- board, tenant, workspace, model and role allowlists validate;
- task cap is at most three;
- no production or public action is requested.

If no work is due, write an auditable no-work decision and remain idle. Do not create an empty graph.

## Deterministic stages

1. **Plan** — CEO selects one business KPI and produces bounded JSON.
2. **Workers** — one-role assignments execute in parallel only when independent.
3. **Review** — independent reviewer checks evidence, KPI relevance and acceptance criteria.
4. **Compliance** — read-only witness checks provenance, role separation and production wall.
5. **Closeout** — CEO records KPI status, decisions, stopped work and next measurement.
6. **Hailey** — consolidates company deltas and decides whether Ben is needed.

The controller—not the CEO, director, workers, crons or models—owns every graph mutation.

## Quality layers

### Worker layer

The worker must demonstrate that the artefact exists, acceptance criteria were exercised, sources are valid and no authority boundary was crossed.

### Independent review layer

The reviewer returns `PASS`, `REVISE` or `STOP`; it does not edit the candidate. A revision is a bounded successor, not an unbounded retry.

### Compliance layer

Compliance returns `PASS` or `FAIL` against policy/provenance and does not repair. A failed control blocks closeout.

### CEO business layer

The CEO decides whether the work changes the KPI hypothesis, should continue, should stop or needs a new measurement. Task completion alone is not business success.

### Hailey layer

Hailey checks cross-company priority, owner boundary and executive relevance. Hailey is the only reporting route to Ben.

## Retry and circuit breaker

- Same model: three attempts before cross-provider fallback.
- Task retry: maximum two closed attempts.
- Goal loop: maximum six turns.
- Company: maximum one active cycle.
- Cycle: maximum three worker tasks.
- Repeated stuck cycles: stop after three and route to Hailey.
- A repeated safety or evidence failure is not retried by weakening the guardrail.

## Blocker policy

A true owner blocker must require an owner decision and be one of:

- financial commitment;
- legal commitment;
- public reputation;
- irreversible action;
- credential authorisation;
- owner preference.

Technical troubleshooting, missing evidence, failed tools and weak drafts are company/Hailey problems, not reasons to message Ben.

## Production handoff

The company may produce an approval package containing:

- proposed change;
- current-state evidence and hash;
- exact scope;
- safety gates;
- backup and rollback;
- cache plan;
- rendered-live verification plan;
- residual risks.

It cannot execute the package. Hailey may execute only after explicit Ben approval and mandatory Genesis guardrails.
