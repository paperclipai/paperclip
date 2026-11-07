import { useTranslation, t as translate } from "@/i18n";
import { Button } from "@/components/ui/button";
import { useNavigate } from "@/lib/router";
import { QueryErrorState, type QueryViewSize, type QueryViewState } from "@/components/QueryView";

export function AppReadError({ failure, onRetry, action = translate("connections:load_tools_for_this_app_1bf1cb0"), size = "panel" }: {
  failure: QueryViewState<unknown>;
  onRetry?: () => void;
  action?: string;
  size?: QueryViewSize;
}) {
  useTranslation("connections");
  return <div className={size === "page" ? undefined : "py-8"}>
    <QueryErrorState size={size} error={failure.error} action={action}
      onRetry={() => { failure.retry(); onRetry?.(); }} retrying={failure.isFetching} />
  </div>;
}

export function AppNotFound() {
  const { t } = useTranslation("connections");
  const navigate = useNavigate();
  return <div className="max-w-3xl p-6">
    <p className="text-sm text-muted-foreground">{t("we_couldn_t_find_that_app_54c28af")}</p>
    <Button className="mt-4" variant="outline" onClick={() => navigate("/apps")}>{t("back_to_connectors_8934af7")}</Button>
  </div>;
}
