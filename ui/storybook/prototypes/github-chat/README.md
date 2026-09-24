# GitHub chat and review bot — design approval preview

Open **Apps / GitHub chat & reviews / 00 · Start here**. All provider handoffs,
identity events, tool probes, GitHub output, and Paperclip tasks are fixtures.
No production route, credential storage, runtime, or provider call is changed.

The preview reuses Paperclip primitives and the shared setup navigation/footer.
The assigned agent, responsible user, bot-owned GitHub connection, and linked
Paperclip task remain visible throughout. Review configuration is local state.
The interactive start story supports Save & exit and refresh/resume through
sessionStorage; only non-secret settings are stored. Reset preview clears it.
Individual state stories start independently and do not persist settings.

The real setup's **Copy setup prompt** includes the current Paperclip origin.
For this preview, start Storybook with `PAPERCLIP_STORYBOOK_API_URL` set to the
real instance URL. The copied prompt then includes that instance instead of the
Storybook address. Without that setting, it asks for the instance URL.

## Review path

1. Walk the eight setup steps. GitHub dialogs explicitly simulate leaving and
   returning from GitHub. Tool and identity verification are separate gates.
2. Open Settings, change repository scope, edit an override, and reset it.
3. Open Access and try sponsored guest permissions.
4. Open Reviews, inspect GitHub output, and open the underlying Paperclip task.
5. Inspect the unavailable-tool, permission, webhook, expired-registration,
   save-error, incomplete-review, and mobile stories.

The Verification stories exercise the complete setup path, tool access gate,
repository override isolation, save retry, explicit guest access, installation
refresh without automatic enablement, and personal account sign-in using
Storybook play assertions. Browser walkthroughs also check rendered desktop and
mobile layouts. These test fixtures, not real GitHub delivery or agent execution.

Functional implementation and local/staging provider qualification follow design
approval. The implementation contract is doc/plans/2026-09-19-github-chat-review-bot.md.

## Revised design — user feedback

Installation and repository selection are separate steps. The repository picker
uses the regular GitHub connection's Refresh access and Configure access on GitHub
patterns. Its list represents the bot App installation inventory, independently
of Paperclip's enabled repository subset. The simulated GitHub configuration adds
acme/mobile; refreshing makes it available but leaves it disabled. Empty and
failed-refresh stories provide recovery paths. Settings reuses the same picker.

Identity linking now selects the current user's personal GitHub connection,
confirms its verified account, and uses ordinary sign-in/reconnect if needed.
There is no mention challenge or teammate invitation flow. A personal identity
link does not give the bot personal credentials. Access allows existing members
to link their own account.

The previous draft persistence key was versioned so saved seven-step previews
do not resume in the wrong step of the revised eight-step flow.

Local review links (port 6017):

- Installation: http://127.0.0.1:6017/?path=/story/apps-github-chat-reviews--install-app
- Repositories: http://127.0.0.1:6017/?path=/story/apps-github-chat-reviews--select-repositories
- Personal account: http://127.0.0.1:6017/?path=/story/apps-github-chat-reviews--connect-identity

All actions remain fixtures. Live provider and agent qualification and full
workspace integration checks follow design approval.

## Browser verification of this revision

- Completed the revised eight-step journey into Settings.
- Verified a GitHub installation access change appears only after refresh, leaves
  the new repository disabled, and preserves its selection across Back/Next.
- Exercised failed inventory refresh, retry, explicit selection, and progression.
- Exercised missing personal connection → simulated normal sign-in → choose a
  different personal account → explicit confirmation → linked account.
- Inspected repository and account screens on desktop and 390 × 844 mobile;
  neither page overflowed horizontally. No browser errors in the checked flows.
- UI typecheck and token gates passed. All provider actions above were fixtures.


## Approved access model

Access now includes all linked company members or an explicit member list, plus
specific external GitHub accounts confirmed through a simulated lookup. External
accounts require a sponsor and use the restricted guest profile. Newly added
people can mention the bot; automatic PR reviews start off and are controlled
separately per person. Existing members must link their own GitHub account before
being selected. Add-member is not a company invitation or identity-link operation.
Open-anyone access is deferred. Reviews stays as a view over task/run outputs.

The browser interaction stories cover external-account confirmation, required
sponsor, default automation off, removing access, missing member identity blocking
addition, and explicitly enabling automatic reviews for an added member.
