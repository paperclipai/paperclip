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

interface BreadcrumbProviderProps {
  children: ReactNode;
  companyName?: string | null;
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

export function buildDocumentTitle(breadcrumbs: Breadcrumb[], companyName?: string | null) {
  const pageParts = breadcrumbs.length === 0
    ? []
    : [...breadcrumbs].reverse().map((breadcrumb) => breadcrumb.label);
  const companyPart = companyName?.trim() ? [companyName.trim()] : [];
  const parts = [...pageParts, ...companyPart, "Paperclip"];
  return parts.join(" • ");
}

export function BreadcrumbProvider({ children, companyName }: BreadcrumbProviderProps) {
  const [breadcrumbs, setBreadcrumbsState] = useState<Breadcrumb[]>([]);
  const [mobileToolbar, setMobileToolbarState] = useState<ReactNode | null>(null);

  const setBreadcrumbs = useCallback((crumbs: Breadcrumb[]) => {
    setBreadcrumbsState((current) => (breadcrumbsEqual(current, crumbs) ? current : crumbs));
  }, []);

  const setMobileToolbar = useCallback((node: ReactNode | null) => {
    setMobileToolbarState(node);
  }, []);

  useEffect(() => {
    document.title = buildDocumentTitle(breadcrumbs, companyName);
  }, [breadcrumbs, companyName]);

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
