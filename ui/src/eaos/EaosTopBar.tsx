import { useCallback } from "react";
import { Link } from "@/lib/router";
import { Bell, ClipboardList, KeyRound, MessageSquareWarning, Search, ShieldAlert, User } from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { EaosStateChip } from "./EaosStateChip";
import {
  DEFAULT_TOPBAR_POSTURE_LABEL,
  KERNEL_POSTURE_LABEL,
  NOT_CONNECTED_DATA_LABEL,
  NOT_CONNECTED_DATA_PREFIX,
  SCOPE_PREVIEW_LABEL,
  SHELL_POSTURE_PREFIX,
  STUB_COUNT_NOTE,
  STUB_COUNT_PLACEHOLDER,
} from "./state-labels";
import { EAOS_KERNEL_NAV } from "./nav-zones";
import { redactSecretLikeText } from "./secret-redact";

// Top-bar slot config per LET-164 §3 (right-of-search indicator cluster).
// Counts stay marked as Stub here so the shell chrome remains test-friendly
// (no QueryClient coupling). The Command Center landing carries the real
// backend-backed mission/approval telemetry where it belongs.
const INDICATORS = [
  {
    id: "approvals",
    label: "Approvals waiting on me",
    path: "/eaos/approvals?scope=mine",
    icon: ClipboardList,
  },
  {
    id: "risk",
    label: "High/critical risk items",
    path: "/eaos/approvals?tab=risk",
    icon: ShieldAlert,
  },
  {
    id: "loop",
    label: "Autonomous loop state",
    path: "/eaos/loops",
    icon: MessageSquareWarning,
  },
  {
    id: "notifications",
    label: "Notifications",
    path: "/eaos/inbox",
    icon: Bell,
  },
] as const;

export interface EaosTopBarProps {
  // When the shell is mounted under `/k/*` we re-skin the env chip and label
  // the surface as the kernel/admin escape hatch.
  variant: "eaos" | "kernel";
  onOpenPrimaryNav: () => void;
}

export function EaosTopBar({ variant, onOpenPrimaryNav }: EaosTopBarProps) {
  const isKernel = variant === "kernel";
  const { selectedCompany } = useCompany();

  // Open the existing command palette by dispatching the shortcut its global
  // listener already handles. Keeps this slice from coupling to the dialog
  // state machine inside CommandPalette.tsx.
  const openCommandPalette = useCallback(() => {
    if (typeof window === "undefined") return;
    const event = new KeyboardEvent("keydown", {
      key: "k",
      ctrlKey: true,
      metaKey: true,
      bubbles: true,
    });
    document.dispatchEvent(event);
  }, []);

  return (
    <header
      role="banner"
      aria-label={isKernel ? "Kernel/Admin top bar" : "Enterprise Agent OS top bar"}
      className="flex h-12 w-full items-center gap-3 border-b border-border bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80"
    >
      <button
        type="button"
        onClick={onOpenPrimaryNav}
        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background md:hidden"
        aria-label="Open primary navigation"
        data-testid="eaos-topbar-nav-toggle"
      >
        <span aria-hidden="true" className="block h-0.5 w-4 bg-current shadow-[0_-4px_0_currentColor,0_4px_0_currentColor]" />
      </button>

      <Link
        to={isKernel ? "/dashboard" : "/eaos"}
        className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm font-semibold tracking-tight text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <span aria-hidden="true" className="inline-flex h-6 w-6 items-center justify-center rounded bg-primary text-[11px] font-bold text-primary-foreground">
          EA
        </span>
        <span className="hidden sm:inline">{isKernel ? "Enterprise Agent OS · Kernel" : "Enterprise Agent OS"}</span>
      </Link>

      {!isKernel ? (
        <div
          className="hidden items-center gap-2 lg:flex"
          data-testid="eaos-topbar-scope"
          data-eaos-scope-connected={selectedCompany ? "true" : "false"}
        >
          <span className="text-xs text-muted-foreground">Scope</span>
          {selectedCompany ? (() => {
            // LET-484 QA gate: company name / issuePrefix originate from
            // user-authored company records, so route every surface that
            // could leak a credential-shaped string (visible label, title,
            // aria-label, and the prefix chip) through `redactSecretLikeText`.
            const safeName = redactSecretLikeText(selectedCompany.name);
            const safePrefix = selectedCompany.issuePrefix
              ? redactSecretLikeText(selectedCompany.issuePrefix)
              : "—";
            return (
              <span
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-0.5 text-xs font-medium text-foreground"
                title={`Active company scope · ${safeName}`}
                aria-label={`Active scope ${safeName}`}
                data-testid="eaos-topbar-scope-active"
              >
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                <span className="font-mono uppercase tracking-wide text-[10px] text-muted-foreground">
                  {safePrefix}
                </span>
                <span className="max-w-[10rem] truncate">{safeName}</span>
              </span>
            );
          })() : (
            <span
              className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border bg-card px-2 py-0.5 text-xs font-medium text-muted-foreground"
              title={`${SCOPE_PREVIEW_LABEL}. Company/project read model is not wired yet.`}
              aria-label={SCOPE_PREVIEW_LABEL}
            >
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
              {SCOPE_PREVIEW_LABEL}
            </span>
          )}
        </div>
      ) : null}

      <div className="ml-auto flex items-center gap-2">
        <div
          className="hidden items-center gap-2 md:flex"
          data-testid="eaos-topbar-posture"
          data-eaos-data-connected="false"
        >
          {isKernel ? (
            <EaosStateChip label="BACKEND-BACKED" prefix="Kernel/Admin" title={KERNEL_POSTURE_LABEL} />
          ) : (
            <>
              <EaosStateChip label={DEFAULT_TOPBAR_POSTURE_LABEL} prefix={SHELL_POSTURE_PREFIX} />
              <EaosStateChip label={NOT_CONNECTED_DATA_LABEL} prefix={NOT_CONNECTED_DATA_PREFIX} />
            </>
          )}
        </div>

        <button
          type="button"
          onClick={openCommandPalette}
          className="hidden h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-xs text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:flex"
          aria-label="Open command palette (Ctrl/Cmd + K)"
          data-testid="eaos-topbar-command-palette-trigger"
        >
          <Search aria-hidden="true" className="h-3.5 w-3.5" />
          <span>Search</span>
          <kbd aria-hidden="true" className="ml-1 rounded border border-border px-1 text-[10px]">⌘K</kbd>
        </button>

        <ul className="flex items-center gap-1" data-testid="eaos-topbar-indicators">
          {INDICATORS.map(({ id, label, path, icon: Icon }) => (
            <li key={id}>
              <Link
                to={path}
                aria-label={`${label} (${STUB_COUNT_NOTE})`}
                title={`${label} — ${STUB_COUNT_NOTE}`}
                className="relative inline-flex h-9 w-9 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                data-testid={`eaos-topbar-indicator-${id}`}
                data-eaos-indicator-stub="true"
              >
                <Icon aria-hidden="true" className="h-4 w-4" />
                <span
                  aria-hidden="true"
                  className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-dashed border-border bg-card px-1 text-[10px] font-medium text-muted-foreground"
                >
                  {STUB_COUNT_PLACEHOLDER}
                </span>
              </Link>
            </li>
          ))}
        </ul>

        <button
          type="button"
          aria-label="Role and user menu"
          title="Role / user (stub)"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          data-testid="eaos-topbar-user-menu"
        >
          <User aria-hidden="true" className="h-4 w-4" />
        </button>

        <Link
          to={isKernel ? "/eaos" : EAOS_KERNEL_NAV.path}
          aria-label={isKernel ? "Return to Enterprise Agent OS shell" : "Open kernel/admin escape hatch"}
          title={isKernel ? "Return to Enterprise Agent OS" : "Kernel / Admin (legacy Paperclip)"}
          className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          data-testid="eaos-topbar-kernel-hatch"
        >
          <KeyRound aria-hidden="true" className="h-3.5 w-3.5" />
          <span aria-hidden="true">⎈</span>
          <span className="hidden sm:inline">{isKernel ? "EAOS" : "Kernel"}</span>
        </Link>
      </div>
    </header>
  );
}
