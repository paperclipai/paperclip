// Verifies that PATCH /api/companies/:companyId syncs the company budget
// policy when `budgetMonthlyCents` is updated, and that the company-row
// update and budget-policy upsert commit inside the same transaction so a
// concurrent reader cannot observe a half-applied state.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const companyId = "33333333-3333-4333-8333-333333333333";

function baseCompany(overrides: Record<string, unknown> = {}) {
	return {
		id: companyId,
		name: "Test Co",
		urlKey: "test-co",
		status: "active",
		budgetMonthlyCents: 50_000,
		spentMonthlyCents: 0,
		requireBoardApprovalForNewAgents: false,
		feedbackDataSharingEnabled: false,
		feedbackDataSharingConsentAt: null,
		feedbackDataSharingConsentByUserId: null,
		feedbackDataSharingTermsVersion: null,
		createdAt: new Date("2026-05-12T00:00:00.000Z"),
		updatedAt: new Date("2026-05-12T00:00:00.000Z"),
		...overrides,
	};
}

const mockCompanyService = vi.hoisted(() => ({
	getById: vi.fn(),
	update: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
	getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
	canUser: vi.fn(async () => true),
	hasPermission: vi.fn(async () => true),
	ensureMembership: vi.fn(async () => undefined),
}));

const mockBudgetService = vi.hoisted(() => ({
	upsertPolicy: vi.fn(async () => ({ id: "policy-1" })),
}));

const mockPortability = vi.hoisted(() => ({}));

const mockFeedback = vi.hoisted(() => ({}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../services/index.js", () => ({
	companyService: () => mockCompanyService,
	agentService: () => mockAgentService,
	accessService: () => mockAccessService,
	budgetService: () => mockBudgetService,
	companyPortabilityService: () => mockPortability,
	feedbackService: () => mockFeedback,
	logActivity: mockLogActivity,
}));

async function createApp() {
	const [{ companyRoutes }, { errorHandler }] = await Promise.all([
		vi.importActual<typeof import("../routes/companies.js")>(
			"../routes/companies.js",
		),
		vi.importActual<typeof import("../middleware/index.js")>(
			"../middleware/index.js",
		),
	]);
	const app = express();
	app.use(express.json());
	app.use((req, _res, next) => {
		(req as any).actor = {
			type: "board",
			userId: "local-board",
			companyIds: [companyId],
			source: "local_implicit",
			isInstanceAdmin: false,
		};
		next();
	});
	const db = {
		// Sentinel-bearing tx so the test can assert it threads through to
		// svc.update and budgets.upsertPolicy.
		transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
			fn({ __tx: true }),
		),
	};
	app.use("/api/companies", companyRoutes(db as any));
	app.use(errorHandler);
	return app;
}

describe("PATCH /api/companies/:companyId budget sync", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("calls budgets.upsertPolicy and threads tx when budgetMonthlyCents changes", async () => {
		mockCompanyService.getById.mockResolvedValue(
			baseCompany({ budgetMonthlyCents: 50_000 }),
		);
		mockCompanyService.update.mockResolvedValue(
			baseCompany({ budgetMonthlyCents: 200_000 }),
		);

		const app = await createApp();
		const res = await request(app)
			.patch(`/api/companies/${companyId}`)
			.send({ budgetMonthlyCents: 200_000 });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(mockBudgetService.upsertPolicy).toHaveBeenCalledTimes(1);
		expect(mockBudgetService.upsertPolicy).toHaveBeenCalledWith(
			companyId,
			{
				scopeType: "company",
				scopeId: companyId,
				amount: 200_000,
				windowKind: "calendar_month_utc",
			},
			"local-board",
			{ __tx: true },
		);
		// svc.update must receive the same tx as the 3rd arg so the company
		// row update commits atomically with the policy upsert.
		expect(mockCompanyService.update).toHaveBeenCalledWith(
			companyId,
			expect.objectContaining({ budgetMonthlyCents: 200_000 }),
			{ __tx: true },
		);
	});

	it("skips budgets.upsertPolicy when budgetMonthlyCents is unchanged", async () => {
		mockCompanyService.getById.mockResolvedValue(
			baseCompany({ budgetMonthlyCents: 50_000 }),
		);
		mockCompanyService.update.mockResolvedValue(
			baseCompany({ budgetMonthlyCents: 50_000, name: "Renamed Co" }),
		);

		const app = await createApp();
		const res = await request(app)
			.patch(`/api/companies/${companyId}`)
			.send({ name: "Renamed Co" });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(mockBudgetService.upsertPolicy).not.toHaveBeenCalled();
	});

	it("skips budgets.upsertPolicy when budgetMonthlyCents body value matches existing", async () => {
		mockCompanyService.getById.mockResolvedValue(
			baseCompany({ budgetMonthlyCents: 75_000 }),
		);
		mockCompanyService.update.mockResolvedValue(
			baseCompany({ budgetMonthlyCents: 75_000 }),
		);

		const app = await createApp();
		const res = await request(app)
			.patch(`/api/companies/${companyId}`)
			.send({ budgetMonthlyCents: 75_000 });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(mockBudgetService.upsertPolicy).not.toHaveBeenCalled();
	});
});
