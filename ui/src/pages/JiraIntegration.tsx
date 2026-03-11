import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { jiraIntegrationsApi } from "../api/jiraIntegrations";
import { projectsApi } from "../api/projects";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Plus, Pencil, Trash2, Unplug, CheckCircle, AlertTriangle, Loader2 } from "lucide-react";
import type {
  JiraIntegration as JiraIntegrationType,
  JiraProject,
  JiraStatus,
  JiraUser,
  JiraIssuePreview,
  JiraImportResult,
} from "@paperclipai/shared";

const inputClass =
  "w-full rounded-md border border-border bg-transparent px-2.5 py-1.5 text-sm outline-none focus:border-foreground/30 transition-colors";

const selectClass =
  "w-full rounded-md border border-border bg-background text-foreground px-2.5 py-1.5 text-sm outline-none focus:border-foreground/30 transition-colors appearance-none bg-[length:16px_16px] bg-[right_8px_center] bg-no-repeat cursor-pointer [background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")] pr-8";

// ─── Create / Edit Dialog ──────────────────────────────────────────

function JiraIntegrationDialog({
  open,
  onOpenChange,
  companyId,
  editIntegration,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  editIntegration: JiraIntegrationType | null;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [hostUrl, setHostUrl] = useState("");
  const [authType, setAuthType] = useState<"token" | "password">("token");
  const [usernameOrEmail, setUsernameOrEmail] = useState("");
  const [apiToken, setApiToken] = useState("");

  useEffect(() => {
    if (editIntegration) {
      setName(editIntegration.name);
      setHostUrl(editIntegration.hostUrl);
      setUsernameOrEmail(editIntegration.usernameOrEmail);
      setApiToken("");
      // Heuristic: if host doesn't contain atlassian.net, likely Server/DC
      setAuthType(editIntegration.hostUrl.includes("atlassian.net") ? "token" : "password");
    } else {
      setName("");
      setHostUrl("");
      setAuthType("token");
      setUsernameOrEmail("");
      setApiToken("");
    }
  }, [editIntegration, open]);

  // Auto-detect auth type from host URL
  useEffect(() => {
    if (!editIntegration) {
      const isCloud = hostUrl.includes("atlassian.net");
      setAuthType(isCloud ? "token" : "password");
    }
  }, [hostUrl, editIntegration]);

  const createMutation = useMutation({
    mutationFn: (data: { name: string; hostUrl: string; usernameOrEmail: string; apiToken: string }) =>
      jiraIntegrationsApi.create(companyId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.jiraIntegrations.list(companyId) });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      jiraIntegrationsApi.update(id, data as Parameters<typeof jiraIntegrationsApi.update>[1]),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.jiraIntegrations.list(companyId) });
    },
  });

  const mutation = editIntegration ? updateMutation : createMutation;

  async function handleSubmit() {
    try {
      if (editIntegration) {
        const patch: Record<string, unknown> = {};
        if (name.trim() !== editIntegration.name) patch.name = name.trim();
        if (hostUrl.trim() !== editIntegration.hostUrl) patch.hostUrl = hostUrl.trim();
        if (usernameOrEmail.trim() !== editIntegration.usernameOrEmail)
          patch.usernameOrEmail = usernameOrEmail.trim();
        if (apiToken.trim()) patch.apiToken = apiToken.trim();
        await updateMutation.mutateAsync({ id: editIntegration.id, data: patch });
      } else {
        await createMutation.mutateAsync({
          name: name.trim(),
          hostUrl: hostUrl.trim(),
          usernameOrEmail: usernameOrEmail.trim(),
          apiToken: apiToken.trim(),
        });
      }
      onOpenChange(false);
    } catch {
      // surfaced via mutation.isError
    }
  }

  const isValid =
    name.trim().length > 0 &&
    hostUrl.trim().length > 0 &&
    usernameOrEmail.trim().length > 0 &&
    (editIntegration ? true : apiToken.trim().length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="p-0 gap-0 sm:max-w-lg">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <span className="text-sm text-muted-foreground">
            {editIntegration ? "Edit Jira Integration" : "New Jira Integration"}
          </span>
          <Button variant="ghost" size="icon-xs" onClick={() => onOpenChange(false)}>
            <span className="text-lg leading-none">&times;</span>
          </Button>
        </div>

        <div className="px-4 py-4 space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Name</label>
            <input
              className={inputClass}
              placeholder="My Jira"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Host URL</label>
            <input
              className={inputClass}
              placeholder="https://your-domain.atlassian.net"
              value={hostUrl}
              onChange={(e) => setHostUrl(e.target.value)}
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              {authType === "token" ? "Email" : "Username"}
            </label>
            <input
              className={inputClass}
              placeholder={authType === "token" ? "you@company.com" : "jira_username"}
              value={usernameOrEmail}
              onChange={(e) => setUsernameOrEmail(e.target.value)}
            />
          </div>
          <div>
            <div className="flex items-center gap-3 mb-1">
              <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                <input
                  type="radio"
                  name="authType"
                  checked={authType === "token"}
                  onChange={() => setAuthType("token")}
                  className="accent-foreground"
                />
                <span className="text-muted-foreground">API Token</span>
              </label>
              <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                <input
                  type="radio"
                  name="authType"
                  checked={authType === "password"}
                  onChange={() => setAuthType("password")}
                  className="accent-foreground"
                />
                <span className="text-muted-foreground">Password</span>
              </label>
              {editIntegration && (
                <span className="text-[11px] text-muted-foreground/60">(leave blank to keep current)</span>
              )}
            </div>
            {authType === "token" && (
              <p className="text-[11px] text-muted-foreground/70 mb-1">
                For Jira Cloud.{" "}
                <a
                  href="https://id.atlassian.com/manage-profile/security/api-tokens"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-foreground transition-colors"
                >
                  Create a token here
                </a>
                {" "}&mdash; any Jira user can do this, no admin rights needed.
              </p>
            )}
            {authType === "password" && (
              <p className="text-[11px] text-muted-foreground/70 mb-1">
                For Jira Server / Data Center. Uses your regular Jira password.
              </p>
            )}
            <input
              className={inputClass}
              type="password"
              placeholder={editIntegration ? "••••••••" : authType === "token" ? "Paste your API token" : "Your Jira password"}
              value={apiToken}
              onChange={(e) => setApiToken(e.target.value)}
            />
          </div>
        </div>

        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border">
          {mutation.isError ? (
            <p className="text-xs text-destructive">
              {mutation.error instanceof Error ? mutation.error.message : "Failed to save."}
            </p>
          ) : (
            <span />
          )}
          <Button size="sm" disabled={!isValid || mutation.isPending} onClick={handleSubmit}>
            {mutation.isPending ? "Saving..." : editIntegration ? "Save" : "Create"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Delete Confirm Dialog ──────────────────────────────────────────

function DeleteConfirmDialog({
  open,
  onOpenChange,
  integration,
  companyId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  integration: JiraIntegrationType | null;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const deleteMutation = useMutation({
    mutationFn: (id: string) => jiraIntegrationsApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.jiraIntegrations.list(companyId) });
      onOpenChange(false);
    },
  });

  if (!integration) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="p-0 gap-0 sm:max-w-md">
        <div className="px-4 py-4 space-y-3">
          <p className="text-sm font-medium">Delete Jira Integration</p>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete <strong>{integration.name}</strong>?
          </p>
          {deleteMutation.isError && (
            <p className="text-xs text-destructive">Failed to delete.</p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-border">
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={deleteMutation.isPending}
            onClick={() => deleteMutation.mutate(integration.id)}
          >
            {deleteMutation.isPending ? "Deleting..." : "Delete"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Import Wizard ──────────────────────────────────────────────────

function ImportWizard({
  integrations,
  companyId,
}: {
  integrations: JiraIntegrationType[];
  companyId: string;
}) {
  const [selectedIntegrationId, setSelectedIntegrationId] = useState("");
  const [selectedProjectKey, setSelectedProjectKey] = useState("");
  const [selectedAssignee, setSelectedAssignee] = useState<string | null>(null);
  const [selectedStatuses, setSelectedStatuses] = useState<string[]>([]);
  const [targetStatus, setTargetStatus] = useState("backlog");
  const [targetProjectId, setTargetProjectId] = useState("");
  const [previewData, setPreviewData] = useState<JiraIssuePreview[] | null>(null);
  const [debugJql, setDebugJql] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<JiraImportResult | null>(null);

  const enabledIntegrations = integrations.filter((i) => i.enabled);

  const { data: jiraProjects, isLoading: projectsLoading } = useQuery({
    queryKey: queryKeys.jiraIntegrations.projects(selectedIntegrationId),
    queryFn: () => jiraIntegrationsApi.listProjects(selectedIntegrationId),
    enabled: !!selectedIntegrationId,
  });

  const { data: jiraStatuses, isLoading: statusesLoading } = useQuery({
    queryKey: queryKeys.jiraIntegrations.statuses(selectedIntegrationId, selectedProjectKey),
    queryFn: () => jiraIntegrationsApi.getStatuses(selectedIntegrationId, selectedProjectKey),
    enabled: !!selectedIntegrationId && !!selectedProjectKey,
  });

  const { data: jiraAssignees } = useQuery({
    queryKey: queryKeys.jiraIntegrations.assignees(selectedIntegrationId, selectedProjectKey),
    queryFn: () => jiraIntegrationsApi.getAssignees(selectedIntegrationId, selectedProjectKey),
    enabled: !!selectedIntegrationId && !!selectedProjectKey,
  });

  const { data: paperclipProjects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: !!companyId,
  });

  const previewMutation = useMutation({
    mutationFn: () =>
      jiraIntegrationsApi.preview(selectedIntegrationId, {
        integrationId: selectedIntegrationId,
        projectKey: selectedProjectKey,
        statuses: selectedStatuses,
        assigneeAccountId: selectedAssignee,
        targetProjectId: targetProjectId || undefined,
        targetStatus: targetStatus as "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled",
      }),
    onSuccess: (data) => {
      setPreviewData(data.issues ?? []);
      setDebugJql(data.jql ?? null);
    },
  });

  const importMutation = useMutation({
    mutationFn: () =>
      jiraIntegrationsApi.import(selectedIntegrationId, {
        integrationId: selectedIntegrationId,
        projectKey: selectedProjectKey,
        statuses: selectedStatuses,
        assigneeAccountId: selectedAssignee,
        targetProjectId: targetProjectId || undefined,
        targetStatus: targetStatus as "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled",
      }),
    onSuccess: (data) => setImportResult(data),
  });

  // Reset downstream state when integration changes
  useEffect(() => {
    setSelectedProjectKey("");
    setSelectedAssignee(null);
    setSelectedStatuses([]);
    setPreviewData(null);
    setImportResult(null);
  }, [selectedIntegrationId]);

  useEffect(() => {
    setSelectedAssignee(null);
    setSelectedStatuses([]);
    setPreviewData(null);
    setImportResult(null);
  }, [selectedProjectKey]);

  if (enabledIntegrations.length === 0) return null;

  const canPreview =
    selectedIntegrationId && selectedProjectKey && selectedStatuses.length > 0;

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        Import Issues
      </h3>

      {/* Step 1: Select integration */}
      <div>
        <label className="text-xs font-medium text-muted-foreground">Integration</label>
        <select
          className={selectClass}
          value={selectedIntegrationId}
          onChange={(e) => setSelectedIntegrationId(e.target.value)}
        >
          <option value="" className="bg-background text-foreground">Select an integration...</option>
          {enabledIntegrations.map((i) => (
            <option key={i.id} value={i.id} className="bg-background text-foreground">
              {i.name} ({i.hostUrl})
            </option>
          ))}
        </select>
      </div>

      {/* Step 2: Select project */}
      {selectedIntegrationId && (
        <div>
          <label className="text-xs font-medium text-muted-foreground">Jira Project</label>
          {projectsLoading ? (
            <p className="text-xs text-muted-foreground">Loading projects...</p>
          ) : (
            <select
              className={selectClass}
              value={selectedProjectKey}
              onChange={(e) => setSelectedProjectKey(e.target.value)}
            >
              <option value="" className="bg-background text-foreground">Select a project...</option>
              {jiraProjects?.map((p: JiraProject) => (
                <option key={p.key} value={p.key} className="bg-background text-foreground">
                  {p.key} - {p.name}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Step 3: Select assignee */}
      {selectedProjectKey && (
        <div>
          <label className="text-xs font-medium text-muted-foreground">
            Assignee Filter <span className="text-muted-foreground/60">(optional)</span>
          </label>
          <select
            className={selectClass}
            value={selectedAssignee ?? ""}
            onChange={(e) => setSelectedAssignee(e.target.value || null)}
          >
            <option value="" className="bg-background text-foreground">All assignees</option>
            {jiraAssignees?.map((u: JiraUser) => (
              <option key={u.accountId} value={u.accountId} className="bg-background text-foreground">
                {u.displayName}
              </option>
            ))}
          </select>
          {!selectedAssignee && (
            <p className="text-xs text-amber-500 mt-1 flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              Importing all assignees may create many issues
            </p>
          )}
        </div>
      )}

      {/* Step 4: Select statuses */}
      {selectedProjectKey && (
        <div>
          <label className="text-xs font-medium text-muted-foreground">Jira Statuses to Import</label>
          {statusesLoading ? (
            <p className="text-xs text-muted-foreground">Loading statuses...</p>
          ) : (
            <div className="flex flex-wrap gap-2 mt-1">
              {jiraStatuses?.map((s: JiraStatus) => (
                <label key={s.id} className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedStatuses.includes(s.id)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedStatuses([...selectedStatuses, s.id]);
                      } else {
                        setSelectedStatuses(selectedStatuses.filter((n) => n !== s.id));
                      }
                      setPreviewData(null);
                      setImportResult(null);
                    }}
                    className="rounded"
                  />
                  {s.name}
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Target status + project */}
      {selectedProjectKey && selectedStatuses.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Target Status in Paperclip</label>
            <select
              className={selectClass}
              value={targetStatus}
              onChange={(e) => setTargetStatus(e.target.value)}
            >
              <option value="backlog" className="bg-background text-foreground">Backlog</option>
              <option value="todo" className="bg-background text-foreground">To Do</option>
              <option value="in_progress" className="bg-background text-foreground">In Progress</option>
              <option value="in_review" className="bg-background text-foreground">In Review</option>
              <option value="blocked" className="bg-background text-foreground">Blocked</option>
              <option value="done" className="bg-background text-foreground">Done</option>
              <option value="cancelled" className="bg-background text-foreground">Cancelled</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Target Project</label>
            <select
              className={selectClass}
              value={targetProjectId}
              onChange={(e) => setTargetProjectId(e.target.value)}
            >
              <option value="" className="bg-background text-foreground">No project</option>
              {paperclipProjects?.map((p: { id: string; name: string }) => (
                <option key={p.id} value={p.id} className="bg-background text-foreground">
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Preview + Import buttons */}
      {canPreview && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={previewMutation.isPending}
            onClick={() => {
              setImportResult(null);
              previewMutation.mutate();
            }}
          >
            {previewMutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                Loading...
              </>
            ) : (
              "Preview Issues"
            )}
          </Button>

          {previewData && previewData.length > 0 && !importResult && (
            <Button
              size="sm"
              disabled={importMutation.isPending}
              onClick={() => importMutation.mutate()}
            >
              {importMutation.isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                  Importing...
                </>
              ) : (
                `Import ${previewData.length} Issues`
              )}
            </Button>
          )}
        </div>
      )}

      {/* Preview table */}
      {previewData && previewData.length > 0 && !importResult && (
        <div className="rounded-md border border-border overflow-auto max-h-80">
          <table className="w-full text-sm">
            <thead className="bg-muted/30">
              <tr>
                <th className="text-left px-3 py-1.5 text-xs font-medium text-muted-foreground">Key</th>
                <th className="text-left px-3 py-1.5 text-xs font-medium text-muted-foreground">Summary</th>
                <th className="text-left px-3 py-1.5 text-xs font-medium text-muted-foreground">Status</th>
                <th className="text-left px-3 py-1.5 text-xs font-medium text-muted-foreground">Priority</th>
                <th className="text-left px-3 py-1.5 text-xs font-medium text-muted-foreground">Assignee</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {previewData.map((issue: JiraIssuePreview) => (
                <tr key={issue.key} className="hover:bg-accent/30">
                  <td className="px-3 py-1.5 font-mono text-xs">{issue.key}</td>
                  <td className="px-3 py-1.5 truncate max-w-xs">{issue.summary}</td>
                  <td className="px-3 py-1.5">
                    <Badge variant="outline" className="text-[10px]">{issue.status}</Badge>
                  </td>
                  <td className="px-3 py-1.5 text-xs">{issue.priority}</td>
                  <td className="px-3 py-1.5 text-xs text-muted-foreground">{issue.assignee ?? "Unassigned"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {previewData && previewData.length === 0 && (
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">No matching issues found.</p>
          {debugJql && (
            <p className="text-xs text-muted-foreground/60 font-mono break-all">
              JQL: {debugJql}
            </p>
          )}
        </div>
      )}

      {debugJql && previewData && previewData.length > 0 && (
        <p className="text-xs text-muted-foreground/60 font-mono break-all">
          JQL: {debugJql}
        </p>
      )}

      {/* Import result */}
      {importResult && (
        <div className="rounded-md border border-border p-4 space-y-2">
          <div className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-green-500" />
            <span className="text-sm font-medium">Import Complete</span>
          </div>
          <div className="text-sm text-muted-foreground space-y-1">
            <p>Imported: {importResult.imported}</p>
            <p>Skipped (duplicates): {importResult.skipped}</p>
            {importResult.errors.length > 0 && (
              <div>
                <p className="text-destructive">Errors: {importResult.errors.length}</p>
                <ul className="text-xs text-destructive mt-1 list-disc list-inside">
                  {importResult.errors.map((err, i) => (
                    <li key={i}>{err}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}

      {previewMutation.isError && (
        <p className="text-xs text-destructive">
          {previewMutation.error instanceof Error ? previewMutation.error.message : "Failed to preview"}
        </p>
      )}
      {importMutation.isError && (
        <p className="text-xs text-destructive">
          {importMutation.error instanceof Error ? importMutation.error.message : "Failed to import"}
        </p>
      )}
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────

export function JiraIntegration() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editIntegration, setEditIntegration] = useState<JiraIntegrationType | null>(null);
  const [deleteIntegration, setDeleteIntegration] = useState<JiraIntegrationType | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; message: string }>>({});

  useEffect(() => {
    setBreadcrumbs([{ label: "Jira" }]);
  }, [setBreadcrumbs]);

  const {
    data: integrations,
    isLoading,
    error,
  } = useQuery({
    queryKey: queryKeys.jiraIntegrations.list(selectedCompanyId!),
    queryFn: () => jiraIntegrationsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      jiraIntegrationsApi.update(id, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.jiraIntegrations.list(selectedCompanyId!) });
    },
  });

  const testMutation = useMutation({
    mutationFn: (id: string) => jiraIntegrationsApi.testConnection(id),
    onSuccess: (data, id) => {
      setTestResults((prev) => ({
        ...prev,
        [id]: { ok: data.ok, message: data.ok ? `Connected as ${data.user?.displayName}` : data.error ?? "Failed" },
      }));
    },
    onError: (err, id) => {
      setTestResults((prev) => ({
        ...prev,
        [id]: { ok: false, message: err instanceof Error ? err.message : "Connection failed" },
      }));
    },
  });

  if (!selectedCompanyId) return <EmptyState icon={Unplug} message="Select a company." />;
  if (isLoading) return <PageSkeleton variant="list" />;

  return (
    <div className="space-y-6">
      {/* Integration Management */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Jira Integrations</h2>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setEditIntegration(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="h-4 w-4 mr-1" />
            Add Integration
          </Button>
        </div>

        {error && (
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : "Failed to load"}
          </p>
        )}

        {integrations && integrations.length === 0 && (
          <EmptyState
            icon={Unplug}
            message="No Jira integrations configured yet."
            action="Add Integration"
            onAction={() => {
              setEditIntegration(null);
              setDialogOpen(true);
            }}
          />
        )}

        {integrations && integrations.length > 0 && (
          <div className="rounded-md border border-border divide-y divide-border">
            {integrations.map((integration) => (
              <div
                key={integration.id}
                className="flex items-center gap-3 px-4 py-3 hover:bg-accent/30 transition-colors"
              >
                <Unplug className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{integration.name}</span>
                    <Badge variant="outline" className="text-[10px] font-normal shrink-0">
                      {integration.hostUrl}
                    </Badge>
                    {!integration.enabled && (
                      <Badge variant="secondary" className="text-[10px] font-normal shrink-0">
                        disabled
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {integration.usernameOrEmail}
                    {integration.lastSyncAt && (
                      <> &middot; Last sync: {new Date(integration.lastSyncAt).toLocaleDateString()}</>
                    )}
                  </p>
                  {testResults[integration.id] && (
                    <p
                      className={`text-xs mt-0.5 ${testResults[integration.id].ok ? "text-green-500" : "text-destructive"}`}
                    >
                      {testResults[integration.id].ok ? <CheckCircle className="h-3 w-3 inline mr-1" /> : null}
                      {testResults[integration.id].message}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title="Test Connection"
                    disabled={testMutation.isPending}
                    onClick={() => testMutation.mutate(integration.id)}
                  >
                    <span className="text-xs">Test</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title={integration.enabled ? "Disable" : "Enable"}
                    onClick={() =>
                      toggleMutation.mutate({ id: integration.id, enabled: !integration.enabled })
                    }
                  >
                    <span
                      className={`text-xs ${integration.enabled ? "text-green-500" : "text-muted-foreground"}`}
                    >
                      {integration.enabled ? "ON" : "OFF"}
                    </span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => {
                      setEditIntegration(integration);
                      setDialogOpen(true);
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => setDeleteIntegration(integration)}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Import Wizard */}
      {integrations && integrations.length > 0 && (
        <div className="border-t border-border pt-6">
          <ImportWizard integrations={integrations} companyId={selectedCompanyId} />
        </div>
      )}

      <JiraIntegrationDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        companyId={selectedCompanyId}
        editIntegration={editIntegration}
      />

      <DeleteConfirmDialog
        open={!!deleteIntegration}
        onOpenChange={(open) => {
          if (!open) setDeleteIntegration(null);
        }}
        integration={deleteIntegration}
        companyId={selectedCompanyId}
      />
    </div>
  );
}
