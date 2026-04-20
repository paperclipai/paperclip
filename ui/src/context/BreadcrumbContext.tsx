import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

export interface Breadcrumb {
  label: string;
  href?: string;
}

interface BreadcrumbContextValue {
  breadcrumbs: Breadcrumb[];
  setBreadcrumbs: (crumbs: Breadcrumb[]) => void;
  mobileToolbar: ReactNode | null;
  setMobileToolbar: (node: ReactNode | null) => void;
}

const BreadcrumbContext = createContext<BreadcrumbContextValue | null>(null);

function breadcrumbsEqual(left: Breadcrumb[], right: Breadcrumb[]) {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.label !== right[index]?.label || left[index]?.href !== right[index]?.href) {
      return false;
    }
  }
  return true;
}

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [breadcrumbs, setBreadcrumbsState] = useState<Breadcrumb[]>([]);
  const [mobileToolbar, setMobileToolbarState] = useState<ReactNode | null>(null);

  const setBreadcrumbs = useCallback((crumbs: Breadcrumb[]) => {
    setBreadcrumbsState((current) => (breadcrumbsEqual(current, crumbs) ? current : crumbs));
  }, []);

  const setMobileToolbar = useCallback((node: ReactNode | null) => {
    setMobileToolbarState(node);
  }, []);

  useEffect(() => {
    if (breadcrumbs.length === 0) {
      document.title = "Paperclip";
    } else {
      const parts = [...breadcrumbs].reverse().map((b) => b.label);
      document.title = `${parts.join(" · ")} · Paperclip`;
    }
  }, [breadcrumbs]);

  return (
    <BreadcrumbContext.Provider value={{ breadcrumbs, setBreadcrumbs, mobileToolbar, setMobileToolbar }}>
      {children}
    </BreadcrumbContext.Provider>
  );
}

export function useBreadcrumbs() {
  const ctx = useContext(BreadcrumbContext);
  if (!ctx) {
    throw new Error("useBreadcrumbs must be used within BreadcrumbProvider");
  }
  return ctx;
}
