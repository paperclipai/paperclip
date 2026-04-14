import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { translateText } from "../../../packages/shared/src/i18n.js";
import { getCurrentLocale } from "@/lib/locale-store";

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

const defaultBreadcrumbContextValue: BreadcrumbContextValue = {
  breadcrumbs: [],
  setBreadcrumbs: () => {},
  mobileToolbar: null,
  setMobileToolbar: () => {},
};

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [breadcrumbs, setBreadcrumbsState] = useState<Breadcrumb[]>([]);
  const [mobileToolbar, setMobileToolbarState] = useState<ReactNode | null>(null);

  const setBreadcrumbs = useCallback((crumbs: Breadcrumb[]) => {
    setBreadcrumbsState(crumbs);
  }, []);

  const setMobileToolbar = useCallback((node: ReactNode | null) => {
    setMobileToolbarState(node);
  }, []);

  useEffect(() => {
    if (breadcrumbs.length === 0) {
      document.title = "Paperclip";
    } else {
      const parts = [...breadcrumbs].reverse().map((b) => translateText(getCurrentLocale(), b.label));
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
    if (import.meta.env.MODE === "test") {
      return defaultBreadcrumbContextValue;
    }
    throw new Error("useBreadcrumbs must be used within BreadcrumbProvider");
  }
  return ctx;
}
