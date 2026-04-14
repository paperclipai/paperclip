import * as React from "react";
import * as RouterDom from "react-router-dom";
import type { NavigateOptions, To } from "react-router-dom";
import type { Issue } from "@paperclipai/shared";
import { useCompany } from "@/context/CompanyContext";
import { IssueLinkQuicklook } from "@/components/IssueLinkQuicklook";
import {
  applyCompanyPrefix,
  extractCompanyPrefixFromPath,
  normalizeCompanyPrefix,
} from "@/lib/company-routes";

function parseIssuePathIdFromPath(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  const match = pathname.match(/(?:^|\/)issues\/([^/?#]+)/);
  return match?.[1] ?? null;
}

function resolveTo(to: To, companyPrefix: string | null): To {
  if (typeof to === "string") {
    return applyCompanyPrefix(to, companyPrefix);
  }

  if (to.pathname && to.pathname.startsWith("/")) {
    const pathname = applyCompanyPrefix(to.pathname, companyPrefix);
    if (pathname !== to.pathname) {
      return { ...to, pathname };
    }
  }

  return to;
}

function useActiveCompanyPrefix(): string | null {
  const { selectedCompany } = useCompany();
  const params = RouterDom.useParams<{ companyPrefix?: string }>();
  const location = RouterDom.useLocation();

  if (params.companyPrefix) {
    return normalizeCompanyPrefix(params.companyPrefix);
  }

  const pathPrefix = extractCompanyPrefixFromPath(location.pathname);
  if (pathPrefix) return pathPrefix;

  return selectedCompany ? normalizeCompanyPrefix(selectedCompany.issuePrefix) : null;
}

export * from "react-router-dom";

type CompanyLinkProps = React.ComponentProps<typeof RouterDom.Link> & {
  disableIssueQuicklook?: boolean;
  issuePrefetch?: Issue | null;
};

export const Link = React.forwardRef<HTMLAnchorElement, CompanyLinkProps>(
  function CompanyLink({ to, disableIssueQuicklook = false, issuePrefetch = null, ...props }, ref) {
    const companyPrefix = useActiveCompanyPrefix();
    const resolvedTo = resolveTo(to, companyPrefix);
    const issuePathId = parseIssuePathIdFromPath(typeof resolvedTo === "string" ? resolvedTo : resolvedTo.pathname);

    if (issuePathId) {
      return (
        <IssueLinkQuicklook
          ref={ref}
          to={resolvedTo}
          issuePathId={issuePathId}
          disableIssueQuicklook={disableIssueQuicklook}
          issuePrefetch={issuePrefetch}
          {...props}
        />
      );
    }

    return <RouterDom.Link ref={ref} to={resolvedTo} {...props} />;
  },
);

export const NavLink = React.forwardRef<HTMLAnchorElement, React.ComponentProps<typeof RouterDom.NavLink>>(
  function CompanyNavLink({ to, ...props }, ref) {
    const companyPrefix = useActiveCompanyPrefix();
    return <RouterDom.NavLink ref={ref} to={resolveTo(to, companyPrefix)} {...props} />;
  },
);

export function Navigate({ to, ...props }: React.ComponentProps<typeof RouterDom.Navigate>) {
  const companyPrefix = useActiveCompanyPrefix();
  return <RouterDom.Navigate to={resolveTo(to, companyPrefix)} {...props} />;
}

export function useNavigate(): ReturnType<typeof RouterDom.useNavigate> {
  const navigate = RouterDom.useNavigate();
  const companyPrefix = useActiveCompanyPrefix();

  return React.useCallback(
    ((to: To | number, options?: NavigateOptions) => {
      if (typeof to === "number") {
        navigate(to);
        return;
      }
      navigate(resolveTo(to, companyPrefix), options);
    }) as ReturnType<typeof RouterDom.useNavigate>,
    [navigate, companyPrefix],
  );
}
