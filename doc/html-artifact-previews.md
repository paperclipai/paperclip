# HTML artifact previews

HTML attachments and workspace `.html`/`.htm` files open rendered by default.
The eye and code icons beside Download switch between the report and its original
source. Download always returns the original file. Empty and oversized attachments
use the existing text-viewer states and limits.

The shared `HtmlArtifactPreview` uses `srcdoc` in an iframe with
`sandbox="allow-scripts"`. **Never add `allow-same-origin`.** Its opaque origin
prevents artifact JavaScript from reading Paperclip cookies, storage, or the parent
DOM. Forms, popups, downloads from inside the frame, and top navigation are not
granted. The host does not accept messages or privileged requests from artifacts.

A trusted CSP is installed before any artifact markup. It permits inline scripts
and styles for self-contained tables, charts, filtering, and other report controls.
It blocks API connections, remote scripts/styles/images/fonts/media, child frames,
objects, base URLs, and form submissions. Embedded data images/fonts/media work.
An artifact's own CSP cannot weaken the first policy. No artifact HTML is parsed
or inserted into the host DOM. The iframe sends no referrer.

This supports self-contained reports. Reports that need CDN libraries or external
resources must embed them instead. Ordinary external links cannot open new tabs
or navigate the host. The sandbox does allow navigation within the artifact frame;
its opaque-origin restrictions remain after navigation. This is not a claim of
complete network isolation or protection against resource exhaustion by scripts.

Attachment HTTP serving retains forced download, `nosniff`, and its existing
sandbox CSP. Workspace previews return bounded UTF-8 inside JSON, and workspace
downloads retain `Content-Disposition: attachment`. No database or API shape changes
are needed.

Review **HTML artifacts** in Storybook for the production viewer, security probes,
workspace panel/file sheet, and a task-to-report journey. Run the browser security
checks with:

```sh
pnpm exec playwright test --config tests/html-preview/playwright.config.ts
```

These checks use Chromium and simulated report data. They verify working report
controls, raw mode, cookie/storage/parent access denials, blocked resource and API
requests, and denied top navigation/popups. They do not replace testing the actual
attachment journey in a running Paperclip instance.
