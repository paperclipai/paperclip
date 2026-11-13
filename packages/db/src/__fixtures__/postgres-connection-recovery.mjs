import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";

const postgres = process.env.DRIVER_FORMAT === "cjs"
  ? createRequire(import.meta.url)("postgres")
  : (await import("postgres")).default;
const mode = process.env.RECOVERY_CASE;
const closed = Promise.withResolvers();
const sql = postgres(process.env.TEST_DATABASE_URL, {
  max: mode === "no-pipeline" || mode === "no-pipeline-fairness" ? 2 : 1,
  max_pipeline: mode?.startsWith("no-pipeline") ? 0 : 1,
  connection: { application_name: `driver-recovery-${mode}` },
  backoff: 0,
  onnotice() {},
  onclose: () => closed.resolve(),
});
const control = postgres(process.env.TEST_DATABASE_URL, { max: 1, onnotice() {} });
const capture = (query) => Promise.resolve(query).then(
  () => { throw new Error("Expected the closed connection to reject"); },
  (error) => error,
);
const terminate = async (pid) => {
  await control.unsafe("select pg_terminate_backend($1)", [pid]);
  await closed.promise;
};

try {
  await control.unsafe("drop table if exists connection_recovery_probe");
  await control.unsafe("create table connection_recovery_probe (id integer)");

  if (mode === "no-pipeline-fairness") {
    const query = "select pg_advisory_xact_lock($1::bigint)";
    const lookup = "select $1::int as value";
    const one = await sql.reserve();
    const two = await sql.reserve();
    for (const connection of [one, two]) {
      await connection.unsafe(query, [900001]);
      await connection.unsafe(lookup, [42]);
    }
    one.release();
    two.release();
    let first;
    let second;
    let fast;
    try {
      await control.unsafe("select pg_advisory_lock(900001), pg_advisory_lock(900002)");
      const waitForBlocked = async (count) => {
        const deadline = performance.now() + 5000;
        let observed = 0;
        while (performance.now() < deadline) {
          const [row] = await control.unsafe("select count(*)::int as count from pg_stat_activity where application_name=$1 and wait_event='advisory'", [`driver-recovery-${mode}`]);
          observed = row.count;
          if (row.count === count) return;
          await setImmediate();
        }
        throw new Error(`Expected ${count} advisory lock waits; observed ${observed}`);
      };
      let firstFinished = false;
      first = sql.unsafe(query, [900001]).then(() => { firstFinished = true; });
      await waitForBlocked(1);
      second = sql.unsafe(query, [900002]).then(() => {});
      await waitForBlocked(2);
      fast = sql.unsafe(lookup, [42]).then((rows) => rows);
      await control.unsafe("select pg_advisory_unlock(900002)");
      assert.equal((await fast)[0].value, 42);
      assert.equal(firstFinished, false, "lookup must progress after one pool connection is released while the other stays blocked");
    } finally {
      await control.unsafe("select pg_advisory_unlock_all()");
      await Promise.allSettled([first, second, fast].filter(Boolean));
    }
  } else if (mode === "no-pipeline" || mode === "no-pipeline-single") {
    await sql.begin(async (tx) => {
      await tx.unsafe("insert into connection_recovery_probe values (1)");
      const results = await Promise.all([
        tx.unsafe("select id from connection_recovery_probe"),
        tx.unsafe("select count(*)::int as count from connection_recovery_probe"),
      ]);
      assert.deepEqual(results[0].map((row) => row.id), [1]);
      assert.equal(results[1][0].count, 1);
      assert.equal((await control.unsafe("select count(*)::int as count from connection_recovery_probe"))[0].count, 0);
    });
    await assert.rejects(sql.begin(async (tx) => {
      await tx.unsafe("insert into connection_recovery_probe values (2)");
      throw new Error("controlled transaction rollback");
    }), /controlled transaction rollback/);
    await sql.begin(async (tx) => {
      await tx.unsafe("insert into connection_recovery_probe values (3)");
      await assert.rejects(tx.savepoint(async (nested) => {
        await nested.unsafe("insert into connection_recovery_probe values (4)");
        throw new Error("controlled savepoint rollback");
      }), /controlled savepoint rollback/);
      assert.deepEqual((await tx.unsafe("select id from connection_recovery_probe order by id")).map((row) => row.id), [1, 3]);
    });
    const reserved = await sql.reserve();
    try {
      assert.deepEqual((await reserved.unsafe("select id from connection_recovery_probe order by id")).map((row) => row.id), [1, 3]);
    } finally {
      reserved.release();
    }
  } else if (mode === "transaction" || mode === "transaction-closed" || mode === "savepoint") {
    const started = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const callbackDone = Promise.withResolvers();
    let lateError;
    const work = async (tx) => {
      const [row] = await tx.unsafe("select pg_backend_pid() as pid");
      await tx.unsafe("insert into connection_recovery_probe values (1)");
      started.resolve(row.pid);
      await resume.promise;
      try {
        await tx.unsafe("insert into connection_recovery_probe values (2)");
      } catch (error) {
        lateError = error;
        throw error;
      } finally {
        callbackDone.resolve();
      }
    };
    const failed = capture(sql.begin((tx) => mode === "savepoint" ? tx.savepoint(work) : work(tx)));
    await terminate(await started.promise);
    assert.equal((await failed).code, "CONNECTION_CLOSED");

    const finishOldCallback = async () => {
      resume.resolve();
      await callbackDone.promise;
      await setImmediate();
      await setImmediate();
      assert.equal(lateError?.code, "CONNECTION_CLOSED");
    };
    if (mode === "transaction-closed") await finishOldCallback();

    // Reuse the physical pool slot before the old callback resumes. The old
    // query and its automatic rollback must not run in this new transaction.
    await sql.begin(async (tx) => {
      await tx.unsafe("insert into connection_recovery_probe values (3)");
      await finishOldCallback();
      await tx.unsafe("insert into connection_recovery_probe values (4)");
    });
    const rows = await sql.unsafe("select id from connection_recovery_probe order by id");
    assert.deepEqual(rows.map((row) => row.id), [3, 4]);
  } else if (mode === "reserve") {
    const reserved = await sql.reserve();
    const [row] = await reserved.unsafe("select pg_backend_pid() as pid");
    await terminate(row.pid);
    assert.equal((await capture(reserved.unsafe("select 1"))).code, "CONNECTION_CLOSED");
    reserved.release();
    const fresh = await sql.reserve();
    try {
      const [freshRow] = await fresh.unsafe("select pg_backend_pid() as pid");
      assert.notEqual(freshRow.pid, row.pid);
      reserved.release();
      assert.equal((await capture(reserved.unsafe("select 1"))).code, "CONNECTION_CLOSED");
      assert.equal((await fresh.unsafe("select 42 as value"))[0].value, 42);
    } finally {
      fresh.release();
    }
  } else if (mode === "transaction-queue" || mode === "reserve-queue") {
    const started = Promise.withResolvers();
    let pending;
    const work = async (tx) => {
      const [row] = await tx.unsafe("select pg_backend_pid() as pid");
      // With max_pipeline=1, later queries stay in the scope's local queue.
      // Disconnect after PostgreSQL starts the first query.
      pending = [0, 1, 2].map(() => capture(tx.unsafe("select pg_sleep(30)")));
      started.resolve(row.pid);
      const errors = await Promise.all(pending);
      assert.ok(errors.every((error) => ["57P01", "CONNECTION_CLOSED"].includes(error.code)));
    };
    const reserved = mode === "reserve-queue" ? await sql.reserve() : null;
    const task = reserved ? work(reserved) : capture(sql.begin(work));
    const pid = await started.promise;
    while (true) {
      const [row] = await control.unsafe("select wait_event from pg_stat_activity where pid = $1", [pid]);
      if (row?.wait_event === "PgSleep") break;
      await setImmediate();
    }
    await terminate(pid);
    await task;
    await Promise.all(pending);
    reserved?.release();
  } else {
    throw new Error("Unknown recovery case");
  }

  assert.equal((await sql.unsafe("select 42 as value"))[0].value, 42);
  await setImmediate();
  console.log("recovered");
} finally {
  await sql.end({ timeout: 1 });
  await control.end({ timeout: 1 });
}
