import { useState, useRef, useEffect } from "react";
import { Check, ChevronDown, Plus } from "lucide-react";
import { Popover } from "@heroui/react";
import { useCompany } from "../../context/CompanyContext";
import { useDialog } from "../../context/DialogContext";
import { useNavigate } from "@/lib/router";
import type { Company } from "@paperclipai/shared";

function CompanyAvatar({ company }: { company: Company }) {
  const color = company.brandColor ?? "#4ade80";
  const initials = company.name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <span
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold text-white shadow-sm glow-accent"
      style={{ backgroundColor: color }}
    >
      {initials}
    </span>
  );
}

export function CompanySwitcher() {
  const { companies, selectedCompany, setSelectedCompanyId } = useCompany();
  const { openOnboarding } = useDialog();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const visibleCompanies = companies.filter((c) => c.status !== "archived");

  function handleSelect(companyId: string) {
    setSelectedCompanyId(companyId, { source: "manual" });
    setOpen(false);
    navigate("/");
  }

  function handleCreateCompany() {
    setOpen(false);
    openOnboarding();
  }

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Popover.Trigger>
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label="Switch company"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-default/40"
        >
        {selectedCompany ? (
          <CompanyAvatar company={selectedCompany} />
        ) : (
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-default-200" />
        )}

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-foreground">
            {selectedCompany?.name ?? "Select company"}
          </span>
          {selectedCompany?.issuePrefix && (
            <span className="block truncate text-[11px] text-foreground/40">
              {selectedCompany.issuePrefix.toUpperCase()}
            </span>
          )}
        </span>

        <ChevronDown
          className="h-3.5 w-3.5 shrink-0 text-foreground/30 transition-transform duration-150"
          style={{ transform: open ? "rotate(180deg)" : undefined }}
        />
        </button>
      </Popover.Trigger>

      <Popover.Content placement="bottom start" offset={4} className="w-56 p-0">
        <Popover.Dialog className="overflow-hidden rounded-xl border border-default-200/60 bg-overlay shadow-lg">
          <ul role="listbox" aria-label="Companies" className="max-h-72 overflow-y-auto py-1.5">
            {visibleCompanies.length === 0 && (
              <li className="px-3 py-2 text-sm text-foreground/40">No companies</li>
            )}
            {visibleCompanies.map((company) => {
              const isSelected = company.id === selectedCompany?.id;
              return (
                <li key={company.id} role="option" aria-selected={isSelected}>
                  <button
                    type="button"
                    onClick={() => handleSelect(company.id)}
                    className="flex w-full items-center gap-2.5 rounded-lg mx-1.5 px-2 py-1.5 text-left transition-colors hover:bg-accent/[0.05]"
                    style={{ width: "calc(100% - 12px)" }}
                  >
                    <CompanyAvatar company={company} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {company.name}
                      </span>
                      <span className="block truncate text-[11px] text-foreground/40">
                        {company.issuePrefix.toUpperCase()}
                      </span>
                    </span>
                    {isSelected && (
                      <Check className="h-3.5 w-3.5 shrink-0 text-accent" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="border-t border-default-200/40 py-1.5">
            <button
              type="button"
              onClick={handleCreateCompany}
              className="flex w-full items-center gap-2.5 rounded-lg mx-1.5 px-2 py-1.5 text-left text-sm text-foreground/50 transition-colors hover:bg-accent/[0.05] hover:text-foreground"
              style={{ width: "calc(100% - 12px)" }}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-dashed border-default-200">
                <Plus className="h-3.5 w-3.5" />
              </span>
              Create company
            </button>
          </div>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
