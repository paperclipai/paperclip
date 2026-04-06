import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { cloudDeploymentService } from "../services/cloud-deployments.js";
import { logActivity } from "../services/activity-log.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function cloudDeploymentRoutes(db: Db) {
  const router = Router();
  const svc = cloudDeploymentService(db);

  // List health checks for a deployment
  router.get("/companies/:companyId/deployments/:deploymentId/health-checks", async (req, res) => {
    const { companyId, deploymentId } = req.params;
    assertCompanyAccess(req, companyId);
    const checks = await svc.listHealthChecks(companyId, deploymentId);
    res.json(checks);
  });

  // Run a health check for a deployment
  router.post("/companies/:companyId/deployments/:deploymentId/health-check", async (req, res) => {
    const { companyId, deploymentId } = req.params;
    assertCompanyAccess(req, companyId);

    try {
      const healthCheck = await svc.checkHealth(companyId, deploymentId);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "deployment.health_checked",
        entityType: "deployment",
        entityId: deploymentId,
        details: { status: healthCheck.status, responseTimeMs: healthCheck.responseTimeMs },
      });

      res.json(healthCheck);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Health check failed";
      res.status(400).json({ error: message });
    }
  });

  // List deployment recipes
  router.get("/companies/:companyId/deployment-recipes", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    const recipes = await svc.listRecipes(companyId);
    res.json(recipes);
  });

  // Create deployment recipe
  router.post("/companies/:companyId/deployment-recipes", async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);

    const { name, description, cloudProvider, cloudRegion, resourceType, configTemplate, envTemplate } = req.body;

    if (!name || !cloudProvider || !resourceType) {
      res.status(400).json({ error: "name, cloudProvider, and resourceType are required" });
      return;
    }

    const recipe = await svc.createRecipe(companyId, {
      name,
      description: description ?? null,
      cloudProvider,
      cloudRegion: cloudRegion ?? "us-east-1",
      resourceType,
      configTemplate: configTemplate ?? {},
      envTemplate: envTemplate ?? {},
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "deployment_recipe.created",
      entityType: "deployment_recipe",
      entityId: recipe.id,
      details: { name: recipe.name, cloudProvider: recipe.cloudProvider },
    });

    res.status(201).json(recipe);
  });

  // Update deployment recipe
  router.patch("/companies/:companyId/deployment-recipes/:recipeId", async (req, res) => {
    const { companyId, recipeId } = req.params;
    assertCompanyAccess(req, companyId);

    const recipe = await svc.updateRecipe(companyId, recipeId, req.body);
    if (!recipe) {
      res.status(404).json({ error: "Recipe not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "deployment_recipe.updated",
      entityType: "deployment_recipe",
      entityId: recipe.id,
      details: { name: recipe.name },
    });

    res.json(recipe);
  });

  // Delete deployment recipe
  router.delete("/companies/:companyId/deployment-recipes/:recipeId", async (req, res) => {
    const { companyId, recipeId } = req.params;
    assertCompanyAccess(req, companyId);

    const deleted = await svc.deleteRecipe(companyId, recipeId);
    if (!deleted) {
      res.status(404).json({ error: "Recipe not found" });
      return;
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "deployment_recipe.deleted",
      entityType: "deployment_recipe",
      entityId: recipeId,
      details: {},
    });

    res.status(204).send();
  });

  // Trigger cloud deploy
  router.post("/companies/:companyId/deployments/:deploymentId/deploy-cloud", async (req, res) => {
    const { companyId, deploymentId } = req.params;
    assertCompanyAccess(req, companyId);

    const { cloudProvider, cloudRegion, cloudResourceType, cloudConfig, version, commitSha, dockerImage, domain, sslEnabled } = req.body;

    if (!cloudProvider) {
      res.status(400).json({ error: "cloudProvider is required" });
      return;
    }

    try {
      const deployment = await svc.deployToCloud(companyId, deploymentId, {
        cloudProvider,
        cloudRegion,
        cloudResourceType,
        cloudConfig: cloudConfig ?? {},
        version,
        commitSha,
        dockerImage,
        domain,
        sslEnabled,
      });

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "deployment.cloud_deployed",
        entityType: "deployment",
        entityId: deploymentId,
        details: { cloudProvider, status: deployment.status },
      });

      res.json(deployment);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Cloud deploy failed";
      res.status(400).json({ error: message });
    }
  });

  // Rollback deployment
  router.post("/companies/:companyId/deployments/:deploymentId/rollback", async (req, res) => {
    const { companyId, deploymentId } = req.params;
    assertCompanyAccess(req, companyId);

    try {
      const rollback = await svc.rollback(companyId, deploymentId);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "deployment.rolled_back",
        entityType: "deployment",
        entityId: deploymentId,
        details: { rollbackDeploymentId: rollback.id, status: rollback.status },
      });

      res.json(rollback);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Rollback failed";
      res.status(400).json({ error: message });
    }
  });

  return router;
}
