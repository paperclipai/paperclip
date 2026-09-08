import { describe, expect, it } from "vitest";
import {
  composioChildParentConnectionId,
  composioChildToolkitSlug,
  composioServiceIsSettling,
  composioServiceRowFromStatus,
  composioServiceRows,
  composioServiceStateFor,
  isComposioBrokerConnection,
  type ComposioServicesResponse,
} from "./composio-services";
import { BROKER_ONLY_APP_TABS, CONNECTED_ONLY_APP_TABS } from "./app-tabs";

function toolkit(slug: string, over: Record<string, unknown> = {}) {
  return {
    slug,
    name: slug.toUpperCase(),
    meta: { description: `${slug} desc`, logo: `https://logo/${slug}.png`, tools_count: 3 },
    ...over,
  };
}

function listResponse(
  services: ComposioServicesResponse["services"],
): ComposioServicesResponse {
  return { parentConnectionId: "parent-1", userId: "paperclip:company-1", services };
}

describe("composioServiceStateFor", () => {
  it("reads ACTIVE as connected regardless of casing", () => {
    expect(composioServiceStateFor("ACTIVE")).toBe("connected");
    expect(composioServiceStateFor("active")).toBe("connected");
  });

  it("reads a missing account as not connected", () => {
    expect(composioServiceStateFor(null)).toBe("not_connected");
    expect(composioServiceStateFor(undefined)).toBe("not_connected");
    expect(composioServiceStateFor("  ")).toBe("not_connected");
  });

  it("reads an unusable credential as attention, not pending", () => {
    for (const status of ["EXPIRED", "INACTIVE", "DISABLED", "FAILED", "REVOKED", "ERROR"]) {
      expect(composioServiceStateFor(status)).toBe("attention");
    }
  });

  /**
   * The fallback direction matters: an unrecognized status must read as "still
   * working on it" so a status Composio adds later shows a spinner the poll will
   * clear, rather than a wrong terminal verdict the user cannot act on.
   */
  it("treats an unknown in-flight status as pending", () => {
    expect(composioServiceStateFor("INITIALIZING")).toBe("pending");
    expect(composioServiceStateFor("INITIATED")).toBe("pending");
    expect(composioServiceStateFor("SOME_FUTURE_STATUS")).toBe("pending");
  });
});

describe("composioServiceRows", () => {
  it("renders all three design states from one payload", () => {
    const rows = composioServiceRows(listResponse([
      {
        toolkit: toolkit("gmail"),
        status: "not_connected",
        connectedAccountId: null,
        connectedAccountStatus: null,
        childConnectionId: null,
      },
      {
        toolkit: toolkit("github"),
        status: "connected",
        connectedAccountId: "ca-1",
        connectedAccountStatus: "ACTIVE",
        childConnectionId: "child-1",
      },
      {
        toolkit: toolkit("slack"),
        status: "pending",
        connectedAccountId: "ca-2",
        connectedAccountStatus: "INITIALIZING",
        childConnectionId: null,
      },
    ]));

    expect(rows.map((row) => [row.toolkitSlug, row.state])).toEqual([
      ["github", "connected"],
      ["slack", "pending"],
      ["gmail", "not_connected"],
    ]);
  });

  it("carries the child connection id so a connected row can link to it", () => {
    const [row] = composioServiceRows(listResponse([{
      toolkit: toolkit("github"),
      status: "connected",
      connectedAccountId: "ca-1",
      connectedAccountStatus: "ACTIVE",
      childConnectionId: "child-1",
    }]));
    expect(row!.childConnectionId).toBe("child-1");
    expect(row!.logoUrl).toBe("https://logo/github.png");
    expect(row!.toolCount).toBe(3);
  });

  /**
   * The server's own `status` field only knows connected/pending/not_connected, so
   * an expired account arrives labelled `pending`. Deriving state from the account
   * status instead is what keeps that row from showing a spinner forever.
   */
  it("classifies an expired account as attention even when the server said pending", () => {
    const [row] = composioServiceRows(listResponse([{
      toolkit: toolkit("github"),
      status: "pending",
      connectedAccountId: "ca-1",
      connectedAccountStatus: "EXPIRED",
      childConnectionId: "child-1",
    }]));
    expect(row!.state).toBe("attention");
  });

  it("sorts attention first, then connected, then pending, then the alphabetical tail", () => {
    const rows = composioServiceRows(listResponse([
      { toolkit: toolkit("zoom"), status: "not_connected", connectedAccountId: null, connectedAccountStatus: null, childConnectionId: null },
      { toolkit: toolkit("asana"), status: "not_connected", connectedAccountId: null, connectedAccountStatus: null, childConnectionId: null },
      { toolkit: toolkit("slack"), status: "pending", connectedAccountId: "c", connectedAccountStatus: "INITIALIZING", childConnectionId: null },
      { toolkit: toolkit("github"), status: "connected", connectedAccountId: "c", connectedAccountStatus: "ACTIVE", childConnectionId: "x" },
      { toolkit: toolkit("gmail"), status: "connected", connectedAccountId: "c", connectedAccountStatus: "EXPIRED", childConnectionId: "y" },
    ]));
    expect(rows.map((row) => row.toolkitSlug)).toEqual(["gmail", "github", "slack", "asana", "zoom"]);
  });

  it("tolerates a missing payload and missing toolkit metadata", () => {
    expect(composioServiceRows(undefined)).toEqual([]);
    const [row] = composioServiceRows(listResponse([{
      toolkit: { slug: "bare", name: "" },
      status: "not_connected",
      connectedAccountId: null,
      connectedAccountStatus: null,
      childConnectionId: null,
    }]));
    expect(row!.name).toBe("bare");
    expect(row!.description).toBeNull();
    expect(row!.logoUrl).toBeNull();
    expect(row!.toolCount).toBeNull();
  });
});

describe("composioServiceRowFromStatus", () => {
  /**
   * The poll endpoint answers a different shape than the list. Normalizing both
   * to one row is what lets a pending row flip to connected in place.
   */
  it("normalizes the poll payload into the same row the list produces", () => {
    const row = composioServiceRowFromStatus({
      toolkit: toolkit("github"),
      account: { id: "ca-1", status: "ACTIVE" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      child: { id: "child-9" } as any,
    });
    expect(row.state).toBe("connected");
    expect(row.childConnectionId).toBe("child-9");
    expect(row.toolkitSlug).toBe("github");
  });

  it("reads no account as not connected", () => {
    const row = composioServiceRowFromStatus({
      toolkit: toolkit("gmail"),
      account: null,
      child: null,
    });
    expect(row.state).toBe("not_connected");
    expect(row.childConnectionId).toBeNull();
  });
});

describe("composioServiceIsSettling", () => {
  it("keeps polling only while a row is pending", () => {
    expect(composioServiceIsSettling("pending")).toBe(true);
    expect(composioServiceIsSettling("connected")).toBe(false);
    expect(composioServiceIsSettling("not_connected")).toBe(false);
    // An unusable credential needs the user, not another poll.
    expect(composioServiceIsSettling("attention")).toBe(false);
  });
});

describe("connection provenance", () => {
  const broker = { config: { sourceTemplateKey: "composio" } };
  const child = {
    config: { provider: "composio", parentConnectionId: "parent-1", toolkitSlug: "github" },
  };

  it("recognizes the broker connection", () => {
    expect(isComposioBrokerConnection(broker)).toBe(true);
  });

  /** The two kinds must not overlap, or a child would grow its own Services tab. */
  it("does not mistake a toolkit child for the broker", () => {
    expect(isComposioBrokerConnection(child)).toBe(false);
    expect(composioChildToolkitSlug(broker)).toBeNull();
  });

  it("ignores unrelated apps", () => {
    expect(isComposioBrokerConnection({ config: { sourceTemplateKey: "github" } })).toBe(false);
    expect(isComposioBrokerConnection({ config: {} })).toBe(false);
    expect(isComposioBrokerConnection(null)).toBe(false);
    expect(composioChildToolkitSlug({ config: { sourceTemplateKey: "github" } })).toBeNull();
    expect(composioChildToolkitSlug(null)).toBeNull();
  });

  it("reads a child's toolkit and parent for the provenance chip", () => {
    expect(composioChildToolkitSlug(child)).toBe("github");
    expect(composioChildParentConnectionId(child)).toBe("parent-1");
  });

  it("reads a child with no parent link as unlinked rather than throwing", () => {
    const orphan = { config: { provider: "composio", toolkitSlug: "github" } };
    expect(composioChildToolkitSlug(orphan)).toBe("github");
    expect(composioChildParentConnectionId(orphan)).toBeNull();
  });
});

describe("Services tab visibility", () => {
  /**
   * Services needs both gates: a live connection to read an API key from, and a
   * broker to have services at all.
   */
  it("is gated on both a connection and a broker", () => {
    expect(CONNECTED_ONLY_APP_TABS.has("services")).toBe(true);
    expect(BROKER_ONLY_APP_TABS.has("services")).toBe(true);
  });

  it("does not gate the ordinary tabs behind broker-only", () => {
    for (const tab of ["review", "permissions"] as const) {
      expect(BROKER_ONLY_APP_TABS.has(tab)).toBe(false);
    }
  });
});
