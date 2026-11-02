# Issue work-product attribution test audit — 2026-10-13

## Change and remaining proof

Remove the success-only `stores the authenticated agent run id when creating work products` case from `server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts`. It POSTed an artifact with omitted `createdByRunId` and asserted that the service received the authenticated run ID.

The retained `adds the authenticated run diff summary to PR work products` case exercises the same route with omitted attribution. It asserts the same `createdByRunId: ownerRunId`, plus the authenticated run's diff lookup and metadata. Forged create/update run attribution and foreign-company board attribution cases also remain.

The route's `resolveWorkProductCreatedByRunId` helper takes no work-product type. The POST route assigns `createInput.createdByRunId` unconditionally before type-specific metadata enrichment. The removed case used provider `test`, so it did not exercise the separate Paperclip artifact attachment metadata path. The service persists attribution generically across work-product types.

## Audit scope and evidence

Read all 83 original declarations, including the human self-handoff cases added in #16082. Before removal, the suite had 64 plain `it` declarations and 19 `it.each` declarations. After removal, it has 63 plain declarations and 19 `it.each` declarations; the 19 tables expand to 79 rows, for 142 runtime cases. Retain all other declarations: their route registrations, actor classes, recovery authority, admission, workspace defaults, or observable ordering differ. In particular, independently registered write routes must each preserve their authorization gate, even when they share a helper.

Reviewed the owning route attribution helper and POST handler, work-product service persistence and metadata helper, sibling `work-products.test.ts`, production route mounting, CLI work-product create/update commands, board API calls, test helper and Vitest configuration, CI selection, and relevant history. The removed case originated in `86b0fe7d01` on June 5; the stronger keeper arrived in `87d05e194b` (#12717) on September 2.

The suite already hoists its module graph (#13524). Its historical 50,945ms shard weight comes from September 12 and includes isolated process startup, imports, collection, tests, and shutdown. It is not a runtime savings estimate. CI still selects the file through the serialized route/authz matcher; PR and release workflows invoke `pnpm test:run:serialized` with shard parameters.

## Savings

- Test code: 16 lines removed, including its separator.
- Declarations: 83 → 82; expanded cases: 143 → 142.
- Requests: one fewer HTTP request per owner-suite run.
- Production and shared support: zero lines changed.
- Runtime savings: not measured.

## Validation

Focused exact-head validation passed with local bind access: `pnpm exec vitest run --project @paperclipai/server server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts` reported **142/142 passing** in 10.59 seconds (start 08:18:35; finish 08:18:45). Expected warning logs are produced by cases that inject revalidation failures. The corrected run was serialized and completed successfully. No timing savings are inferred from this test duration.

`git diff --check` passed for the changed test file; its exact source diff is zero added lines and 16 removed lines. No production mutation was performed in this change. A recommended preservation mutation is to temporarily remove the POST route's `createInput.createdByRunId = createdByRunId` assignment, require the retained PR case to fail its attribution assertion, then restore production byte-for-byte.

Whole-repository typecheck, test, build, and PR checks remain campaign-level gates.
