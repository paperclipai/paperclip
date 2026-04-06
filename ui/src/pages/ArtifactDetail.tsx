import { useEffect, useState } from "react";
import { useParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { artifactsApi, type Artifact } from "../api/artifacts";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  FileText,
  Image,
  Link as LinkIcon,
  Package,
  ExternalLink,
  Save,
  ArrowLeft,
  Trash2,
} from "lucide-react";
import { useNavigate } from "@/lib/router";

const kindIcons: Record<string, typeof FileText> = {
  attachment: FileText,
  image: Image,
  link: LinkIcon,
  package: Package,
};

const KIND_OPTIONS = ["attachment", "image", "link", "package"] as const;
const STATUS_OPTIONS = ["active", "inactive"] as const;

function formatBytes(bytes: number | null): string {
  if (bytes == null || bytes === 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function InputField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-muted-foreground mb-1">{label}</label>
      {children}
    </div>
  );
}

const inputClass = "w-full rounded-[2px] border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

export function ArtifactDetail() {
  const { artifactId } = useParams<{ artifactId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: artifact, isLoading, error } = useQuery({
    queryKey: queryKeys.artifacts.detail(selectedCompanyId!, artifactId!),
    queryFn: () => artifactsApi.get(selectedCompanyId!, artifactId!),
    enabled: !!selectedCompanyId && !!artifactId,
  });

  const [form, setForm] = useState<{
    title: string;
    kind: string;
    description: string;
    url: string;
    filePath: string;
    mimeType: string;
    sizeBytes: string;
    previewUrl: string;
    status: string;
    metadata: string;
  } | null>(null);

  useEffect(() => {
    if (artifact && !form) {
      setForm({
        title: artifact.title,
        kind: artifact.kind,
        description: artifact.description ?? "",
        url: artifact.url ?? "",
        filePath: artifact.filePath ?? "",
        mimeType: artifact.mimeType ?? "",
        sizeBytes: artifact.sizeBytes != null ? String(artifact.sizeBytes) : "",
        previewUrl: artifact.previewUrl ?? "",
        status: artifact.status,
        metadata: JSON.stringify(artifact.metadata ?? {}, null, 2),
      });
    }
  }, [artifact, form]);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Artifacts", href: "/artifacts" },
      { label: artifact?.title ?? "Detail" },
    ]);
  }, [setBreadcrumbs, artifact?.title]);

  const updateMutation = useMutation({
    mutationFn: (data: Parameters<typeof artifactsApi.update>[2]) =>
      artifactsApi.update(selectedCompanyId!, artifactId!, data),
    onSuccess: (updated) => {
      pushToast({ title: "Artifact updated", tone: "success" });
      queryClient.invalidateQueries({ queryKey: queryKeys.artifacts.list(selectedCompanyId!) });
      queryClient.setQueryData(queryKeys.artifacts.detail(selectedCompanyId!, artifactId!), updated);
      // Reset form to reflect saved state
      setForm(null);
    },
    onError: (err) => {
      pushToast({ title: "Failed to update artifact", body: err.message, tone: "error" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => artifactsApi.remove(selectedCompanyId!, artifactId!),
    onSuccess: () => {
      pushToast({ title: "Artifact deleted", tone: "success" });
      queryClient.invalidateQueries({ queryKey: queryKeys.artifacts.list(selectedCompanyId!) });
      navigate("/artifacts");
    },
    onError: (err) => {
      pushToast({ title: "Failed to delete artifact", body: err.message, tone: "error" });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={FileText} message="Select a company to view artifacts." />;
  }
  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive p-4">{error.message}</p>;
  if (!artifact || !form) return <EmptyState icon={FileText} message="Artifact not found." />;

  const Icon = kindIcons[form.kind] ?? FileText;
  const hasChanges =
    form.title !== artifact.title ||
    form.kind !== artifact.kind ||
    form.description !== (artifact.description ?? "") ||
    form.url !== (artifact.url ?? "") ||
    form.filePath !== (artifact.filePath ?? "") ||
    form.mimeType !== (artifact.mimeType ?? "") ||
    form.sizeBytes !== (artifact.sizeBytes != null ? String(artifact.sizeBytes) : "") ||
    form.previewUrl !== (artifact.previewUrl ?? "") ||
    form.status !== artifact.status ||
    form.metadata !== JSON.stringify(artifact.metadata ?? {}, null, 2);

  function handleSave() {
    if (!form) return;
    let parsedMetadata: Record<string, unknown> = {};
    try {
      parsedMetadata = form.metadata.trim() ? JSON.parse(form.metadata) : {};
    } catch {
      pushToast({ title: "Invalid JSON in metadata field", tone: "error" });
      return;
    }

    updateMutation.mutate({
      title: form.title,
      kind: form.kind,
      description: form.description || null,
      url: form.url || null,
      filePath: form.filePath || null,
      mimeType: form.mimeType || null,
      sizeBytes: form.sizeBytes ? Number(form.sizeBytes) : null,
      previewUrl: form.previewUrl || null,
      status: form.status,
      metadata: parsedMetadata,
    });
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" onClick={() => navigate("/artifacts")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className={cn("flex items-center justify-center h-10 w-10 rounded-[2px] shrink-0",
          form.kind === "image" ? "bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400" :
          form.kind === "link" ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400" :
          form.kind === "package" ? "bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400" :
          "bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400"
        )}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-semibold truncate font-[var(--font-display)] uppercase tracking-[0.06em]">{artifact.title}</h1>
          <p className="text-xs text-muted-foreground">
            Created {new Date(artifact.createdAt).toLocaleString()}
            {artifact.updatedAt !== artifact.createdAt && (
              <> · Updated {new Date(artifact.updatedAt).toLocaleString()}</>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {artifact.url && (
            <Button variant="outline" size="sm" asChild>
              <a href={artifact.url} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" /> Open
              </a>
            </Button>
          )}
          <Button
            variant="destructive"
            size="sm"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
          >
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            {deleteMutation.isPending ? "Deleting..." : "Delete"}
          </Button>
        </div>
      </div>

      {/* Edit form */}
      <div className="rounded-[2px] border border-border bg-card p-5 space-y-4 hud-panel hud-shimmer">
        <h2 className="text-sm font-semibold hud-section-header font-[var(--font-display)] uppercase tracking-[0.06em]">Details</h2>

        <div className="grid grid-cols-2 gap-4">
          <InputField label="Title *">
            <input
              className={inputClass}
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              required
            />
          </InputField>

          <InputField label="Kind">
            <select
              className={inputClass}
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value })}
            >
              {KIND_OPTIONS.map((k) => (
                <option key={k} value={k}>{k.charAt(0).toUpperCase() + k.slice(1)}</option>
              ))}
            </select>
          </InputField>

          <InputField label="Status">
            <select
              className={inputClass}
              value={form.status}
              onChange={(e) => setForm({ ...form, status: e.target.value })}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
              ))}
            </select>
          </InputField>

          <InputField label="MIME Type">
            <input
              className={inputClass}
              value={form.mimeType}
              onChange={(e) => setForm({ ...form, mimeType: e.target.value })}
              placeholder="e.g. application/pdf"
            />
          </InputField>
        </div>

        <InputField label="Description">
          <textarea
            className={cn(inputClass, "min-h-[60px] resize-y")}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="Optional description"
            rows={2}
          />
        </InputField>

        <div className="grid grid-cols-2 gap-4">
          <InputField label="URL">
            <input
              className={inputClass}
              type="url"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="https://..."
            />
          </InputField>

          <InputField label="File Path">
            <input
              className={inputClass}
              value={form.filePath}
              onChange={(e) => setForm({ ...form, filePath: e.target.value })}
              placeholder="/path/to/file"
            />
          </InputField>

          <InputField label="Preview URL">
            <input
              className={inputClass}
              type="url"
              value={form.previewUrl}
              onChange={(e) => setForm({ ...form, previewUrl: e.target.value })}
              placeholder="https://preview..."
            />
          </InputField>

          <InputField label="Size (bytes)">
            <input
              className={inputClass}
              type="number"
              value={form.sizeBytes}
              onChange={(e) => setForm({ ...form, sizeBytes: e.target.value })}
              placeholder="0"
              min={0}
            />
          </InputField>
        </div>

        <InputField label="Metadata (JSON)">
          <textarea
            className={cn(inputClass, "font-mono text-xs min-h-[80px] resize-y")}
            value={form.metadata}
            onChange={(e) => setForm({ ...form, metadata: e.target.value })}
            rows={3}
          />
        </InputField>

        {/* Preview image if kind=image and previewUrl/url set */}
        {form.kind === "image" && (form.previewUrl || form.url) && (
          <div className="rounded-[2px] border border-border overflow-hidden bg-muted/30">
            <img
              src={form.previewUrl || form.url}
              alt={form.title}
              className="max-h-48 object-contain mx-auto"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          </div>
        )}

        {/* Size display */}
        {form.sizeBytes && Number(form.sizeBytes) > 0 && (
          <p className="text-xs text-muted-foreground">
            File size: {formatBytes(Number(form.sizeBytes))}
          </p>
        )}

        <div className="flex items-center gap-2 pt-2">
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!hasChanges || updateMutation.isPending || !form.title}
          >
            <Save className="h-3.5 w-3.5 mr-1.5" />
            {updateMutation.isPending ? "Saving..." : "Save Changes"}
          </Button>
          {hasChanges && (
            <Button size="sm" variant="outline" onClick={() => setForm(null)}>
              Reset
            </Button>
          )}
          {!hasChanges && (
            <span className="text-xs text-muted-foreground">No unsaved changes</span>
          )}
        </div>
      </div>

      {/* Metadata preview (read-only) */}
      {artifact.runId && (
        <div className="rounded-[2px] border border-border bg-card p-5 hud-panel hud-shimmer">
          <h2 className="text-sm font-semibold mb-2 hud-section-header font-[var(--font-display)] uppercase tracking-[0.06em]">Linked Run</h2>
          <p className="text-xs text-muted-foreground font-[var(--font-mono)]">{artifact.runId}</p>
        </div>
      )}
      {artifact.issueId && (
        <div className="rounded-[2px] border border-border bg-card p-5 hud-panel hud-shimmer">
          <h2 className="text-sm font-semibold mb-2 hud-section-header font-[var(--font-display)] uppercase tracking-[0.06em]">Linked Issue</h2>
          <p className="text-xs text-muted-foreground font-[var(--font-mono)]">{artifact.issueId}</p>
        </div>
      )}
    </div>
  );
}
