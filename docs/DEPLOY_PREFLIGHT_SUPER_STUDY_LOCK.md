# Deploy Preflight Super Study Lock

This file is the current frozen working memory for the SINK DINK India Paperclip organisation build.

## Strict working rule

Do not patch randomly.

Before every deploy-affecting code change:

1. Re-read the current repo state.
2. Re-check Paperclip official route/auth/middleware pattern.
3. Re-check Render deploy risk.
4. Re-check Supabase insert/audit risk.
5. Re-check Hugging Face worker limits and route behavior.
6. Re-check Gemini fallback and QA gate behavior.
7. Re-check dashboard/control-room flow.
8. Create or update a preflight note first.
9. Patch one small scope only.
10. Test in this order: Render health -> worker status -> single worker create -> AI campaign -> controlled workflow.

## Current remembered project state

The project is not at the beginner stage.

The project already reached this stage before chat context loss:

- content generation had worked
- QA had passed
- reels/media output had appeared
- remote media output pipeline had produced upload-ready assets
- the remaining work was in the final bulk organisation steps
- the active step is the AI integration / controlled organisation workflow layer

## Current verified architecture

- Paperclip dashboard/control room: user-facing company dashboard and approval surface
- Render: Paperclip backend, orchestration, routes, auth, approval guard
- Hugging Face Space: remote SINK DINK media worker
- Supabase: jobs table and audit log memory
- GitHub: source code and deploy history
- Gemini: campaign/content brain when enabled
- Human: final approval and manual publishing decision

## Paperclip official pattern to preserve

- Routes are mounted under the Paperclip API router.
- Mutating board requests are protected by boardMutationGuard.
- Browser-origin mutations require trusted Origin or Referer.
- Existing working routes must not be broken.
- Dashboard/control-room UI must remain the normal user surface.

## Current working routes

These have passed or are expected to stay working:

- GET /api/health
- GET /api/health/sink-dink/remote-worker/status
- POST /api/health/sink-dink/remote-worker/create
- GET /api/sink-dink/ai-campaign/status
- POST /api/sink-dink/ai-campaign/create
- GET /api/sink-dink/agent-workflow/status

## Current known blocker

POST /api/sink-dink/agent-workflow/start-day has failed because the wrapped internal POST to /api/sink-dink/ai-campaign/create was blocked by Paperclip boardMutationGuard:

- HTTP status: 403 from wrapped campaign route
- error: Board mutation requires trusted browser origin
- wrapper returned 502

This is not a media worker failure.
This is not a Gemini failure.
This is not a Supabase failure.
This is a Paperclip trusted-browser-origin/auth integration issue in the controlled workflow wrapper.

## Do not repeat these mistakes

- Do not assume core pipeline is broken when only the wrapper fails.
- Do not deploy multiple unrelated changes at once.
- Do not change the existing AI campaign route unless evidence proves it is the issue.
- Do not change Hugging Face worker when the failure is Paperclip origin/auth.
- Do not expose or commit secrets.
- Do not bypass human approval.

## Safety locks

Always preserve:

- agentsRunMode = paused_human_approval
- approvalStatus = pending_human_approval
- humanApprovalRequired = true
- publishingBlocked = true
- no auto-publishing
- no auto-spend
- no uncontrolled loop

## Next correct technical direction

The next code step must be based on Paperclip middleware, not random wrapper guessing.

Study and decide between these safe options before patching:

1. Mount the controlled workflow route before boardMutationGuard if it must act as an internal orchestrator.
2. Or refactor the AI campaign logic into a shared internal service function and let both routes call that function, avoiding an internal HTTP POST.
3. Or make the self-call use a Paperclip-supported board_key/cloud_tenant actor route if available and safe.

Preferred long-term clean solution:

- Extract AI campaign creation logic into an internal service module.
- /api/sink-dink/ai-campaign/create calls the service.
- /api/sink-dink/agent-workflow/start-day calls the same service directly.
- No internal HTTP self-call.
- No boardMutationGuard conflict.
- Existing public route behavior stays unchanged.

## Next deploy file rule

Before the next deploy, prepare a small technical patch plan that states:

- exact files to change
- exact route behavior
- why it will not break existing working pipeline
- rollback plan
- expected test output
