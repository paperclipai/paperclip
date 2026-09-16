import { createRoot, type Root } from "react-dom/client";

export interface PaperclipReactRootHost {
  __paperclipReactRoot?: Root;
}

type CreateRoot = (container: Parameters<typeof createRoot>[0]) => Root;

/**
 * Keep one React root per browser window even if Vite evaluates the entry
 * module more than once during a development reload.
 */
export function getOrCreatePaperclipReactRoot(
  host: object,
  container: Parameters<typeof createRoot>[0],
  create: CreateRoot = createRoot,
): Root {
  const rootHost = host as PaperclipReactRootHost;
  if (rootHost.__paperclipReactRoot) return rootHost.__paperclipReactRoot;

  const root = create(container);
  rootHost.__paperclipReactRoot = root;
  return root;
}
