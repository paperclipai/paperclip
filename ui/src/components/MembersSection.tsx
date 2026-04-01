import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, Crown, Link2, Shield, ShieldCheck, User, Bot, ChevronDown, ChevronUp, UserPlus } from "lucide-react";
import { PERMISSION_KEYS } from "@paperclipai/shared";
import { membersApi, type CompanyMember } from "../api/members";
import { accessApi } from "../api/access";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { deriveInitials } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const PERMISSION_LABELS: Record<string, { label: string; tip: string }> = {
  "agents:create": { label: "Create agents", tip: "Can create new AI agents in this company" },
  "users:invite": { label: "Invite users", tip: "Can generate invite links for new users and agents" },
  "users:manage_permissions": { label: "Manage permissions", tip: "Can view members and change their permissions" },
  "tasks:assign": { label: "Assign tasks", tip: "Can create and assign issues to agents" },
  "tasks:assign_scope": { label: "Scoped task assignment", tip: "Can assign tasks with scoped permissions" },
  "joins:approve": { label: "Approve join requests", tip: "Can approve or reject join requests from invites" },
};

function InviteDialog({ companyId }: { companyId: string }) {
  const [open, setOpen] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [joinType, setJoinType] = useState<"human" | "agent" | "both">("human");
  const { pushToast } = useToast();

  const mutation = useMutation({
    mutationFn: () => accessApi.createCompanyInvite(companyId, { allowedJoinTypes: joinType }),
    onSuccess: (data) => {
      const url = data.inviteUrl ?? `${window.location.origin}/invite/${data.token}`;
      setInviteUrl(url);
    },
    onError: (err) => pushToast({
      title: "Failed to create invite",
      body: err instanceof Error ? err.message : "Unknown error",
      tone: "error",
    }),
  });

  const copyToClipboard = () => {
    if (!inviteUrl) return;
    navigator.clipboard.writeText(inviteUrl);
    pushToast({ title: "Invite link copied", tone: "success" });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setInviteUrl(null); } }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5">
          <UserPlus className="h-3.5 w-3.5" /> Invite
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite to Company</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Who can join?</p>
            <div className="flex gap-2">
              {(["human", "agent", "both"] as const).map((t) => (
                <Button
                  key={t}
                  size="sm"
                  variant={joinType === t ? "default" : "outline"}
                  onClick={() => { setJoinType(t); setInviteUrl(null); }}
                  className="capitalize"
                >
                  {t === "human" ? "Users" : t === "agent" ? "Agents" : "Both"}
                </Button>
              ))}
            </div>
          </div>

          {!inviteUrl ? (
            <Button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending}
              className="w-full gap-1.5"
            >
              <Link2 className="h-4 w-4" />
              {mutation.isPending ? "Generating..." : "Generate Invite Link"}
            </Button>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
                <code className="flex-1 text-xs break-all">{inviteUrl}</code>
                <Button size="icon-sm" variant="ghost" onClick={copyToClipboard}>
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                This link expires in 10 minutes. The invitee will need to be approved before gaining access.
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MemberRow({
  member,
  companyId,
  currentUserId,
}: {
  member: CompanyMember;
  companyId: string;
  currentUserId: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pendingGrants, setPendingGrants] = useState<string[] | null>(null);
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const isSelf = member.principalType === "user" && member.principalId === currentUserId;
  const grants = pendingGrants ?? member.grants;

  const mutation = useMutation({
    mutationFn: (newGrants: string[]) =>
      membersApi.updatePermissions(
        companyId,
        member.id,
        newGrants.map((k) => ({ permissionKey: k })),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.members.list(companyId) });
      setPendingGrants(null);
      pushToast({ title: "Permissions updated", tone: "success" });
    },
    onError: (err) => {
      pushToast({
        title: "Failed to update permissions",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  const toggleGrant = (key: string) => {
    const current = pendingGrants ?? member.grants;
    const next = current.includes(key)
      ? current.filter((k) => k !== key)
      : [...current, key];
    setPendingGrants(next);
  };

  const isDirty = pendingGrants !== null &&
    (pendingGrants.length !== member.grants.length ||
      pendingGrants.some((k) => !member.grants.includes(k)));

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/30 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <Avatar size="sm">
          <AvatarFallback>{deriveInitials(member.displayName)}</AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{member.displayName}</span>
            {isSelf && <Badge variant="outline" className="text-[10px] px-1.5 py-0">You</Badge>}
            {member.membershipRole === "owner" && (
              <Badge variant="default" className="text-[10px] px-1.5 py-0 gap-0.5 bg-amber-600 hover:bg-amber-600">
                <Crown className="h-2.5 w-2.5" /> Owner
              </Badge>
            )}
            {member.isInstanceAdmin && (
              <Badge variant="default" className="text-[10px] px-1.5 py-0 gap-0.5 bg-violet-600 hover:bg-violet-600">
                <Shield className="h-2.5 w-2.5" /> Admin
              </Badge>
            )}
          </div>
          {member.email && (
            <p className="text-xs text-muted-foreground truncate">{member.email}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {member.principalType === "agent" ? (
            <Badge variant="secondary" className="text-[10px] gap-1">
              <Bot className="h-3 w-3" /> Agent
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-[10px] gap-1">
              <User className="h-3 w-3" /> User
            </Badge>
          )}
          <Badge variant="outline" className="text-[10px]">
            {member.status}
          </Badge>
          {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </div>
      </button>
      {expanded && (
        <div className="px-4 pb-3 pt-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
            Permissions
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {PERMISSION_KEYS.map((key) => (
              <Tooltip key={key}>
                <TooltipTrigger asChild>
                  <label
                    className="flex items-center gap-2 text-sm cursor-pointer select-none"
                  >
                    <Checkbox
                      checked={grants.includes(key)}
                      onCheckedChange={() => toggleGrant(key)}
                      disabled={mutation.isPending}
                    />
                    <span>{PERMISSION_LABELS[key]?.label ?? key}</span>
                  </label>
                </TooltipTrigger>
                <TooltipContent side="top">{PERMISSION_LABELS[key]?.tip ?? key}</TooltipContent>
              </Tooltip>
            ))}
          </div>
          {isDirty && (
            <div className="mt-3 flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => mutation.mutate(pendingGrants!)}
                disabled={mutation.isPending}
              >
                {mutation.isPending ? "Saving..." : "Save permissions"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPendingGrants(null)}
                disabled={mutation.isPending}
              >
                Cancel
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function MembersSection({
  companyId,
  currentUserId,
}: {
  companyId: string;
  currentUserId: string | null;
}) {
  const { data: members, isLoading, error } = useQuery({
    queryKey: queryKeys.members.list(companyId),
    queryFn: () => membersApi.list(companyId),
    enabled: !!companyId,
  });

  const userMembers = members?.filter((m) => m.principalType === "user") ?? [];
  const agentMembers = members?.filter((m) => m.principalType === "agent") ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Members & Permissions
          </div>
        </div>
        <InviteDialog companyId={companyId} />
      </div>

      {isLoading && (
        <div className="rounded-md border border-border px-4 py-6 text-sm text-muted-foreground">
          Loading members...
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error instanceof Error && error.message.includes("403")
            ? "You don't have permission to manage members."
            : "Failed to load members."}
        </div>
      )}

      {members && (
        <div className="rounded-md border border-border overflow-hidden">
          {userMembers.length > 0 && (
            <>
              <div className="px-4 py-2 bg-muted/30 text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <User className="h-3.5 w-3.5" /> Users ({userMembers.length})
              </div>
              {userMembers.map((m) => (
                <MemberRow key={m.id} member={m} companyId={companyId} currentUserId={currentUserId} />
              ))}
            </>
          )}
          {agentMembers.length > 0 && (
            <>
              <div className="px-4 py-2 bg-muted/30 text-xs font-medium text-muted-foreground flex items-center gap-1.5 border-t border-border">
                <Bot className="h-3.5 w-3.5" /> Agents ({agentMembers.length})
              </div>
              {agentMembers.map((m) => (
                <MemberRow key={m.id} member={m} companyId={companyId} currentUserId={currentUserId} />
              ))}
            </>
          )}
          {members.length === 0 && (
            <div className="px-4 py-6 text-sm text-muted-foreground text-center">
              No members found.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
