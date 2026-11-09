import { describe, expect, it } from "vitest";
import {
  githubDefaultOrganization,
  githubDefaultOwnerApplies,
  githubDefaultOwnerArguments,
  githubOwnerToolInputSchema,
} from "./github-default-owner.js";

const managed = { config: { sourceTemplateKey: "github", connectionMethodKey: "managed" } };
const createSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    organization: { type: "string", description: "Organization to create the repository in (omit to create in your personal account)" },
  },
  required: ["name"],
};
const orgOnly = {
  login: "octocat",
  installationOwnerLogins: ["acme"],
  repositories: [{ id: "1", fullName: "acme/site", installationId: "9", ownerType: "organization" }],
};

describe("githubDefaultOrganization", () => {
  it("uses the only installed organization when the personal account has no installation", () => {
    expect(githubDefaultOrganization(orgOnly)).toBe("acme");
    // Snapshots written before ownerType was recorded behave the same.
    expect(githubDefaultOrganization({ login: "octocat", installationOwnerLogins: ["acme"] })).toBe("acme");
  });

  it("keeps GitHub's personal default when the personal account is installed", () => {
    expect(githubDefaultOrganization({ login: "octocat", installationOwnerLogins: ["octocat"] })).toBeNull();
    expect(githubDefaultOrganization({ login: "OctoCat", installationOwnerLogins: ["octocat", "acme"] })).toBeNull();
  });

  it("does not guess between several organizations", () => {
    expect(githubDefaultOrganization({ login: "octocat", installationOwnerLogins: ["acme", "globex"] })).toBeNull();
    expect(githubDefaultOrganization({ login: "octocat", installationOwnerLogins: ["Acme", "acme"] })).toBe("Acme");
  });

  it("ignores another person's account and incomplete snapshots", () => {
    expect(githubDefaultOrganization({ login: "octocat", installationOwnerLogins: ["hubot"],
      repositories: [{ fullName: "hubot/tools", ownerType: "personal" }] })).toBeNull();
    expect(githubDefaultOrganization({ installationOwnerLogins: ["acme"] })).toBeNull();
    expect(githubDefaultOrganization({ login: "octocat", installationOwnerLogins: [] })).toBeNull();
    expect(githubDefaultOrganization(undefined)).toBeNull();
  });
});

describe("githubDefaultOwnerArguments", () => {
  it("fills an omitted or blank organization", () => {
    expect(githubDefaultOwnerArguments("create_repository", { name: "site" }, orgOnly))
      .toEqual({ name: "site", organization: "acme" });
    expect(githubDefaultOwnerArguments("mcp.github:create-repository", { name: "site", organization: " " }, orgOnly))
      .toEqual({ name: "site", organization: "acme" });
    expect(githubDefaultOwnerArguments("fork_repository", { owner: "octo-org", repo: "tools" }, orgOnly))
      .toEqual({ owner: "octo-org", repo: "tools", organization: "acme" });
  });

  it("keeps explicit owners and calls without a default", () => {
    const explicit = { name: "site", organization: "globex" };
    expect(githubDefaultOwnerArguments("create_repository", explicit, orgOnly)).toBe(explicit);
    const personal = { name: "site" };
    expect(githubDefaultOwnerArguments("create_repository", personal,
      { login: "octocat", installationOwnerLogins: ["octocat"] })).toBe(personal);
  });

  it("does not fork a repository into its own organization", () => {
    const fork = { owner: "ACME", repo: "site" };
    expect(githubDefaultOwnerArguments("fork_repository", fork, orgOnly)).toBe(fork);
  });
});

describe("githubDefaultOwnerApplies", () => {
  it("applies only to managed GitHub owner tools that declare organization", () => {
    expect(githubDefaultOwnerApplies(managed, "create_repository", createSchema, { name: "site" })).toBe(true);
    expect(githubDefaultOwnerApplies({ config: {}, transportConfig: managed.config }, "fork_repository",
      createSchema, { owner: "a", repo: "b" })).toBe(true);
    expect(githubDefaultOwnerApplies(managed, "create_repository", createSchema, { name: "site", organization: "acme" })).toBe(false);
    expect(githubDefaultOwnerApplies(managed, "create_issue", createSchema, {})).toBe(false);
    expect(githubDefaultOwnerApplies(managed, "create_repository", { properties: { name: {} } }, { name: "site" })).toBe(false);
    expect(githubDefaultOwnerApplies({ config: { sourceTemplateKey: "github", connectionMethodKey: "mcp-key" } },
      "create_repository", createSchema, { name: "site" })).toBe(false);
  });
});

describe("githubOwnerToolInputSchema", () => {
  it("describes the default for managed GitHub owner tools only", () => {
    const projected = githubOwnerToolInputSchema(managed, "create_repository", createSchema);
    expect(projected.required).toEqual(["name"]);
    expect((projected.properties as Record<string, { description?: string }>).organization?.description)
      .toMatch(/installed only on one organization; then Paperclip uses that organization/);
    expect(createSchema.properties.organization.description).toMatch(/omit to create in your personal account/);
    expect(githubOwnerToolInputSchema({ config: { sourceTemplateKey: "github", connectionMethodKey: "mcp-key" } },
      "create_repository", createSchema)).toBe(createSchema);
    expect(githubOwnerToolInputSchema(managed, "create_issue", createSchema)).toBe(createSchema);
  });
});
