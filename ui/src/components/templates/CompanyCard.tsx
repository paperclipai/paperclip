import { Button } from "@/components/ui/button";
import type { TemplateCompany } from "@paperclipai/shared";

interface Props {
  company: TemplateCompany;
  onInstall: (slug: string) => void;
  installing: boolean;
  disabled?: boolean;
}

export function CompanyCard({ company, onInstall, installing, disabled = false }: Props) {
  return (
    <div className="rounded-lg border p-4 flex flex-col gap-3">
      <div>
        <h3 className="text-lg font-semibold">{company.name}</h3>
        <p className="text-sm text-muted-foreground">{company.description}</p>
      </div>
      <div className="text-sm text-muted-foreground">
        {company.agents_count} agents · {company.skills_count} skills
      </div>
      {company.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {company.tags.map((tag) => (
            <span key={tag} className="text-xs px-2 py-0.5 rounded bg-secondary">
              {tag}
            </span>
          ))}
        </div>
      )}
      <Button
        onClick={() => onInstall(company.slug)}
        disabled={installing || disabled}
        className="mt-auto"
      >
        {installing ? "Installing…" : "Install"}
      </Button>
    </div>
  );
}
