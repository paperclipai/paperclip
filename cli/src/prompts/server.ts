import * as p from "@clack/prompts";
import type { AuthConfig, ServerConfig } from "../config/schema.js";
import { parseHostnameCsv } from "../config/hostnames.js";

export async function promptServer(opts?: {
  currentServer?: Partial<ServerConfig>;
  currentAuth?: Partial<AuthConfig>;
}): Promise<{ server: ServerConfig; auth: AuthConfig }> {
  const currentServer = opts?.currentServer;
  const currentAuth = opts?.currentAuth;

  const deploymentModeSelection = await p.select({
    message: "Deployment mode",
    options: [
      {
        value: "local_trusted",
        label: "Local trusted",
        hint: "Easiest for local setup (no login, localhost-only)",
      },
      {
        value: "authenticated",
        label: "Authenticated",
        hint: "Login required; use for private network or public hosting",
      },
    ],
    initialValue: currentServer?.deploymentMode ?? "local_trusted",
  });

  if (p.isCancel(deploymentModeSelection)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }
  const deploymentMode = deploymentModeSelection as ServerConfig["deploymentMode"];

  let exposure: ServerConfig["exposure"] = "private";
  if (deploymentMode === "authenticated") {
    const exposureSelection = await p.select({
      message: "Exposure profile",
      options: [
        {
          value: "private",
          label: "Private network",
          hint: "Private access (for example Tailscale), lower setup friction",
        },
        {
          value: "public",
          label: "Public internet",
          hint: "Internet-facing deployment with stricter requirements",
        },
      ],
      initialValue: currentServer?.exposure ?? "private",
    });
    if (p.isCancel(exposureSelection)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }
    exposure = exposureSelection as ServerConfig["exposure"];
  }

  const hostDefault = deploymentMode === "local_trusted" ? "127.0.0.1" : "0.0.0.0";
  const hostStr = await p.text({
    message: "Bind host",
    defaultValue: currentServer?.host ?? hostDefault,
    placeholder: hostDefault,
    validate: (val) => {
      if (!val.trim()) return "Host is required";
    },
  });

  if (p.isCancel(hostStr)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const portStr = await p.text({
    message: "Server port",
    defaultValue: String(currentServer?.port ?? 3100),
    placeholder: "3100",
    validate: (val) => {
      const n = Number(val);
      if (isNaN(n) || n < 1 || n > 65535 || !Number.isInteger(n)) {
        return "Must be an integer between 1 and 65535";
      }
    },
  });

  if (p.isCancel(portStr)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  let allowedHostnames: string[] = [];
  if (deploymentMode === "authenticated" && exposure === "private") {
    const allowedHostnamesInput = await p.text({
      message: "Allowed hostnames (comma-separated, optional)",
      defaultValue: (currentServer?.allowedHostnames ?? []).join(", "),
      placeholder: "dotta-macbook-pro, your-host.tailnet.ts.net",
      validate: (val) => {
        try {
          parseHostnameCsv(val);
          return;
        } catch (err) {
          return err instanceof Error ? err.message : "Invalid hostname list";
        }
      },
    });

    if (p.isCancel(allowedHostnamesInput)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }
    allowedHostnames = parseHostnameCsv(allowedHostnamesInput);
  }

  const port = Number(portStr) || 3100;
  let auth: AuthConfig = { baseUrlMode: "auto", disableSignUp: false };
  if (deploymentMode === "authenticated" && exposure === "public") {
    const urlInput = await p.text({
      message: "Public base URL",
      defaultValue: currentAuth?.publicBaseUrl ?? "",
      placeholder: "https://paperclip.example.com",
      validate: (val) => {
        const candidate = val.trim();
        if (!candidate) return "Public base URL is required for public exposure";
        try {
          const url = new URL(candidate);
          if (url.protocol !== "http:" && url.protocol !== "https:") {
            return "URL must start with http:// or https://";
          }
          return;
        } catch {
          return "Enter a valid URL";
        }
      },
    });
    if (p.isCancel(urlInput)) {
      p.cancel("Setup cancelled.");
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
