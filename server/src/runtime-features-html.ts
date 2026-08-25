import type { HostFeaturesSnapshotV1 } from "@paperclipai/shared";

export const RUNTIME_FEATURES_HTML_MARKER = "<!-- PAPERCLIP_RUNTIME_FEATURES -->";

/** Escape JSON so it cannot terminate its application/json script element. */
export function serializeRuntimeFeaturesForHtml(snapshot: HostFeaturesSnapshotV1): string {
  return JSON.stringify(snapshot)
    .replace(/&/g, "\\u0026")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function injectRuntimeFeaturesHtml(
  html: string,
  snapshot: HostFeaturesSnapshotV1,
): string {
  const script = `<script id="paperclip-runtime-features" type="application/json">${serializeRuntimeFeaturesForHtml(snapshot)}</script>`;
  if (html.includes(RUNTIME_FEATURES_HTML_MARKER)) {
    return html.replace(RUNTIME_FEATURES_HTML_MARKER, script);
  }
  return html.includes("</head>")
    ? html.replace("</head>", `  ${script}\n</head>`)
    : `${script}\n${html}`;
}
