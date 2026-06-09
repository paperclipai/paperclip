import { NavLink, useLocation } from "@/lib/router";
import { cn } from "../lib/utils";


/** Sub-navigation groups for the AGNB sections (mirrors AGNB's SUBNAV config). */
export const AGNB_SUBNAV = {
  assets: [
    { to: "/assets", label: "Templates" },
    { to: "/pitch", label: "Pitch decks" },
  ],
  pipeline: [
    { to: "/pipeline", label: "HubSpot" },
    { to: "/forecast", label: "Forecast" },
    { to: "/demos", label: "Demos" },
    { to: "/channels", label: "Channels" },
    { to: "/attribution", label: "Attribution" },
    { to: "/funnel", label: "Site funnel" },
    { to: "/crm-hygiene", label: "CRM hygiene" },
    { to: "/win-loss", label: "Win/loss" },
    { to: "/invoices", label: "Invoices" },
  ],
  content: [
    { to: "/idea-inbox", label: "Ideas" },
    { to: "/content", label: "Briefs" },
    { to: "/blog-automation", label: "Blog archive" },
    { to: "/linkedin-hooks", label: "Hooks" },
    { to: "/bofu", label: "BoFu" },
  ],
  campaigns: [
    { to: "/campaigns", label: "Campaigns" },
    { to: "/targeting", label: "Saved targetings" },
    { to: "/personas", label: "Personas" },
    { to: "/products", label: "Products" },
    { to: "/justdial", label: "JustDial" },
    { to: "/linkedin", label: "LinkedIn scraper" },
    { to: "/csv", label: "CSV leads" },
    { to: "/rocket", label: "Rocket ↗" },
    { to: "/icps", label: "ICPs" },
  ],
  experiments: [
    { to: "/experiments", label: "Auto-experiments" },
    { to: "/buckets", label: "Buckets" },
    { to: "/bucket-compare", label: "Compare" },
    { to: "/cohorts", label: "Cohorts" },
    { to: "/subjects", label: "Subjects" },
  ],
  research: [
    { to: "/competitors", label: "Competition" },
    { to: "/rss-feeds", label: "RSS" },
  ],
  mentions: [
    { to: "/mentions", label: "Mentions" },
    { to: "/reviews", label: "Reviews radar" },
    { to: "/sov", label: "Share of voice" },
    { to: "/backlinks", label: "Backlinks" },
    { to: "/backlink-prospects", label: "Prospects" },
  ],
  renewals: [
    { to: "/renewals", label: "Calendar" },
    { to: "/changelog-queue", label: "Changelog" },
    { to: "/newsletter", label: "Newsletter" },
    { to: "/press-releases", label: "Press releases" },
  ],
  ops: [
    { to: "/agnb-health", label: "Health" },
    { to: "/north-star", label: "North star" },
    { to: "/producers", label: "Producers" },
    { to: "/jobs", label: "Jobs" },
    { to: "/agnb-sync", label: "Sync" },
    { to: "/quota", label: "Quota" },
  ],
  team: [
    { to: "/my-queue", label: "My queue" },
    { to: "/backlog", label: "Backlog" },
    { to: "/routing-rules", label: "Routing rules" },
  ],
  inbox: [
    { to: "/rocket-inbox", label: "Threads" },
    { to: "/rocket-approval", label: "Approval queue" },
    { to: "/reply-drafts", label: "Reply drafts" },
    { to: "/reply-mining", label: "Reply mining" },
  ],
  youtube: [
    { to: "/youtube", label: "Ideas" },
    { to: "/youtube-scripts", label: "Scripts" },
    { to: "/youtube-titles", label: "Title tester" },
    { to: "/youtube-thumbnails", label: "Thumbnails" },
    { to: "/youtube-shorts", label: "Shorts mill" },
    { to: "/youtube-performance", label: "Performance" },
  ],
} as const;

export type AgnbSubnavGroup = keyof typeof AGNB_SUBNAV;

/** Horizontal tab bar for an AGNB section. Links are company-prefixed by the router. */
export function AgnbSubnav({ group }: { group: AgnbSubnavGroup }) {
  const location = useLocation();
  // company-relative path (strip the leading /<companyPrefix> segment) for active matching
  const rel = "/" + location.pathname.split("/").filter(Boolean).slice(1).join("/");

  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1 border-b border-border">
      {AGNB_SUBNAV[group].map((item) => {
        const active = rel === item.to;
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end
            className={cn(
              "relative inline-flex h-9 items-center px-2.5 text-sm font-medium transition-colors",
              active
                ? "text-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-foreground"
                : "text-foreground/60 hover:text-foreground",
            )}
          >
            {item.label}
          </NavLink>
        );
      })}
    </div>
  );
}
