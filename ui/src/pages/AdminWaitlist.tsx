import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";

type WaitlistEntry = {
  id: string;
  email: string;
  name: string | null;
  companyName: string | null;
  notes: string | null;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  approvedAt: string | null;
  provisionedCompanyId: string | null;
  inviteUrl?: string | null;
  connectProvidersUrl?: string | null;
  inviteEmail?: {
    attempted?: boolean;
    sent?: boolean;
    message?: string;
  } | null;
};

function resolveSaasControlBase() {
  if (typeof window !== "undefined") {
    const injected =
      (window as Window & { __TYE_SAAS_CONTROL_BASE_URL?: string; TYE_SAAS_CONTROL_URL?: string })
        .__TYE_SAAS_CONTROL_BASE_URL ??
      (window as Window & { __TYE_SAAS_CONTROL_BASE_URL?: string; TYE_SAAS_CONTROL_URL?: string })
        .TYE_SAAS_CONTROL_URL;
    if (typeof injected === "string" && injected.trim().length > 0) {
      return injected.trim().replace(/\/+$/, "");
    }
  }
  return "https://control.tye.ai";
}

function parseErrorPayload(payload: unknown, fallback: string): string {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const errorValue = (payload as { error?: unknown }).error;
    if (typeof errorValue === "string" && errorValue.trim().length > 0) return errorValue;
  }
  return fallback;
}

export function AdminWaitlistPage() {
  const saasBase = useMemo(() => resolveSaasControlBase(), []);
  const [token, setToken] = useState<string>(() => localStorage.getItem("saas-control-admin-token") ?? "");
  const [entries, setEntries] = useState<WaitlistEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function loadEntries() {
    if (!token.trim()) {
      setMessage("Admin token is required.");
      return;
    }
    localStorage.setItem("saas-control-admin-token", token.trim());
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch(`${saasBase}/admin/waitlist`, {
        method: "GET",
        headers: {
          "x-admin-token": token.trim(),
        },
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(parseErrorPayload(payload, `Request failed (${response.status})`));
      }
      const nextEntries = Array.isArray((payload as { entries?: unknown })?.entries)
        ? ((payload as { entries: WaitlistEntry[] }).entries ?? [])
        : [];
      setEntries(nextEntries);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load waitlist");
    } finally {
      setLoading(false);
    }
  }

  async function approveEntry(entry: WaitlistEntry) {
    if (!token.trim()) {
      setMessage("Admin token is required.");
      return;
    }
    setApprovingId(entry.id);
    setMessage(null);
    try {
      const response = await fetch(`${saasBase}/admin/waitlist/${entry.id}/approve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": token.trim(),
        },
        body: JSON.stringify({}),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(parseErrorPayload(payload, `Request failed (${response.status})`));
      }
      setMessage(`Approved ${entry.email}`);
      await loadEntries();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to approve entry");
    } finally {
      setApprovingId(null);
    }
  }

  async function resendInvite(entry: WaitlistEntry) {
    if (!token.trim()) {
      setMessage("Admin token is required.");
      return;
    }
    setApprovingId(entry.id);
    setMessage(null);
    try {
      const response = await fetch(`${saasBase}/admin/waitlist/${entry.id}/resend-invite`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-token": token.trim(),
        },
        body: JSON.stringify({}),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(parseErrorPayload(payload, `Request failed (${response.status})`));
      }
      setMessage(`Invite resent to ${entry.email}`);
      await loadEntries();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to resend invite");
    } finally {
      setApprovingId(null);
    }
  }

  return (
    <div className="mx-auto max-w-4xl py-10">
      <div className="rounded-lg border border-border bg-card p-6">
        <h1 className="text-2xl font-semibold">Admin Waitlist</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Review waitlist entries and provision invite-only companies through SaaS control.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <input
            className="w-full max-w-md rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="SaaS control admin token"
          />
          <Button type="button" onClick={() => void loadEntries()} disabled={loading}>
            {loading ? "Loading..." : "Load waitlist"}
          </Button>
        </div>
        {message && (
          <p className="mt-3 text-sm text-muted-foreground">{message}</p>
        )}
      </div>

      <div className="mt-6 overflow-hidden rounded-lg border border-border">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-card">
            <tr>
              <th className="px-4 py-3 font-medium">Email</th>
              <th className="px-4 py-3 font-medium">Company</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Created</th>
              <th className="px-4 py-3 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && (
              <tr>
                <td className="px-4 py-4 text-muted-foreground" colSpan={5}>
                  No waitlist entries yet.
                </td>
              </tr>
            )}
            {entries.map((entry) => (
              <tr key={entry.id} className="border-t border-border">
                <td className="px-4 py-3">{entry.email}</td>
                <td className="px-4 py-3">{entry.companyName ?? "-"}</td>
                <td className="px-4 py-3">{entry.status}</td>
                <td className="px-4 py-3">{new Date(entry.createdAt).toLocaleString()}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      disabled={entry.status !== "pending" || approvingId === entry.id}
                      onClick={() => void approveEntry(entry)}
                    >
                      {approvingId === entry.id ? "Approving..." : "Approve"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={entry.status !== "approved" || approvingId === entry.id}
                      onClick={() => void resendInvite(entry)}
                    >
                      Resend invite
                    </Button>
                  </div>
                  {entry.inviteUrl && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Invite: <a className="underline" href={entry.inviteUrl} target="_blank" rel="noreferrer">{entry.inviteUrl}</a>
                    </p>
                  )}
                  {entry.inviteEmail?.message && (
                    <p className="mt-1 text-xs text-muted-foreground">{entry.inviteEmail.message}</p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
