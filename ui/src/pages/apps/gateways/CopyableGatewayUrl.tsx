import { useTranslation } from "@/i18n";
import { Copy } from "lucide-react";
import { useToast } from "@/context/ToastContext";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

export function gatewayEndpointUrl(endpointPath: string): string {
  if (typeof window === "undefined") return endpointPath;
  try {
    return new URL(endpointPath, window.location.origin).toString();
  } catch {
    return endpointPath;
  }
}

export function CopyableGatewayUrl({
  endpointPath,
  className,
}: {
  endpointPath: string;
  className?: string;
}) {
  const { t } = useTranslation("connections");
  const { pushToast } = useToast();
  const url = gatewayEndpointUrl(endpointPath);

  async function copy() {
    try {
      await copyTextToClipboard(url);
      pushToast({ title: t("gateway_url_copied_a9f3e55"), tone: "success" });
    } catch {
      pushToast({
        title: t("copy_failed_bd5acbf"),
        body: t("clipboard_access_is_unavailable_0d01be9"),
        tone: "error",
      });
    }
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        void copy();
      }}
      className={cn(
        "flex min-w-0 max-w-full items-center gap-1 text-left font-mono text-xs text-muted-foreground hover:text-foreground",
        className,
      )}
      title={t("click_to_copy_b88d72c", { url: url })}
      aria-label={t("copy_gateway_url_063c4b6")}
    >
      <span className="min-w-0 truncate">{url}</span>
      <Copy className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    </button>
  );
}
