import type { Plugin } from "vite";
import { TASK_COLLECTION_PAINTED_EVENT } from "./issue-detail-preload-events";

export function preloadIssueDetail(): Plugin {
  return {
    name: "paperclip-preload-issue-detail",
    apply: "build",
    transformIndexHtml(_html, { bundle }) {
      const issueDetail = Object.values(bundle ?? {}).find((chunk) =>
        chunk.type === "chunk" && chunk.moduleIds.some((id) => id.endsWith("/src/pages/IssueDetail.tsx")),
      );
      if (!issueDetail) return [];
      return [{
        tag: "script",
        injectTo: "head-prepend",
        children: `(() => {
          const isDetail = pathname => {
            const parts = pathname.split("/").filter(Boolean);
            const route = parts.length === 3 ? parts[1] : parts.length === 2 ? parts[0] : null;
            return route === "chats" || (route === "issues" && !["all", "active", "backlog", "done", "recent"].includes(parts[parts.length - 1]));
          };
          let requested = false;
          const preload = (speculative = false) => {
            if (requested) return;
            requested = true;
            if (speculative) {
              void fetch(${JSON.stringify(`/${issueDetail.fileName}`)}, { credentials: "same-origin", cache: "force-cache", priority: "low" }).then(response => response.arrayBuffer()).catch(() => {});
              return;
            }
            const link = document.createElement("link");
            link.rel = "modulepreload";
            link.href = ${JSON.stringify(`/${issueDetail.fileName}`)};
            link.crossOrigin = "";
            document.head.appendChild(link);
          };
          if (isDetail(location.pathname)) preload();
          window.addEventListener(${JSON.stringify(TASK_COLLECTION_PAINTED_EVENT)}, () => preload(true), { once: true });
          const onIntent = event => {
            const link = event.target.closest?.("a[href]");
            if (link?.origin === location.origin && isDetail(link.pathname)) preload(true);
          };
          document.addEventListener("pointerover", onIntent, { passive: true });
          document.addEventListener("pointerdown", onIntent, { passive: true });
          document.addEventListener("focusin", onIntent);
        })();`,
      }];
    },
  };
}
