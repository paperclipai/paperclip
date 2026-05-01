import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { rt2PayrollSettlementService } from "../services/rt2-payroll-settlement.js";
import { assertCompanyAccess } from "./authz.js";

export function rt2PayrollSettlementRoutes(db: Db) {
  const router = Router();
  const svc = rt2PayrollSettlementService(db);

  // Process monthly payroll for a company
  // POST /api/companies/:companyId/rt2/payroll/run
  router.post("/companies/:companyId/rt2/payroll/run", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const { period } = req.body;
      const run = await svc.processMonthlyPayroll(companyId, period);
      res.json({ data: run });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // Get payroll run for a specific period
  // GET /api/companies/:companyId/rt2/payroll/runs/:period
  router.get("/companies/:companyId/rt2/payroll/runs/:period", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const { period } = req.params;
      const run = await svc.getPayrollRun(companyId, period);
      if (!run) {
        return res.status(404).json({ error: "Payroll run not found for this period" });
      }
      res.json({ data: run });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // List recent payroll runs for a company
  // GET /api/companies/:companyId/rt2/payroll/runs
  router.get("/companies/:companyId/rt2/payroll/runs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const limit = parseInt(req.query.limit as string) || 12;
      const runs = await svc.listPayrollRuns(companyId, limit);
      res.json({ data: runs });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // Add a payment receipt (BILL-03)
  // POST /api/companies/:companyId/rt2/payroll/receipts
  router.post("/companies/:companyId/rt2/payroll/receipts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const {
        providerReference,
        providerName,
        amount,
        currency,
        status,
        paidAt,
        settlementId,
        payrollRunId,
        metadata,
      } = req.body;
      const receipt = await svc.addPaymentReceipt(companyId, {
        providerReference,
        providerName,
        amount: Number(amount),
        currency,
        status,
        paidAt: paidAt ? new Date(paidAt) : undefined,
        settlementId,
        payrollRunId,
        metadata: metadata ?? {},
      });
      res.status(201).json({ data: receipt });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // Confirm a payment receipt
  // POST /api/companies/:companyId/rt2/payroll/receipts/:receiptId/confirm
  router.post("/companies/:companyId/rt2/payroll/receipts/:receiptId/confirm", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const { receiptId } = req.params;
      const receipt = await svc.confirmPaymentReceipt(receiptId, companyId);
      res.json({ data: receipt });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // Get payment receipts for a company
  // GET /api/companies/:companyId/rt2/payroll/receipts
  router.get("/companies/:companyId/rt2/payroll/receipts", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const { status, settlementId, period } = req.query;
      const receipts = await svc.getPaymentReceipts(companyId, {
        status: status as string | undefined,
        settlementId: settlementId as string | undefined,
        period: period as string | undefined,
      });
      res.json({ data: receipts });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // Reconcile a settlement with a payment receipt (BILL-03)
  // POST /api/companies/:companyId/rt2/payroll/reconcile
  router.post("/companies/:companyId/rt2/payroll/reconcile", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const { settlementId, receiptId } = req.body;
      if (!settlementId || !receiptId) {
        return res.status(400).json({ error: "settlementId and receiptId are required" });
      }
      const record = await svc.reconcileSettlementWithReceipt(companyId, settlementId, receiptId);
      res.json({ data: record });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  // Get reconciliation report
  // GET /api/companies/:companyId/rt2/payroll/reconciliation-report
  router.get("/companies/:companyId/rt2/payroll/reconciliation-report", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    try {
      const { period } = req.query;
      const report = await svc.getReconciliationReport(companyId, period as string | undefined);
      res.json({ data: report });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  return router;
}
