import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquareQuote, Pencil, Plus, Trash2, Star, Eye, EyeOff } from "lucide-react";
import type { Testimonial } from "@paperclipai/shared";
import { testimonialsApi } from "@/api/testimonials";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";

type FormState = {
  authorName: string;
  authorRole: string;
  authorAvatarUrl: string;
  content: string;
  rating: number;
  sortOrder: number;
  isPublished: boolean;
};

const emptyForm: FormState = {
  authorName: "",
  authorRole: "",
  authorAvatarUrl: "",
  content: "",
  rating: 0,
  sortOrder: 0,
  isPublished: false,
};

export function AdminTestimonials() {
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
      { label: "Testimonials" },
    ]);
  }, [setBreadcrumbs]);

  const testimonialsQuery = useQuery({
    queryKey: queryKeys.testimonials.list(selectedCompanyId ?? ""),
    queryFn: () => testimonialsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  function resetForm(item?: Testimonial) {
    if (item) {
      setForm({
        authorName: item.authorName,
        authorRole: item.authorRole ?? "",
        authorAvatarUrl: item.authorAvatarUrl ?? "",
        content: item.content,
        rating: item.rating ?? 0,
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
    queryClient.invalidateQueries({ queryKey: queryKeys.testimonials.list(selectedCompanyId!) });

  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => testimonialsApi.create(selectedCompanyId!, data as never),
    onSuccess: () => {
      invalidate();
      setShowForm(false);
      pushToast({ title: "Testimonial created", tone: "success" });
    },
    onError: (err) => pushToast({ title: err instanceof Error ? err.message : "Failed to create", tone: "error" }),
  });

  const updateMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => testimonialsApi.update(selectedCompanyId!, editingId!, data as never),
    onSuccess: () => {
      invalidate();
      setShowForm(false);
      pushToast({ title: "Testimonial updated", tone: "success" });
    },
    onError: (err) => pushToast({ title: err instanceof Error ? err.message : "Failed to update", tone: "error" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => testimonialsApi.remove(selectedCompanyId!, id),
    onSuccess: () => {
      invalidate();
      pushToast({ title: "Testimonial deleted", tone: "success" });
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const data: Record<string, unknown> = {
      authorName: form.authorName,
      authorRole: form.authorRole || null,
      authorAvatarUrl: form.authorAvatarUrl || null,
      content: form.content,
      rating: form.rating > 0 ? form.rating : null,
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

  function StarRating({ rating, size = "sm" }: { rating: number; size?: "sm" | "xs" }) {
    const cls = size === "xs" ? "h-3 w-3" : "h-4 w-4";
    return (
      <span className="flex items-center gap-0.5">
        {[1, 2, 3, 4, 5].map((star) => (
          <Star key={star} className={`${cls} ${star <= rating ? "fill-amber-400 text-amber-400" : "text-muted-foreground"}`} />
        ))}
      </span>
    );
  }

  if (!selectedCompanyId) {
    return <div className="text-sm text-muted-foreground">Select a company to manage testimonials.</div>;
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <MessageSquareQuote className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Testimonials</h1>
        </div>
        <Button size="sm" onClick={() => resetForm()} disabled={showForm && !editingId}>
          <Plus className="mr-1.5 h-4 w-4" />
          New Testimonial
        </Button>
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} className="space-y-4 rounded-xl border border-border bg-card p-5">
          <h2 className="text-sm font-semibold">{editingId ? "Edit Testimonial" : "New Testimonial"}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Author Name *</span>
              <input className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none" value={form.authorName} onChange={(e) => setForm({ ...form, authorName: e.target.value })} required />
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Author Role</span>
              <input className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none" value={form.authorRole} onChange={(e) => setForm({ ...form, authorRole: e.target.value })} />
            </label>
            <label className="space-y-1.5 text-sm sm:col-span-2">
              <span className="font-medium">Content *</span>
              <textarea className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none" rows={4} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} required />
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Avatar URL</span>
              <input className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none" value={form.authorAvatarUrl} onChange={(e) => setForm({ ...form, authorAvatarUrl: e.target.value })} />
            </label>
            <label className="space-y-1.5 text-sm">
              <span className="font-medium">Rating (1-5)</span>
              <input type="number" min={0} max={5} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none" value={form.rating} onChange={(e) => setForm({ ...form, rating: Number(e.target.value) })} />
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
            <Button type="submit" size="sm" disabled={isPending || !form.authorName.trim() || !form.content.trim()}>
              {isPending ? "Saving..." : editingId ? "Update" : "Create"}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {testimonialsQuery.isLoading && (
        <div className="text-sm text-muted-foreground">Loading testimonials...</div>
      )}

      {testimonialsQuery.error && (
        <div className="text-sm text-destructive">
          {testimonialsQuery.error instanceof ApiError ? testimonialsQuery.error.message : "Failed to load testimonials"}
        </div>
      )}

      {testimonialsQuery.data && testimonialsQuery.data.length === 0 && !showForm && (
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No testimonials yet. Click "New Testimonial" to add one.
        </div>
      )}

      {testimonialsQuery.data && testimonialsQuery.data.length > 0 && (
        <div className="space-y-3">
          {testimonialsQuery.data.map((item) => (
            <div key={item.id} className="flex items-start justify-between gap-4 rounded-xl border border-border bg-card p-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{item.authorName}</span>
                  {item.isPublished ? (
                    <Eye className="h-3.5 w-3.5 text-green-600" />
                  ) : (
                    <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </div>
                {item.authorRole && <div className="text-sm text-muted-foreground">{item.authorRole}</div>}
                {item.rating && item.rating > 0 && <StarRating rating={item.rating} size="xs" />}
                <div className="mt-1 text-sm text-muted-foreground line-clamp-2">{item.content}</div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => resetForm(item)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button size="sm" variant="ghost" onClick={() => { if (window.confirm("Delete this testimonial?")) deleteMutation.mutate(item.id); }}>
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
