# PraeSyn, LLC — CPA Tax Planning Memorandum
**August 17, 2026 (Updated with Real Bluevine Data)**
**Prepared by:** CPA (AI agent a6cac3da)
**Status:** Updated — based on actual Bluevine bank data through Aug 14, 2026
**Parent:** PRA-49 (Monthly Close Process via Ledger)
**Supersedes:** Aug 16 revision (modeled data)

---

## Executive Summary

Real Bluevine data (exported via PRA-383, 18 rows) has been imported, reconciled, and closed. The actual business is **substantially smaller** than the earlier model assumed.

**Actual YTD snapshot (Feb 4 – Aug 14, 2026, cash basis):**
| Metric | Actual | Prior Modeled |
|--------|--------|---------------|
| Gross Revenue | $11,301.08 | $52,800 |
| Total Expenses | $520.60 | $3,108 |
| Net Profit | $10,782.77 | $49,692 |
| Ending Cash | $10,882.77 | $30,692 |
| Owner's Draws | $0.00 | $24,000 |

**Reconciliation:** 17 posted transactions tie exactly to Bluevine ending balance $10,882.77. One $5.00 item (PRAESYN.COM) never posted (returned/declined) — excluded. Books are balanced.

---

## 1. S-Corp Election Analysis (Form 2553)

### Updated Position
Annualized net profit is now **~$18,500/yr** ($10,783 × 12/7), not ~$85K. At this scale:

| Component | Disregarded Entity (Current) | S-Corp (Projected) |
|-----------|------------------------------|-------------------|
| Net Profit (annualized) | ~$18,485 | ~$18,485 |
| Reasonable Salary | N/A | ~$18,000 (problematic — salary ≈ profit) |
| SE Tax | **~$2,611** | ~$2,754 (employer+employee on salary) |
| Income Tax | ~$0 (below std deduction) | ~$0 |
| Payroll/admin costs | $0 | ~$500+/yr (Gusto + filings) |
| **Net Annual Cost** | **~$2,611** | **~$3,250+** |

**Conclusion: S-corp election is NOT favorable at current revenue.** The SE tax savings disappears when reasonable compensation must equal most of the profit, and payroll compliance costs exceed any benefit. Revisit if annualized revenue exceeds **~$50K sustained**. This reverses the prior memo's tentative lean toward S-corp.

---

## 2. HSA Strategy & Healthcare Plan Tax Implications

**Unchanged from Aug 16 revision** (no financial data dependency):
- 2026 self-only limit: **$4,400**; catch-up +$1,000 (age 55+)
- Last-month rule: eligible on Dec 1, 2026 → full-year contribution allowed (watch 2027 testing period)
- Fidelity HSA recommended (no fees)
- SE-HIP deduction and HSA deduction stack; SE-HIP limited to earned income
- Deadline-sensitive action: **HDHP enrollment by Dec 1, 2026** for 2026 HSA eligibility

---

## 3. Q3 2026 Estimated Tax — REAL Data Computation

### YTD Actuals (Feb–Aug 2026)
| Component | Amount |
|-----------|--------|
| Net Profit | $10,782.77 |
| SE Tax Base (92.35%) | $9,957.89 |
| SE Tax (15.3%) | $1,523.56 |
| Deductible ½ SE Tax | $761.78 |
| AGI | $10,020.99 |
| Standard Deduction (2026, single) | ~$15,000 |
| **Taxable Income** | **$0** |
| **Federal Income Tax** | **$0** |
| **Total Federal Tax Liability** | **~$1,524** |

### Q3 Payment (due Sep 15, 2026)
| Scenario | Q3 Due |
|----------|--------|
| No payments made | **$1,371** (90% of $1,524) |
| $343/quarter already paid | $685 |
| 100% of 2025 liability | **UNKNOWN — need 2025 return** |

**Recommended action:** Pay **$1,371** by Sep 15 via IRS Direct Pay (irs.gov/directpay → Estimated Tax → 1040-ES → 2026) unless 2025 liability exceeds $1,523 (then use 100% of 2025 as safe harbor).

**⚠️ Confirm with Ben:** (1) Any Q1/Q2 2026 estimated payments made? (2) 2025 total tax liability (1040 line 24)?

### WA B&O Tax
| Component | Amount |
|-----------|--------|
| Gross Receipts | $11,301.08 |
| B&O Rate (Services) | 1.5% |
| Gross Liability | $169.52 |
| Small Business Credit | $840+ (exceeds liability) |
| **Net Due** | **$0** (must still file by Oct 31, 2026) |

---

## 4. WA State Tax Compliance Summary

**Unchanged from Aug 16 revision** except gross receipts now $11,301.08:
- **B&O:** $0 due after SBBC credit; file by **Oct 31, 2026**
- **L&I:** no coverage required (no employees)
- **PFML:** no employer premium 2026; no reporting without W-2 employees
- **WA Cares:** employee-only; no reporting without W-2 employees
- S-corp election (if ever pursued) would trigger W-2 payroll obligations

---

## 5. Action Items Summary

### Ben (Human Actions Required)
| Priority | Action | Deadline | Issue |
|----------|--------|----------|-------|
| CRITICAL | Pay Q3 2026 estimated tax (~$1,371) | Sep 15, 2026 | PRA-49 |
| HIGH | Confirm Q1/Q2 2026 estimated payments | Before Sep 15 | PRA-49 |
| HIGH | Provide 2025 1040 total tax liability | Before Sep 15 | PRA-49 |
| MEDIUM | Complete SEP screening at wahealthplanfinder.org | Before Dec 1, 2026 | PRA-277 |
| LOW | Verify pending $5.00 PRAESYN.COM transaction | Next close | PRA-49 |
| LOW | Review revenue actuals vs projections | ASAP | PRA-49 |

### CPA (AI Agent)
| Action | Status |
|--------|--------|
| Import Bluevine CSV → reconcile → P&L | ✅ Done (Aug 17) |
| Compute Q3 estimated tax with safe harbor | ✅ Done — $1,371 recommendation |
| File Q3 WA B&O return | Due Oct 31, 2026 |
| Prepare 1099-NEC validation list | Dec 2026 (PRA-372) |
| S-corp election worksheet | On hold — not favorable at current revenue |

---

## Data Dependencies

| Item | Status | Blocks |
|------|--------|--------|
| Bluevine CSV export | ✅ RECEIVED (PRA-383 done) | — |
| Q1/Q2 payment confirmation | PENDING (Ben) | Q3 payment finalization |
| 2025 1040 safe harbor data | PENDING (Ben) | Underpayment penalty protection |
| SEP screening result | PENDING (Ben) | Healthcare enrollment path |

---

*Prepared by CPA (AI agent a6cac3da) for PraeSyn, LLC based on actual Bluevine data reconciled to ledger. Not a substitute for professional tax advice from a licensed CPA. Consult a qualified tax professional before making tax payments or elections.*