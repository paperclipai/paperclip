# PRAE-49 Monthly Close — August 2026
**Date:** August 17, 2026 (17:24 PT)
**Prepared by:** CPA (agent a6cac3da)
**Data Source:** Bluevine business checking — CSV export (PRA-383)

---

## 1. Reconciliation Statement

### Bluevine Checking Account
| Metric | Amount |
|--------|--------|
| Ending Balance (Aug 14, 2026) | $10,882.77 |
| Ledger Balance | $10,882.77 |
| **Difference** | **$0.00 ✓** |

### Transactions Reviewed
| Metric | Count | Amount |
|--------|-------|--------|
| Posted transactions reconciled | 17 | $10,882.77 |
| Uncleared / pending items | 1 | $5.00 |
| **Total in export** | **18** | |

### Reconciliation Finding
One Bluevine CSV row ($5.00 PRAESYN.COM domain, 2026-05-11) appears in the export but never affected the running balance. The balance chain ties out excluding this item:
- Starting balance after Microsoft: $692.16
- Next posted transaction (Stripe +4.51): $696.67 ✓
- If -$5.00 had posted: would be $691.67 — but actual balance shows $696.67
- **Verdict:** Transaction did not post (returned/declined). Excluded from ledger. Flagged for Ben's awareness.

---

## 2. Profit & Loss (Cash Basis) — YTD through Aug 14, 2026

### Revenue
| Category | Amount |
|----------|--------|
| Client Revenue — Rambur Inc ACH | $10,260.00 |
| Payment Processing — Stripe Settlements | $1,041.08 |
| **Total Operating Revenue** | **$11,301.08** |

### Other Income
| Category | Amount |
|----------|--------|
| Interest Income (Bluevine) | $2.29 |
| **Total Other Income** | **$2.29** |

### Expenses
| Category | Amount |
|----------|--------|
| Software & Subscriptions | $437.58 |
| Automobile Fuel | $76.12 |
| Meals (50% deductible: $3.45) | $6.90 |
| **Total Expenses** | **$520.60** |

### Net Profit
| Component | Amount |
|-----------|--------|
| Total Income | $11,303.37 |
| Total Expenses | ($520.60) |
| **Net Profit** | **$10,782.77** |

### Expense Detail
| Date | Description | Amount | Category |
|------|-------------|--------|----------|
| 2026-04-16 | Marlbism.com — DOVER DE | $35.00 | Subscriptions |
| 2026-04-17 | SQ Luv-a-Latte — TACOMA WA | $6.90 | Meals |
| 2026-04-18 | Marlbism.com — DOVER DE | $257.00 | Subscriptions |
| 2026-04-18 | Microsoft #G153395425 | $79.34 | Subscriptions |
| 2026-06-08 | Costco Gas #0061 — FEDERAL WAY WA | $46.23 | Auto Fuel |
| 2026-06-08 | Costco Gas #0061 — FEDERAL WAY WA | $29.89 | Auto Fuel |
| 2026-07-15 | Vercel Inc — COVINA CA | $44.16 | Hosting |
| 2026-08-14 | Vercel Inc — COVINA CA | $22.08 | Hosting |

### Revenue Detail
| Date | Description | Amount | Category |
|------|-------------|--------|----------|
| 2026-02-04 | Transfer from Robinhood (6362) | $100.00 | **Owner Capital** (not revenue) |
| 2026-04-13 | Stripe Transfer | $970.40 | Payment settlement |
| 2026-05-19 | Stripe Transfer | $4.51 | Payment settlement |
| 2026-07-10 | Rambur Inc ACH | $10.00 | Client revenue |
| 2026-07-13 | Rambur Inc ACH | $2,500.00 | Client revenue |
| 2026-08-01 | Interest earned July 2026 | $2.29 | Interest income |
| 2026-08-07 | Rambur Inc ACH | $5,000.00 | Client revenue |
| 2026-08-11 | Stripe Transfer | $66.17 | Payment settlement |
| 2026-08-13 | Rambur Inc ACH | $2,750.00 | Client revenue |

---

## 3. Balance Sheet (as of Aug 14, 2026)

| Assets | Amount |
|--------|--------|
| Cash — Bluevine Checking | $10,882.77 |
| **Total Assets** | **$10,882.77** |

| Liabilities | Amount |
|-------------|--------|
| (none) | $0.00 |
| **Total Liabilities** | **$0.00** |

| Equity | Amount |
|--------|--------|
| Owner Contributions | $100.00 |
| Retained Earnings (Net Profit) | $10,782.77 |
| **Total Equity** | **$10,882.77** |

| **Total Liabilities + Equity** | **$10,882.77** |

**Status: BALANCED ✓**

---

## 4. Uncategorized Transaction Review

All 17 posted transactions are categorized. Categories map to Schedule C lines:

| Schedule C Line | Account Category | Amount | Status |
|-----------------|------------------|--------|--------|
| Line 1 — Gross receipts | Client Revenue | $10,260.00 | ✓ |
| Line 1 — Gross receipts | Payment Processing | $1,041.08 | ✓ (net; Stripe fees not separated) |
| Line 6 — Other income | Bank Interest | $2.29 | ✓ |
| Line 15 — Meals | Meals | $6.90 | ✓ (50% deductible) |
| Line 18 — Supplies | Subscriptions | $371.34 | ✓ |
| Line 20 — Other expenses | Hosting (Vercel) | $66.24 | ✓ |
| Line 21 — Vehicle | Auto Fuel | $76.12 | ✓ |

**Note:** Stripe settlements are booked net of fees. The gross amount and fee breakout are available on the Stripe dashboard if needed for Schedule C. At this volume (~$1,041 in settlements), fees are immaterial (~$30–40).

**No uncategorized transactions remain.** All mapped.

---

## 5. Q3 2026 Estimated Tax — Real Computation

### Key Finding: Modeled Revenue Was Overstated
The previous modeled ledger assumed $52,800 annualized revenue (~$7,500/mo × 7 months). Actual Bluevine data shows $11,301.08 YTD operating revenue through Aug 14 (Feb–Aug ~6 months). Revenue is concentrated in Rambur client payments ($10,260 of $11,301).

### YTD Tax Computation
| Component | Amount |
|-----------|--------|
| Net Profit | $10,782.77 |
| SE Tax Base (92.35%) | $9,957.89 |
| SE Tax (15.3%) | $1,523.56 |
| Deductible ½ SE | $761.78 |
| AGI | $10,020.99 |
| Standard Deduction (2026, single) | ~$15,000 |
| **Taxable Income** | **$0** (below standard deduction) |
| Federal Income Tax | $0.00 |
| **Total Federal Tax Liability** | **~$1,524** |

### Safe Harbor Comparison
| Method | Amount |
|--------|--------|
| 90% of 2026 liability | $1,371 |
| 100% of 2025 liability | **UNKNOWN** (need 2025 return data) |

### Q3 Payment Recommendation (due Sep 15, 2026)
| Scenario | Q1 | Q2 | Q3 Due (Sep 15) |
|----------|----|----|-----------------|
| No payments made | $0 | $0 | **$1,371** (90% of $1,524) |
| $343/quarter (annualized) | $343 | $343 | **$685** |
| 100% of 2025 safe harbor | Q1/Q2 unknown | | **Variable** |

**⛔ CRITICAL QUESTION FOR BEN:**
- What was your **2025 total tax liability** (1040 line 24)? This determines the safe harbor for avoiding underpayment penalty.
- Were any Q1/Q2 2026 estimated tax payments made?

**Recommendation:** If 2025 liability is below $1,523, pay **$1,371** by Sep 15 using IRS Direct Pay (irs.gov/directpay → Estimated Tax → 1040-ES → 2026). If 2025 liability was higher, use that as the safe harbor target.

### WA B&O Tax
| Component | Amount |
|-----------|--------|
| Gross Receipts | $11,301.08 |
| B&O Rate (Services) | 1.5% |
| Gross Liability | $169.52 |
| Small Business Credit (~$105/mo) | $840+ (exceeds liability) |
| **Net Due** | **$0** |
| **Filing Due** | **October 31, 2026** |

---

## 6. Variance Analysis — Modeled vs Actual

| Metric | Modeled (Old Ledger) | Actual (Bluevine) | Variance | Notes |
|--------|---------------------|-------------------|----------|-------|
| YTD Revenue | $52,800 | $11,301 | -$41,499 | Model assumed $7,500/mo; actual is Rambur-concentrated |
| YTD Expenses | $3,108 | $521 | +$2,587 | Actual spending lower |
| YTD Net Profit | $49,692 | $10,783 | -$38,909 | Business smaller than modeled |
| Ending Cash | $30,692 | $10,883 | -$19,809 | No owner draws in actual data |
| Owner Draws | $24,000 | $0 | +$24,000 | Modeled draws; none taken yet |

**Implications:**
- Quarterly estimated tax is ~$1,500 not ~$18,000 — substantially lower than modeled
- S-corp election analysis changes: at ~$11K annual revenue, the ~$2,300 SE tax savings is still modest, but both numerator and denominator are smaller
- Recommend COO/CEO review of revenue projections vs actuals

---

## 7. Deliverables Produced

| Deliverable | Path | Status |
|-------------|------|--------|
| Reconcile Bluevine → Ledger | doc/status/pra49-ledger-2026-08-17.csv | ✓ 17 transactions reconciled |
| Uncategorized Review | §4 above | ✓ All categorized |
| YTD P&L Statement | §2 above | ✓ Net profit $10,782.77 |
| Balance Sheet | §3 above | ✓ Balanced |
| Q3 Estimated Tax Computation | §5 above | ✓ Recommend $1,371 by Sep 15 |
| Tax Planning Memo Update | Document on issue | ↻ Needs update with real data |
| Variance Analysis | §6 above | ✓ Revenue 79% below model |

---

## 8. Open Items

| Item | Owner | Due |
|------|-------|-----|
| Confirm Q1/Q2 2026 estimated payments | Ben Hamilton | Before Sep 15 |
| Provide 2025 1040 total tax liability | Ben Hamilton | Before Sep 15 |
| Pay Q3 2026 estimated tax (~$1,371) | Ben Hamilton | Sep 15, 2026 |
| Verify pending PRAESYN.COM $5.00 transaction | Ben Hamilton | Next close cycle |
| Review revenue actuals vs projections | CEO / COO | ASAP |
| File Q3 WA B&O return | CPA | Oct 31, 2026 |

---

*Prepared by CPA (AI agent a6cac3da) for PraeSyn, LLC. This is an internal management report. Consult a licensed CPA before making tax payments or elections.*