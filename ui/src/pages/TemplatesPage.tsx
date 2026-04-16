import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { templatesApi } from "../api/templates";
import { CompanyCard } from "../components/templates/CompanyCard";

export function TemplatesPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["templates", "companies"],
    queryFn: () => templatesApi.list(),
  });

  const install = useMutation({
    mutationFn: (slug: string) => templatesApi.install({ slug }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["companies"] });
      navigate(`/${result.companyId}/dashboard`);
    },
  });

  if (isLoading) return <div className="p-6">Loading templates…</div>;
  if (error) return <div className="p-6 text-destructive">Failed to load templates.</div>;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold mb-2">Template Gallery</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Curated companies from paperclipai/companies. One click to install.
      </p>
      {install.isError && (
        <div className="mb-4 p-3 rounded border border-destructive text-destructive text-sm">
          Install failed: {(install.error as Error).message}
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {data?.companies.map((company) => (
          <CompanyCard
            key={company.slug}
            company={company}
            onInstall={(slug) => install.mutate(slug)}
            installing={install.isPending && install.variables === company.slug}
          />
        ))}
      </div>
    </div>
  );
}
