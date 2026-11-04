# Agent adapter validation route fixture audit — 2026-10-13

Status: remove one duplicate positive test. Based on `github/master` `d67e3507b23041212fa26302ce6de078c5ebcc05`. Owner: `server/src/__tests__/agent-adapter-validation-routes.test.ts`. Production code is unchanged.

## Fixture consolidation and removed declaration

The dynamic external-adapter positive now sets an unrelated adapter as disabled. This same retained declaration proves the registered `external_test` adapter remains selectable and asserts both HTTP 201 and the returned adapter type. Remove the weaker duplicate positive that separately asserted only HTTP 201. Keep the disabled-selection rejection cases and the case that permits editing an existing disabled adapter.

The audit also considered deleting the local `requestApp` helper and replacing its 38 uses with direct `request(app)` calls. Do not include that cleanup here: the direct-request version repeatedly approached or exceeded the 15-second first-test timeout locally, while the focused baseline passed. Keep the helper until a broader timing comparison shows no regression.

The remaining route declarations continue to cover provider-specific model refresh, credentials, rollback, Runner rollout, Dot authorization, provider admission, validation failures, and partial edits. The production entry point remains `routes/agents.ts`; UI configuration and create/hire flows call these routes. CI discovers this filename in the serialized route/authz lane.

## Local validation and savings

The historical serialized weight is 24,906 ms and includes isolated process startup, imports, tests, and teardown. It is not a measured runtime reduction. The change removes one test declaration and about 13 test lines, including its separator. It removes no production lines, and no CI time reduction is claimed.

Focused exact-head validation passed: `pnpm exec vitest run --project @paperclipai/server server/src/__tests__/agent-adapter-validation-routes.test.ts` reported **44/44 passing** in 29.57 seconds with local bind access. `git diff --check` is also required before commit. Relevant adapter registry/environment siblings remain to be validated if later changes touch their behavior.

## Integration with current master

The disabled-adapter fixture moves into the existing dynamic-registration keeper. Newer saved-legacy, harness-selection and native-Codex rollout regression cases from master are retained unchanged.
