"""Transactional, company-scoped reviewer-cost reservations.

Replaces the process-local JSON cost ledger (``cost_cap.py``) with durable,
concurrency-safe reservations in the ``enrichment_reviewer_reservations`` table.

Cap rule
--------
For a given company, *committed* (``settled`` rows' ``actual_cents``) plus
*outstanding* (``reserved`` rows' ``reserved_cents``) reviewer spend must never
exceed :data:`CAP_CENTS`. Enforcement is atomic per company: every
``reserve`` takes a transaction-scoped Postgres advisory lock keyed on the
company id, so two concurrent reservations cannot both read the same
under-cap total and both insert. The check-then-insert is therefore
serialized per company without locking unrelated companies.

Settlement never records more than was reserved (``actual_cents`` is clamped
to the row's ``reserved_cents``), so a settle can only hold or lower the
company total and can never retroactively breach the cap.

Lifecycle
---------
    reserve()  -> 'reserved'   row holds ``reserved_cents``
    settle()   -> 'settled'    records ``actual_cents`` (spend incurred)
    release()  -> 'released'   frees the hold (reviewer skipped/failed)

Idempotency
-----------
``(company_id, queue_row_id, request_key)`` is unique. ``reserve`` returns
the *existing* reservation for a repeated request key rather than
double-charging. ``settle`` / ``release`` only act on a ``reserved`` row and
are no-ops once the reservation is terminal, so retries are safe.

Connection ownership
--------------------
Callers own the connection lifecycle. Each function runs its work inside one
transaction and commits or rolls back before returning; it never closes the
connection. Cursors are always used as context managers, so a raised error
releases the cursor and the rollback releases the advisory lock — no leak.
"""
from __future__ import annotations

from dataclasses import dataclass

# $50.00 rolling cap expressed in integer cents to avoid float drift.
CAP_CENTS: int = 5000

# Reservation states (mirror the enrichment_reviewer_reservations.state column).
STATE_RESERVED = "reserved"
STATE_SETTLED = "settled"
STATE_RELEASED = "released"

# reserve() outcomes.
OUTCOME_RESERVED = "reserved"        # a fresh hold was created
OUTCOME_EXISTS = "exists"            # idempotent hit on an existing request key
OUTCOME_CAP_EXCEEDED = "cap_exceeded"  # hold would breach the cap; nothing written
OUTCOME_NOT_FOUND_OR_FOREIGN = "not_found_or_foreign"
OUTCOME_ALREADY_TERMINAL = "already_terminal"

CAP_PAUSE_NOTIFICATION_KEY = "reviewer-cap-v1"
CAP_PAUSE_PENDING = "pending"
CAP_PAUSE_ATTEMPTED = "attempted"
CAP_PAUSE_DELIVERED = "delivered"
CAP_PAUSE_FAILED = "failed"


@dataclass(frozen=True)
class ReservationResult:
    """Outcome of a :func:`reserve` call."""

    outcome: str
    reservation_id: str | None
    state: str | None
    reserved_cents: int
    # Committed + outstanding spend for the company *after* this call, in cents.
    committed_reserved_cents: int

    @property
    def ok(self) -> bool:
        """True when the caller holds a live reservation it may spend against."""
        return self.outcome in (OUTCOME_RESERVED, OUTCOME_EXISTS) and self.state == STATE_RESERVED


def _cap_allows(current_cents: int, add_cents: int, cap_cents: int = CAP_CENTS) -> bool:
    """Return whether adding ``add_cents`` keeps the company at or under the cap."""
    return current_cents + add_cents <= cap_cents


def _advisory_lock(cur, company_id: str) -> None:
    """Take a transaction-scoped advisory lock keyed on the company id.

    ``hashtext`` maps the uuid string to the ``bigint`` the lock function wants;
    collisions merely serialize two unrelated companies occasionally, which is
    safe. The lock releases automatically at COMMIT/ROLLBACK.
    """
    cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (str(company_id),))


def committed_plus_reserved_cents(conn, company_id: str) -> int:
    """Return committed (settled actual) + outstanding (reserved) cents for a company."""
    with conn.cursor() as cur:
        _committed_reserved(cur, company_id)
        row = cur.fetchone()
    return _scalar(row)


def _committed_reserved(cur, company_id: str) -> None:
    cur.execute(
        """
        SELECT COALESCE(SUM(
            CASE state
                WHEN 'reserved' THEN reserved_cents
                WHEN 'settled'  THEN COALESCE(actual_cents, reserved_cents)
                ELSE 0
            END
        ), 0) AS total_cents
        FROM enrichment_reviewer_reservations
        WHERE company_id = %s
        """,
        (str(company_id),),
    )


def _find_existing(cur, company_id: str, queue_row_id: str, request_key: str):
    cur.execute(
        """
        SELECT id, state, reserved_cents, actual_cents
        FROM enrichment_reviewer_reservations
        WHERE company_id = %s AND queue_row_id = %s AND request_key = %s
        """,
        (str(company_id), str(queue_row_id), str(request_key)),
    )
    return cur.fetchone()


def _queue_belongs_to_company(cur, company_id: str, queue_row_id: str) -> bool:
    """Verify the queue row and reservation company share one tenant boundary."""
    cur.execute(
        """
        SELECT 1
        FROM enrichment_queue
        WHERE id = %s AND company_id = %s
        FOR KEY SHARE
        """,
        (str(queue_row_id), str(company_id)),
    )
    return cur.fetchone() is not None


def reserve(
    conn,
    company_id: str,
    queue_row_id: str,
    request_key: str,
    reserved_cents: int,
) -> ReservationResult:
    """Atomically reserve ``reserved_cents`` of reviewer budget for a company.

    Idempotent on ``(company_id, queue_row_id, request_key)``. Returns a
    :class:`ReservationResult`; on ``cap_exceeded`` nothing is written.
    """
    if reserved_cents < 0:
        raise ValueError("reserved_cents must be non-negative")
    try:
        with conn.cursor() as cur:
            _advisory_lock(cur, company_id)

            # The two scalar foreign keys on reservations only prove that the
            # company and queue row exist independently. Keep this ownership
            # check in the advisory-locked transaction before any insert.
            if not _queue_belongs_to_company(cur, company_id, queue_row_id):
                conn.rollback()
                return ReservationResult(
                    outcome=OUTCOME_NOT_FOUND_OR_FOREIGN,
                    reservation_id=None,
                    state=None,
                    reserved_cents=reserved_cents,
                    committed_reserved_cents=0,
                )

            existing = _find_existing(cur, company_id, queue_row_id, request_key)
            if existing is not None:
                current = _current_after_lock(cur, company_id)
                conn.commit()
                return ReservationResult(
                    outcome=OUTCOME_EXISTS,
                    reservation_id=str(_col(existing, "id", 0)),
                    state=_col(existing, "state", 1),
                    reserved_cents=int(_col(existing, "reserved_cents", 2)),
                    committed_reserved_cents=current,
                )

            current = _current_after_lock(cur, company_id)
            if not _cap_allows(current, reserved_cents):
                conn.rollback()
                return ReservationResult(
                    outcome=OUTCOME_CAP_EXCEEDED,
                    reservation_id=None,
                    state=None,
                    reserved_cents=reserved_cents,
                    committed_reserved_cents=current,
                )

            cur.execute(
                """
                INSERT INTO enrichment_reviewer_reservations
                    (company_id, queue_row_id, request_key, state, reserved_cents)
                VALUES (%s, %s, %s, 'reserved', %s)
                RETURNING id
                """,
                (str(company_id), str(queue_row_id), str(request_key), int(reserved_cents)),
            )
            new_id = _scalar(cur.fetchone())
        conn.commit()
        return ReservationResult(
            outcome=OUTCOME_RESERVED,
            reservation_id=str(new_id),
            state=STATE_RESERVED,
            reserved_cents=int(reserved_cents),
            committed_reserved_cents=current + reserved_cents,
        )
    except Exception:
        conn.rollback()
        raise


def settle(conn, company_id: str, reservation_id: str, actual_cents: int) -> str:
    """Record actual spend on a reserved hold. Idempotent; returns the final state.

    Only a ``reserved`` row transitions to ``settled``; a row that is already
    ``settled`` or ``released`` is returned unchanged.

    Cap safety: the recorded spend is clamped to the row's own
    ``reserved_cents`` via ``LEAST`` — a settlement can never record more than
    was reserved. Because ``reserve`` already cap-checked that hold, settling
    can only hold or *lower* the company's committed+reserved total, so it can
    never retroactively breach :data:`CAP_CENTS`. No separate company-scoped
    cap check is needed at settle time. Clamping (rather than raising on an
    over-spend) keeps the row's lifecycle total: the hold is always
    terminalized instead of leaking in the ``reserved`` state. Callers must
    therefore reserve a conservative upper bound so ``actual`` stays within it.
    """
    if actual_cents < 0:
        raise ValueError("actual_cents must be non-negative")
    return _terminalize(
        conn,
        company_id,
        reservation_id,
        """
        UPDATE enrichment_reviewer_reservations
        SET state = 'settled', actual_cents = LEAST(%s, reserved_cents), settled_at = NOW()
        WHERE id = %s AND company_id = %s AND state = 'reserved'
        RETURNING state
        """,
        (int(actual_cents), str(reservation_id), str(company_id)),
    )


def release(conn, company_id: str, reservation_id: str) -> str:
    """Release a reserved hold without charging. Idempotent; returns final state."""
    return _terminalize(
        conn,
        company_id,
        reservation_id,
        """
        UPDATE enrichment_reviewer_reservations
        SET state = 'released', released_at = NOW()
        WHERE id = %s AND company_id = %s AND state = 'reserved'
        RETURNING state
        """,
        (str(reservation_id), str(company_id)),
    )


def enqueue_cap_pause_event(conn, company_id: str, queue_row_id: str, amount_cents: int) -> str:
    """Durably enqueue the single idempotent reviewer-cap notification.

    The event commit is intentionally separate from a denied reservation: the
    denial rolls back its transaction, while this outbox row must survive even
    though no reservation was created.
    """
    try:
        with conn.cursor() as cur:
            _advisory_lock(cur, company_id)
            # The queue-row FK alone cannot prove tenant ownership because
            # PostgreSQL permits the two scalar FKs to reference different
            # companies. Validate the pair before creating the outbox row.
            cur.execute(
                """
                SELECT 1 FROM enrichment_queue
                WHERE id = %s AND company_id = %s
                """,
                (str(queue_row_id), str(company_id)),
            )
            if cur.fetchone() is None:
                raise ValueError("queue row not found or belongs to another company")
            cur.execute(
                """
                INSERT INTO enrichment_cap_pause_events
                    (company_id, queue_row_id, notification_key, state, amount_cents)
                VALUES (%s, %s, %s, 'pending', %s)
                ON CONFLICT (company_id, notification_key) DO NOTHING
                RETURNING id
                """,
                (str(company_id), str(queue_row_id), CAP_PAUSE_NOTIFICATION_KEY, int(amount_cents)),
            )
            row = cur.fetchone()
            if row is None:
                cur.execute(
                    """
                    SELECT id FROM enrichment_cap_pause_events
                    WHERE company_id = %s AND notification_key = %s
                    """,
                    (str(company_id), CAP_PAUSE_NOTIFICATION_KEY),
                )
                row = cur.fetchone()
        conn.commit()
        return str(_scalar(row))
    except Exception:
        conn.rollback()
        raise


def claim_cap_pause_event(conn, company_id: str, event_id: str) -> bool:
    """Atomically change one pending outbox row to ``attempted``."""
    try:
        with conn.cursor() as cur:
            _advisory_lock(cur, company_id)
            cur.execute(
                """
                UPDATE enrichment_cap_pause_events
                SET state = 'attempted', attempted_at = NOW()
                WHERE id = %s AND company_id = %s AND state = 'pending'
                RETURNING id
                """,
                (str(event_id), str(company_id)),
            )
            claimed = cur.fetchone() is not None
        conn.commit()
        return claimed
    except Exception:
        conn.rollback()
        raise


def finalize_cap_pause_event(conn, company_id: str, event_id: str, *, delivered: bool, error_class: str | None = None) -> None:
    """Persist the only terminal result of the single notification attempt."""
    state = CAP_PAUSE_DELIVERED if delivered else CAP_PAUSE_FAILED
    timestamp_column = "delivered_at" if delivered else "failed_at"
    try:
        with conn.cursor() as cur:
            _advisory_lock(cur, company_id)
            cur.execute(
                f"""
                UPDATE enrichment_cap_pause_events
                SET state = %s, {timestamp_column} = NOW(), error_class = %s
                WHERE id = %s AND company_id = %s AND state = 'attempted'
                """,
                (state, None if delivered else (error_class or "notification_failed"), str(event_id), str(company_id)),
            )
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def _terminalize(conn, company_id: str, reservation_id: str, sql: str, params: tuple) -> str:
    try:
        with conn.cursor() as cur:
            _advisory_lock(cur, company_id)
            cur.execute(sql, params)
            updated = cur.fetchone()
            if updated is not None:
                conn.commit()
                return _scalar(updated)
            # Do not leak row existence across company boundaries. A caller gets a
            # typed outcome rather than an ambiguous "released" default.
            cur.execute(
                "SELECT state FROM enrichment_reviewer_reservations WHERE id = %s AND company_id = %s",
                (str(reservation_id), str(company_id)),
            )
            current = cur.fetchone()
        conn.commit()
        return OUTCOME_ALREADY_TERMINAL if current is not None else OUTCOME_NOT_FOUND_OR_FOREIGN
    except Exception:
        conn.rollback()
        raise


def _current_after_lock(cur, company_id: str) -> int:
    _committed_reserved(cur, company_id)
    return _scalar(cur.fetchone())


# --- Row/column access helpers -------------------------------------------------
# Cursors may be RealDictCursor (dict rows) or a plain tuple cursor; support both.


def _scalar(row):
    if row is None:
        return 0
    if isinstance(row, dict):
        return next(iter(row.values()))
    return row[0]


def _col(row, name: str, index: int):
    if isinstance(row, dict):
        return row[name]
    return row[index]
