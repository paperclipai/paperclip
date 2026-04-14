import { useEffect } from "react";

/**
 * Sets the document title to "[page] - IronWorks".
 * Pass the page-specific segment (e.g. "Dashboard", "Missions").
 */
export function usePageTitle(page: string) {
  useEffect(() => {
    document.title = page ? `${page} - IronWorks` : "IronWorks";
  }, [page]);
}
