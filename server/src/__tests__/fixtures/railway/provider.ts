// Public discovery metadata observed 2026-09-13. Tool descriptors below are
// deterministic examples of documented tools, not an authenticated tools/list capture.
export const railwayResourceMetadata = {
  resource: "https://mcp.railway.com",
  authorization_servers: ["https://backboard.railway.com"],
  scopes_supported: ["openid", "profile", "email", "offline_access", "workspace:member"],
  bearer_methods_supported: ["header"],
};
export const railwayAuthorizationMetadata = {
  issuer: "https://backboard.railway.com",
  authorization_endpoint: "https://backboard.railway.com/oauth/auth?resource=https%3A%2F%2Fbackboard.railway.com",
  token_endpoint: "https://backboard.railway.com/oauth/token",
  registration_endpoint: "https://backboard.railway.com/oauth/register",
  scopes_supported: railwayResourceMetadata.scopes_supported,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
  token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none", "private_key_jwt"],
  code_challenge_methods_supported: ["S256"],
};
export const target = {
  projectId: "11111111-1111-4111-8111-111111111111",
  environmentId: "22222222-2222-4222-8222-222222222222",
  serviceId: "33333333-3333-4333-8333-333333333333",
  deploymentId: "44444444-4444-4444-8444-444444444444",
};
export const instanceId = "55555555-5555-4555-8555-555555555555";
export const targetData = {
  project: { id: target.projectId },
  environment: { id: target.environmentId, projectId: target.projectId },
  service: { id: target.serviceId, projectId: target.projectId },
  serviceInstance: { environmentId: target.environmentId, serviceId: target.serviceId, source: { repo: "example/app" } },
};
export const deploymentData = {
  deployment: { ...target, id: target.deploymentId, status: "SUCCESS", canRedeploy: true, canRollback: true, instances: [{ id: instanceId }] },
};
