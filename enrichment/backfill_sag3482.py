"""
backfill_sag3482.py — SAG-3483 / SAG-3482

Update reviewer_verdict='reviewer_error' → 'reviewer_skipped' for the 99 rows
that were written before the preflight fix. Those rows reached the reviewer tier
but the call was never made (401 from dev_key placeholder); 'reviewer_error'
was written incorrectly. 'reviewer_skipped' is the accurate historical label.

Idempotent: safe to run multiple times.

Usage:
    python enrichment/backfill_sag3482.py
"""
import psycopg2

DB_URL = "postgresql://paperclip:paperclip@localhost:54329/enrichment_db"
TABLE = "enrichment_staging.enrichment_staging"


def main() -> None:
    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()

    cur.execute(
        f"SELECT COUNT(*) FROM {TABLE} WHERE reviewer_verdict = 'reviewer_error'"
    )
    before = cur.fetchone()[0]
    print(f"Before: {before} rows with reviewer_verdict='reviewer_error'")

    cur.execute(
        f"""
        UPDATE {TABLE}
        SET reviewer_verdict = 'reviewer_skipped'
        WHERE reviewer_verdict = 'reviewer_error'
        """
    )
    updated = cur.rowcount
    conn.commit()

    cur.execute(
        f"SELECT COUNT(*) FROM {TABLE} WHERE reviewer_verdict = 'reviewer_error'"
    )
    after = cur.fetchone()[0]
    print(f"Updated: {updated} rows")
    print(f"After:   {after} rows with reviewer_verdict='reviewer_error'")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
