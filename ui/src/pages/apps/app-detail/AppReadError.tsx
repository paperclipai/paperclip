import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useNavigate } from "@/lib/router";
import { QueryErrorState, type QueryViewSize, type QueryViewState } from "@/components/QueryView";

export function AppReadError({ failure, onRetry, action, size = "panel" }: {
  failure: QueryViewState<unknown>;
  onRetry?: () => void;
  action?: string;
  size?: QueryViewSize;
}) {
  const { t } = useTranslation();
  return <div className={size === "page" ? undefined : "py-8"}>
    <QueryErrorState size={size} error={failure.error} action={action || t("apps.readError.loadToolsAction")}
      onRetry={() => { failure.retry(); onRetry?.(); }} retrying={failure.isFetching} />
  </div>;
}

export function AppNotFound() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return <div className="max-w-3xl p-6">
    <p className="text-sm text-muted-foreground">{t("apps.readError.notFound")}</p>
    <Button className="mt-4" variant="outline" onClick={() => navigate("/apps")}>{t("apps.readError.backToConnectors")}</Button>
  </div>;
}
