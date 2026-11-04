import { startNativeSessionExecutionLeaseRenewal, type NativeExecutionLeaseRenewal } from "./native-execution-lease.js";
import { eq } from "drizzle-orm";
import { createDb, closeLivenessDb, livenessDb, nativeRunFinalizations } from "@paperclipai/db";
import { beforeAll, expect, it, vi } from "vitest";
import { nativeRestartFixture, describeEmbeddedPostgres } from "../../__tests__/helpers/native-restart.js";

describeEmbeddedPostgres("native runner restart recovery: lease-renewal", () => {
  const environment = nativeRestartFixture();
  const { seedRun } = environment;
  let temporary: typeof environment.current.temporary;
  let companyId: typeof environment.current.companyId;
  let successor: typeof environment.current.successor;
  beforeAll(() => { ({ temporary, companyId, successor } = environment.current); });

  it("retains remote ownership through two delayed successful liveness-pool renewals", async () => {
    const fixture = await seedRun("DELAYED-RENEWAL-SUCCESS");
    const owner = createDb(temporary.connectionString);
    const pool = livenessDb(owner);
    const input = { db: owner, runId: fixture.runId, companyId, issueId: fixture.issueId,
      controller: successor, leaseOwner: "delayed-renewal-owner", attempt: 1, remote: true,
      onLost: vi.fn(async () => undefined) };
    const initialExpiry = new Date(Date.now() + 60_000);
    await fixture.db.update(nativeRunFinalizations).set({ controllerBootId: successor.bootId,
      controllerPid: successor.pid, controllerProcessStartedAt: successor.processStartedAt,
      leaseOwner: input.leaseOwner, attempt: 1, leaseExpiresAt: initialExpiry })
      .where(eq(nativeRunFinalizations.runId, fixture.runId));
    let release: (() => void) | undefined;
    let occupied: Promise<unknown> | undefined;
    let guard: NativeExecutionLeaseRenewal | undefined;
    const occupyPool = async () => {
      let entered = 0;
      let ready!: () => void;
      const acquired = new Promise<void>(resolve => { ready = resolve; });
      const barrier = new Promise<void>(resolve => { release = resolve; });
      occupied = Promise.all([0, 1].map(() => pool.transaction(async () => {
        if (++entered === 2) ready();
        await barrier;
      })));
      await acquired;
    };
    const savedExpiry = async () => {
      const [saved] = await fixture.db.select({ expires: nativeRunFinalizations.leaseExpiresAt })
        .from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, fixture.runId));
      return saved.expires!.getTime();
    };
    try {
      await occupyPool();
      guard = startNativeSessionExecutionLeaseRenewal(input);
      await new Promise(resolve => setTimeout(resolve, 50_000));
      release!(); await occupied;
      await vi.waitFor(async () => expect(await savedExpiry()).toBeGreaterThan(initialExpiry.getTime() + 40_000));
      const firstExpiry = await savedExpiry();
      await occupyPool();
      await new Promise(resolve => setTimeout(resolve, 40_000));
      release!(); await occupied;
      await vi.waitFor(async () => expect(await savedExpiry()).toBeGreaterThan(firstExpiry + 30_000));
      expect(input.onLost).not.toHaveBeenCalled();
      await guard.stop();
    } finally {
      release?.(); await occupied; await guard?.stop().catch(() => undefined);
      await closeLivenessDb(owner, 1); await owner.$client.end({ timeout: 1 });
    }
  }, 120_000);

});
