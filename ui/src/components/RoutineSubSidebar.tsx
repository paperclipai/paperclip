import { useRef } from "react";
import {
  Activity as ActivityIcon,
  Circle,
  Clock3,
  History as HistoryIcon,
  KeyRound,
  LayoutGrid,
  Play,
  Send,
  SlidersHorizontal,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Link } from "@/lib/router";
import { t, useTranslation } from "@/i18n";
import { cn } from "@/lib/utils";
import {
  ROUTINE_SECTION_KEYS,
  type RoutineSectionKey,
} from "./routine-sections/context";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type NavItem = {
  key: RoutineSectionKey;
  label: string;
  icon: LucideIcon;
};

type NavGroup = {
  id: string;
  label: string;
  items: NavItem[];
};

function getNavGroups(): NavGroup[] {
  return [
    {
      id: "routine",
      label: t("components.routineSubSidebar.groupRoutine", {
        defaultValue: "Routine",
      }),
      items: [
        {
          key: "overview",
          label: t("components.routineSubSidebar.itemOverview", {
            defaultValue: "Overview",
          }),
          icon: Circle,
        },
        {
          key: "triggers",
          label: t("components.routineSubSidebar.itemTriggers", {
            defaultValue: "Triggers",
          }),
          icon: Clock3,
        },
        {
          key: "variables",
          label: t("components.routineSubSidebar.itemVariables", {
            defaultValue: "Variables",
          }),
          icon: LayoutGrid,
        },
        {
          key: "secrets",
          label: t("components.routineSubSidebar.itemSecrets", {
            defaultValue: "Secrets",
          }),
          icon: KeyRound,
        },
        {
          key: "delivery",
          label: t("components.routineSubSidebar.itemDelivery", {
            defaultValue: "Delivery",
          }),
          icon: Send,
        },
      ],
    },
    {
      id: "operate",
      label: t("components.routineSubSidebar.groupOperate", {
        defaultValue: "Operate",
      }),
      items: [
        {
          key: "runs",
          label: t("components.routineSubSidebar.itemRuns", {
            defaultValue: "Runs",
          }),
          icon: Play,
        },
        {
          key: "activity",
          label: t("components.routineSubSidebar.itemActivity", {
            defaultValue: "Activity",
          }),
          icon: ActivityIcon,
        },
        {
          key: "history",
          label: t("components.routineSubSidebar.itemHistory", {
            defaultValue: "History",
          }),
          icon: HistoryIcon,
        },
      ],
    },
  ];
}

const ALL_ITEMS: NavItem[] = getNavGroups().flatMap((group) => group.items);

export function RoutineSubSidebar({
  activeSection,
  hrefFor,
  isSectionDirty,
  hasLiveRun,
  onNavigate,
}: {
  activeSection: RoutineSectionKey;
  hrefFor: (section: RoutineSectionKey) => string;
  isSectionDirty: (section: RoutineSectionKey) => boolean;
  hasLiveRun: boolean;
  onNavigate: (section: RoutineSectionKey) => void;
}) {
  const { t } = useTranslation();
  const itemRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const navGroups = getNavGroups();

  const focusItem = (index: number) => {
    const clamped = (index + ALL_ITEMS.length) % ALL_ITEMS.length;
    itemRefs.current[clamped]?.focus();
    onNavigate(ALL_ITEMS[clamped].key);
  };

  const handleKeyDown = (event: React.KeyboardEvent, index: number) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusItem(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusItem(index - 1);
        break;
      case "Home":
        event.preventDefault();
        focusItem(0);
        break;
      case "End":
        event.preventDefault();
        focusItem(ALL_ITEMS.length - 1);
        break;
      default:
        break;
    }
  };

  let flatIndex = -1;

  return (
    <nav
      aria-label={t("components.routineSubSidebar.navAriaLabel", {
        defaultValue: "Routine sections",
      })}
      className="sticky top-0 hidden max-h-[100dvh] w-52 shrink-0 flex-col gap-4 self-start overflow-y-auto border-r border-border bg-sidebar/30 px-3 py-4 md:flex"
    >
      {navGroups.map((group) => (
        <div key={group.id} className="flex flex-col gap-0.5">
          <p className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
            {group.label}
          </p>
          {group.items.map((item) => {
            flatIndex += 1;
            const index = flatIndex;
            const isActive = item.key === activeSection;
            const Icon = item.icon;
            const dirty = isSectionDirty(item.key);
            const showLiveDot = item.key === "runs" && hasLiveRun;
            return (
              <Link
                key={item.key}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                to={hrefFor(item.key)}
                replace
                role="tab"
                aria-current={isActive ? "page" : undefined}
                tabIndex={isActive ? 0 : -1}
                onKeyDown={(event) => handleKeyDown(event, index)}
                onClick={() => onNavigate(item.key)}
                className={cn(
                  "flex h-9 items-center gap-2 rounded-md px-3 text-sm transition-colors motion-safe:duration-150",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{item.label}</span>
                {showLiveDot ? (
                  <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-blue-500 motion-safe:animate-pulse" />
                ) : dirty ? (
                  <span
                    aria-label={t("components.routineSubSidebar.unsavedChanges", {
                      defaultValue: "Unsaved changes",
                    })}
                    className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500 ring-2 ring-background"
                  />
                ) : null}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/** Mobile section picker — collapses the sub-sidebar into a grouped `<Select>`. */
export function RoutineSectionPicker({
  activeSection,
  onNavigate,
  isSectionDirty,
}: {
  activeSection: RoutineSectionKey;
  onNavigate: (section: RoutineSectionKey) => void;
  isSectionDirty: (section: RoutineSectionKey) => boolean;
}) {
  const { t } = useTranslation();
  const navGroups = getNavGroups();
  return (
    <div className="sticky top-0 z-10 border-b border-border bg-background px-4 py-2 md:hidden">
      <Select
        value={activeSection}
        onValueChange={(value) => {
          if (ROUTINE_SECTION_KEYS.includes(value as RoutineSectionKey)) {
            onNavigate(value as RoutineSectionKey);
          }
        }}
      >
        <SelectTrigger
          className="h-11 w-full"
          aria-label={t("components.routineSubSidebar.pickerAriaLabel", {
            defaultValue: "Routine section",
          })}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {navGroups.map((group) => (
            <SelectGroup key={group.id}>
              <SelectLabel className="uppercase tracking-[0.12em] text-[11px]">
                {group.label}
              </SelectLabel>
              {group.items.map((item) => (
                <SelectItem key={item.key} value={item.key} className="h-11">
                  <span className="flex items-center gap-2">
                    <item.icon className="h-3.5 w-3.5" />
                    {item.label}
                    {isSectionDirty(item.key) ? (
                      <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                    ) : null}
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export { ALL_ITEMS as ROUTINE_NAV_ITEMS };
