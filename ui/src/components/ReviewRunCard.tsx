import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { ReviewCheckItem } from "./ReviewCheckItem";
import type { ReviewRun } from "../api/reviewPipeline";

interface ReviewRunCardProps {
  run: ReviewRun;
  prTitle?: string;
  prUrl?: string;
  onApprove?: () => void;
  onReject?: () => void;
  isApproving?: boolean;
}

export function ReviewRunCard({ run, prTitle, prUrl, onApprove, onReject, isApproving }: ReviewRunCardProps) {
  const passedCount = run.checks.filter((c) => c.status === "passed").length;
  const totalCount = run.checks.length;
  const allDone = run.checks.every((c) => ["passed", "failed", "skipped"].includes(c.status));
  const statusColor =
    run.status === "passed"
      ? "text-green-600"
      : run.status === "failed"
        ? "text-red-600"
        : "text-blue-600";

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">
            {prTitle && <span>{prTitle}</span>}
          </CardTitle>
          {prUrl && (
            <a
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-500 hover:underline"
            >
              GitHub에서 보기 ↗
            </a>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline" className={statusColor}>{run.status}</Badge>
          <span>{passedCount}/{totalCount} 통과</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-1">
        {run.checks.map((check) => (
          <ReviewCheckItem key={check.id} check={check} />
        ))}
        {allDone && (
          <div className="flex gap-2 pt-3 border-t">
            <Button size="sm" onClick={onApprove} disabled={isApproving}>
              승인 + 머지
            </Button>
            <Button size="sm" variant="outline" onClick={onReject} disabled={isApproving}>
              반려
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
