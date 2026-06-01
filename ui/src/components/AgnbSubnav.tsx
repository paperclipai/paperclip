import { NavLink } from "@/lib/router";
import { cn } from "../lib/utils";

/** Sub-navigation groups for the AGNB sections (mirrors AGNB's SUBNAV config). */
export const AGNB_SUBNAV = {
  pipeline: [
    { to: "/pipeline", label: "HubSpot" },
    { to: "/forecast", label: "Forecast" },
    { to: "/demos", label: "Demos" },
    { to: "/channels", label: "Channels" },
    { to: "/attribution", label: "Attribution" },
    { to: "/funnel", label: "Site funnel" },
    { to: "/crm-hygiene", label: "CRM hygiene" },
    { to: "/win-loss", label: "Win/loss" },
  ],
  assets: [
    { to: "/assets", label: "Sales enablement" },
    { to: "/invoices", label: "Invoices" },
  ],
  campaigns: [
    { to: "/campaigns", label: "Campaigns" },
    { to: "/targeting", label: "Saved targetings" },
    { to: "/personas", label: "Personas" },
    { to: "/products", label: "Products" },
    { to: "/justdial", label: "JustDial" },
    { to: "/linkedin", label: "LinkedIn scraper" },
    { to: "/buckets", label: "Buckets" },
    { to: "/icps", label: "ICPs" },
  ],
} as const;

export type AgnbSubnavGroup = keyof typeof AGNB_SUBNAV;

/** Horizontal tab bar for an AGNB section. Links are company-prefixed by the router. */
export function AgnbSubnav({ group }: { group: AgnbSubnavGroup }) {
  return (
    <div className="flex flex-wrap gap-1 border-b border-border pb-2">
      {AGNB_SUBNAV[group].map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end
          className={({ isActive }) =>
            cn(
              "rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors",
              isActive
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )
          }
        >
          {item.label}
        </NavLink>
      ))}
    </div>
  );
}
