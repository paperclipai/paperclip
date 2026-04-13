/**
 * Clerk login helper for the `authenticated` Playwright project.
 *
 * Phase 4 stub. When implemented, this will:
 *   1. Read seeded QA test user credentials from env vars (injected via Paperclip secrets):
 *      - VIRACUE_QA_TEST_USER_EMAIL
 *      - VIRACUE_QA_TEST_USER_PASSWORD
 *   2. Navigate to https://viracue.ai/sign-in in a fresh Chromium context
 *   3. Complete the Clerk flow (email + password + any bot checks Clerk allows test accounts to skip)
 *   4. Persist the resulting storageState to `.auth/qa-user.json` so the `authenticated` project
 *      can reuse it across spec runs
 *   5. Regenerate the cached storageState at most once per 23 hours to avoid session expiry
 *
 * Until this is implemented, any spec that requests `--project=authenticated` will fail because
 * the storageState path does not exist. That failure surfaces as a Playwright error which the
 * verification worker reports as `unavailable` with the reason, prompting the QA agent to either
 * switch to `anonymous` or escalate for Phase 4 completion.
 */
export async function loginToClerk(): Promise<void> {
  throw new Error(
    "Clerk login helper not yet implemented (Phase 4). Use --project=anonymous in the meantime.",
  );
}
