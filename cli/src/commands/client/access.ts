import { readFileSync } from "node:fs";
import { Command } from "commander";
import {
  acceptInviteSchema,
  archiveCompanyMemberSchema,
  claimJoinRequestApiKeySchema,
  createCompanyInviteSchema,
  createOpenClawInvitePromptSchema,
  updateCompanyMemberSchema,
  updateCompanyMemberWithPermissionsSchema,
  updateMemberPermissionsSchema,
  updateUserCompanyAccessSchema,
} from "@paperclipai/shared";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

interface PayloadOptions extends BaseClientOptions {
  payload?: string;
  payloadFile?: string;
}

interface CompanyOnly extends BaseClientOptions {
  companyId?: string;
}

function readJson(opts: PayloadOptions, name: string): unknown {
  if (opts.payload !== undefined && opts.payloadFile !== undefined) {
    throw new Error(`Pass either --${name} or --${name}-file, not both.`);
  }
  if (opts.payload !== undefined) {
    try {
      return JSON.parse(opts.payload);
    } catch (err) {
      throw new Error(`--${name} must be valid JSON: ${(err as Error).message}`);
    }
  }
  if (opts.payloadFile !== undefined) {
    const raw = readFileSync(opts.payloadFile, "utf8");
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(`--${name}-file must be valid JSON: ${(err as Error).message}`);
    }
  }
  return undefined;
}

export function registerAccessCommands(program: Command): void {
  // ── invites ─────────────────────────────────────────────────────────────
  const invite = program.command("invite").description("Company invite operations");

  addCommonClientOptions(
    invite
      .command("list")
      .description("List invites for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: CompanyOnly) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<unknown[]>(
            `/api/companies/${ctx.companyId}/invites`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    invite
      .command("create")
      .description("Create a new invite")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--payload <json>", "Invite payload as JSON object")
      .option("--payload-file <path>", "Read invite payload from JSON file")
      .action(async (opts: PayloadOptions & CompanyOnly) => {
        try {
          const payload = readJson(opts, "payload");
          if (payload === undefined) throw new Error("--payload or --payload-file required");
          const parsed = createCompanyInviteSchema.parse(payload);
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.post<unknown>(
            `/api/companies/${ctx.companyId}/invites`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    invite
      .command("openclaw-prompt")
      .description("Generate an OpenClaw invite prompt for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .option("--payload <json>", "Prompt payload as JSON object")
      .option("--payload-file <path>", "Read prompt payload from JSON file")
      .action(async (opts: PayloadOptions & CompanyOnly) => {
        try {
          const payload = readJson(opts, "payload");
          if (payload === undefined) throw new Error("--payload or --payload-file required");
          const parsed = createOpenClawInvitePromptSchema.parse(payload);
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.post<unknown>(
            `/api/companies/${ctx.companyId}/openclaw/invite-prompt`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    invite
      .command("get")
      .description("Look up an invite by token")
      .argument("<token>", "Invite token")
      .action(async (token: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>(
            `/api/invites/${encodeURIComponent(token)}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  for (const [verb, path] of [
    ["onboarding", "onboarding"],
    ["onboarding-text", "onboarding.txt"],
    ["skills-index", "skills/index"],
    ["test-resolution", "test-resolution"],
  ] as const) {
    addCommonClientOptions(
      invite
        .command(verb)
        .description(`Get an invite's ${verb}`)
        .argument("<token>", "Invite token")
        .action(async (token: string, opts: BaseClientOptions) => {
          try {
            const ctx = resolveCommandContext(opts);
            const row = await ctx.api.get<unknown>(
              `/api/invites/${encodeURIComponent(token)}/${path}`,
            );
            printOutput(row, { json: ctx.json });
          } catch (err) {
            handleCommandError(err);
          }
        }),
      { includeCompany: false },
    );
  }

  addCommonClientOptions(
    invite
      .command("skill")
      .description("Get a single invite skill by name")
      .argument("<token>", "Invite token")
      .argument("<skillName>", "Skill name")
      .action(async (token: string, skillName: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>(
            `/api/invites/${encodeURIComponent(token)}/skills/${encodeURIComponent(skillName)}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    invite
      .command("accept")
      .description("Accept an invite (joining a company)")
      .argument("<token>", "Invite token")
      .option("--payload <json>", "Accept payload as JSON object")
      .option("--payload-file <path>", "Read accept payload from JSON file")
      .action(async (token: string, opts: PayloadOptions) => {
        try {
          const payload = (readJson(opts, "payload") as Record<string, unknown> | undefined) ?? {};
          const parsed = acceptInviteSchema.parse(payload);
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/invites/${encodeURIComponent(token)}/accept`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    invite
      .command("revoke")
      .description("Revoke an invite by ID")
      .argument("<inviteId>", "Invite ID")
      .action(async (inviteId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/invites/${encodeURIComponent(inviteId)}/revoke`,
            {},
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ── join requests ───────────────────────────────────────────────────────
  const joinRequest = program
    .command("join-request")
    .description("Company join request operations");

  addCommonClientOptions(
    joinRequest
      .command("list")
      .description("List join requests for a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: CompanyOnly) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<unknown[]>(
            `/api/companies/${ctx.companyId}/join-requests`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  for (const verb of ["approve", "reject"] as const) {
    addCommonClientOptions(
      joinRequest
        .command(verb)
        .description(`${verb[0].toUpperCase()}${verb.slice(1)} a join request`)
        .requiredOption("-C, --company-id <id>", "Company ID")
        .argument("<requestId>", "Join request ID")
        .action(async (requestId: string, opts: CompanyOnly) => {
          try {
            const ctx = resolveCommandContext(opts, { requireCompany: true });
            const row = await ctx.api.post<unknown>(
              `/api/companies/${ctx.companyId}/join-requests/${encodeURIComponent(requestId)}/${verb}`,
              {},
            );
            printOutput(row, { json: ctx.json });
          } catch (err) {
            handleCommandError(err);
          }
        }),
      { includeCompany: false },
    );
  }

  addCommonClientOptions(
    joinRequest
      .command("claim-api-key")
      .description("Claim the API key for an approved join request via secret")
      .argument("<requestId>", "Join request ID")
      .option("--payload <json>", "Claim payload { claimSecret } as JSON")
      .option("--payload-file <path>", "Read claim payload from JSON file")
      .action(async (requestId: string, opts: PayloadOptions) => {
        try {
          const payload = readJson(opts, "payload");
          if (payload === undefined) throw new Error("--payload or --payload-file required");
          const parsed = claimJoinRequestApiKeySchema.parse(payload);
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/join-requests/${encodeURIComponent(requestId)}/claim-api-key`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ── members ─────────────────────────────────────────────────────────────
  const member = program.command("member").description("Company member operations");

  addCommonClientOptions(
    member
      .command("list")
      .description("List members in a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: CompanyOnly) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<unknown[]>(
            `/api/companies/${ctx.companyId}/members`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    member
      .command("user-directory")
      .description("List the user directory for a company (users + agents)")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .action(async (opts: CompanyOnly) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const rows = (await ctx.api.get<unknown[]>(
            `/api/companies/${ctx.companyId}/user-directory`,
          )) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    member
      .command("update")
      .description("Update a member's role")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .argument("<memberId>", "Member ID")
      .option("--payload <json>", "Patch as JSON object")
      .option("--payload-file <path>", "Read patch from JSON file")
      .action(async (memberId: string, opts: PayloadOptions & CompanyOnly) => {
        try {
          const payload = readJson(opts, "payload");
          if (payload === undefined) throw new Error("--payload or --payload-file required");
          const parsed = updateCompanyMemberSchema.parse(payload);
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.patch<unknown>(
            `/api/companies/${ctx.companyId}/members/${encodeURIComponent(memberId)}`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    member
      .command("role-and-grants")
      .description("Update a member's role and permission grants together")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .argument("<memberId>", "Member ID")
      .option("--payload <json>", "Patch as JSON object")
      .option("--payload-file <path>", "Read patch from JSON file")
      .action(async (memberId: string, opts: PayloadOptions & CompanyOnly) => {
        try {
          const payload = readJson(opts, "payload");
          if (payload === undefined) throw new Error("--payload or --payload-file required");
          const parsed = updateCompanyMemberWithPermissionsSchema.parse(payload);
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.patch<unknown>(
            `/api/companies/${ctx.companyId}/members/${encodeURIComponent(memberId)}/role-and-grants`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    member
      .command("archive")
      .description("Archive a member from a company")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .argument("<memberId>", "Member ID")
      .option("--payload <json>", "Archive payload as JSON")
      .option("--payload-file <path>", "Read archive payload from JSON file")
      .action(async (memberId: string, opts: PayloadOptions & CompanyOnly) => {
        try {
          const payload = (readJson(opts, "payload") as Record<string, unknown> | undefined) ?? {};
          const parsed = archiveCompanyMemberSchema.parse(payload);
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.post<unknown>(
            `/api/companies/${ctx.companyId}/members/${encodeURIComponent(memberId)}/archive`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    member
      .command("permissions")
      .description("Update a member's permission grants")
      .requiredOption("-C, --company-id <id>", "Company ID")
      .argument("<memberId>", "Member ID")
      .option("--payload <json>", "Permissions patch as JSON")
      .option("--payload-file <path>", "Read permissions patch from JSON file")
      .action(async (memberId: string, opts: PayloadOptions & CompanyOnly) => {
        try {
          const payload = readJson(opts, "payload");
          if (payload === undefined) throw new Error("--payload or --payload-file required");
          const parsed = updateMemberPermissionsSchema.parse(payload);
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const row = await ctx.api.patch<unknown>(
            `/api/companies/${ctx.companyId}/members/${encodeURIComponent(memberId)}/permissions`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ── admin users ─────────────────────────────────────────────────────────
  const adminUser = program
    .command("admin-user")
    .description("Instance admin user operations");

  addCommonClientOptions(
    adminUser
      .command("list")
      .description("List instance users")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const rows = (await ctx.api.get<unknown[]>("/api/admin/users")) ?? [];
          printOutput(rows, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  for (const verb of ["promote-instance-admin", "demote-instance-admin"] as const) {
    addCommonClientOptions(
      adminUser
        .command(verb)
        .description(`${verb.replace("-", " ")} for a user`)
        .argument("<userId>", "User ID")
        .action(async (userId: string, opts: BaseClientOptions) => {
          try {
            const ctx = resolveCommandContext(opts);
            const row = await ctx.api.post<unknown>(
              `/api/admin/users/${encodeURIComponent(userId)}/${verb}`,
              {},
            );
            printOutput(row, { json: ctx.json });
          } catch (err) {
            handleCommandError(err);
          }
        }),
      { includeCompany: false },
    );
  }

  addCommonClientOptions(
    adminUser
      .command("company-access-get")
      .description("List the companies a user has access to")
      .argument("<userId>", "User ID")
      .action(async (userId: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>(
            `/api/admin/users/${encodeURIComponent(userId)}/company-access`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    adminUser
      .command("company-access-set")
      .description("Replace the companies a user has access to")
      .argument("<userId>", "User ID")
      .option("--payload <json>", "Update payload as JSON object")
      .option("--payload-file <path>", "Read payload from JSON file")
      .action(async (userId: string, opts: PayloadOptions) => {
        try {
          const payload = readJson(opts, "payload");
          if (payload === undefined) throw new Error("--payload or --payload-file required");
          const parsed = updateUserCompanyAccessSchema.parse(payload);
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.put<unknown>(
            `/api/admin/users/${encodeURIComponent(userId)}/company-access`,
            parsed,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ── skills catalog (instance-wide) ──────────────────────────────────────
  const catalog = program
    .command("skill-catalog")
    .description("Instance-wide skill catalog (built-in / available)");

  addCommonClientOptions(
    catalog
      .command("available")
      .description("List skills available on this instance")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>("/api/skills/available");
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    catalog
      .command("index")
      .description("Get the skills index")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>("/api/skills/index");
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    catalog
      .command("get")
      .description("Get one skill from the catalog")
      .argument("<skillName>", "Skill name")
      .action(async (skillName: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>(
            `/api/skills/${encodeURIComponent(skillName)}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  // ── board claim ─────────────────────────────────────────────────────────
  const boardClaim = program
    .command("board-claim")
    .description("Board admin claim flow");

  addCommonClientOptions(
    boardClaim
      .command("get")
      .description("Inspect a board claim token")
      .argument("<token>", "Claim token")
      .action(async (token: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.get<unknown>(
            `/api/board-claim/${encodeURIComponent(token)}`,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );

  addCommonClientOptions(
    boardClaim
      .command("claim")
      .description("Claim a board claim token (becomes board admin)")
      .argument("<token>", "Claim token")
      .option("--payload <json>", "Optional claim body as JSON")
      .option("--payload-file <path>", "Read claim body from JSON file")
      .action(async (token: string, opts: PayloadOptions) => {
        try {
          const payload = readJson(opts, "payload") ?? {};
          const ctx = resolveCommandContext(opts);
          const row = await ctx.api.post<unknown>(
            `/api/board-claim/${encodeURIComponent(token)}/claim`,
            payload,
          );
          printOutput(row, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
