import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { projectsApi } from "@/api/projects";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export function ProjectGitAuthorization({ project }: { project: Project }) {
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
    <section aria-label="Background GitHub authorization" className="flex flex-col gap-3 py-4">
      <h3 className="text-sm font-medium">Background GitHub authorization</h3>
      <p className="text-sm text-muted-foreground">
        Allow this project’s workspace provider to use your GitHub Connector for repository provisioning and maintenance
        until revoked. This shares the Connector credential with the provider using its existing GitHub permissions.
        Project repository editors can add repositories covered by this connection. Manage repository access in the GitHub connection.
        Task runs continue to use their own identity.
      </p>
      {data?.grantId && (
        <p role="status" className="text-sm">
          Authorized:{" "}
          {data.options.find((option) => option.grantId === data.grantId)?.login ??
            "selected grant (unavailable or owned by another member)"}
        </p>
      )}
      {data && (
        <div className="flex flex-wrap gap-2">
          <Select value={selected} onValueChange={setSelected} disabled={save.isPending}>
            <SelectTrigger aria-label="Your GitHub authorization">
              <SelectValue placeholder="Select your GitHub account" />
            </SelectTrigger>
            <SelectContent>
              {data.options.map((option) => (
                <SelectItem key={option.grantId} value={option.grantId}>
                  {option.login} · {option.connectionName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button disabled={!selected || save.isPending} onClick={() => save.mutate(selected)}>
            Authorize project
          </Button>
          {data.grantId && (
            <Button variant="outline" disabled={save.isPending} onClick={() => save.mutate(null)}>
              Revoke authorization
            </Button>
          )}
        </div>
      )}
      {data && !data.options.length && (
        <p className="text-sm text-muted-foreground">
          Connect your GitHub account and install the Connector for this company to authorize it.
        </p>
      )}
      {(authorization.error || save.error) && (
        <p role="alert" className="text-sm text-destructive">
          {(authorization.error || save.error)?.message}
        </p>
      )}
    </section>
  );
}
