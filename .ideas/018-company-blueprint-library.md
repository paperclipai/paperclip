# 018 — Company Blueprint Library (Parameterized Templates)

## Suggestion

Paperclip can import/export whole companies (`company-portability.ts`; `companies.sh` is a
shipped roadmap item), which makes a company *portable* — but every new company still starts
from a blank org chart. Standing up a sensible team (CEO → CTO/CMO/CFO → reports, with budgets,
roles, and initial goals wired correctly) is the highest-friction, most error-prone part of
getting value from Paperclip, and the Dry-Run Estimator (idea 004) exists partly because it's
so easy to misconfigure. Export gives you *reuse of a specific company*; what's missing is
*reusable, parameterized blueprints*.

Add a **blueprint library**: curated, parameterized company templates ("SaaS startup,"
"content marketing agency," "research lab") that an operator instantiates by answering a few
prompts (goal, budget, which adapters), producing a ready-to-run org.

## How it could be achieved

1. **Blueprint = parameterized export.** Build on the portability format: a blueprint is a
   company export with declared *variables* (company goal, total budget, preferred adapter/model
   per role, team size) and templated fields that get substituted at instantiation.
2. **Instantiation wizard.** A guided flow collects the variables, validates them with the
   existing company/agent/budget validators, and runs the Dry-Run Estimator (idea 004)
   automatically so the operator sees projected cost before launch.
3. **Built-in starter set.** Ship a handful of opinionated blueprints reflecting real
   structures (the README's "note-taking app to $1M MRR" is a perfect canonical example),
   each with role definitions, default adapter configs, and starter goal trees.
4. **Adapter-agnostic substitution.** Because the agent is defined by its adapter config, a
   blueprint should let the operator swap the whole org from (say) Claude Code to a local LLM
   (idea 008) at instantiation — same structure, different runtime/economics.
5. **Community sharing (later).** A signed, importable blueprint format so operators can publish
   and exchange org designs — with `source-trust.ts` gating untrusted blueprints on import.

## Perceived complexity

**Medium.** The serialization backbone exists; the new work is the variable/templating layer,
the instantiation wizard, and a quality starter set. The instantiation logic must be robust —
a half-applied blueprint that leaves a company in an invalid state is worse than no blueprint —
so it should build atomically and run validation + dry-run before going live. Community sharing
adds a trust/security surface and is rightly a later phase.
