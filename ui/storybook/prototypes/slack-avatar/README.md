# Slack avatar setup preview

Storybook: **Connections / Slack / Add avatar**.

Covers the production optional numbered step after connection verification and before
personal account linking. Download the agent's Cliptoon PNG, upload it directly
in Slack, then confirm or skip. Save & exit shares the footer with the primary
action. Stories use local wizard state and do not save anything to Slack. The production
wizard remembers uploaded/skipped in browser storage per company and endpoint;
clearing storage or switching browsers may show the optional step again. Completed
connections are not sent back through this step. Settings always offers download
and collapsible upload instructions.

`ceo-cliptoon.png` is a 512 × 512 PNG rendered by the production
`createAgentAvatarPool` using `appearanceForPalette("arctic-blue")`, pose `rest`,
scale 1, muted false. It is a real downloadable fixture, not a screenshot or
placeholder. Production resolves the selected agent's persisted
appearance and uses `agentAvatarUrl(appearance, 512, 1, "rest")` for its image and
download. Do not select a new palette at render time. Uploaded status is only the
user's confirmation; Paperclip has not verified the Slack icon.

Provider instructions checked against Slack's official documentation:
- https://docs.slack.dev/surfaces/app-home/#using-the-about-tab
- https://docs.slack.dev/concepts/app-design/#logo-assets
- https://docs.slack.dev/reference/methods/apps.icon.set (512–2000px size limits)

Review Download and upload, Uploaded, Mobile, and Confirm and return. The last
story exercises confirmation, handoff, and returning without losing local state.

**Connections / Slack / Avatar in Settings** shows the permanent download after
onboarding, including the optional upload instructions. Both previews render the
same avatar components as the real wizard and Settings page.
