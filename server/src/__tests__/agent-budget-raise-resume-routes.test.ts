// Verifies that PATCH /api/agents/:id syncs the agent budget policy when
// `budgetMonthlyCents` is updated, which is what triggers `resumeScopeFromBudget`
// for agents previously paused under reason="budget". Prior to this wiring,
// raising the budget left the agent paused indefinitely.

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";

function baseAgent(overrides: Record<string, unknown> = {}) {
	return {
		id: agentId,
		companyId,
		name: "Builder",
		urlKey: "builder",
		role: "engineer",
		title: "Builder",
		icon: null,
		status: "idle",
		reportsTo: null,
		capabilities: null,
		adapterType: "claude_local",
		adapterConfig: {},
		runtimeConfig: {},
		budgetMonthlyCents: 10_000,
		spentMonthlyCents: 0,
		pauseReason: null,
		pausedAt: null,
		permissions: { canCreateAgents: false },
		lastHeartbeatAt: null,
		metadata: null,
		createdAt: new Date("2026-05-12T00:00:00.000Z"),
		updatedAt: new Date("2026-05-12T00:00:00.000Z"),
		...overrides,
	};
}

const mockAgentService = vi.hoisted(() => ({
	getById: vi.fn(),
	update: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
	canUser: vi.fn(async () => true),
	hasPermission: vi.fn(async () => true),
	ensureMembership: vi.fn(async () => undefined),
}));

const mockBudgetService = vi.hoisted(() => ({
	upsertPolicy: vi.fn(async () => ({ id: "policy-1" })),
}));

const mockApprovalService = vi.hoisted(() => ({
	create: vi.fn(),
	getById: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
	normalizeAdapterConfigForPersistence: vi.fn(
		async (_companyId: string, c: Record<string, unknown>) => c,
	),
	resolveAdapterConfigForRuntime: vi.fn(
		async (_companyId: string, c: Record<string, unknown>) => ({ config: c }),
	),
	syncEnvBindingsForTarget: vi.fn(async () => undefined),
}));

const mockCompanySkillService = vi.hoisted(() => ({
	listRuntimeSkillEntries: vi.fn(async () => []),
	resolveRequestedSkillKeys: vi.fn(async () => []),
}));

const mockHeartbeatService = vi.hoisted(() => ({
	cancelActiveForAgent: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
	linkManyForApproval: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
	materializeManagedBundle: vi.fn(),
	getBundle: vi.fn(),
	readFile: vi.fn(),
	updateBundle: vi.fn(),
	writeFile: vi.fn(),
	deleteFile: vi.fn(),
	exportFiles: vi.fn(),
	ensureManagedBundle: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

const mockInstanceSettingsService = vi.hoisted(() => ({
	getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
}));

vi.mock("../services/index.js", () => ({
	agentService: () => mockAgentService,
	agentInstructionsService: () => mockAgentInstructionsService,
	accessService: () => mockAccessService,
	approvalService: () => mockApprovalService,
	companySkillService: () => mockCompanySkillService,
	budgetService: () => mockBudgetService,
	heartbeatService: () => mockHeartbeatService,
	issueApprovalService: () => mockIssueApprovalService,
	issueService: () => ({}),
	logActivity: mockLogActivity,
	secretService: () => mockSecretService,
	syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
	workspaceOperationService: () => ({}),
}));

vi.mock("../services/instance-settings.js", () => ({
	instanceSettingsService: () => mockInstanceSettingsService,
}));

async function createApp() {
	const [{ agentRoutes }, { errorHandler }] = await Promise.all([
		vi.importActual<typeof import("../routes/agents.js")>(
			"../routes/agents.js",
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
		select: vi.fn(() => ({
			from: vi.fn(() => ({
				where: vi.fn(async () => [
					{ id: companyId, requireBoardApprovalForNewAgents: false },
				]),
			})),
		})),
	};
	app.use("/api", agentRoutes(db as any));
	app.use(errorHandler);
	return app;
}

describe("PATCH /api/agents/:id budget sync", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("calls budgets.upsertPolicy when budgetMonthlyCents changes", async () => {
		const existing = baseAgent({
			budgetMonthlyCents: 10_000,
			status: "paused",
			pauseReason: "budget",
			pausedAt: new Date("2026-05-12T10:00:00.000Z"),
		});
		mockAgentService.getById.mockResolvedValue(existing);
		mockAgentService.update.mockResolvedValue(
			baseAgent({
				budgetMonthlyCents: 200_000,
				status: "paused",
				pauseReason: "budget",
			}),
		);

		const app = await createApp();
		const res = await request(app)
			.patch(`/api/agents/${agentId}`)
			.send({ budgetMonthlyCents: 200_000 });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(mockBudgetService.upsertPolicy).toHaveBeenCalledTimes(1);
		expect(mockBudgetService.upsertPolicy).toHaveBeenCalledWith(
			companyId,
			{
				scopeType: "agent",
				scopeId: agentId,
				amount: 200_000,
				windowKind: "calendar_month_utc",
			},
			"local-board",
		);
	});

	it("skips budgets.upsertPolicy when budgetMonthlyCents is unchanged", async () => {
		const existing = baseAgent({ budgetMonthlyCents: 10_000 });
		mockAgentService.getById.mockResolvedValue(existing);
		mockAgentService.update.mockResolvedValue(
			baseAgent({ budgetMonthlyCents: 10_000, name: "Renamed" }),
		);

		const app = await createApp();
		const res = await request(app)
			.patch(`/api/agents/${agentId}`)
			.send({ name: "Renamed" });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(mockBudgetService.upsertPolicy).not.toHaveBeenCalled();
	});

	it("skips budgets.upsertPolicy when budgetMonthlyCents is in body but matches existing", async () => {
		const existing = baseAgent({ budgetMonthlyCents: 50_000 });
		mockAgentService.getById.mockResolvedValue(existing);
		mockAgentService.update.mockResolvedValue(
			baseAgent({ budgetMonthlyCents: 50_000 }),
		);

		const app = await createApp();
		const res = await request(app)
			.patch(`/api/agents/${agentId}`)
			.send({ budgetMonthlyCents: 50_000 });

		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(mockBudgetService.upsertPolicy).not.toHaveBeenCalled();
	});
});
