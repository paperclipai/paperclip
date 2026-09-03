import { useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronsUpDown,
  GripVertical,
  LogOut,
  Plus,
  RefreshCw,
  UserPlus,
} from "lucide-react";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Company } from "@paperclipai/shared";
import { Link, useLocation, useNavigate } from "@/lib/router";
import { authApi } from "@/api/auth";
import { cloudApi, type CloudStackSummary } from "@/api/cloud";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { useCloudInstance } from "@/hooks/useCloudInstance";
import { useCompanyOrder } from "@/hooks/useCompanyOrder";
import { useSignOut } from "@/hooks/useSignOut";
import { navigateTopLevel } from "@/lib/browserNavigation";
import { cloudStackCreateUrl, cloudStackEnterUrl } from "@/lib/cloudLinks";
import { queryKeys } from "@/lib/queryKeys";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "@/lib/utils";
import { useSidebar } from "../context/SidebarContext";
import { CompanyPatternIcon } from "./CompanyPatternIcon";

interface SidebarCompanyMenuProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

const WORKSPACE_ICON_CLASS = "size-5 shrink-0 rounded-md text-(length:--text-micro)";
const WORKSPACE_BADGE_CLASS =
  "shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-(length:--text-nano) text-muted-foreground";

function WorkspaceIcon({ company }: { company: Company }) {
  return (
    <CompanyPatternIcon
      companyName={company.name}
      logoUrl={company.logoUrl}
      className={WORKSPACE_ICON_CLASS}
    />
  );
}

/**
 * Cloud stacks have no hot-linkable icon URL in the portfolio payload, so v1
 * renders the same deterministic monogram treatment cloud's own portfolio page
 * uses — seeded by the display name, never fetched.
 */
function StackIcon({ displayName }: { displayName: string }) {
  return <CompanyPatternIcon companyName={displayName} className={WORKSPACE_ICON_CLASS} />;
}

/**
 * The switcher trigger on a Cloud instance. A Cloud tenant holds exactly one
 * company and the harness pushes the stack's uploaded workspace icon into
 * that company's branding, so the company logo is the stack logo here.
 * The stack rows keep the monogram treatment above.
 */
function CurrentStackIcon({
  displayName,
  company,
}: {
  displayName: string;
  company: Company | null;
}) {
  return (
    <CompanyPatternIcon
      companyName={displayName}
      logoUrl={company?.logoUrl}
      className={WORKSPACE_ICON_CLASS}
    />
  );
}

function CloudStackItem({
  stack,
  isSelected,
  onSelect,
}: {
  stack: CloudStackSummary;
  isSelected: boolean;
  onSelect: (stack: CloudStackSummary) => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={() => onSelect(stack)}
      className={cn("min-w-0 gap-2 py-2", isSelected && "bg-accent text-accent-foreground")}
    >
      <StackIcon displayName={stack.displayName} />
      <span className="min-w-0 flex-1 truncate" title={stack.displayName}>
        {stack.displayName}
      </span>
      {/* Company badges are 3-4 character issue prefixes, but stack slugs are
          user-chosen and can be long enough to truncate the name to a single
          letter — the name is the primary identifier, so the badge yields. */}
      <span className={cn(WORKSPACE_BADGE_CLASS, "max-w-24 truncate")} title={stack.stackSlug}>
        {stack.stackSlug}
      </span>
      {isSelected ? <Check className="size-4 shrink-0 text-muted-foreground" /> : null}
    </DropdownMenuItem>
  );
}

function SortableCompanyItem({
  company,
  isEditing,
  isSelected,
  onSelect,
}: {
  company: Company;
  isEditing: boolean;
  isSelected: boolean;
  onSelect: (company: Company) => void;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: company.id, disabled: !isEditing });

  return (
    <DropdownMenuItem
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 10 : undefined,
      }}
      onSelect={(event) => {
        if (isEditing) {
          event.preventDefault();
          return;
        }
        onSelect(company);
      }}
      className={cn(
        "min-w-0 gap-2 py-2",
        isEditing && "cursor-grab",
        isDragging && "opacity-80",
        isSelected && "bg-accent text-accent-foreground",
      )}
    >
      <WorkspaceIcon company={company} />
      <span className="min-w-0 flex-1 truncate">{company.name}</span>
      {isEditing ? (
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-label={`Reorder ${company.name}`}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-(length:--rad-2) focus-visible:ring-ring"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" aria-hidden="true" />
        </button>
      ) : (
        <>
          <span className={WORKSPACE_BADGE_CLASS}>{company.issuePrefix}</span>
          {isSelected ? <Check className="size-4 text-muted-foreground" /> : null}
        </>
      )}
    </DropdownMenuItem>
  );
}

export function SidebarCompanyMenu({ open: controlledOpen, onOpenChange }: SidebarCompanyMenuProps = {}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [isEditingOrder, setIsEditingOrder] = useState(false);
  const { companies, selectedCompany, setSelectedCompanyId, companyListUnavailable, retryCompanies } =
    useCompany();
  const { openOnboarding } = useDialogActions();
  const { isMobile, setSidebarOpen, collapsed, peeking } = useSidebar();
  const rail = collapsed && !peeking;
  const location = useLocation();
  const navigate = useNavigate();
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 180, tolerance: 6 },
    }),
  );
  const sidebarCompanies = useMemo(
    () => companies.filter((company) => company.status !== "archived"),
    [companies],
  );
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const { orderedCompanies, persistOrder } = useCompanyOrder({
    companies: sidebarCompanies,
    userId: currentUserId,
  });

  // In Paperclip Cloud the switcher lists the signed-in user's stacks
  // (organizations) instead of the instance's companies: a cloud instance holds
  // exactly one company, and switching means leaving this tenant host entirely.
  const cloud = useCloudInstance();
  const isCloud = Boolean(cloud);
  const cloudBaseUrl = cloud?.cloudBaseUrl ?? null;
  const stacksQuery = useQuery({
    queryKey: queryKeys.cloud.stacks,
    queryFn: () => cloudApi.listStacks(),
    enabled: isCloud,
    staleTime: 30_000,
    retry: false,
  });
  const stacks = stacksQuery.data?.stacks ?? [];
  const currentStack = isCloud
    ? stacks.find((stack) => stack.isCurrent)
      ?? stacks.find((stack) => Boolean(cloud?.stackSlug) && stack.stackSlug === cloud?.stackSlug)
      ?? null
    : null;
  const createStackUrl = isCloud ? cloudStackCreateUrl(cloudBaseUrl) : null;
  const switcherNoun = isCloud ? "organization" : "company";
  // The one name the chrome shows for "where am I": the stack in cloud, the
  // company when self-hosted.
  const currentName = isCloud
    ? currentStack?.displayName ?? cloud?.stackDisplayName ?? cloud?.stackSlug ?? null
    : selectedCompany?.name ?? null;

  const signOutMutation = useSignOut({ onSignedOut: closeNavigationChrome });

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) setIsEditingOrder(false);
    setOpen(nextOpen);
  }

  function closeNavigationChrome() {
    setOpen(false);
    setIsEditingOrder(false);
    if (isMobile) setSidebarOpen(false);
  }

  function selectCompany(company: Company) {
    const pathPrefix = location.pathname.split("/")[1]?.toUpperCase();
    const isCompanyRoute = sidebarCompanies.some((sidebarCompany) => (
      sidebarCompany.issuePrefix.toUpperCase() === pathPrefix
    ));
    const shouldLeaveCurrentRoute = company.id !== selectedCompany?.id
      && (location.pathname.startsWith("/instance/") || isCompanyRoute);

    setSelectedCompanyId(company.id);
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
    if (shouldLeaveCurrentRoute) {
      navigate(`/${company.issuePrefix}/dashboard`);
    }
  }

  /**
   * Switching stacks is a full top-level navigation, not client routing: the
   * cloud entry-code handoff authenticates the user for the target stack and
   * wakes it if it is asleep before landing on its own tenant host.
   */
  function selectStack(stack: CloudStackSummary) {
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
    if (stack.stackSlug === currentStack?.stackSlug) return;
    const target = cloudStackEnterUrl(cloudBaseUrl, stack.stackSlug);
    if (!target) return;
    navigateTopLevel(target);
  }

  function addCompany() {
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
    // Cloud creates organizations in the cloud app; the in-app company wizard
    // is unreachable there (POST /companies is a 403 floor on managed stacks).
    if (isCloud) {
      if (createStackUrl) navigateTopLevel(createStackUrl);
      return;
    }
    // Skip the front-door "how would you like to get started?" choice and land
    // directly on "Name your organization" — this entry point is unambiguously
    // "create a new company" (PAP-431).
    openOnboarding({ initialStep: 1 });
  }

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const ids = orderedCompanies.map((company) => company.id);
      const oldIndex = ids.indexOf(active.id as string);
      const newIndex = ids.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return;

      persistOrder(arrayMove(ids, oldIndex, newIndex));
    },
    [orderedCompanies, persistOrder],
  );

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          // The nav icon column sits at nav px-3 + item mx-2 + item px-2.
          // Match that inset with wrapper px-3 + trigger px-4. Override the
          // Button's direct-SVG padding too so the expanded chevron cannot pull
          // the avatar four pixels left of the nav icons.
          // `min-w-0` on every link of the flex chain (button → label row → label)
          // is what lets the name truncate: a flex item's default `min-width:auto`
          // floors it at its content width, so without it a long name widens the
          // trigger past the sidebar and pushes the chevron out of bounds. Company
          // names were short in practice; cloud stack names are user-chosen.
          className="h-9 min-w-0 flex-1 justify-start gap-2 px-4 text-left hover:bg-accent/50 hover:text-foreground has-[>svg]:px-4 dark:hover:bg-accent/50"
          aria-label={
            currentName
              ? `Open ${currentName} ${switcherNoun} switcher`
              : `Open ${switcherNoun} switcher`
          }
        >
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {isCloud
              ? currentName ? <CurrentStackIcon displayName={currentName} company={selectedCompany} /> : null
              : selectedCompany ? <WorkspaceIcon company={selectedCompany} /> : null}
            {/* The header has room for ~110px of name beside the collapse
                control (~142px on mobile, which hides it) — search moved to
                the nav to buy that width. A name that still
                truncates stays hover-recoverable via title. */}
            <span
              className={cn(
                "min-w-0 truncate text-sm font-bold text-foreground",
                rail && SIDEBAR_RAIL_HIDDEN_LABEL,
              )}
              title={currentName ?? undefined}
            >
              {currentName ?? (isCloud ? "Select organization" : "Select company")}
            </span>
          </span>
          {!rail && <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={8} className="w-64 p-1">
        <div className="flex items-center justify-between gap-2 px-2 py-1.5">
          <DropdownMenuLabel className="p-0 text-(length:--text-micro) font-semibold uppercase text-muted-foreground">
            {isCloud ? "Switch organization" : "Switch company"}
          </DropdownMenuLabel>
          {/* Stack order is owned by cloud's own portfolio in v1, so the
              drag-to-reorder affordance stays self-hosted-only. */}
          {isCloud ? null : (
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setIsEditingOrder((current) => !current);
              }}
              className="rounded px-1.5 py-0.5 text-(length:--text-micro) font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {isEditingOrder ? "Done" : "Edit"}
            </button>
          )}
        </div>
        <div className="max-h-96 overflow-y-auto">
          {isCloud ? (
            <>
              {stacks.map((stack) => (
                <CloudStackItem
                  key={stack.stackSlug}
                  stack={stack}
                  isSelected={stack.stackSlug === currentStack?.stackSlug}
                  onSelect={selectStack}
                />
              ))}
              {stacks.length === 0 ? (
                <DropdownMenuItem disabled>
                  {stacksQuery.isLoading
                    ? "Loading organizations..."
                    : stacksQuery.isError
                      ? "Could not load organizations"
                      : "No organizations"}
                </DropdownMenuItem>
              ) : null}
            </>
          ) : (
            <>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={orderedCompanies.map((company) => company.id)}
                  strategy={verticalListSortingStrategy}
                >
                  {orderedCompanies.map((company) => (
                    <SortableCompanyItem
                      key={company.id}
                      company={company}
                      isEditing={isEditingOrder}
                      isSelected={company.id === selectedCompany?.id}
                      onSelect={selectCompany}
                    />
                  ))}
                </SortableContext>
              </DndContext>
              {orderedCompanies.length === 0 ? (
                // "No companies" is a claim about the account. After a failed
                // list request it is one we cannot make, and this menu is the
                // only place the customer can act on it — say what happened and
                // offer the way back.
                companyListUnavailable ? (
                  <>
                    <DropdownMenuItem disabled>Couldn&apos;t load companies</DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={(event) => {
                        // Keep the menu open so the result of the retry is visible.
                        event.preventDefault();
                        void retryCompanies();
                      }}
                    >
                      <RefreshCw className="h-4 w-4 mr-2" />
                      Try again
                    </DropdownMenuItem>
                  </>
                ) : (
                  <DropdownMenuItem disabled>No companies</DropdownMenuItem>
                )
              ) : null}
            </>
          )}
        </div>
        <DropdownMenuSeparator />
        {/* A cloud instance without a configured cloud origin has nowhere to
            send the user, so the row (and its separator) drop out entirely. */}
        {isCloud && !createStackUrl ? null : (
          <>
            <DropdownMenuItem
              onClick={addCompany}
              className="gap-2 py-2 text-muted-foreground"
              disabled={isEditingOrder}
            >
              <Plus className="size-4" />
              <span>Create new organization...</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem asChild disabled={isEditingOrder}>
          <Link
            to="/company/settings/invites"
            onClick={(event) => {
              if (isEditingOrder) {
                event.preventDefault();
                return;
              }
              closeNavigationChrome();
            }}
          >
            <UserPlus className="size-4" />
            <span className="truncate">
              {currentName ? `Invite people to ${currentName}` : "Invite people"}
            </span>
          </Link>
        </DropdownMenuItem>
        {session?.session ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => signOutMutation.mutate()}
              disabled={isEditingOrder || signOutMutation.isPending}
            >
              <LogOut className="size-4" />
              <span>{signOutMutation.isPending ? "Signing out..." : "Sign out"}</span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
