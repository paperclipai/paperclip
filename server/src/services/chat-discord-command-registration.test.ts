import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createDiscordCommandRegistration,
  discordPaperclipCommandDefinition,
  parseDiscordCommandRegistration,
  reconcileDiscordCommandRegistration,
  type DiscordCommandRegistration,
  type ReconcileDiscordCommandRegistrationOptions,
} from "./chat-discord-command-registration.js";

const scope = {
  companyId: "11111111-1111-4111-8111-111111111111",
  endpointId: "22222222-2222-4222-8222-222222222222",
  applicationId: "123456789012345678",
  guildId: "234567890123456789",
};
const runtimeFence = { generation: 2, credentialFingerprint: "a".repeat(64) };
const commandId = "345678901234567890";
const version = "456789012345678901";
const secret = "SYNTHETIC-BOT-SECRET";
const json = (body: unknown, status = 200) => Response.json(body, { status });
function fixture() {
  let stored = createDiscordCommandRegistration(scope);
  const unrelated = {
    id: "567890123456789012",
    application_id: scope.applicationId,
    version,
    type: 1,
    name: "customer",
    description: "Customer-owned command",
  };
  let commands: Record<string, unknown>[] = [unrelated];
  const order: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    expect(String(url)).toMatch(
      /^https:\/\/discord\.com\/api\/v10\/applications\/123456789012345678\/commands(?:\/345678901234567890)?$/,
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bot ${secret}`,
    );
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const method = init?.method ?? "GET";
    order.push(method);
    if (method === "GET") return json(commands);
    expect(stored.phase).toBe("attempted");
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual(discordPaperclipCommandDefinition(stored.ownerId));
    expect(["POST", "PATCH"]).toContain(method);
    if (method === "PATCH")
      expect(String(url).endsWith(`/${commandId}`)).toBe(true);
    const result = {
      ...body,
      id: commandId,
      application_id: scope.applicationId,
      version,
    };
    commands = [
      ...commands.filter((command) => command.id !== commandId),
      result,
    ];
    return json(result, method === "POST" ? 201 : 200);
  });
  const commit = vi.fn(
    async (
      expected: DiscordCommandRegistration,
      next: DiscordCommandRegistration,
    ) => {
      expect(expected).toEqual(stored);
      order.push(`persist:${next.phase}`);
      stored = JSON.parse(JSON.stringify(next));
    },
  );
  const authorize = vi.fn(async () => undefined);
  const options = (): ReconcileDiscordCommandRegistrationOptions => ({
    scope,
    state: JSON.parse(JSON.stringify(stored)),
    runtimeFence,
    verifiedIdentity: {
      botExternalId: scope.applicationId,
      providerAccountId: scope.guildId,
    },
    botToken: secret,
    fetch,
    authorize,
    commit,
    requestTimeoutMs: 1000,
  });
  return {
    options,
    fetch,
    commit,
    authorize,
    order,
    unrelated,
    get stored() {
      return stored;
    },
    set stored(value: DiscordCommandRegistration) {
      stored = structuredClone(value);
    },
    get commands() {
      return commands;
    },
    set commands(value: Record<string, unknown>[]) {
      commands = value;
    },
  };
}

describe("Discord owned native-command registration", () => {
  async function priorCopyFixture() {
    const f = fixture();
    await reconcileDiscordCommandRegistration(f.options());
    const prior = discordPaperclipCommandDefinition(f.stored.ownerId);
    prior.options[2]!.description = "Close the current Paperclip task";
    if (f.stored.phase !== "registered") throw new Error("Missing receipt");
    f.stored = {
      ...f.stored,
      receipt: {
        ...f.stored.receipt,
        definitionDigest: createHash("sha256")
          .update(JSON.stringify(prior))
          .digest("hex"),
      },
    };
    f.commands[1] = {
      ...prior,
      id: commandId,
      application_id: scope.applicationId,
      version,
    };
    f.order.length = 0;
    f.commit.mockClear();
    return f;
  }

  it("upgrades the exact prior close description using its retained owner, command and version", async () => {
    const f = await priorCopyFixture();
    expect(parseDiscordCommandRegistration(f.stored, scope)).toBeNull();
    expect(parseDiscordCommandRegistration(f.stored, scope, true)).toEqual(
      f.stored,
    );
    await expect(
      reconcileDiscordCommandRegistration(f.options()),
    ).resolves.toMatchObject({ kind: "registered" });
    expect(f.order).toEqual([
      "GET",
      "persist:attempted",
      "PATCH",
      "persist:registered",
    ]);
    expect(f.commands[0]).toEqual(f.unrelated);
    expect(f.commands[1]).toMatchObject({
      id: commandId,
      ...discordPaperclipCommandDefinition(f.stored.ownerId),
    });
  });

  it.each(["version", "custom", "foreign"])(
    "does not migrate prior copy over a %s remote change",
    async (change) => {
      const f = await priorCopyFixture();
      if (change === "version") f.commands[1]!.version = "456789012345678902";
      if (change === "custom")
        (
          f.commands[1]!.options as Array<{ description: string }>
        )[2]!.description = "Custom operator behavior";
      if (change === "foreign") f.commands[1]!.description = "Foreign owner";
      await expect(
        reconcileDiscordCommandRegistration(f.options()),
      ).resolves.toMatchObject({ kind: "conflict" });
      expect(f.order).toEqual(["GET"]);
      expect(f.commit).not.toHaveBeenCalled();
    },
  );

  it("reconciles a lost prior-copy PATCH receipt without repeating the write", async () => {
    const f = await priorCopyFixture();
    const send = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      const response = await send(url, init);
      if (init?.method === "PATCH") throw new Error("synthetic lost receipt");
      return response;
    });
    await expect(
      reconcileDiscordCommandRegistration(f.options()),
    ).resolves.toMatchObject({ kind: "unknown" });
    f.fetch.mockImplementation(send);
    f.order.length = 0;
    await expect(
      reconcileDiscordCommandRegistration(f.options()),
    ).resolves.toMatchObject({ kind: "registered" });
    expect(f.order).toEqual(["GET", "persist:registered"]);
  });

  it("does not replay an ambiguous upgrade while GET still shows the prior copy", async () => {
    const f = await priorCopyFixture();
    const send = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      if (init?.method === "PATCH")
        throw new Error("synthetic indeterminate write");
      return send(url, init);
    });
    await expect(
      reconcileDiscordCommandRegistration(f.options()),
    ).resolves.toMatchObject({ kind: "unknown" });
    f.fetch.mockImplementation(send);
    f.order.length = 0;
    await expect(
      reconcileDiscordCommandRegistration(f.options()),
    ).resolves.toMatchObject({ kind: "unknown" });
    expect(f.order).toEqual(["GET"]);
  });

  it("does not recognize arbitrary prior digests or unconfirmed prior write attempts", async () => {
    const f = await priorCopyFixture();
    if (f.stored.phase !== "registered") throw new Error("Missing receipt");
    const { receipt, ...base } = f.stored;
    for (const invalid of [
      { ...base, receipt: { ...receipt, definitionDigest: "a".repeat(64) } },
      {
        ...base,
        phase: "attempted",
        attempt: {
          operation: "update",
          commandId,
          definitionDigest: receipt.definitionDigest,
          runtimeFence,
        },
      },
    ]) {
      expect(parseDiscordCommandRegistration(invalid, scope, true)).toBeNull();
      await expect(
        reconcileDiscordCommandRegistration({ ...f.options(), state: invalid }),
      ).rejects.toThrow("Invalid Discord command registration authority");
    }
    expect(f.order).toEqual([]);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("describes closing a conversation without claiming to close the Paperclip task", () => {
    const definition = discordPaperclipCommandDefinition(
      createDiscordCommandRegistration(scope).ownerId,
    );
    expect(
      definition.options.find((option) => option.name === "close"),
    ).toMatchObject({ description: "Close the current chat conversation" });
  });

  it("creates one namespaced command after durable intent and preserves unrelated commands", async () => {
    const f = fixture();
    const result = await reconcileDiscordCommandRegistration(f.options());
    expect(result).toMatchObject({
      kind: "registered",
      state: { phase: "registered", receipt: { commandId, version } },
    });
    expect(f.order).toEqual([
      "GET",
      "persist:attempted",
      "POST",
      "persist:registered",
    ]);
    expect(f.commands[0]).toEqual(f.unrelated);
    f.order.length = 0;
    await expect(
      reconcileDiscordCommandRegistration(f.options()),
    ).resolves.toMatchObject({ kind: "registered" });
    expect(f.order).toEqual(["GET"]);
  });

  it("refuses an existing unowned namespace even if its command shape looks familiar", async () => {
    const f = fixture();
    f.commands = [
      {
        ...discordPaperclipCommandDefinition("b".repeat(32)),
        id: commandId,
        application_id: scope.applicationId,
        version,
      },
    ];
    await expect(
      reconcileDiscordCommandRegistration(f.options()),
    ).resolves.toEqual({ kind: "conflict", reason: "unowned_namespace" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("leaves customer-owned status, new and close commands untouched", async () => {
    const f = fixture();
    const generic = ["status", "new", "close"].map((name, index) => ({
      ...f.unrelated,
      id: String(BigInt(f.unrelated.id) + BigInt(index + 1)),
      name,
    }));
    f.commands = [f.unrelated, ...generic];
    await expect(
      reconcileDiscordCommandRegistration(f.options()),
    ).resolves.toMatchObject({ kind: "registered" });
    expect(f.commands.slice(0, 4)).toEqual([f.unrelated, ...generic]);
    expect(f.commands[4]!.name).toBe("paperclip");
  });

  it("reconciles a committed create after lost response without sending another POST", async () => {
    const f = fixture();
    const send = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      const response = await send(url, init);
      if (init?.method === "POST")
        throw new Error(`${secret}: socket lost after provider commit`);
      return response;
    });
    await expect(
      reconcileDiscordCommandRegistration(f.options()),
    ).resolves.toMatchObject({
      kind: "unknown",
      state: { phase: "attempted" },
    });
    f.fetch.mockImplementation(send);
    f.order.length = 0;
    await expect(
      reconcileDiscordCommandRegistration(f.options()),
    ).resolves.toMatchObject({ kind: "registered" });
    expect(f.order).toEqual(["GET", "persist:registered"]);
    expect(JSON.stringify(f.stored)).not.toContain(secret);
  });

  it("leaves an absent command after a timed-out attempt unknown instead of blindly creating again", async () => {
    const f = fixture();
    const send = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      if (init?.method === "POST") throw new Error(secret);
      return send(url, init);
    });
    await expect(
      reconcileDiscordCommandRegistration(f.options()),
    ).resolves.toMatchObject({ kind: "unknown" });
    f.fetch.mockImplementation(send);
    f.order.length = 0;
    await expect(
      reconcileDiscordCommandRegistration(f.options()),
    ).resolves.toMatchObject({ kind: "unknown" });
    expect(f.order).toEqual(["GET"]);
    expect(f.stored.phase).toBe("attempted");
  });

  it("updates only the registered owned command ID and narrows its definition", async () => {
    const f = fixture();
    await reconcileDiscordCommandRegistration(f.options());
    f.commands[1]!.contexts = [0, 1, 2];
    f.commands[1]!.integration_types = [0, 1];
    f.commands[1]!.options = [];
    f.order.length = 0;
    await expect(
      reconcileDiscordCommandRegistration(f.options()),
    ).resolves.toMatchObject({ kind: "registered" });
    expect(f.order).toEqual([
      "GET",
      "persist:attempted",
      "PATCH",
      "persist:registered",
    ]);
    expect(f.commands[0]).toEqual(f.unrelated);
    expect(f.commands[1]).toMatchObject({
      contexts: [0, 1],
      integration_types: [0],
    });
  });

  it("does not reclaim a deleted, renamed or unmarked registered command", async () => {
    for (const mutation of ["deleted", "renamed", "marker_removed", "new_id"]) {
      const f = fixture();
      await reconcileDiscordCommandRegistration(f.options());
      if (mutation === "deleted") f.commands = [f.unrelated];
      if (mutation === "renamed") f.commands[1]!.name = "customer_controls";
      if (mutation === "marker_removed")
        f.commands[1]!.description = "Customer now owns this command";
      if (mutation === "new_id") f.commands[1]!.id = "678901234567890123";
      f.order.length = 0;
      await expect(
        reconcileDiscordCommandRegistration(f.options()),
      ).resolves.toEqual({ kind: "conflict", reason: "owned_command_changed" });
      expect(f.order).toEqual(["GET"]);
    }
  });

  it("requires exact definition and known update ID when reconciling an unknown write", async () => {
    const f = fixture();
    await reconcileDiscordCommandRegistration(f.options());
    f.commands[1]!.options = [];
    const send = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      if (init?.method === "PATCH") throw new Error(secret);
      return send(url, init);
    });
    await expect(
      reconcileDiscordCommandRegistration(f.options()),
    ).resolves.toMatchObject({ kind: "unknown" });
    f.fetch.mockImplementation(send);
    f.order.length = 0;
    await expect(
      reconcileDiscordCommandRegistration(f.options()),
    ).resolves.toMatchObject({ kind: "unknown" });
    expect(f.order).toEqual(["GET"]);
    f.commands[1] = {
      ...discordPaperclipCommandDefinition(f.stored.ownerId),
      id: "678901234567890123",
      application_id: scope.applicationId,
      version,
    };
    await expect(
      reconcileDiscordCommandRegistration(f.options()),
    ).resolves.toMatchObject({ kind: "conflict" });
  });

  it("does not write before durable intent and can reconcile a failed receipt save", async () => {
    const f = fixture();
    f.commit.mockRejectedValueOnce(new Error(secret));
    await expect(
      reconcileDiscordCommandRegistration(f.options()),
    ).rejects.toThrow("persistence unproven");
    expect(f.order).toEqual(["GET"]);
    expect(f.stored.phase).toBe("prepared");
    const persist = f.commit.getMockImplementation()!;
    f.commit.mockImplementation(async (before, next) => {
      if (next.phase === "registered") throw new Error(secret);
      await persist(before, next);
    });
    await expect(
      reconcileDiscordCommandRegistration(f.options()),
    ).rejects.toThrow("persistence unproven");
    expect(f.stored.phase).toBe("attempted");
    f.commit.mockImplementation(persist);
    f.order.length = 0;
    await expect(
      reconcileDiscordCommandRegistration(f.options()),
    ).resolves.toMatchObject({ kind: "registered" });
    expect(f.order).toEqual(["GET", "persist:registered"]);
  });

  it("rechecks authorization after read and after receipt without claiming success on revocation", async () => {
    const f = fixture();
    f.authorize.mockImplementation(async (stage?: string) => {
      if (stage === "before_write") throw new Error(secret);
    });
    await expect(
      reconcileDiscordCommandRegistration(f.options()),
    ).rejects.toThrow("authorization denied");
    expect(f.order).toEqual(["GET", "persist:attempted"]);
    const g = fixture();
    g.authorize.mockImplementation(async (stage?: string) => {
      if (stage === "before_receipt") throw new Error(secret);
    });
    await expect(
      reconcileDiscordCommandRegistration(g.options()),
    ).rejects.toThrow("authorization denied");
    expect(g.stored.phase).toBe("attempted");
  });

  it("rejects wrong application, guild, scope and malformed durable ownership before HTTP", async () => {
    const f = fixture();
    for (const override of [
      {
        verifiedIdentity: {
          botExternalId: scope.guildId,
          providerAccountId: scope.guildId,
        },
      },
      {
        verifiedIdentity: {
          botExternalId: scope.applicationId,
          providerAccountId: scope.applicationId,
        },
      },
      { scope: { ...scope, endpointId: scope.companyId } },
      { state: { ...f.stored, ownerId: "guessed" } },
      { state: { ...f.stored, botToken: secret } },
      { runtimeFence: { ...runtimeFence, generation: -1 } },
    ]) {
      await expect(
        reconcileDiscordCommandRegistration({ ...f.options(), ...override }),
      ).rejects.toThrow("Invalid Discord command registration authority");
    }
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("enforces Discord command limits without deleting customer commands", async () => {
    const f = fixture();
    const body = discordPaperclipCommandDefinition(f.stored.ownerId);
    expect(body.name.length).toBeLessThanOrEqual(32);
    expect(body.description.length).toBeLessThanOrEqual(100);
    expect(body.options).toHaveLength(3);
    expect(
      body.options.every(
        (option) =>
          option.name.length <= 32 && option.description.length <= 100,
      ),
    ).toBe(true);
    expect(body).toMatchObject({
      default_member_permissions: null,
      integration_types: [0],
      contexts: [0, 1],
    });
    f.commands = Array.from({ length: 100 }, (_, index) => ({
      ...f.unrelated,
      id: String(BigInt(commandId) + BigInt(index)),
      name: `customer_${index}`,
    }));
    await expect(
      reconcileDiscordCommandRegistration(f.options()),
    ).resolves.toEqual({ kind: "conflict", reason: "command_limit" });
    expect(f.order).toEqual(["GET"]);
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("retains structured rate-limit delay but never exposes provider text or credentials", async () => {
    const f = fixture();
    f.fetch.mockResolvedValue(
      json(
        { message: `${secret} private details`, retry_after: 172800.5 },
        429,
      ),
    );
    await expect(
      reconcileDiscordCommandRegistration(f.options()),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "request_failed",
      retryAfterSeconds: 172800.5,
    });
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("bounds stalled transport and response bytes", async () => {
    const f = fixture();
    f.fetch.mockImplementation(
      async () => new Promise<Response>(() => undefined),
    );
    await expect(
      reconcileDiscordCommandRegistration({
        ...f.options(),
        requestTimeoutMs: 5,
      }),
    ).resolves.toEqual({ kind: "unavailable", reason: "request_failed" });
    f.fetch.mockResolvedValue(
      new Response(`"${"x".repeat(2 * 1024 * 1024)}"`, {
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      reconcileDiscordCommandRegistration(f.options()),
    ).resolves.toEqual({ kind: "unavailable", reason: "invalid_response" });
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("does not accept foreign or duplicate command-list identities", async () => {
    for (const commands of [
      [
        {
          id: commandId,
          application_id: scope.guildId,
          version,
          type: 1,
          name: "customer",
          description: "Customer",
        },
      ],
      Array.from({ length: 2 }, () => ({
        id: commandId,
        application_id: scope.applicationId,
        version,
        type: 1,
        name: "customer",
        description: "Customer",
      })),
    ]) {
      const f = fixture();
      f.commands = commands;
      await expect(
        reconcileDiscordCommandRegistration(f.options()),
      ).resolves.toEqual({ kind: "unavailable", reason: "invalid_response" });
      expect(f.commit).not.toHaveBeenCalled();
    }
  });

  it("does not treat a prepared descriptor's public marker as proof of an earlier write", async () => {
    const f = fixture();
    f.commands = [
      {
        ...discordPaperclipCommandDefinition(f.stored.ownerId),
        id: commandId,
        application_id: scope.applicationId,
        version,
      },
    ];
    await expect(
      reconcileDiscordCommandRegistration(f.options()),
    ).resolves.toEqual({ kind: "conflict", reason: "unowned_namespace" });
    expect(f.commit).not.toHaveBeenCalled();
    expect(
      parseDiscordCommandRegistration(
        { ...f.stored, credential: secret },
        scope,
      ),
    ).toBeNull();
  });

  it("allows only one writer when concurrent callers race the durable descriptor CAS", async () => {
    const f = fixture();
    const first = f.options();
    const second = f.options();
    const outcomes = await Promise.allSettled([
      reconcileDiscordCommandRegistration(first),
      reconcileDiscordCommandRegistration(second),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    expect(
      f.fetch.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(f.stored.phase).toBe("registered");
  });

  it("snapshots HTTP authority before an asynchronous gate and freezes journal candidates", async () => {
    const f = fixture();
    let release!: () => void;
    let observed!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      observed = resolve;
    });
    f.authorize.mockImplementationOnce(async () => {
      observed();
      await held;
    });
    const options = f.options();
    options.scope = { ...scope };
    const run = reconcileDiscordCommandRegistration(options);
    await started;
    options.scope.applicationId = scope.guildId;
    options.botToken = "foreign-secret";
    options.fetch = vi.fn(async () => {
      throw new Error("wrong fetch");
    });
    release();
    await expect(run).resolves.toMatchObject({ kind: "registered" });
    expect(
      f.commit.mock.calls.every(
        ([before, next]) =>
          Object.isFrozen(before) &&
          Object.isFrozen(next) &&
          Object.isFrozen(next.scope),
      ),
    ).toBe(true);
  });
});
