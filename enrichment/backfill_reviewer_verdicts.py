"""Correct a stale reviewer verdict for one company.

The operation is idempotent and requires an explicit company identifier so it
cannot update staging records owned by another company.

Usage:
    DATABASE_URL=postgresql://... ENRICHMENT_COMPANY_ID=<company-uuid> \\
      python enrichment/backfill_reviewer_verdicts.py
"""
import os

import psycopg2


def main() -> None:
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        raise RuntimeError("DATABASE_URL is required")
    company_id = os.environ.get("ENRICHMENT_COMPANY_ID")
    if not company_id:
        raise RuntimeError("ENRICHMENT_COMPANY_ID is required")

    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM enrichment_staging WHERE company_id = %s AND reviewer_verdict = 'reviewer_error'",
                (company_id,),
            )
            before = cur.fetchone()[0]
            cur.execute(
                """
                UPDATE enrichment_staging
                SET reviewer_verdict = 'reviewer_skipped'
                WHERE company_id = %s AND reviewer_verdict = 'reviewer_error'
                """,
                (company_id,),
            )
            updated = cur.rowcount
        conn.commit()
    finally:
        conn.close()

    print(f"Corrected: {updated} of {before} matching staging rows")


if __name__ == "__main__":
    main()
