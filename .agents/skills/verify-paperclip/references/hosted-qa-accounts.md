# Hosted QA accounts and credentials

Use this for testing Cloud login and tenant journeys. It is an environment setup
recipe, not a requirement for local or self-hosted verification.

## Known testing setup

- `https://test.paperclip.app` is the testing Cloud portal. The persistent tenant
  is `https://qa.test.paperclip.app`. Keep testing distinct from staging and
  production, including operator origins and secret namespaces.
- AgentMail supplies `qa@paperclipbots.com`. The custom `paperclipbots.com` domain
  is admitted for testing sign-up. Verify admission through the actual customer
  session when it matters; inbox access alone does not prove admission.
- A dedicated QA account and the persistent workspace already exist. Reuse them
  for existing-user journeys. Account authentication, workspace creation, and
  product onboarding are separate coverage claims.
- Hosted testing currently supports normal email-code authentication. A mailbox
  key is an infrastructure credential; the short-lived sign-in code is not a
  durable password. Do not fabricate a password for a passwordless account.
- The private Cloud Product E2E adapter owns the AgentMail and operator secret
  references, registered stack/company IDs, leases, and cleanup. Locate its
  `scripts/product-e2e/README.md` and reference-only target configuration. Use
  that adapter for campaigns rather than inventing a second Cloud provisioner.

The QA inbox credential can be inbox-scoped/read-only: domain listing or inbox
creation may return 403 while reading the configured QA inbox succeeds. An older
AgentMail key may expose only an `agentmail.to` inbox. That is not the allowed
custom-domain identity; do not silently substitute it. Read the configured inbox
directly. Create a new inbox only when the requested journey needs one and the
available account has that capability.

The Cloud Product E2E credential is the rotation authority. A host-side 1Password
copy can become stale when that shared key rotates, even while browser cookies
still work. Probe the exact inbox and verify a fresh email-code session when
qualifying authentication. If the copy fails, reconcile it from the authorized
current source and verify read-back before creating another key. Record the
rotation owner and mirror refresh procedure in private setup; preserve the
original failed attempt. Use the declared staging AWS profile/region when a
one-time reconciliation reads the Cloud secret, and keep IAM access outside the
normal 1Password-only login dependency.

For Dotta's QA journeys, reading the current verification email in the dedicated
test account's mailbox is an authorized part of sign-in, including Ralph's
GitHub device verification through existing AgentMail credentials. Do not ask
again for that same mailbox access on every run. Keep it scoped to the named QA
account, current login attempt, expected sender, and recipient; this does not
authorize reading unrelated mail. Declare the mailbox and its credential binding
as an explicit harness dependency rather than assuming the Paperclip QA inbox
also receives another account's codes.

Ralph's dedicated verification binding is a separate, single-inbox, read-only
AgentMail key saved in 1Password, expiring **2027-10-23**. Resolve its current
item reference from the private Ponytail account registry; keep provider keys
out of this public reference. Normal GitHub password and current-device-email
verification worked without exporting a passkey. Use the supported ordinary
authentication flow; request assistance only if an additional factor actually
requires it. Expiry is a setup prerequisite and renewal responsibility, not a
reason to read another inbox or create credentials on every eval attempt.

Cloud's shared GitHub OAuth App, the QA user's saved product connection, and a
journey-created review-bot App are separate resources. A 404 before GitHub consent
can be a registration prerequisite failure: compare the broker's actual client
ID/callback with the intended environment registration, then inspect whether the
App can be authorized by accounts outside its owner. A private App is not the
required public distribution for that setup. Verify the repaired OAuth handoff
and exact QA identity separately; changing visibility alone does not prove a
saved user connection or a working review bot. Keep one-time administrator repair
credentials outside normal per-attempt dependencies. Do not silently substitute
a personal token or another account for the requested connection route.

## 1Password access and durable records

The host is expected to supply `OP_SERVICE_ACCOUNT_TOKEN` for a designated QA
vault. It must permit reading required items and creating/updating credential
records when setup includes saving credentials. Successful reads do not prove
write permission. Save the intended account record and verify its returned item
ID; on denial, report the missing capability and retain the setup as incomplete.
Do not mark credentials saved, substitute a personal account, or change vault
permissions yourself.

On Dotta's macOS host, the bootstrap token is stored in Keychain under service
`codex-1password`, account `$USER`. Read it with `/usr/bin/security
find-generic-password -a "$USER" -s "codex-1password" -w` inside a process that
captures stdout in memory and passes it only to the `op` child. A long-lived
shell's `OP_SERVICE_ACCOUNT_TOKEN` may be stale after rotation. Use the configured
bootstrap source; never run that command in a way that prints its result. CI
should inject its own service-account token through the runner's secret store.

Use `op://` references in private setup profiles, with stable aliases such as
`paperclip-qa-user`, `agentmail-qa-inbox`, and `github-qa-user`. Bind each alias to
its account, consumer, required scopes, reference/field, and ownership. The
service-account token bootstraps the harness secret resolver; it never belongs
in a browser, product-agent environment, committed file, or evidence report.
Use the CLI's structured stdin input when creating an item. On macOS, `op`
may ignore Node socket-backed stdin; the private setup helper uses an actual
POSIX pipe and verifies saved fields rather than trusting an item ID. Keep secret values
out of shell arguments, transcripts, screenshots, and temporary handoff files.

For a passwordless account, save the login URL, username, authentication method,
and reference to the approved mailbox credential. Save a real password only if
the product actually creates one. Preserve passkeys in their supported
authenticator and record that attended authentication may be required; a
1Password service account's ability to read a login item does not prove it can
exercise that item's passkey.

## Authenticate, verify, and retain

1. Read the exact QA inbox and credential bindings from private setup. Capture
   message IDs already present before requesting a code.
2. Use the normal portal UI and dedicated QA identity. For a genuinely new
   account, complete its sign-up flow and save its account record. For the
   existing QA account, reuse normal sign-in without resetting credentials.
3. Read only the current attempt's verification mail. Match the configured
   sender, exact recipient, unseen message ID, time window, and one unexpired
   code. Keep the key and code in process memory; exclude authentication pages
   and raw email from screenshots, traces, and reports.
4. Verify the authenticated principal and, if workspace creation is relevant,
   `capabilities.canCreateOrganizations` through the customer session. Enter the
   intended tenant and verify its actual company. A portal login alone does not
   prove tenant access.
5. Record the account alias, credential-item reference, target, auth method,
   fresh/reused state, and the observed outcome in private evidence. Keep pending
   credential storage explicit. Retain the shared QA account, inbox, workspace,
   and reusable repository; clean up only attempt-owned resources.

Use the shared Product Journey target adapter for automated authentication and
ownership. Fixed UI scripts prove the actions they execute; an email login to an
existing account does not establish new-account onboarding coverage.
