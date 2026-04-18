---
name: architecture-review
description: Schema-first architecture review. Traces data flow end-to-end, evaluates schema health, identifies structural risks, and produces actionable recommendations.
---

# Architecture Review

Systematic review of system architecture with a schema-first lens. Evaluates data models, API contracts, component boundaries, and integration points.

## When To Use

- Before a major feature build (validate the foundation)
- When a system "feels wrong" but nobody can explain why
- After acquiring or inheriting a codebase
- Before scaling a system (find the bottlenecks before they find you)
- When refactoring decisions need data, not opinions

## The Review Process

### Step 1: Schema Audit

Start at the data layer. Everything else depends on this.

**Read:** Database schema files, migration history, ORM models, type definitions.

**Evaluate:**
- Do table/collection names map clearly to domain concepts?
- Are relationships explicit (foreign keys, joins) or implicit (string matching, conventions)?
- Is there data duplication that could drift?
- Are there fields that exist but are never read? Fields that are overloaded (storing different things based on context)?
- Does the schema support the current feature set, or is it being worked around?

**Output:** Schema health report. Red flags, yellow flags, green flags. Each flag includes: what it is, why it matters, what to do about it.

### Step 2: API Contract Review

Trace how data moves between layers.

**Read:** Route definitions, API handlers, middleware, request/response types.

**Evaluate:**
- Do API shapes match schema shapes, or is there a translation layer doing heavy lifting?
- Is error handling consistent? (Same error format across all endpoints?)
- Are there endpoints that do too much? (Multiple unrelated mutations in one call?)
- Is authentication/authorization checked at the right layer?
- Are there undocumented side effects? (Endpoint that "also" sends an email, updates a cache, triggers a webhook?)

**Output:** API contract map. List of endpoints with: purpose, input shape, output shape, side effects, auth requirements, known issues.

### Step 3: Component Boundary Analysis

How is the system decomposed?

**Evaluate:**
- Are component boundaries aligned with domain boundaries?
- Is there circular dependency between modules?
- Can a component be understood without reading its neighbors?
- Are shared utilities actually shared, or are they one component's internals leaking?
- Is the abstraction level consistent within each layer?

**Output:** Boundary assessment. Which boundaries are clean, which are leaking, which should be merged or split.

### Step 4: Data Flow Trace

Pick 3 critical user journeys. Trace each end-to-end:

User action > Frontend component > API call > Middleware > Handler > Database query > Response > State update > UI render

For each journey, document:
- Happy path (works correctly)
- Error path (what happens when it fails at each layer?)
- Edge cases (empty state, concurrent access, stale data)

### Step 5: Risk Assessment

Synthesize findings into a prioritized risk list:

| Risk | Severity | Likelihood | Impact | Recommendation |
|------|----------|------------|--------|----------------|
| [description] | High/Med/Low | High/Med/Low | [what breaks] | [what to do] |

### Step 6: Recommendations

Produce 3 tiers of recommendations:
- **Fix now:** Active risks that will cause problems at current scale
- **Fix before scaling:** Latent risks that activate under load or growth
- **Improve when convenient:** Quality improvements that reduce maintenance burden

Each recommendation includes: what to change, why, estimated effort, and what to watch for during the change.

## Quality Gate

Before delivering the review, verify:
- [ ] Schema was actually read (not assumed from API shapes)
- [ ] At least 3 data flow traces completed
- [ ] Recommendations are specific (not "improve error handling" but "add try/catch to payment webhook handler because failures silently drop events")
- [ ] Severity ratings justified with evidence
- [ ] No recommendations that contradict each other
