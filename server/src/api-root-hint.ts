function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function buildApiRootHintHtml(opts: {
  deploymentMode: string;
  bindHost: string;
  uiBaseUrl?: string;
}): string {
  const uiSection = opts.uiBaseUrl
    ? `<p>The web UI is at <a href="${escapeHtml(opts.uiBaseUrl)}">${escapeHtml(opts.uiBaseUrl)}</a></p>`
    : `<p>The web UI is served separately (not on this port).</p>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Paperclip API</title>
<style>body{font-family:system-ui,sans-serif;max-width:600px;margin:80px auto;padding:0 1rem;color:#1a1a1a}h1{color:#0066cc}code{background:#f1f1f1;padding:2px 5px;border-radius:3px;font-size:.9em}a{color:#0066cc}dt{font-weight:600;margin-top:.5rem}dd{margin:0 0 .25rem 1rem}</style>
</head>
<body>
<h1>Paperclip API Server</h1>
<p>This is the <strong>Paperclip API server</strong>, not the web UI.</p>
${uiSection}
<p>API health: <a href="/api/health">/api/health</a></p>
<dl>
<dt>Mode</dt><dd><code>${escapeHtml(opts.deploymentMode)}</code></dd>
<dt>Bind</dt><dd><code>${escapeHtml(opts.bindHost)}</code></dd>
</dl>
</body>
</html>`;
}
