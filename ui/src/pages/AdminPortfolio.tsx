import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Briefcase, Pencil, Plus, Trash2, Eye, EyeOff } from "lucide-react";
import type { PortfolioItem } from "@paperclipai/shared";
import { portfolioApi } from "@/api/portfolio";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

type FormState = {
  title: string;
  description: string;
  imageUrl: string;
  category: string;
  tags: string;
  clientName: string;
  projectUrl: string;
  startDate: string;
  endDate: string;
  sortOrder: number;
  isPublished: boolean;
};

const emptyForm: FormState = {
  title: "",
  description: "",
  imageUrl: "",
  category: "",
  tags: "",
  clientName: "",
  projectUrl: "",
  startDate: "",
  endDate: "",
  sortOrder: 0,
  isPublished: false,
};

export function AdminPortfolio() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Portfolio" },
    ]);
  }, [setBreadcrumbs]);

  const portfolioQuery = useQuery({
    queryKey: queryKeys.portfolio.list(selectedCompanyId ?? ""),
    queryFn: () => portfolioApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  function resetForm(item?: PortfolioItem) {
    if (item) {
      setForm({
        title: item.title,
        description: item.description ?? "",
        imageUrl: item.imageUrl ?? "",
        category: item.category ?? "",
        tags: (item.tags ?? []).join(", "),
        clientName: item.clientName ?? "",
        projectUrl: item.projectUrl ?? "",
        startDate: item.startDate ? item.startDate.slice(0, 10) : "",
        endDate: item.endDate ? item.endDate.slice(0, 10) : "",
        sortOrder: item.sortOrder,
        isPublished: item.isPublished,
      });
      setEditingId(item.id);
    } else {
      setForm(emptyForm);
      setEditingId(null);
    }
    setShowForm(true);
  }

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.portfolio.list(selectedCompanyId!) });

  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => portfolioApi.create(selectedCompanyId!, data as never),
    onSuccess: () => {
      invalidate();
      setShowForm(false);
      pushToast({ title: "Portfolio item created", tone: "success" });
    },
    onError: (err) => pushToast({ title: err instanceof Error ? err.message : "Failed to create", tone: "error" }),
  });

  const updateMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => portfolioApi.update(selectedCompanyId!, editingId!, data as never),
    onSuccess: () => {
      invalidate();
      setShowForm(false);
      pushToast({ title: "Portfolio item updated", tone: "success" });
    },
    onError: (err) => pushToast({ title: err instanceof Error ? err.message : "Failed to update", tone: "error" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => portfolioApi.remove(selectedCompanyId!, id),
    onSuccess: () => {
      invalidate();
      pushToast({ title: "Portfolio item deleted", tone: "success" });
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const data: Record<string, unknown> = {
      title: form.title,
      description: form.description || null,
      imageUrl: form.imageUrl || null,
      category: form.category || null,
      tags: form.tags ? form.tags.split(",").map((t) => t.trim()).filter(Boolean) : null,
      clientName: form.clientName || null,
      projectUrl: form.projectUrl || null,
      startDate: form.startDate || null,
      endDate: form.endDate || null,
      sortOrder: form.sortOrder,
      isPublished: form.isPublished,
    };
    if (editingId) {
      updateMutation.mutate(data);
    } else {
      createMutation.mutate(data);
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending;

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">Select a company to manage portfolio items.</div>;
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Briefcase className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Portfolio</h1>
        </div>
        <Button size="sm" onClick={() => resetForm()} disabled={showForm && !editingId}>
          <Plus className="mr-1.5 h-4 w-4" />
          New Item
        </Button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="space-y-4 rounded-xl border border-border bg-card p-5">
          <h2 className="text-sm font-semibold">{editingId ? "Edit Portfolio Item" : "New Portfolio Item"}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Title *</span>
              <input className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Client Name</span>
              <input className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none" value={form.clientName} onChange={(e) => setForm({ ...form, clientName: e.target.value })} />
            </label>
            <label className="space-y-1.5 text-sm sm:col-span-2">
              <span className="font-medium">Description</span>
              <textarea className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Category</span>
              <input className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Tags (comma separated)</span>
              <input className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Image URL</span>
              <input className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none" value={form.imageUrl} onChange={(e) => setForm({ ...form, imageUrl: e.target.value })} />
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Project URL</span>
              <input className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none" value={form.projectUrl} onChange={(e) => setForm({ ...form, projectUrl: e.target.value })} />
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Start Date</span>
              <input type="date" className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">End Date</span>
              <input type="date" className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Sort Order</span>
              <input type="number" className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) })} />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="rounded border-border" checked={form.isPublished} onChange={(e) => setForm({ ...form, isPublished: e.target.checked })} />
              <span className="font-medium">Published</span>
            </label>
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={isPending || !form.title.trim()}>
              {isPending ? "Saving..." : editingId ? "Update" : "Create"}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {portfolioQuery.isLoading && (
        <div className="text-sm text-muted-foreground">Loading portfolio items...</div>
      )}

      {portfolioQuery.error && (
        <div className="text-sm text-destructive">
          {portfolioQuery.error instanceof ApiError ? portfolioQuery.error.message : "Failed to load portfolio items"}
        </div>
      )}

      {portfolioQuery.data && portfolioQuery.data.length === 0 && !showForm && (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No portfolio items yet. Click "New Item" to add one.
        </div>
      )}

      {portfolioQuery.data && portfolioQuery.data.length > 0 && (
        <div className="space-y-3">
          {portfolioQuery.data.map((item) => (
            <div key={item.id} className="flex items-start justify-between gap-4 rounded-xl border border-border bg-card p-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{item.title}</span>
                  {item.isPublished ? (
                    <Eye className="h-3.5 w-3.5 text-green-600" />
                  ) : (
                    <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </div>
                {item.clientName && <div className="text-sm text-muted-foreground">{item.clientName}</div>}
                {item.category && <div className="mt-1 text-xs text-muted-foreground">{item.category}</div>}
                {item.tags && item.tags.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {item.tags.map((tag) => (
                      <span key={tag} className="rounded-md bg-muted px-2 py-0.5 text-xs">{tag}</span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => resetForm(item)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { if (window.confirm("Delete this portfolio item?")) deleteMutation.mutate(item.id); }}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
