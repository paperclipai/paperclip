"""Tests for the transactional reviewer-cost reservation ledger.

No live Postgres: a programmable fake connection records executed SQL and
returns queued ``fetchone`` results, matching this package's mocked-DB style.
The tests exercise the module's control flow — cap math, idempotency
branching, advisory locking, and commit/rollback discipline.
"""
import unittest

import reviewer_reservations as rr


class FakeCursor:
    def __init__(self, conn):
        self._conn = conn

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self._conn.executed.append((" ".join(sql.split()), params))

    def fetchone(self):
        return self._conn.fetch_queue.pop(0)


class FakeConn:
    """Shared fetch queue across cursors; counts commit/rollback."""

    def __init__(self, fetch_queue):
        self.fetch_queue = list(fetch_queue)
        self.executed = []
        self.commits = 0
        self.rollbacks = 0

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    # Test helpers -----------------------------------------------------------
    def sql_log(self):
        return " || ".join(s for s, _ in self.executed)


COMPANY = "company-test"
QUEUE = "queue-test"


class TestCapDecision(unittest.TestCase):
    def test_under_cap(self):
        self.assertTrue(rr._cap_allows(4000, 999))

    def test_exact_cap_boundary_allowed(self):
        self.assertTrue(rr._cap_allows(4000, 1000))  # lands exactly on $50.00

    def test_over_cap_rejected(self):
        self.assertFalse(rr._cap_allows(4000, 1001))

    def test_cap_is_5000_cents(self):
        self.assertEqual(rr.CAP_CENTS, 5000)


class TestReserve(unittest.TestCase):
    def test_fresh_reservation_under_cap_inserts_and_commits(self):
        # fetchone order: find_existing -> None, current sum -> 1000, insert id
        conn = FakeConn([None, {"total_cents": 1000}, {"id": "res-1"}])
        res = rr.reserve(conn, COMPANY, QUEUE, "req-a", 500)
        self.assertEqual(res.outcome, rr.OUTCOME_RESERVED)
        self.assertTrue(res.ok)
        self.assertEqual(res.reservation_id, "res-1")
        self.assertEqual(res.committed_reserved_cents, 1500)
        self.assertEqual(conn.commits, 1)
        self.assertEqual(conn.rollbacks, 0)
        # advisory lock was taken and an INSERT ran
        self.assertIn("pg_advisory_xact_lock", conn.sql_log())
        self.assertIn("INSERT INTO", conn.sql_log())
        self.assertIn("queue_row_id", conn.sql_log())
        self.assertNotIn("staging_row_id", conn.sql_log())

    def test_cap_exceeded_does_not_insert_and_rolls_back(self):
        conn = FakeConn([None, {"total_cents": 4800}])  # 4800 + 500 = 5300 > 5000
        res = rr.reserve(conn, COMPANY, QUEUE, "req-b", 500)
        self.assertEqual(res.outcome, rr.OUTCOME_CAP_EXCEEDED)
        self.assertFalse(res.ok)
        self.assertIsNone(res.reservation_id)
        self.assertEqual(res.committed_reserved_cents, 4800)
        self.assertEqual(conn.commits, 0)
        self.assertEqual(conn.rollbacks, 1)
        self.assertNotIn("INSERT INTO", conn.sql_log())

    def test_exact_boundary_reserves(self):
        conn = FakeConn([None, {"total_cents": 4500}, {"id": "res-x"}])  # +500 == 5000
        res = rr.reserve(conn, COMPANY, QUEUE, "req-edge", 500)
        self.assertEqual(res.outcome, rr.OUTCOME_RESERVED)
        self.assertEqual(res.committed_reserved_cents, 5000)

    def test_idempotent_existing_request_key_does_not_reinsert(self):
        existing = {"id": "res-1", "state": "reserved", "reserved_cents": 500, "actual_cents": None}
        conn = FakeConn([existing, {"total_cents": 1500}])
        res = rr.reserve(conn, COMPANY, QUEUE, "req-a", 500)
        self.assertEqual(res.outcome, rr.OUTCOME_EXISTS)
        self.assertTrue(res.ok)
        self.assertEqual(res.reservation_id, "res-1")
        self.assertNotIn("INSERT INTO", conn.sql_log())
        self.assertEqual(conn.commits, 1)

    def test_negative_amount_rejected(self):
        conn = FakeConn([])
        with self.assertRaises(ValueError):
            rr.reserve(conn, COMPANY, QUEUE, "req", -1)

    def test_tuple_cursor_rows_supported(self):
        # RETURNING/SUM as positional tuples rather than dict rows
        conn = FakeConn([None, (1000,), ("res-9",)])
        res = rr.reserve(conn, COMPANY, QUEUE, "req-t", 500)
        self.assertEqual(res.reservation_id, "res-9")
        self.assertEqual(res.committed_reserved_cents, 1500)

    def test_concurrent_second_reserve_sees_updated_total_and_is_capped(self):
        # Simulate serialization: first reserve commits 4800, second reads 4800.
        c1 = FakeConn([None, {"total_cents": 4500}, {"id": "r1"}])
        r1 = rr.reserve(c1, COMPANY, QUEUE, "k1", 300)  # -> 4800
        self.assertTrue(r1.ok)
        c2 = FakeConn([None, {"total_cents": 4800}])       # second txn, post-lock read
        r2 = rr.reserve(c2, COMPANY, QUEUE, "k2", 300)   # 4800 + 300 = 5100 > cap
        self.assertEqual(r2.outcome, rr.OUTCOME_CAP_EXCEEDED)


class TestSettle(unittest.TestCase):
    def test_settle_reserved_transitions_and_commits(self):
        conn = FakeConn([{"state": "settled"}])
        state = rr.settle(conn, COMPANY, "res-1", 320)
        self.assertEqual(state, "settled")
        self.assertEqual(conn.commits, 1)
        self.assertIn("actual_cents", conn.sql_log())
        self.assertIn("company_id = %s", conn.sql_log())
        self.assertIn("pg_advisory_xact_lock", conn.sql_log())

    def test_settle_is_idempotent_when_already_terminal(self):
        # UPDATE affects nothing (already settled) -> fetch current state
        conn = FakeConn([None, {"state": "settled"}])
        state = rr.settle(conn, COMPANY, "res-1", 320)
        self.assertEqual(state, rr.OUTCOME_ALREADY_TERMINAL)
        self.assertEqual(conn.commits, 1)

    def test_settle_rejects_foreign_or_missing_reservation(self):
        conn = FakeConn([None, None])
        state = rr.settle(conn, COMPANY, "res-foreign", 320)
        self.assertEqual(state, rr.OUTCOME_NOT_FOUND_OR_FOREIGN)

    def test_settle_negative_rejected(self):
        with self.assertRaises(ValueError):
            rr.settle(FakeConn([]), COMPANY, "res-1", -5)

    def test_settle_clamps_actual_to_reserved(self):
        # Finding #7: actual spend can never be recorded above the reserved
        # hold, so a settle cannot retroactively breach the cap. Enforcement is
        # atomic in-SQL via LEAST(actual, reserved_cents); assert the recipe.
        conn = FakeConn([{"state": "settled"}])
        rr.settle(conn, COMPANY, "res-1", 999999)
        sql = conn.sql_log()
        self.assertIn("LEAST(%s, reserved_cents)", sql)
        self.assertIn("state = 'reserved'", sql)  # only a live hold settles


class TestRelease(unittest.TestCase):
    def test_release_reserved_transitions(self):
        conn = FakeConn([{"state": "released"}])
        state = rr.release(conn, COMPANY, "res-1")
        self.assertEqual(state, "released")
        self.assertEqual(conn.commits, 1)

    def test_release_idempotent_when_already_released(self):
        conn = FakeConn([None, {"state": "released"}])
        state = rr.release(conn, COMPANY, "res-1")
        self.assertEqual(state, rr.OUTCOME_ALREADY_TERMINAL)

    def test_release_rejects_foreign_or_missing_reservation(self):
        conn = FakeConn([None, None])
        state = rr.release(conn, COMPANY, "res-foreign")
        self.assertEqual(state, rr.OUTCOME_NOT_FOUND_OR_FOREIGN)


class TestSpendQuery(unittest.TestCase):
    def test_committed_plus_reserved_reads_sum(self):
        conn = FakeConn([{"total_cents": 4200}])
        self.assertEqual(rr.committed_plus_reserved_cents(conn, COMPANY), 4200)
        self.assertIn("SUM", conn.sql_log())

    def test_empty_company_is_zero(self):
        conn = FakeConn([{"total_cents": 0}])
        self.assertEqual(rr.committed_plus_reserved_cents(conn, COMPANY), 0)


class TestCapPauseOutbox(unittest.TestCase):
    def test_enqueue_is_company_scoped_idempotent_and_commits_without_reservation(self):
        conn = FakeConn([{"id": "event-1"}])
        event_id = rr.enqueue_cap_pause_event(conn, COMPANY, QUEUE, 5000)
        self.assertEqual(event_id, "event-1")
        self.assertEqual(conn.commits, 1)
        self.assertIn("ON CONFLICT (company_id, notification_key) DO NOTHING", conn.sql_log())
        self.assertIn("pg_advisory_xact_lock", conn.sql_log())

    def test_concurrent_duplicate_reads_existing_event(self):
        conn = FakeConn([None, {"id": "event-1"}])
        event_id = rr.enqueue_cap_pause_event(conn, COMPANY, QUEUE, 5000)
        self.assertEqual(event_id, "event-1")
        self.assertIn("SELECT id FROM enrichment_cap_pause_events", conn.sql_log())

    def test_claim_allows_exactly_one_pending_to_attempted_transition(self):
        claimed = FakeConn([{"id": "event-1"}])
        already_claimed = FakeConn([None])
        self.assertTrue(rr.claim_cap_pause_event(claimed, COMPANY, "event-1"))
        self.assertFalse(rr.claim_cap_pause_event(already_claimed, COMPANY, "event-1"))
        self.assertIn("state = 'pending'", claimed.sql_log())

    def test_finalize_records_delivered_or_sanitized_failure(self):
        delivered = FakeConn([])
        failed = FakeConn([])
        rr.finalize_cap_pause_event(delivered, COMPANY, "event-1", delivered=True)
        rr.finalize_cap_pause_event(failed, COMPANY, "event-1", delivered=False, error_class="notification_failed")
        self.assertIn("delivered_at = NOW()", delivered.sql_log())
        self.assertIn("failed_at = NOW()", failed.sql_log())
        self.assertIn("state = 'attempted'", failed.sql_log())


if __name__ == "__main__":
    unittest.main()
