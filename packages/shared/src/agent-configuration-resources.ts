import { z } from "zod";
import { updateAgentPermissionsSchema, createAgentKeySchema } from "./validators/agent.js";
import { agentDesiredSkillSelectionSchema, agentDesiredSkillEntrySchema } from "./validators/adapter-skills.js";
import { createToolProfileWithEntriesSchema, createToolProfileEntryForProfileSchema, createToolPolicySchema } from "./validators/tool-access.js";
import { chatProviderSchema, updateChatEndpointSchema, replaceChatEndpointResourcesSchema, createChatEndpointSchema, configureChatEndpointSchema } from "./validators/chat-channels.js";
import { createSecretSchema, rotateSecretSchema, updateSecretSchema } from "./validators/secret.js";

const id = z.string().min(1);
const filePath = z.string().min(1).max(512).refine(value => !value.startsWith("/") && !value.includes("\\") && !value.split("/").some(part => part === ".." || part === "." || !part), "Use a relative file path without traversal.");

export const agentConfigurationResourceShape = {
  permissions: updateAgentPermissionsSchema.extend({
    canCreateSkills: z.boolean(), trustPreset: updateAgentPermissionsSchema.shape.trustPreset.unwrap(),
  }).strict().optional(),
  instructions: z.object({
    mode: z.enum(["managed", "external"]).nullable(),
    rootPath: z.string().nullable(),
    entryFile: filePath,
    files: z.record(filePath, z.string().max(1024 * 1024)),
  }).strict().optional(),
  skills: z.array(z.union([agentDesiredSkillSelectionSchema.options[0], agentDesiredSkillEntrySchema.strict()])).optional(),
  tools: z.object({
    connections: z.array(z.object({ connectionId: id, installed: z.boolean() }).strict()),
    profiles: z.array(z.object({
      profileId: id.nullable(), updateSharedDefinition: z.boolean().optional(), priority: z.number().int().min(0).max(10000),
      metadata: z.record(z.string(), z.unknown()).nullable(),
      configuration: createToolProfileWithEntriesSchema.extend({
        entries: z.array(createToolProfileEntryForProfileSchema.strict()).max(250).optional(),
      }).strict(),
    }).strict()),
    policies: z.array(z.object({ id: id.nullable(), configuration: createToolPolicySchema.strict() }).strict()),
  }).strict().optional(),
  channels: z.array(z.object({
    id, provider: chatProviderSchema,
    settings: updateChatEndpointSchema,
    resources: z.array(replaceChatEndpointResourcesSchema.shape.resources.element.strict()),
  }).strict()).optional(),
  apiKeys: z.object({ create: z.array(createAgentKeySchema.strict()), revoke: z.array(id) }).strict().optional(),
  revisions: z.object({ restore: id.nullable() }).strict().optional(),
  secrets: z.object({
    create: z.array(z.object({
      secret: createSecretSchema.strict(),
      bind: z.object({ env: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)), api: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)) }).strict(),
    }).strict()),
    rotate: z.array(z.object({ id, input: rotateSecretSchema.strict() }).strict()),
    update: z.array(z.object({ id, input: updateSecretSchema.strict() }).strict()),
    proposals: z.array(z.object({ id, decision: z.enum(["approve", "reject"]), reason: z.string().optional() }).strict()),
  }).strict().optional(),
  channelOperations: z.object({
    create: z.array(z.object(createChatEndpointSchema.shape).omit({ assignedAgentId: true }).strict().refine(
      value => (!value.slackApp && !value.slackSetupMethod) || value.provider === "slack",
      { message: "Slack app details only apply to Slack connections", path: ["slackApp"] },
    )),
    setup: z.array(z.object({ id, input: configureChatEndpointSchema }).strict()),
    revokeIdentityLinks: z.array(z.object({ endpointId: id, principalId: id }).strict()),
  }).strict().optional(),
};

export type AgentConfigurationResources = z.infer<z.ZodObject<typeof agentConfigurationResourceShape>>;

const resources = agentConfigurationResourceShape;
const tools = resources.tools.unwrap().shape;
const profileReferenceSchema = tools.profiles.element.partial().extend({
  profileKey: id.optional(),
}).refine(value => value.profileId || value.profileKey || value.configuration, {
  message: "Specify profileKey, profileId, or a new profile configuration.",
}).refine(value => value.profileId !== null || !value.profileKey, {
  message: "A new profile (profileId: null) cannot also reference an existing profileKey.",
});

// Omission preserves saved values. Arrays and open configuration maps, when
// explicitly supplied, still replace their saved counterparts.
export const agentConfigurationInputResourceShape = {
  permissions: resources.permissions.unwrap().partial().optional(),
  instructions: resources.instructions.unwrap().partial().extend({
    files: z.record(filePath, z.string().max(1024 * 1024).nullable()).optional(),
  }).optional(),
  skills: resources.skills,
  tools: z.object({
    connections: z.array(tools.connections.element.partial({ installed: true })).optional(),
    profiles: z.array(profileReferenceSchema).optional(),
    policies: tools.policies.optional(),
  }).strict().optional(),
  channels: z.array(resources.channels.unwrap().element.partial().required({ id: true })).optional(),
  apiKeys: resources.apiKeys.unwrap().partial().optional(),
  revisions: resources.revisions,
  secrets: resources.secrets.unwrap().partial().optional(),
  channelOperations: resources.channelOperations.unwrap().partial().optional(),
};
