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
      const chunks = new Map(Object.values(bundle ?? {}).filter(chunk => chunk.type === "chunk").map(chunk => [chunk.fileName, chunk]));
      const dependencies = new Set<string>();
      const visit = (fileName: string) => {
        if (!chunks.has(fileName) || dependencies.has(fileName)) return;
        dependencies.add(fileName);
        for (const imported of chunks.get(fileName)?.imports ?? []) visit(imported);
      };
      visit(issueDetail.fileName);
      return [{
        tag: "script",
        injectTo: "head-prepend",
        children: `(() => {
          const isDetail = pathname => {
            const parts = pathname.split("/").filter(Boolean);
            const route = parts.length === 3 ? parts[1] : parts.length === 2 ? parts[0] : null;
            return route === "chats" || (route === "issues" && !["all", "active", "backlog", "done", "recent"].includes(parts[parts.length - 1]));
          };
          const append = href => {
            const link = document.createElement("link");
            link.rel = "modulepreload";
            link.href = href;
            link.crossOrigin = "";
            document.head.appendChild(link);
          };
          let requested = false;
          const preload = (speculative = false) => {
            if (requested) return;
            requested = true;
            if (speculative) {
              void fetch(${JSON.stringify(`/${issueDetail.fileName}`)}, { credentials: "same-origin", cache: "force-cache", priority: "low" }).then(async response => {
                await response.arrayBuffer();
                if (response.ok && response.headers.get("cache-control")?.split(",").some(value => value.trim().toLowerCase() === "immutable")) append(${JSON.stringify(`/${issueDetail.fileName}`)});
              }).catch(() => {});
              return;
            }
            for (const href of ${JSON.stringify([...dependencies].map(fileName => `/${fileName}`))}) append(href);
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
