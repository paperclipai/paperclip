import * as p from "@clack/prompts";
import { t } from "../i18n/index.js";
import type { AuthConfig, ServerConfig } from "../config/schema.js";
import { parseHostnameCsv } from "../config/hostnames.js";

export async function promptServer(opts?: {
  currentServer?: Partial<ServerConfig>;
  currentAuth?: Partial<AuthConfig>;
}): Promise<{ server: ServerConfig; auth: AuthConfig }> {
  const currentServer = opts?.currentServer;
  const currentAuth = opts?.currentAuth;

  const deploymentModeSelection = await p.select({
    message: t("server.deployment_mode_message"),
    options: [
      {
        value: "local_trusted",
        label: t("server.local_trusted_label"),
        hint: t("server.local_trusted_hint"),
      },
      {
        value: "authenticated",
        label: t("server.authenticated_label"),
        hint: t("server.authenticated_hint"),
      },
    ],
    initialValue: currentServer?.deploymentMode ?? "local_trusted",
  });

  if (p.isCancel(deploymentModeSelection)) {
    p.cancel(t("server.setup_cancelled"));
    process.exit(0);
  }
  const deploymentMode = deploymentModeSelection as ServerConfig["deploymentMode"];

  let exposure: ServerConfig["exposure"] = "private";
  if (deploymentMode === "authenticated") {
    const exposureSelection = await p.select({
      message: t("server.exposure_message"),
      options: [
        {
          value: "private",
          label: t("server.private_label"),
          hint: t("server.private_hint"),
        },
        {
          value: "public",
          label: t("server.public_label"),
          hint: t("server.public_hint"),
        },
      ],
      initialValue: currentServer?.exposure ?? "private",
    });
    if (p.isCancel(exposureSelection)) {
      p.cancel(t("server.setup_cancelled"));
      process.exit(0);
    }
    exposure = exposureSelection as ServerConfig["exposure"];
  }

  const hostDefault = deploymentMode === "local_trusted" ? "127.0.0.1" : "0.0.0.0";
  const hostStr = await p.text({
    message: t("server.host_message"),
    defaultValue: currentServer?.host ?? hostDefault,
    placeholder: hostDefault,
    validate: (val) => {
      if (!val.trim()) return t("server.host_required");
    },
  });

  if (p.isCancel(hostStr)) {
    p.cancel(t("server.setup_cancelled"));
    process.exit(0);
  }

  const portStr = await p.text({
    message: t("server.port_message"),
    defaultValue: String(currentServer?.port ?? 3100),
    placeholder: "3100",
    validate: (val) => {
      const n = Number(val);
      if (isNaN(n) || n < 1 || n > 65535 || !Number.isInteger(n)) {
        return t("server.port_validation");
      }
    },
  });

  if (p.isCancel(portStr)) {
    p.cancel(t("server.setup_cancelled"));
    process.exit(0);
  }

  let allowedHostnames: string[] = [];
  if (deploymentMode === "authenticated" && exposure === "private") {
    const allowedHostnamesInput = await p.text({
      message: t("server.allowed_hostnames_message"),
      defaultValue: (currentServer?.allowedHostnames ?? []).join(", "),
      placeholder: t("server.allowed_hostnames_placeholder"),
      validate: (val) => {
        try {
          parseHostnameCsv(val);
          return;
        } catch (err) {
          return err instanceof Error ? err.message : t("server.allowed_hostnames_invalid");
        }
      },
    });

    if (p.isCancel(allowedHostnamesInput)) {
      p.cancel(t("server.setup_cancelled"));
      process.exit(0);
    }
    allowedHostnames = parseHostnameCsv(allowedHostnamesInput);
  }

  const port = Number(portStr) || 3100;
  let auth: AuthConfig = { baseUrlMode: "auto", disableSignUp: false };
  if (deploymentMode === "authenticated" && exposure === "public") {
    const urlInput = await p.text({
      message: t("server.public_url_message"),
      defaultValue: currentAuth?.publicBaseUrl ?? "",
      placeholder: t("server.public_url_placeholder"),
      validate: (val) => {
        const candidate = val.trim();
        if (!candidate) return t("server.public_url_required");
        try {
          const url = new URL(candidate);
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            return t("server.public_url_protocol");
          }
          return;
        } catch {
          return t("server.public_url_invalid");
        }
      },
    });
    if (p.isCancel(urlInput)) {
      p.cancel(t("server.setup_cancelled"));
      process.exit(0);
    }
    auth = {
      baseUrlMode: "explicit",
      disableSignUp: false,
      publicBaseUrl: urlInput.trim().replace(/\/+$/, ""),
    };
  } else if (currentAuth?.baseUrlMode === "explicit" && currentAuth.publicBaseUrl) {
    auth = {
      baseUrlMode: "explicit",
      disableSignUp: false,
      publicBaseUrl: currentAuth.publicBaseUrl,
    };
  }

  return {
    server: {
      deploymentMode,
      exposure,
      host: hostStr.trim(),
      port,
      allowedHostnames,
      serveUi: currentServer?.serveUi ?? true,
    },
    auth,
  };
}
