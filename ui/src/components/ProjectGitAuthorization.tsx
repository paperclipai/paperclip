import { t, useTranslation, Trans } from "@/i18n";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { projectsApi } from "@/api/projects";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export function ProjectGitAuthorization({ project }: { project: Project }) {
  useTranslation("task-components");
  const client = useQueryClient();
  const key = ["project-git-authorization", project.companyId, project.id];
  const authorization = useQuery({
    queryKey: key,
    queryFn: () => projectsApi.gitAuthorization(project.id),
  });
  const [selected, setSelected] = useState<string>("");
  const save = useMutation({
    mutationFn: (grantId: string | null) => projectsApi.setGitAuthorization(project.id, grantId),
    onSuccess: (data) => {
      client.setQueryData(key, data);
      setSelected("");
    },
  });
  const data = authorization.data;
  return (
    <section aria-label={t("task-components:backgroundGithubAuthorization_6ac61feb")} className="flex flex-col gap-3 py-4">
      <h3 className="text-sm font-medium">{t("task-components:backgroundGithubAuthorization_6ac61feb")}</h3>
      <p className="text-sm text-muted-foreground">{t("task-components:allowThisProjectSWorkspaceProviderTo_de40d6c9")}</p>
      {data?.grantId && (
        <p role="status" className="text-sm"><Trans ns="task-components" i18nKey="sentence_aa735e3762fa" components={{ part1: <>{data.options.find((option) => option.grantId === data.grantId)?.login ??
            t("deep-ui:selected_grant_unavailable_or_owned_by_another_member_f1a68b")}</> }} /></p>
      )}
      {data && (
        <div className="flex flex-wrap gap-2">
          <Select value={selected} onValueChange={setSelected} disabled={save.isPending}>
            <SelectTrigger aria-label={t("deep-ui:your_github_authorization_5f7ee3")}>
              <SelectValue placeholder={t("deep-ui:select_your_github_account_050221")} />
            </SelectTrigger>
            <SelectContent>
              {data.options.map((option) => (
                <SelectItem key={option.grantId} value={option.grantId}>
                  {option.login} · {option.connectionName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button disabled={!selected || save.isPending} onClick={() => save.mutate(selected)}>{t("task-components:authorizeProject_af3b7f80")}</Button>
          {data.grantId && (
            <Button variant="outline" disabled={save.isPending} onClick={() => save.mutate(null)}>{t("task-components:revokeAuthorization_4205f490")}</Button>
          )}
        </div>
      )}
      {data && !data.options.length && (
        <p className="text-sm text-muted-foreground">{t("task-components:sentence_8016048927d0")}</p>
      )}
      {(authorization.error || save.error) && (
        <p role="alert" className="text-sm text-destructive">
          {(authorization.error || save.error)?.message}
        </p>
      )}
    </section>
  );
}
