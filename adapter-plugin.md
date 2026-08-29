- Created branch: feat/external-adapter-phase1

   I started phase 1 in the most merge-friendly way I could: small central changes, reusing existing registry patterns instead of inventing a whole new plugin system up front.

   What I changed

   1. Server adapter registry is now mutable
   Files:
  - server/src/adapters/registry.ts
  - server/src/adapters/index.ts

   Added:
  - registerServerAdapter(adapter)
  - unregisterServerAdapter(type)
  - requireServerAdapter(type)

   Kept the existing built-in registry shape, but changed initialization so built-ins are registered into a mutable map on startup.

   Why this is merge-friendly:
  - existing built-in adapter definitions stay where they already are
  - existing lookup helpers still exist
  - no big architectural rewrite yet

   1. Runtime adapter validation moved to server routes
   File:
  - server/src/routes/agents.ts

   Added:
  - assertKnownAdapterType(...)

   Used it in:
  - /companies/:companyId/adapters/:type/models
  - /companies/:companyId/adapters/:type/detect-model
  - /companies/:companyId/adapters/:type/test-environment
  - POST /companies/:companyId/agents
  - POST /companies/:companyId/agent-hires
  - PATCH /agents/:id when adapterType is touched

   Why:
  - shared schemas can now allow external adapter strings
  - server becomes the real source of truth for “is this adapter actually registered?”

   1. Shared adapterType validation is now open-ended for inputs
   Files:
  - packages/shared/src/adapter-type.ts
  - packages/shared/src/validators/agent.ts
  - packages/shared/src/validators/access.ts
  - packages/shared/src/index.ts

   Changed input validation from hardcoded z.enum(AGENT_ADAPTER_TYPES) to:
  - agentAdapterTypeSchema
  - optionalAgentAdapterTypeSchema

   These accept any non-empty string.

   Important:
  - I did not remove AGENT_ADAPTER_TYPES from constants
  - I did not change the built-in type unions yet
  - this keeps the change minimal and limits blast radius

   So:
  - input payloads can carry external adapter types
  - actual acceptance still depends on server registry validation

   1. UI adapter registry is now mutable too
   Files:
  - ui/src/adapters/registry.ts
  - ui/src/adapters/index.ts

   Added:
  - registerUIAdapter(adapter)
  - unregisterUIAdapter(type)
  - findUIAdapter(type)

   Built-ins are still registered from the same file, same pattern as server.

   1. Began switching UI adapter lists toward the registry
   Files:
  - ui/src/adapters/metadata.ts
  - ui/src/components/AgentConfigForm.tsx
  - ui/src/pages/NewAgent.tsx

   Changed:
  - AgentConfigForm adapter list now comes from registered UI adapters via metadata helper
  - NewAgent supported adapter set now derives from listUIAdapters()

   Why:
  - phase 1 should start reducing hardcoded UI lists
  - but without rewriting every page at once

   1. Tests added first, then implementation
   New tests:
  - server/src/__tests__/adapter-registry.test.ts
  - server/src/__tests__/agent-adapter-validation-routes.test.ts
  - ui/src/adapters/registry.test.ts
  - packages/shared/src/adapter-types.test.ts

   Small test mock fix:
  - server/src/__tests__/agent-skills-routes.test.ts

   Current status

   The branch is created and the phase-1 code is started.

   I also followed TDD in spirit:
  - wrote failing tests first for missing register/unregister APIs
  - then implemented the registry changes

   What is not finished yet

   I have not finished the green/stabilization pass yet.

   I still need to:
  - run the targeted tests again after the implementation changes
  - fix any TS / mocking fallout
  - decide how far to take phase-1 UI wiring in this branch before stopping

   Also, I intentionally did not yet touch the bigger hardcoded surfaces like:
  - NewAgentDialog
  - OnboardingWizard
  - InviteLanding
  - duplicated adapterLabels maps
  - plugin manifest / plugin loader adapter contributions

   That is deliberate.
   For merge safety, I started with the smallest useful seam:
  - dynamic server registry
  - dynamic UI registry
  - runtime validation based on registry
  - first couple of UI consumers

   One note
   There was already an unrelated dirty change in:
  - server/scripts/dev-watch.ts

   I left that alone and did not make phase-1 changes there.

   Recommended next move
   I should keep going on this same branch and do the stabilization pass:
   1. rerun server/ui/shared targeted tests
   2. fix failures
   3. run typechecks
   4. then extend the same registry-driven approach to the next safest UI surfaces
