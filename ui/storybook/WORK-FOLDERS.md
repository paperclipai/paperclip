# Work-folder design review

Run `pnpm storybook` from the repository root. Open the **Work folders** group.
The default URL is `http://localhost:6006`.

## Current pages

**Work folders / Pages / Development Settings** shows the opt-in **Allow
viewing cached task files** toggle under Paperclip Developer Mode. It defaults
to off. **Task Page Cached Files** shows the enabled task properties: choose
**View cached files**, then Task, Project, Agent, or Responsible user to preview
and download their saved collections. The inspector identifies the data as cached, potentially behind the sandbox disk.
Select checkboxes to move files to retained trash; restore them from the Trash
tab for that scope. User scope follows the
task's responsible user and remains private to that user.

Task Page and Mobile Task Page show the default, disabled state. Agent Page,
Project Page, and Profile Settings Page have no standalone stored-file buttons.
Live sandbox filesystem browsing remains a future feature.

**Work folders / Stored-file prototype** retains the reusable browser for design
reference only. Its editing controls are explicitly labeled as unshipped; the task inspector
uses the same browser with selection, trash, and restore controls. It includes Markdown, code, image and empty-file
previews, unsupported/large-file messages, loading, empty, saving, failed-save,
unavailable-storage, failed-upload, trash, and permanent-deletion states.

Use **Controls** to change task/agent/project/user scope or the fixture state.
The toolbar supports light/dark and mobile review. Fixtures reset when you reload
the story or change its controls.

## Fixture boundaries

Prototype uploads, previews, downloads, folder creation, deletion, restoration,
purge, and refresh use fresh in-memory data. They do not contact a tenant, launch
agents, or persist files. The experimental toggle is also simulated in memory. Other page mutations display an unsupported-demo
message. The story restores its fetch handler and clears its query cache on
unmount. The loading example remains pending until you leave the story.

Saving and failed states are fixed visual examples. Refresh shows the real
acknowledgement but does not launch a sandbox. These prototypes do not replace
runtime persistence testing or implement live sandbox inspection.

## Supporting UI

**Work folders / Supporting UI** shows the native Pi ACPX selector and the
request, approved, sign-in-required, and expired CLI authorization pages. The
fictional challenges cannot grant access or create keys.
