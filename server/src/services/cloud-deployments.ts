import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { deployments, deploymentHealthChecks, deploymentRecipes } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

interface RecipeInput {
  name: string;
  description?: string | null;
  cloudProvider: string;
  cloudRegion?: string;
  resourceType: string;
  configTemplate?: Record<string, unknown>;
  envTemplate?: Record<string, string>;
}

interface CloudDeployInput {
  cloudProvider: string;
  cloudRegion?: string;
  cloudResourceType?: string;
  cloudConfig?: Record<string, unknown>;
  version?: string;
  commitSha?: string;
  dockerImage?: string;
  domain?: string;
  sslEnabled?: boolean;
}

async function performHealthCheck(url: string): Promise<{
  status: string;
  responseTimeMs: number;
  statusCode: number | null;
  message: string;
}> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);
    const responseTimeMs = Date.now() - start;
    const statusCode = res.status;

    let status: string;
    let message: string;
    if (statusCode >= 200 && statusCode < 300) {
      status = "healthy";
      message = `OK (${statusCode})`;
    } else if (statusCode >= 300 && statusCode < 500) {
      status = "degraded";
      message = `Non-success status ${statusCode}`;
    } else {
      status = "unhealthy";
      message = `Server error ${statusCode}`;
    }

    return { status, responseTimeMs, statusCode, message };
  } catch (err: unknown) {
    const responseTimeMs = Date.now() - start;
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      status: "unhealthy",
      responseTimeMs,
      statusCode: null,
      message: `Health check failed: ${errMsg}`,
    };
  }
}

function resolveCloudCredentials(provider: string): { valid: boolean; missingEnvVars: string[] } {
  const missing: string[] = [];
  switch (provider) {
    case "aws": {
      if (!process.env.AWS_ACCESS_KEY_ID) missing.push("AWS_ACCESS_KEY_ID");
      if (!process.env.AWS_SECRET_ACCESS_KEY) missing.push("AWS_SECRET_ACCESS_KEY");
      break;
    }
    case "gcp": {
      if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && !process.env.GOOGLE_CLOUD_PROJECT) {
        missing.push("GOOGLE_APPLICATION_CREDENTIALS");
      }
      break;
    }
    case "azure": {
      if (!process.env.AZURE_SUBSCRIPTION_ID) missing.push("AZURE_SUBSCRIPTION_ID");
      if (!process.env.AZURE_CLIENT_ID) missing.push("AZURE_CLIENT_ID");
      if (!process.env.AZURE_CLIENT_SECRET) missing.push("AZURE_CLIENT_SECRET");
      if (!process.env.AZURE_TENANT_ID) missing.push("AZURE_TENANT_ID");
      break;
    }
    default:
      missing.push(`Unsupported cloud provider: ${provider}`);
  }
  return { valid: missing.length === 0, missingEnvVars: missing };
}

async function deployAWS(deployment: typeof deployments.$inferSelect, config: Record<string, unknown>) {
  const resourceType = deployment.cloudResourceType ?? (config.resourceType as string) ?? "ecs";
  const region = deployment.cloudRegion ?? "us-east-1";

  // Dynamic import of AWS SDK - only loaded when actually deploying
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let awsModule: any;
  try {
    switch (resourceType) {
      case "ecs": {
        try {
          awsModule = await (Function('return import("@aws-sdk/client-ecs")')() as Promise<unknown>);
        } catch {
          throw new Error("@aws-sdk/client-ecs is not installed. Run: npm install @aws-sdk/client-ecs");
        }
        const client = new awsModule.ECSClient({ region });
        const command = new awsModule.UpdateServiceCommand({
          cluster: config.cluster as string,
          service: config.service as string,
          taskDefinition: config.taskDefinition as string | undefined,
          desiredCount: config.desiredCount as number | undefined,
          forceNewDeployment: true,
        });
        const result = await client.send(command);
        return {
          cloudResourceId: result.service?.serviceArn ?? null,
          deployLog: `ECS service updated: ${result.service?.serviceName ?? "unknown"}`,
        };
      }
      case "lambda": {
        try {
          awsModule = await (Function('return import("@aws-sdk/client-lambda")')() as Promise<unknown>);
        } catch {
          throw new Error("@aws-sdk/client-lambda is not installed. Run: npm install @aws-sdk/client-lambda");
        }
        const client = new awsModule.LambdaClient({ region });
        const command = new awsModule.UpdateFunctionCodeCommand({
          FunctionName: config.functionName as string,
          ImageUri: deployment.dockerImage ?? (config.imageUri as string | undefined),
          S3Bucket: config.s3Bucket as string | undefined,
          S3Key: config.s3Key as string | undefined,
        });
        const result = await client.send(command);
        return {
          cloudResourceId: result.FunctionArn ?? null,
          deployLog: `Lambda function updated: ${result.FunctionName ?? "unknown"}`,
        };
      }
      default:
        throw new Error(`Unsupported AWS resource type: ${resourceType}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`AWS deployment failed: ${message}`);
  }
}

async function deployGCP(deployment: typeof deployments.$inferSelect, config: Record<string, unknown>) {
  const resourceType = deployment.cloudResourceType ?? (config.resourceType as string) ?? "cloud-run";
  const region = deployment.cloudRegion ?? "us-central1";
  const project = (config.project as string) ?? process.env.GOOGLE_CLOUD_PROJECT;

  if (!project) {
    throw new Error("GCP project not specified in config or GOOGLE_CLOUD_PROJECT env var");
  }

  try {
    switch (resourceType) {
      case "cloud-run": {
        // Use Google Cloud Run Admin API via REST
        const serviceName = config.serviceName as string;
        if (!serviceName) throw new Error("serviceName is required for Cloud Run deployment");

        const image = deployment.dockerImage ?? (config.image as string);
        if (!image) throw new Error("dockerImage or config.image is required for Cloud Run deployment");

        // Get access token from application default credentials
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let googleAuthModule: any;
        try {
          googleAuthModule = await (Function('return import("google-auth-library")')() as Promise<unknown>);
        } catch {
          throw new Error("google-auth-library is not installed. Run: npm install google-auth-library");
        }
        const auth = new googleAuthModule.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
        const client = await auth.getClient();
        const tokenResponse = await client.getAccessToken();
        const token = tokenResponse.token;

        const apiUrl = `https://run.googleapis.com/v2/projects/${project}/locations/${region}/services/${serviceName}`;
        const patchBody = {
          template: {
            containers: [{ image }],
            ...(config.maxInstances ? { scaling: { maxInstanceCount: config.maxInstances } } : {}),
          },
        };

        const res = await fetch(apiUrl, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(patchBody),
        });

        if (!res.ok) {
          const errBody = await res.text();
          throw new Error(`Cloud Run API error (${res.status}): ${errBody}`);
        }

        const result = await res.json() as { name?: string; uri?: string };
        return {
          cloudResourceId: result.name ?? null,
          deployLog: `Cloud Run service updated: ${serviceName} in ${region}`,
          url: result.uri ?? null,
        };
      }
      default:
        throw new Error(`Unsupported GCP resource type: ${resourceType}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`GCP deployment failed: ${message}`);
  }
}

async function deployAzure(deployment: typeof deployments.$inferSelect, config: Record<string, unknown>) {
  const resourceType = deployment.cloudResourceType ?? (config.resourceType as string) ?? "container-app";
  const region = deployment.cloudRegion ?? "eastus";
  const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
  const resourceGroup = config.resourceGroup as string;

  if (!subscriptionId) throw new Error("AZURE_SUBSCRIPTION_ID is required");
  if (!resourceGroup) throw new Error("resourceGroup is required in config");

  try {
    switch (resourceType) {
      case "container-app": {
        const appName = config.appName as string;
        if (!appName) throw new Error("appName is required for Container App deployment");

        const image = deployment.dockerImage ?? (config.image as string);
        if (!image) throw new Error("dockerImage or config.image is required for Container App deployment");

        // Get Azure access token using client credentials
        const tenantId = process.env.AZURE_TENANT_ID;
        const clientId = process.env.AZURE_CLIENT_ID;
        const clientSecret = process.env.AZURE_CLIENT_SECRET;

        const tokenRes = await fetch(
          `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "client_credentials",
              client_id: clientId!,
              client_secret: clientSecret!,
              scope: "https://management.azure.com/.default",
            }),
          },
        );

        if (!tokenRes.ok) {
          throw new Error(`Azure auth failed: ${await tokenRes.text()}`);
        }

        const tokenData = await tokenRes.json() as { access_token: string };
        const token = tokenData.access_token;

        const apiUrl = `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.App/containerApps/${appName}?api-version=2023-05-01`;

        const patchBody = {
          location: region,
          properties: {
            template: {
              containers: [
                {
                  name: appName,
                  image,
                },
              ],
            },
          },
        };

        const res = await fetch(apiUrl, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(patchBody),
        });

        if (!res.ok) {
          const errBody = await res.text();
          throw new Error(`Azure Container App API error (${res.status}): ${errBody}`);
        }

        const result = await res.json() as { id?: string; name?: string };
        return {
          cloudResourceId: result.id ?? null,
          deployLog: `Container App updated: ${appName} in ${region}`,
        };
      }
      default:
        throw new Error(`Unsupported Azure resource type: ${resourceType}`);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Azure deployment failed: ${message}`);
  }
}

export function cloudDeploymentService(db: Db) {
  return {
    listHealthChecks: (companyId: string, deploymentId: string) =>
      db
        .select()
        .from(deploymentHealthChecks)
        .where(
          and(
            eq(deploymentHealthChecks.companyId, companyId),
            eq(deploymentHealthChecks.deploymentId, deploymentId),
          ),
        )
        .orderBy(desc(deploymentHealthChecks.checkedAt))
        .limit(100),

    checkHealth: async (companyId: string, deploymentId: string) => {
      const [deployment] = await db
        .select()
        .from(deployments)
        .where(and(eq(deployments.id, deploymentId), eq(deployments.companyId, companyId)));

      if (!deployment) {
        throw new Error("Deployment not found");
      }

      if (!deployment.url) {
        throw new Error("Deployment has no URL to check health against");
      }

      const result = await performHealthCheck(deployment.url);

      const [healthCheck] = await db
        .insert(deploymentHealthChecks)
        .values({
          deploymentId,
          companyId,
          status: result.status,
          responseTimeMs: result.responseTimeMs,
          statusCode: result.statusCode,
          message: result.message,
        })
        .returning();

      // Update the deployment's health status
      await db
        .update(deployments)
        .set({
          healthStatus: result.status,
          healthCheckedAt: new Date(),
          healthMessage: result.message,
          updatedAt: new Date(),
        })
        .where(eq(deployments.id, deploymentId));

      return healthCheck;
    },

    listRecipes: (companyId: string) =>
      db
        .select()
        .from(deploymentRecipes)
        .where(eq(deploymentRecipes.companyId, companyId))
        .orderBy(desc(deploymentRecipes.createdAt)),

    createRecipe: (companyId: string, input: RecipeInput) =>
      db
        .insert(deploymentRecipes)
        .values({
          companyId,
          name: input.name,
          description: input.description ?? null,
          cloudProvider: input.cloudProvider,
          cloudRegion: input.cloudRegion ?? "us-east-1",
          resourceType: input.resourceType,
          configTemplate: input.configTemplate ?? {},
          envTemplate: input.envTemplate ?? {},
        })
        .returning()
        .then((rows) => rows[0]),

    updateRecipe: async (companyId: string, id: string, input: Partial<RecipeInput>) => {
      const [existing] = await db
        .select()
        .from(deploymentRecipes)
        .where(and(eq(deploymentRecipes.id, id), eq(deploymentRecipes.companyId, companyId)));

      if (!existing) {
        return null;
      }

      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (input.name !== undefined) updateData.name = input.name;
      if (input.description !== undefined) updateData.description = input.description;
      if (input.cloudProvider !== undefined) updateData.cloudProvider = input.cloudProvider;
      if (input.cloudRegion !== undefined) updateData.cloudRegion = input.cloudRegion;
      if (input.resourceType !== undefined) updateData.resourceType = input.resourceType;
      if (input.configTemplate !== undefined) updateData.configTemplate = input.configTemplate;
      if (input.envTemplate !== undefined) updateData.envTemplate = input.envTemplate;

      return db
        .update(deploymentRecipes)
        .set(updateData)
        .where(and(eq(deploymentRecipes.id, id), eq(deploymentRecipes.companyId, companyId)))
        .returning()
        .then((rows) => rows[0] ?? null);
    },

    deleteRecipe: async (companyId: string, id: string) => {
      const [existing] = await db
        .select()
        .from(deploymentRecipes)
        .where(and(eq(deploymentRecipes.id, id), eq(deploymentRecipes.companyId, companyId)));

      if (!existing) {
        return false;
      }

      await db
        .delete(deploymentRecipes)
        .where(and(eq(deploymentRecipes.id, id), eq(deploymentRecipes.companyId, companyId)));

      return true;
    },

    deployToCloud: async (companyId: string, deploymentId: string, input: CloudDeployInput) => {
      const [deployment] = await db
        .select()
        .from(deployments)
        .where(and(eq(deployments.id, deploymentId), eq(deployments.companyId, companyId)));

      if (!deployment) {
        throw new Error("Deployment not found");
      }

      const provider = input.cloudProvider;
      const creds = resolveCloudCredentials(provider);
      if (!creds.valid) {
        throw new Error(
          `Missing cloud credentials for ${provider}: ${creds.missingEnvVars.join(", ")}`,
        );
      }

      // Update deployment to deploying status
      await db
        .update(deployments)
        .set({
          status: "deploying",
          cloudProvider: provider,
          cloudRegion: input.cloudRegion ?? deployment.cloudRegion,
          cloudResourceType: input.cloudResourceType ?? deployment.cloudResourceType,
          cloudConfig: input.cloudConfig ?? deployment.cloudConfig ?? {},
          version: input.version ?? deployment.version,
          commitSha: input.commitSha ?? deployment.commitSha,
          dockerImage: input.dockerImage ?? deployment.dockerImage,
          domain: input.domain ?? deployment.domain,
          sslEnabled: input.sslEnabled ?? deployment.sslEnabled,
          startedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(deployments.id, deploymentId));

      const config = {
        ...(deployment.cloudConfig as Record<string, unknown> ?? {}),
        ...(input.cloudConfig ?? {}),
      };

      // Re-fetch the updated deployment for provider functions
      const [updatedDeployment] = await db
        .select()
        .from(deployments)
        .where(eq(deployments.id, deploymentId));

      try {
        let result: { cloudResourceId?: string | null; deployLog?: string; url?: string | null };

        switch (provider) {
          case "aws":
            result = await deployAWS(updatedDeployment, config);
            break;
          case "gcp":
            result = await deployGCP(updatedDeployment, config);
            break;
          case "azure":
            result = await deployAzure(updatedDeployment, config);
            break;
          default:
            throw new Error(`Unsupported cloud provider: ${provider}`);
        }

        // Update deployment with success
        const [finalDeployment] = await db
          .update(deployments)
          .set({
            status: "succeeded",
            cloudResourceId: result.cloudResourceId ?? deployment.cloudResourceId,
            deployLog: result.deployLog ?? null,
            url: result.url ?? deployment.url,
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(deployments.id, deploymentId))
          .returning();

        return finalDeployment;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ err, deploymentId, provider }, "Cloud deployment failed");

        const [failedDeployment] = await db
          .update(deployments)
          .set({
            status: "failed",
            deployLog: message,
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(deployments.id, deploymentId))
          .returning();

        return failedDeployment;
      }
    },

    rollback: async (companyId: string, deploymentId: string) => {
      const [deployment] = await db
        .select()
        .from(deployments)
        .where(and(eq(deployments.id, deploymentId), eq(deployments.companyId, companyId)));

      if (!deployment) {
        throw new Error("Deployment not found");
      }

      // Find the most recent succeeded deployment for same environment/project before this one
      const [previousDeployment] = await db
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.companyId, companyId),
            eq(deployments.environment, deployment.environment),
            eq(deployments.status, "succeeded"),
          ),
        )
        .orderBy(desc(deployments.finishedAt))
        .limit(2);

      // Find the previous one (not the current)
      const candidates = await db
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.companyId, companyId),
            eq(deployments.environment, deployment.environment),
            eq(deployments.status, "succeeded"),
          ),
        )
        .orderBy(desc(deployments.finishedAt))
        .limit(2);

      const rollbackTarget = candidates.find((d) => d.id !== deploymentId);
      if (!rollbackTarget) {
        throw new Error("No previous successful deployment found to rollback to");
      }

      // Create a new deployment as the rollback
      const [rollbackDeployment] = await db
        .insert(deployments)
        .values({
          companyId,
          projectId: deployment.projectId,
          agentId: deployment.agentId,
          runId: deployment.runId,
          environment: deployment.environment,
          status: "rolling_back",
          url: rollbackTarget.url,
          provider: rollbackTarget.provider,
          cloudProvider: rollbackTarget.cloudProvider,
          cloudRegion: rollbackTarget.cloudRegion,
          cloudResourceId: rollbackTarget.cloudResourceId,
          cloudResourceType: rollbackTarget.cloudResourceType,
          cloudConfig: rollbackTarget.cloudConfig as Record<string, unknown> ?? {},
          version: rollbackTarget.version,
          commitSha: rollbackTarget.commitSha,
          dockerImage: rollbackTarget.dockerImage,
          domain: rollbackTarget.domain,
          sslEnabled: rollbackTarget.sslEnabled,
          rollbackDeploymentId: deploymentId,
          startedAt: new Date(),
          metadata: { rollbackFrom: deploymentId, rollbackTo: rollbackTarget.id },
        })
        .returning();

      // If the rollback target had cloud config, attempt re-deploy
      if (rollbackTarget.cloudProvider && rollbackTarget.cloudConfig) {
        const creds = resolveCloudCredentials(rollbackTarget.cloudProvider);
        if (creds.valid) {
          try {
            let result: { cloudResourceId?: string | null; deployLog?: string; url?: string | null };
            const config = rollbackTarget.cloudConfig as Record<string, unknown>;

            switch (rollbackTarget.cloudProvider) {
              case "aws":
                result = await deployAWS(rollbackTarget, config);
                break;
              case "gcp":
                result = await deployGCP(rollbackTarget, config);
                break;
              case "azure":
                result = await deployAzure(rollbackTarget, config);
                break;
              default:
                throw new Error(`Unsupported provider: ${rollbackTarget.cloudProvider}`);
            }

            await db
              .update(deployments)
              .set({
                status: "succeeded",
                deployLog: `Rollback succeeded. ${result.deployLog ?? ""}`.trim(),
                cloudResourceId: result.cloudResourceId ?? rollbackTarget.cloudResourceId,
                url: result.url ?? rollbackTarget.url,
                finishedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(deployments.id, rollbackDeployment.id));
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error({ err, deploymentId: rollbackDeployment.id }, "Rollback cloud deploy failed");
            await db
              .update(deployments)
              .set({
                status: "failed",
                deployLog: `Rollback failed: ${message}`,
                finishedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(deployments.id, rollbackDeployment.id));
          }
        } else {
          // No credentials, mark as succeeded (config-only rollback)
          await db
            .update(deployments)
            .set({
              status: "succeeded",
              deployLog: "Rollback completed (config-only, no cloud credentials to re-deploy)",
              finishedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(deployments.id, rollbackDeployment.id));
        }
      } else {
        // No cloud provider, just mark as succeeded
        await db
          .update(deployments)
          .set({
            status: "succeeded",
            deployLog: "Rollback completed",
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(deployments.id, rollbackDeployment.id));
      }

      // Re-fetch final state
      const [final] = await db
        .select()
        .from(deployments)
        .where(eq(deployments.id, rollbackDeployment.id));

      return final;
    },
  };
}
