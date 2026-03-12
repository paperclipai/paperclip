import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accessApi } from "../api/access";
import { ROLE_PRESETS, MEMBERSHIP_ROLES, type MembershipRole } from "@paperclipai/shared";
import { Button } from "./ui/button";

type Member = Awaited<ReturnType<typeof accessApi.listMembers>>[number];

function roleBadgeColor(role: string | null) {
  switch (role) {
    case "owner": return "bg-amber-500/10 text-amber-500 border-amber-500/20";
    case "admin": return "bg-blue-500/10 text-blue-500 border-blue-500/20";
    case "contributor": return "bg-green-500/10 text-green-500 border-green-500/20";
    case "viewer": return "bg-gray-500/10 text-gray-400 border-gray-500/20";
    default: return "bg-gray-500/10 text-gray-400 border-gray-500/20";
  }
}

export function MembersSection({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const [editingMember, setEditingMember] = useState<Member | null>(null);
  const [editRole, setEditRole] = useState<MembershipRole>("contributor");
  const [removingMember, setRemovingMember] = useState<Member | null>(null);

  const membersQuery = useQuery({
    queryKey: ["members", companyId],
    queryFn: () => accessApi.listMembers(companyId),
  });

  const removeMutation = useMutation({
    mutationFn: (memberId: string) => accessApi.removeMember(companyId, memberId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["members", companyId] });
      setRemovingMember(null);
    },
  });

  const suspendMutation = useMutation({
    mutationFn: async ({ memberId, suspend }: { memberId: string; suspend: boolean }) =>
      suspend
        ? accessApi.suspendMember(companyId, memberId)
        : accessApi.unsuspendMember(companyId, memberId) as Promise<{ id: string; status: string; membershipRole: string | null }>,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["members", companyId] }),
  });

  const permissionsMutation = useMutation({
    mutationFn: ({ memberId, grants }: { memberId: string; grants: Array<{ permissionKey: string }> }) =>
      accessApi.updateMemberPermissions(companyId, memberId, grants),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["members", companyId] });
      setEditingMember(null);
    },
  });

  const members = membersQuery.data ?? [];

  return (
    <div className="space-y-4">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Members
      </div>
      <div className="space-y-3 rounded-md border border-border px-4 py-4">
        {membersQuery.isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}

        {members.length === 0 && !membersQuery.isLoading && (
          <p className="text-sm text-muted-foreground">No members found.</p>
        )}

        <div className="space-y-2">
          {members.map((member) => (
            <div
              key={member.id}
              className={`flex items-center justify-between rounded-md border border-border p-3 ${
                member.status === "suspended" ? "opacity-50" : ""
              }`}
            >
              <div className="flex items-center gap-3">
                <div>
                  <div className="text-sm font-medium">{member.principalId}</div>
                  <div className="text-xs text-muted-foreground">
                    {member.principalType} &middot; Joined{" "}
                    {new Date(member.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <span
                  className={`rounded-full border px-2 py-0.5 text-xs font-medium ${roleBadgeColor(member.membershipRole)}`}
                >
                  {member.membershipRole ?? "unknown"}
                </span>
                {member.status === "suspended" && (
                  <span className="rounded-full border border-destructive/20 bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                    Suspended
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditingMember(member);
                    const matchedRole =
                      MEMBERSHIP_ROLES.find((r) => r === member.membershipRole) ?? "contributor";
                    setEditRole(matchedRole);
                  }}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    suspendMutation.mutate({
                      memberId: member.id,
                      suspend: member.status !== "suspended",
                    })
                  }
                >
                  {member.status === "suspended" ? "Unsuspend" : "Suspend"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setRemovingMember(member)}
                >
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Edit Permissions Modal */}
      {editingMember && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-96 rounded-lg border border-border bg-card p-6 shadow-lg">
            <h4 className="mb-4 text-lg font-semibold">Edit Permissions</h4>
            <p className="mb-4 text-sm text-muted-foreground">
              Editing {editingMember.principalId}
            </p>
            <div className="mb-4">
              <label className="text-sm font-medium">Role Preset:</label>
              <select
                value={editRole}
                onChange={(e) => setEditRole(e.target.value as MembershipRole)}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
              >
                {MEMBERSHIP_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role.charAt(0).toUpperCase() + role.slice(1)}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditingMember(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  const grants = ROLE_PRESETS[editRole].map((k) => ({ permissionKey: k }));
                  permissionsMutation.mutate({ memberId: editingMember.id, grants });
                }}
                disabled={permissionsMutation.isPending}
              >
                {permissionsMutation.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Remove Confirmation */}
      {removingMember && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-96 rounded-lg border border-border bg-card p-6 shadow-lg">
            <h4 className="mb-2 text-lg font-semibold">Remove Member</h4>
            <p className="mb-4 text-sm text-muted-foreground">
              Remove {removingMember.principalId} from this company? This will delete their
              membership and all permission grants.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setRemovingMember(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => removeMutation.mutate(removingMember.id)}
                disabled={removeMutation.isPending}
              >
                {removeMutation.isPending ? "Removing..." : "Remove"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
