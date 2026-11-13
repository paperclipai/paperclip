import { useMemo } from "react";
import { htmlPreviewDocument } from "@/lib/html-preview";

export function HtmlArtifactPreview({ html, title }: { html: string; title: string }) {
  const srcDoc = useMemo(() => htmlPreviewDocument(html), [html]);
  return (
    <iframe
      title={`${title} rendered HTML`}
      srcDoc={srcDoc}
      // Never add allow-same-origin: the opaque origin is the cookie/storage
      // and parent-DOM security boundary, including after frame navigation.
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'"
      className="block h-full min-h-0 w-full flex-1 border-0 bg-background"
    />
  );
}
