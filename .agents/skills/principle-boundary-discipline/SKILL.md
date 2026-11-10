---
name: principle-boundary-discipline
description: "Apply when changing module contracts, provider integrations, validation, error handling, or framework adapters. Keep special-purpose policy with its owner, shared contracts narrow, and validation at system boundaries."
disable-model-invocation: true
---

# Boundary Discipline

Place validation, type narrowing, and error handling at system boundaries. Trust internal code unconditionally. Business logic lives in pure functions. The shell is thin and mechanical.

**Why:** Scattered validation is noisy, redundant, and gives a false sense of safety. Keep logic out of framework wiring so it can be tested without the framework.

**The pattern:**
- **At boundaries** (CLI args, config files, external APIs, network protocols): validate, return errors, handle defensively.
- **Inside the system:** typed data, error propagation, no re-validation. Trust the types.
- **Across the boundary.** Expose domain concepts, not the boundary's private representation. Keep general-purpose mechanism inside and special-purpose policy at the edge.

**Applications:**

Validation and error handling:
- Validate config at parse time (the boundary), not inside business logic
- Parse raw data into domain types at the boundary
- Do not re-export transport, storage, framework, or wire types through the public surface
- No redundant nil checks deep in call chains if the boundary already validated

Code organization:
- Business logic in pure functions with no framework dependencies
- Parse functions: pure transforms from raw bytes to typed state
- Prompt construction: structured state in, string out
- Scoring and assessment: pure transforms from state to results

**Module ownership and shared changes:**

Before a substantive change crosses modules, identify the behavior's owner,
the existing contract callers should use, and why that contract is insufficient.
Use the task's existing plan or review description; this does not require a new
document or approval step.

- Keep provider protocols, payload interpretation, workarounds, and feature-specific
  sequencing in their owning module. Shared code consumes normalized domain
  contracts. A small registration table or dispatch branch may select the provider
  and delegate its behavior.
- Reuse existing extension points before adding the smallest typed contract the
  concrete workflow needs. Moving a function or renaming an interface does not
  remove a dependency on private implementation details. Do not pass the whole
  service context just to make extraction easy.
- For each substantive change outside the owning module, explain the shared
  capability, affected existing consumers, and behavior when the new feature is
  absent or disabled. Group related files by responsibility; declarations,
  branding, and registration can remain in their established locations.
- Ask whether removing or substituting the provider would leave a coherent shared
  contract. One consumer can justify a general capability; hypothetical reuse or
  a second fixture alone does not. Preserve meaningful provider differences and
  avoid speculative frameworks.
- Review delivery scope separately from code ownership. A correctly factored
  platform capability may need an independently reviewable slice or an explicit
  dependency in a PR stack. Keep tests and docs with their behavior, preserve
  requested features, and respect the user's delivery constraints.
- Keep authorization, isolation, audit, transaction, and resource ownership
  invariants with their existing owners. Trusting validated types does not replace
  checks of current authority or state. Provider isolation must not bypass them.
- Verify the changed contract through the new consumer and relevant existing
  consumers, including feature absence or disablement where behavior could change.
  Test observable outcomes. Identifier searches, line counts, and passing CI do not
  establish sound boundaries by themselves.

Apply these checks to changed behavior; an unrelated fix does not require a
subsystem rewrite.

**The tests:**
- "Is this data crossing a system boundary right now?" If not, validation is redundant.
- "Can this be a pure function that the shell just calls?" If yes, extract it.
- "Does the shared layer understand a provider protocol, or only select its implementation?" Delegate protocol behavior to the owner.
- "Why must this change live outside the feature, and what does it change for existing consumers?" Explain both ownership and delivery scope.
