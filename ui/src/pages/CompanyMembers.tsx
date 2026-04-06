import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { membersApi, type CompanyMember } from "../api/members";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import {
  Users,
  UserPlus,
  Shield,
  UserX,
  XCircle,
  AlertTriangle,
  ChevronDown,
  Calendar,
  Mail,
  Eye,
  Pencil,
  ShieldCheck,
  Crown,
  Check,
  X as XIcon,
  LayoutDashboard,
  CircleDot,
  Target,
  PackageCheck,
  Network,
  Boxes,
  DollarSign,
  History,
  Lock,
  Settings,
  Bot,
  MessageSquare,
  Inbox,
  Repeat,
  FileBox,
  Rocket,
  Container,
  Cloud,
} from "lucide-react";
import { cn } from "../lib/utils";

const ROLES = ["owner", "admin", "operator", "viewer"] as const;
type CompanyRole = (typeof ROLES)[number];

const ROLE_LABELS: Record<CompanyRole, string> = {
  owner: "Owner",
  admin: "Admin",
  operator: "Operator",
  viewer: "Viewer",
};

const ROLE_DESCRIPTIONS: Record<CompanyRole, string> = {
  owner: "Full access. Can manage all members, settings, and billing.",
  admin: "Can manage members, agents, and company settings.",
  operator: "Can manage agents, issues, and run operations.",
  viewer: "Read-only access to company data.",
};

const ROLE_COLORS: Record<CompanyRole, string> = {
  owner: "var(--status-warning)",
  admin: "var(--status-info)",
  operator: "var(--status-active)",
  viewer: "var(--muted-foreground)",
};

const ROLE_ICONS: Record<CompanyRole, typeof Crown> = {
  owner: Crown,
  admin: ShieldCheck,
  operator: Pencil,
  viewer: Eye,
};

// ── Page access matrix per role ───────────────────────────────────────

interface PageDef {
  name: string;
  icon: typeof LayoutDashboard;
  owner: "full" | "read" | "none";
  admin: "full" | "read" | "none";
  operator: "full" | "read" | "none";
  viewer: "full" | "read" | "none";
}

const PAGE_ACCESS: PageDef[] = [
  { name: "Dashboard", icon: LayoutDashboard, owner: "full", admin: "full", operator: "full", viewer: "read" },
  { name: "Inbox", icon: Inbox, owner: "full", admin: "full", operator: "full", viewer: "read" },
  { name: "CEO Chat", icon: MessageSquare, owner: "full", admin: "full", operator: "read", viewer: "none" },
  { name: "Issues", icon: CircleDot, owner: "full", admin: "full", operator: "full", viewer: "read" },
  { name: "Routines", icon: Repeat, owner: "full", admin: "full", operator: "full", viewer: "read" },
  { name: "Goals", icon: Target, owner: "full", admin: "full", operator: "read", viewer: "read" },
  { name: "Deliverables", icon: PackageCheck, owner: "full", admin: "full", operator: "full", viewer: "read" },
  { name: "Approvals", icon: ShieldCheck, owner: "full", admin: "full", operator: "full", viewer: "read" },
  { name: "Artifacts", icon: FileBox, owner: "full", admin: "full", operator: "full", viewer: "read" },
  { name: "Deployments", icon: Rocket, owner: "full", admin: "full", operator: "full", viewer: "read" },
  { name: "Cloud Deploy", icon: Cloud, owner: "full", admin: "full", operator: "full", viewer: "none" },
  { name: "Sandboxes", icon: Container, owner: "full", admin: "full", operator: "full", viewer: "none" },
  { name: "Agents", icon: Bot, owner: "full", admin: "full", operator: "full", viewer: "read" },
  { name: "Org Chart", icon: Network, owner: "full", admin: "full", operator: "read", viewer: "read" },
  { name: "Skills", icon: Boxes, owner: "full", admin: "full", operator: "read", viewer: "read" },
  { name: "Costs", icon: DollarSign, owner: "full", admin: "full", operator: "read", viewer: "none" },
  { name: "Communication", icon: Mail, owner: "full", admin: "full", operator: "read", viewer: "none" },
  { name: "Vault", icon: Lock, owner: "full", admin: "full", operator: "none", viewer: "none" },
  { name: "Activity", icon: History, owner: "full", admin: "full", operator: "read", viewer: "read" },
  { name: "Members", icon: Users, owner: "full", admin: "full", operator: "read", viewer: "read" },
  { name: "Settings", icon: Settings, owner: "full", admin: "full", operator: "none", viewer: "none" },
];

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "-";
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "-";
  }
}

function formatDateTime(dateStr: string | null): string {
  if (!dateStr) return "-";
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "-";
  }
}

function RoleBadge({ role }: { role: string }) {
  const color = ROLE_COLORS[role as CompanyRole] ?? "var(--muted-foreground)";
  const Icon = ROLE_ICONS[role as CompanyRole] ?? Eye;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-[2px] px-2 py-0.5 font-[var(--font-mono)] text-[9px] uppercase"
      style={{ backgroundColor: `${color}15`, color }}
    >
      <Icon className="h-2.5 w-2.5" />
      {ROLE_LABELS[role as CompanyRole] ?? role}
    </span>
  );
}

function AccessDot({ level }: { level: "full" | "read" | "none" }) {
  if (level === "full") return <Check className="h-3.5 w-3.5 text-[var(--status-active)]" />;
  if (level === "read") return <Eye className="h-3 w-3 text-[var(--status-info)]/60" />;
  return <XIcon className="h-3 w-3 text-muted-foreground/30" />;
}

/* ── Confirmation Dialog ─────────────────────────────────────────── */

function DismissConfirmDialog({
  memberName,
  actionLabel,
  onConfirm,
  onCancel,
  isPending,
}: {
  memberName: string;
  actionLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-sm rounded-[4px] border border-[var(--status-error)]/30 bg-card shadow-[0_20px_60px_rgba(0,0,0,0.4)] animate-in zoom-in-95 slide-in-from-bottom-2 duration-200">
        <div className="h-[2px] bg-gradient-to-r from-transparent via-[var(--status-error)]/50 to-transparent" />
        <div className="px-5 py-4 space-y-4">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--status-error)]/10">
              <AlertTriangle className="h-4.5 w-4.5 text-[var(--status-error)]" />
            </div>
            <div>
              <h3 className="text-sm font-[var(--font-display)] uppercase tracking-[0.06em]">
                {actionLabel}
              </h3>
              <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                Are you sure you want to {actionLabel.toLowerCase()}{" "}
                <strong className="text-foreground">{memberName}</strong>?
                This action cannot be undone.
              </p>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={onCancel} disabled={isPending} className="text-xs">
              Cancel
            </Button>
            <Button size="sm" variant="destructive" onClick={onConfirm} disabled={isPending} className="text-xs gap-1.5">
              <UserX className="h-3.5 w-3.5" />
              {isPending ? "Processing..." : actionLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Member Card (expandable) ────────────────────────────────────── */

function MemberCard({
  member,
  companyId,
  currentUserId,
}: {
  member: CompanyMember;
  companyId: string;
  currentUserId: string | undefined;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [roleValue, setRoleValue] = useState(member.role);
  const [showDismissDialog, setShowDismissDialog] = useState(false);

  const isCurrentUser = member.principalId === currentUserId;
  const roleColor = ROLE_COLORS[member.role as CompanyRole] ?? "var(--muted-foreground)";
  const RoleIcon = ROLE_ICONS[member.role as CompanyRole] ?? Eye;

  const roleChangeMutation = useMutation({
    mutationFn: (newRole: string) =>
      membersApi.changeRole(companyId, member.principalId, newRole),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.members.list(companyId) });
      pushToast({ title: "Role updated", tone: "success" });
    },
    onError: (err) => {
      setRoleValue(member.role);
      pushToast({
        title: "Failed to update role",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const removeMutation = useMutation({
    mutationFn: () => membersApi.remove(companyId, member.principalId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.members.list(companyId) });
      pushToast({ title: "Member dismissed successfully", tone: "success" });
      setShowDismissDialog(false);
    },
    onError: (err) => {
      pushToast({
        title: "Failed to dismiss member",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  function handleRoleChange(newRole: string) {
    if (newRole === member.role) return;
    setRoleValue(newRole);
    roleChangeMutation.mutate(newRole);
  }

  return (
    <>
      <div
        className={cn(
          "rounded-[2px] border transition-all duration-200",
          expanded
            ? "border-[color:var(--role-color)]/30 shadow-[0_0_15px_var(--role-color-glow)]"
            : "border-border hover:border-border/80",
        )}
        style={{
          "--role-color": roleColor,
          "--role-color-glow": `${roleColor}10`,
        } as React.CSSProperties}
      >
        {/* Card header — always visible */}
        <div
          className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none hover:bg-[var(--sidebar-accent)] transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          {/* Avatar */}
          <div className="relative shrink-0">
            {member.userImage ? (
              <img src={member.userImage} alt="" className="h-10 w-10 rounded-full object-cover" />
            ) : (
              <div
                className="flex h-10 w-10 items-center justify-center rounded-full text-sm font-medium"
                style={{ backgroundColor: `${roleColor}15`, color: roleColor }}
              >
                {(member.userName ?? member.userEmail ?? "?").charAt(0).toUpperCase()}
              </div>
            )}
            {/* Online indicator */}
            <span
              className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-card"
              style={{ backgroundColor: "var(--status-active)" }}
            />
          </div>

          {/* Name + email */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">
                {member.userName ?? "Unknown"}
              </span>
              {isCurrentUser && (
                <span className="text-[10px] text-muted-foreground font-[var(--font-mono)]">(you)</span>
              )}
              <RoleBadge role={member.role} />
            </div>
            <div className="text-xs text-muted-foreground truncate mt-0.5">
              {member.userEmail ?? member.principalId}
            </div>
          </div>

          {/* Joined date */}
          <div className="hidden sm:flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
            <Calendar className="h-3 w-3" />
            {formatDate(member.joinedAt)}
          </div>

          {/* Expand chevron */}
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground transition-transform duration-200 shrink-0",
              expanded && "rotate-180"
            )}
          />
        </div>

        {/* Expanded details */}
        {expanded && (
          <div className="border-t border-border animate-in slide-in-from-top-1 fade-in duration-200">
            {/* Member info grid */}
            <div className="grid grid-cols-2 gap-px bg-border">
              <div className="bg-card px-4 py-3">
                <div className="text-[9px] font-[var(--font-mono)] uppercase tracking-wider text-muted-foreground mb-1">Email</div>
                <div className="text-xs font-medium truncate flex items-center gap-1.5">
                  <Mail className="h-3 w-3 text-muted-foreground shrink-0" />
                  {member.userEmail ?? "-"}
                </div>
              </div>
              <div className="bg-card px-4 py-3">
                <div className="text-[9px] font-[var(--font-mono)] uppercase tracking-wider text-muted-foreground mb-1">Member ID</div>
                <div className="text-xs font-[var(--font-mono)] text-muted-foreground truncate">
                  {member.principalId.substring(0, 12)}...
                </div>
              </div>
              <div className="bg-card px-4 py-3">
                <div className="text-[9px] font-[var(--font-mono)] uppercase tracking-wider text-muted-foreground mb-1">Joined</div>
                <div className="text-xs flex items-center gap-1.5">
                  <Calendar className="h-3 w-3 text-muted-foreground shrink-0" />
                  {formatDateTime(member.joinedAt)}
                </div>
              </div>
              <div className="bg-card px-4 py-3">
                <div className="text-[9px] font-[var(--font-mono)] uppercase tracking-wider text-muted-foreground mb-1">Status</div>
                <div className="flex items-center gap-1.5">
                  <span
                    className="inline-flex h-2 w-2 rounded-full"
                    style={{ backgroundColor: "var(--status-active)" }}
                  />
                  <span className="text-xs font-medium capitalize">{member.status}</span>
                </div>
              </div>
            </div>

            {/* Role management */}
            <div className="px-4 py-3 border-t border-border">
              <div className="text-[9px] font-[var(--font-mono)] uppercase tracking-wider text-muted-foreground mb-2">Role & Permissions</div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 flex-1">
                  <RoleIcon className="h-4 w-4" style={{ color: roleColor }} />
                  <select
                    className="rounded-[2px] border border-border bg-secondary px-2.5 py-1.5 font-[var(--font-mono)] text-xs outline-none disabled:opacity-50 flex-1"
                    value={roleValue}
                    onChange={(e) => handleRoleChange(e.target.value)}
                    disabled={isCurrentUser || roleChangeMutation.isPending}
                    title={isCurrentUser ? "You cannot change your own role" : undefined}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                    ))}
                  </select>
                </div>
                <p className="text-[10px] text-muted-foreground flex-1">
                  {ROLE_DESCRIPTIONS[roleValue as CompanyRole]}
                </p>
              </div>
            </div>

            {/* Page access for this member's role */}
            <div className="px-4 py-3 border-t border-border">
              <div className="text-[9px] font-[var(--font-mono)] uppercase tracking-wider text-muted-foreground mb-2">
                Page Access ({ROLE_LABELS[member.role as CompanyRole]})
              </div>
              <div className="grid grid-cols-3 gap-1">
                {PAGE_ACCESS.map((page) => {
                  const level = page[member.role as CompanyRole] ?? "none";
                  return (
                    <div
                      key={page.name}
                      className={cn(
                        "flex items-center gap-1.5 px-2 py-1 rounded-[2px] text-[10px]",
                        level === "full" && "text-foreground",
                        level === "read" && "text-muted-foreground",
                        level === "none" && "text-muted-foreground/30 line-through",
                      )}
                    >
                      <page.icon className="h-3 w-3 shrink-0" />
                      <span className="truncate">{page.name}</span>
                      <span className="ml-auto shrink-0">
                        <AccessDot level={level} />
                      </span>
                    </div>
                  );
                })}
              </div>
              <div className="flex items-center gap-4 mt-2 text-[9px] text-muted-foreground">
                <span className="flex items-center gap-1"><Check className="h-3 w-3 text-[var(--status-active)]" /> Full Access</span>
                <span className="flex items-center gap-1"><Eye className="h-2.5 w-2.5 text-[var(--status-info)]/60" /> Read Only</span>
                <span className="flex items-center gap-1"><XIcon className="h-2.5 w-2.5 text-muted-foreground/30" /> No Access</span>
              </div>
            </div>

            {/* Actions */}
            {!isCurrentUser && member.role !== "owner" && (
              <div className="px-4 py-3 border-t border-border flex justify-end">
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-[var(--status-error)] hover:text-[var(--status-error)] hover:bg-[var(--status-error)]/10 gap-1.5 text-xs"
                  onClick={() => setShowDismissDialog(true)}
                >
                  <UserX className="h-3.5 w-3.5" />
                  Dismiss from Company
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {showDismissDialog && (
        <DismissConfirmDialog
          memberName={member.userName ?? member.userEmail ?? "this member"}
          actionLabel="Dismiss Employee"
          onConfirm={() => removeMutation.mutate()}
          onCancel={() => setShowDismissDialog(false)}
          isPending={removeMutation.isPending}
        />
      )}
    </>
  );
}

/* ── Pending Invitation Card ─────────────────────────────────────── */

function PendingMemberCard({
  member,
  companyId,
}: {
  member: CompanyMember;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [showRevokeDialog, setShowRevokeDialog] = useState(false);

  const revokeMutation = useMutation({
    mutationFn: () => membersApi.remove(companyId, member.principalId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.members.list(companyId) });
      pushToast({ title: "Invitation revoked", tone: "success" });
      setShowRevokeDialog(false);
    },
    onError: (err) => {
      pushToast({
        title: "Failed to revoke invitation",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  return (
    <>
      <div className="flex items-center gap-3 rounded-[2px] border border-[var(--status-warning)]/20 bg-[var(--status-warning)]/5 px-4 py-3">
        {/* Avatar */}
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--status-warning)]/15 text-sm font-medium text-[var(--status-warning)]">
          {(member.userEmail ?? "?").charAt(0).toUpperCase()}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{member.userEmail ?? "Unknown"}</span>
            <RoleBadge role={member.role} />
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            Invited {formatDate(member.createdAt)} — awaiting signup
          </div>
        </div>

        {/* Status + actions */}
        <span className="hidden sm:inline-flex items-center rounded-[2px] bg-[var(--status-warning)]/15 text-[var(--status-warning)] px-2 py-0.5 font-[var(--font-mono)] text-[9px] uppercase shrink-0">
          Pending
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="text-[var(--status-error)] hover:text-[var(--status-error)] hover:bg-[var(--status-error)]/10 gap-1.5 text-xs shrink-0"
          onClick={() => setShowRevokeDialog(true)}
        >
          <XCircle className="h-3.5 w-3.5" />
          Revoke
        </Button>
      </div>

      {showRevokeDialog && (
        <DismissConfirmDialog
          memberName={member.userEmail ?? "this invitation"}
          actionLabel="Revoke Invitation"
          onConfirm={() => revokeMutation.mutate()}
          onCancel={() => setShowRevokeDialog(false)}
          isPending={revokeMutation.isPending}
        />
      )}
    </>
  );
}

/* ── Role Access Matrix ──────────────────────────────────────────── */

function RoleAccessMatrix() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="space-y-3">
      <button
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronDown className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")} />
        <Shield className="h-3.5 w-3.5" />
        <span className="font-[var(--font-mono)] uppercase tracking-wider text-[10px]">Role Access Matrix</span>
      </button>

      {expanded && (
        <div className="overflow-hidden overflow-x-auto rounded-[2px] border border-border animate-in slide-in-from-top-1 fade-in duration-200">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-border bg-[var(--sidebar-accent)]">
                <th className="px-3 py-2 font-[var(--font-mono)] text-[9px] uppercase tracking-wider text-muted-foreground w-[180px]">
                  Page
                </th>
                {ROLES.map((role) => {
                  const Icon = ROLE_ICONS[role];
                  const color = ROLE_COLORS[role];
                  return (
                    <th key={role} className="px-3 py-2 text-center">
                      <div className="flex flex-col items-center gap-0.5">
                        <Icon className="h-3 w-3" style={{ color }} />
                        <span className="font-[var(--font-mono)] text-[9px] uppercase tracking-wider" style={{ color }}>
                          {ROLE_LABELS[role]}
                        </span>
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {PAGE_ACCESS.map((page) => (
                <tr key={page.name} className="border-b border-border last:border-b-0 hover:bg-[var(--sidebar-accent)] transition-colors">
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-2 text-xs">
                      <page.icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      {page.name}
                    </div>
                  </td>
                  {ROLES.map((role) => (
                    <td key={role} className="px-3 py-1.5 text-center">
                      <div className="flex justify-center">
                        <AccessDot level={page[role]} />
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-center gap-6 py-2 bg-[var(--sidebar-accent)] border-t border-border text-[9px] text-muted-foreground">
            <span className="flex items-center gap-1"><Check className="h-3 w-3 text-[var(--status-active)]" /> Full Access (Read & Write)</span>
            <span className="flex items-center gap-1"><Eye className="h-2.5 w-2.5 text-[var(--status-info)]/60" /> Read Only</span>
            <span className="flex items-center gap-1"><XIcon className="h-2.5 w-2.5 text-muted-foreground/30" /> No Access</span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Main page ──────────────────────────────────────────────────── */

export function CompanyMembers() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<CompanyRole>("viewer");

  const membersQuery = useQuery({
    queryKey: queryKeys.members.list(selectedCompanyId!),
    queryFn: () => membersApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const inviteMutation = useMutation({
    mutationFn: (data: { email: string; role: string }) =>
      membersApi.invite(selectedCompanyId!, data),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.members.list(selectedCompanyId!) });
      setInviteEmail("");
      setInviteRole("viewer");
      const isPending = (data as unknown as Record<string, unknown>).pendingSignup;
      pushToast({
        title: isPending
          ? "Invitation sent! An email has been sent with signup instructions."
          : "Member added successfully! A notification email has been sent.",
        tone: "success",
      });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to invite member",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Members" },
    ]);
  }, [setBreadcrumbs, selectedCompany?.name]);

  if (!selectedCompany) {
    return (
      <div className="text-sm text-muted-foreground">
        No company selected. Select a company from the switcher above.
      </div>
    );
  }

  const allMembers = (membersQuery.data ?? []).filter(
    (m) => (m.status === "active" || m.status === "invited") && m.principalType === "user",
  );
  const activeMembers = allMembers.filter((m) => m.status === "active");
  const pendingMembers = allMembers.filter((m) => m.status === "invited");

  const sessionData = queryClient.getQueryData<{
    user?: { id?: string };
  }>(["auth", "session"]);
  const currentUserId = sessionData?.user?.id;

  return (
    <div className="max-w-4xl space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Users className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-[var(--font-display)] uppercase tracking-[0.06em]">Team Members</h1>
        <span className="ml-auto font-[var(--font-mono)] text-xs text-muted-foreground">
          {activeMembers.length} active{pendingMembers.length > 0 ? ` · ${pendingMembers.length} pending` : ""}
        </span>
      </div>

      {/* Invite Form */}
      <div className="space-y-3">
        <div className="hud-section-header">Invite a Member</div>
        <div className="space-y-3 rounded-[2px] border border-border px-4 py-4 hud-panel hud-shimmer">
          <div className="flex items-end gap-3">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Email address</label>
              <input
                type="email"
                placeholder="colleague@example.com"
                className="w-full rounded-[2px] border border-border bg-secondary px-2.5 py-1.5 text-sm outline-none"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && inviteEmail.trim() && inviteEmail.includes("@")) {
                    inviteMutation.mutate({ email: inviteEmail.trim(), role: inviteRole });
                  }
                }}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Role</label>
              <select
                className="rounded-[2px] border border-border bg-secondary px-2.5 py-1.5 text-sm outline-none"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as CompanyRole)}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                ))}
              </select>
            </div>
            <Button
              size="sm"
              onClick={() => inviteMutation.mutate({ email: inviteEmail.trim(), role: inviteRole })}
              disabled={inviteMutation.isPending || !inviteEmail.trim() || !inviteEmail.includes("@")}
            >
              <UserPlus className="mr-1.5 h-3.5 w-3.5" />
              {inviteMutation.isPending ? "Inviting..." : "Invite"}
            </Button>
          </div>
          {inviteRole && (
            <div className="flex items-start gap-2 text-xs text-muted-foreground">
              <Shield className="h-3 w-3 mt-0.5 shrink-0" />
              <div>
                <span className="font-medium" style={{ color: ROLE_COLORS[inviteRole] }}>{ROLE_LABELS[inviteRole]}:</span>{" "}
                {ROLE_DESCRIPTIONS[inviteRole]}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Active Members */}
      <div className="space-y-3">
        <div className="hud-section-header">
          Current Members
        </div>
        {membersQuery.isLoading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading members...</div>
        ) : membersQuery.isError ? (
          <div className="py-8 text-center text-sm text-destructive">
            {membersQuery.error instanceof Error ? membersQuery.error.message : "Failed to load members"}
          </div>
        ) : activeMembers.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground rounded-[2px] border border-dashed border-border">
            No members found. Invite someone to get started.
          </div>
        ) : (
          <div className="space-y-2">
            {activeMembers.map((member) => (
              <MemberCard
                key={member.id}
                member={member}
                companyId={selectedCompanyId!}
                currentUserId={currentUserId}
              />
            ))}
          </div>
        )}
      </div>

      {/* Pending Invitations */}
      {pendingMembers.length > 0 && (
        <div className="space-y-3">
          <div className="hud-section-header">Pending Invitations</div>
          <div className="space-y-2">
            {pendingMembers.map((member) => (
              <PendingMemberCard
                key={member.id}
                member={member}
                companyId={selectedCompanyId!}
              />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            These users have been invited but haven&apos;t created an account yet. They will automatically join the company when they sign up with the invited email address.
          </p>
        </div>
      )}

      {/* Role Access Matrix */}
      <RoleAccessMatrix />
    </div>
  );
}
