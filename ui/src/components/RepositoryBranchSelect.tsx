import { t, useTranslation, Trans } from "@/i18n";
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
  useTranslation("task-components");
  const uniqueBranches = [...new Map(branches.map(branch => [branch.name, branch])).values()];
  const options: BranchOption[] = uniqueBranches.map(branch => ({ key: branch.name, value: branch.name, label: branch.name, searchText: branch.isDefault ? 'default branch' : undefined, isDefault: branch.isDefault }));
  if (value && !options.some(option => option.value === value)) options.push({ key: value, value, label: value });
  const groups: SearchableSelectGroup<string, BranchOption>[] = [
    { id: 'default', label: t("task-components:defaultBranch_411aa61a"), options: options.filter(option => option.isDefault) },
    { id: 'branches', label: t("task-components:branches_2eee037c"), options: options.filter(option => !option.isDefault) },
  ];
  return <div className="flex min-w-0 flex-col gap-2">
    <SearchableSelect<string, BranchOption>
      value={value} groups={groups} disabled={disabled} triggerAriaLabel={t("final-components-b:RepositoryBranchSelect.Branch_52656e")} mobileTitle={t("final-components-b:RepositoryBranchSelect.Choose_a_branch_16a1b6")}
      placeholder={t("task-components:chooseABranch_16a1b6e2")} searchPlaceholder={t("final-components-b:RepositoryBranchSelect.Search_or_enter_a_branch_name_d17b9d")}
      emptyMessage={loading ? t("task-components:branchesAreLoadingYouCanStillEnter_0f26f9d9") : t("task-components:noMatchingBranchesEnterABranchName_b68a244f")}
      onValueChange={branch => onChange(branch)}
      deriveGroups={(query, current) => {
        const name = query.trim();
        return name && !options.some(option => option.value === name)
          ? [...current, { id: 'entered', options: [{ key: `entered:${name}`, value: name, label: name, entered: true }] }]
          : current;
      }}
      renderOption={option => <>
        <GitBranch className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate" title={option.value}>{option.entered ? t("task-components:use_895d5c96", { value1: option.value }) : option.label}</span>
        {option.isDefault && <span className="text-xs text-muted-foreground">{t("task-components:default_21b111cb")}</span>}
      </>}
    />
    {loading && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" />{t("task-components:loadingBranches_55704e8f")}</p>}
    {error && <div className="flex flex-wrap items-center gap-2"><p role="alert" className="text-sm text-destructive"><Trans ns="task-components" i18nKey="sentence_a050efd01951" components={{ part1: <>{error}</> }} /></p>
      {onRetry && <Button type="button" size="sm" variant="ghost" disabled={loading || disabled} onClick={onRetry}>{t("task-components:tryAgain_d8b8392e")}</Button>}
    </div>}
  </div>;
}
