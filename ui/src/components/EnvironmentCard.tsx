import { Card, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Pencil, Trash2 } from "lucide-react";
import type { ProjectEnvironment } from "../api/projectEnvironments";

export function EnvironmentCard({ env, onEdit, onDelete }: { env: ProjectEnvironment; onEdit: () => void; onDelete: () => void }) {
  const gh = env.config.github;
  const merge = env.config.merge;

  return (
    <Card>
      <CardContent className="flex items-start justify-between p-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{env.name}</span>
            {env.isDefault && <Badge variant="secondary">default</Badge>}
          </div>
          {gh && <p className="text-sm text-muted-foreground">GitHub: {gh.owner}/{gh.repo} · Branch: {gh.baseBranch}</p>}
          {env.config.deploy?.url && <p className="text-sm text-muted-foreground">Deploy: {env.config.deploy.url}</p>}
          {merge && <p className="text-xs text-muted-foreground">Merge: {merge.method ?? "squash"}{merge.deleteSourceBranch ? ", 소스 브랜치 삭제" : ""}</p>}
        </div>
        <div className="flex gap-1">
          <Button variant="ghost" size="icon" onClick={onEdit}><Pencil className="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" onClick={onDelete}><Trash2 className="h-4 w-4" /></Button>
        </div>
      </CardContent>
    </Card>
  );
}
