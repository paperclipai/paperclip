import { Check, ChevronsUpDown, Plus, Settings } from "lucide-react";
import { useNavigate } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { Dropdown, Badge } from "@heroui/react";
import { pickTextColorForSolidBg } from "@/lib/color-contrast";

const AVATAR_COLORS = [
  "#6366f1", // indigo
  "#8b5cf6", // violet
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ef4444", // red
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#14b8a6", // teal
];

function companyAvatarColor(companyId: string, brandColor: string | null | undefined): string {
  if (brandColor) return brandColor;
  let hash = 0;
  for (let i = 0; i < companyId.length; i++) {
    hash = companyId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function statusLabel(status?: string): string {
  switch (status) {
    case "active": return "Active";
    case "paused": return "Paused";
    case "archived": return "Archived";
    default: return "Active";
  }
}

export function CompanySwitcher() {
  const { companies, selectedCompany, setSelectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const sidebarCompanies = companies.filter((company) => company.status !== "archived");

  const selectedColor = selectedCompany
    ? companyAvatarColor(selectedCompany.id, selectedCompany.brandColor)
    : "#6366f1";

  return (
    <Dropdown>
      <Dropdown.Trigger>
        <button className="w-full flex items-center justify-between px-2 py-1.5 h-auto text-left rounded-md hover:bg-default/40 transition-colors">
          <div className="flex items-center gap-2.5 min-w-0">
            {selectedCompany && (
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[10px] font-bold leading-none"
                style={{
                  backgroundColor: selectedColor,
                  color: pickTextColorForSolidBg(selectedColor),
                }}
              >
                {selectedCompany.name.charAt(0).toUpperCase()}
              </span>
            )}
            <div className="min-w-0">
              <span className="text-sm font-medium truncate block">
                {selectedCompany?.name ?? "Select company"}
              </span>
              {selectedCompany && (
                <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                  {selectedCompany.name.slice(0, 3).toUpperCase()}
                </span>
              )}
            </div>
          </div>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Popover>
        <Dropdown.Menu>
          <Dropdown.Section aria-label="Companies">
            {sidebarCompanies.map((company) => {
              const color = companyAvatarColor(company.id, company.brandColor);
              const isSelected = company.id === selectedCompany?.id;
              return (
                <Dropdown.Item
                  key={company.id}
                  onPress={() => setSelectedCompanyId(company.id)}
                  className={isSelected ? "bg-accent/10" : ""}
                >
                  <div className="flex items-center gap-2.5 w-full">
                    <span
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[10px] font-bold leading-none"
                      style={{
                        backgroundColor: color,
                        color: pickTextColorForSolidBg(color),
                      }}
                    >
                      {company.name.charAt(0).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="truncate block text-sm">{company.name}</span>
                      <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                        {company.name.slice(0, 3).toUpperCase()} &middot; {statusLabel(company.status)}
                      </span>
                    </div>
                    {isSelected && <Check className="h-4 w-4 shrink-0 text-accent" />}
                  </div>
                </Dropdown.Item>
              );
            })}
            {sidebarCompanies.length === 0 && (
              <Dropdown.Item isDisabled>No companies</Dropdown.Item>
            )}
          </Dropdown.Section>
          <Dropdown.Section className="border-t border-default-200/40" aria-label="Actions">
            <Dropdown.Item onPress={() => navigate("/company/settings")}>
              <Settings className="h-4 w-4 mr-2" />
              Company Settings
            </Dropdown.Item>
            <Dropdown.Item onPress={() => navigate("/companies")}>
              <Plus className="h-4 w-4 mr-2" />
              Manage Companies
            </Dropdown.Item>
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
