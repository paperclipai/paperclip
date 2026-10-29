import type { Environment, EnvironmentCapabilities } from "@paperclipai/shared";
import { prepareFixtureApi, type FixtureState } from "./api";
export const environment: Environment = {
  id: "environment-gap",
  name: "Release sandbox",
  description: "Isolated release checks",
  driver: "sandbox",
  status: "active",
  config: { provider: "daytona", reuseLease: true },
  envVars: {},
  metadata: null,
  createdAt: new Date("2026-10-12"),
  updatedAt: new Date("2026-10-12"),
};
const capabilities: EnvironmentCapabilities = {
  adapters: [],
  drivers: {
    local: "supported",
    ssh: "supported",
    sandbox: "supported",
    plugin: "unsupported",
  },
  sandboxProviders: {
    fake: {
      status: "unsupported",
      supportsLoginPty: false,
      supportsSavedProbe: false,
      supportsUnsavedProbe: false,
      supportsRunExecution: false,
      supportsReusableLeases: false,
      supportsInteractiveSetup: false,
      interactiveSetupConnectionTypes: [],
      supportsTemplateCapture: false,
      supportsTemplateDelete: false,
    },
    daytona: {
      status: "supported",
      supportsLoginPty: true,
      supportsSavedProbe: true,
      supportsUnsavedProbe: true,
      supportsRunExecution: true,
      supportsReusableLeases: true,
      supportsInteractiveSetup: true,
      interactiveSetupConnectionTypes: ["ssh"],
      supportsTemplateCapture: true,
      supportsTemplateDelete: true,
      displayName: "Daytona",
    },
  },
};
export function installEnvironmentFixture(
  state: FixtureState = "ready",
  image: "none" | "captured" | "failed" | "loading" | "denied" = "none",
  unsupported = false,
) {
  let current = { ...environment };
  const template = {
    id: "template-gap",
    environmentId: environment.id,
    provider: "daytona",
    templateKind: "snapshot",
    templateRef: "fixture-template",
    sourceTemplateRef: null,
    sourceEnvironmentConfigFingerprint: "fixture-fingerprint",
    status: "active",
    createdByUserId: "user-storybook",
    createdByAgentId: null,
    capturedAt: "2026-10-12T12:00:00Z",
    lastUsedAt: null,
    supersededByTemplateId: null,
    metadata: null,
    createdAt: "2026-10-12T12:00:00Z",
    updatedAt: "2026-10-12T12:00:00Z",
  };
  return prepareFixtureApi(
    [
      {
        path: "/api/instance/settings/experimental",
        state: "ready",
        read: () => ({
          enableEnvironments: true,
          enableManagedSandboxOnly: false,
        }),
      },
      {
        path: "/api/instance/settings",
        state: "ready",
        read: () => ({ defaultEnvironmentId: environment.id }),
      },
      {
        path: "/api/companies/company-storybook/environments",
        read: () => (state === "empty" ? [] : [current]),
      },
      {
        path: "/api/companies/company-storybook/environments/capabilities",
        read: () =>
          unsupported
            ? {
                ...capabilities,
                sandboxProviders: {
                  fake: {
                    status: "unsupported",
                    supportsLoginPty: false,
                    supportsSavedProbe: false,
                    supportsUnsavedProbe: false,
                    supportsRunExecution: false,
                    supportsReusableLeases: false,
                    supportsInteractiveSetup: false,
                    interactiveSetupConnectionTypes: [],
                    supportsTemplateCapture: false,
                    supportsTemplateDelete: false,
                  },
                  daytona: {
                    ...capabilities.sandboxProviders.daytona,
                    status: "unsupported",
                    supportsSavedProbe: false,
                    supportsTemplateCapture: false,
                  },
                },
              }
            : capabilities,
      },
      {
        path: "/api/environments/environment-gap/secret-refs",
        read: () => ({ refs: [] }),
      },
      {
        path: "/api/environments/environment-gap",
        method: "PATCH",
        read: ({ body }) => {
          current = { ...current, ...body };
          return current;
        },
      },
      {
        path: "/api/environments/environment-gap/probe",
        method: "POST",
        read: () => ({
          ok: true,
          driver: "sandbox",
          summary: "Provider connection succeeded.",
          details: {},
        }),
      },
      {
        path: "/api/environments/environment-gap/custom-image-template",
        read: () =>
          image === "loading"
            ? new Promise<Response>(() => {})
            : image === "denied"
              ? Response.json(
                  {
                    error: "You do not have permission to inspect this image.",
                  },
                  { status: 403 },
                )
              : image === "failed"
                ? Response.json(
                    { error: "Image metadata is unavailable." },
                    { status: 503 },
                  )
                : {
                    activeTemplate: image === "captured" ? template : null,
                    activeTemplateMatchesConfig: true,
                    activeSession: null,
                    latestSession: null,
                  },
      },
    ],
    state,
  );
}
