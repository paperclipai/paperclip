import { t, useTranslation } from "@/i18n";
import { GitBranch, LoaderCircle } from 'lucide-react';
import { SearchableSelect, type SearchableSelectGroup, type SearchableSelectOption } from '@/components/SearchableSelect';
import { Button } from '@/components/ui/button';

export interface RepositoryBranch {
  name: string;
  isDefault?: boolean;
}

interface BranchOption extends SearchableSelectOption {
  isDefault?: boolean;
  entered?: boolean;
}

export function RepositoryBranchSelect({ value, branches, loading, error, disabled, onChange, onRetry }: {
  value: string;
  branches: readonly RepositoryBranch[];
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
  onChange: (branch: string) => void;
  onRetry?: () => void;
}) {
  useTranslation();
  const uniqueBranches = [...new Map(branches.map(branch => [branch.name, branch])).values()];
  const options: BranchOption[] = uniqueBranches.map(branch => ({ key: branch.name, value: branch.name, label: branch.name, searchText: branch.isDefault ? t("oct19Core.coverage066") : undefined, isDefault: branch.isDefault }));
  if (value && !options.some(option => option.value === value)) options.push({ key: value, value, label: value });
  const groups: SearchableSelectGroup<string, BranchOption>[] = [
    { id: 'default', label: t("oct19Core.coverage066"), options: options.filter(option => option.isDefault) },
    { id: 'branches', label: t("oct19Core.coverage067"), options: options.filter(option => !option.isDefault) },
  ];
  return <div className="flex min-w-0 flex-col gap-2">
    <SearchableSelect<string, BranchOption>
      value={value} groups={groups} disabled={disabled} triggerAriaLabel={t("oct19Core.coverage068")} mobileTitle={t("oct19Core.coverage069")}
      placeholder={t("oct19Core.coverage069")} searchPlaceholder={t("oct19Core.coverage070")}
      emptyMessage={loading ? t("oct19Core.coverage071") : t("oct19Core.coverage072")}
      onValueChange={branch => onChange(branch)}
      deriveGroups={(query, current) => {
        const name = query.trim();
        return name && !options.some(option => option.value === name)
          ? [...current, { id: 'entered', options: [{ key: `entered:${name}`, value: name, label: name, entered: true }] }]
          : current;
      }}
      renderOption={option => <>
        <GitBranch className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate" title={option.value}>{option.entered ? t("oct19Core.useBranch", { branch: option.value }) : option.label}</span>
        {option.isDefault && <span className="text-xs text-muted-foreground">{t("oct19Core.coverage073")}</span>}
      </>}
    />
    {loading && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />{t("oct19Core.coverage074")}</p>}
    {error && <div className="flex flex-wrap items-center gap-2"><p role="alert" className="text-sm text-destructive">{error} {t("oct19Core.coverage075")}</p>
      {onRetry && <Button type="button" size="sm" variant="ghost" disabled={loading || disabled} onClick={onRetry}>{t("oct19Core.tryAgain")}</Button>}
    </div>}
  </div>;
}
