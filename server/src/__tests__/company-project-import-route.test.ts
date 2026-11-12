import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  agentGetById: vi.fn(), previewImport: vi.fn(), importBundle: vi.fn(), resolveSource: vi.fn(),
}));

vi.mock('../services/company-project-repository-import.js', () => ({ resolveCompanyProjectRepository: mocks.resolveSource }));
vi.mock('../services/access.js', () => ({ accessService: () => ({}) }));
vi.mock('../services/agents.js', () => ({ agentService: () => ({ getById: mocks.agentGetById, list: vi.fn().mockResolvedValue([]) }) }));
vi.mock('../services/budgets.js', () => ({ budgetService: () => ({}) }));
vi.mock('../services/companies.js', () => ({ companyService: () => ({}) }));
vi.mock('../services/company-portability.js', () => ({ companyPortabilityService: () => ({ previewImport: mocks.previewImport, importBundle: mocks.importBundle }) }));
vi.mock('../services/feedback.js', () => ({ feedbackService: () => ({}) }));
vi.mock('../services/activity-log.js', () => ({ logActivity: vi.fn() }));
vi.mock('../services/index.js', () => ({
  accessService: () => ({}), agentService: () => ({ getById: mocks.agentGetById, list: vi.fn().mockResolvedValue([]) }),
  budgetService: () => ({}), heartbeatService: () => ({ cancelBudgetScopeWork: vi.fn() }),
  buildExportFidelityReport: vi.fn(), collectExportFidelityCounts: vi.fn(), companyArtifactsService: () => ({}),
  companyPortabilityService: () => ({ previewImport: mocks.previewImport, importBundle: mocks.importBundle }),
  companyService: () => ({}), feedbackService: () => ({}), logActivity: vi.fn(), workTimelineService: () => ({}),
}));

let importCounter = 0;
async function createApp(actor: Record<string, unknown>) {
  importCounter += 1;
  const suffix = `company-project-import-route-${importCounter}`;
  const routeModulePath = `../routes/companies.js?${suffix}`;
  const middlewareModulePath = `../middleware/index.js?${suffix}`;
  const [{ companyRoutes }, { errorHandler }] = await Promise.all([
    import(routeModulePath) as Promise<typeof import('../routes/companies.js')>,
    import(middlewareModulePath) as Promise<typeof import('../middleware/index.js')>,
  ]) as [typeof import('../routes/companies.js'), typeof import('../middleware/index.js')];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).actor = actor; next(); });
  app.use('/api/companies', companyRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const routeCompany = '11111111-1111-4111-8111-111111111111';
const otherCompany = '22222222-2222-4222-8222-222222222222';
const requestBody = (companyId: string) => ({
  source: { type: 'project_repository', companyId, workspaceId: '33333333-3333-4333-8333-333333333333' },
  include: { company: true, agents: true, projects: false, issues: false },
  target: { mode: 'existing_company', companyId: routeCompany }, collisionStrategy: 'rename',
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.agentGetById.mockResolvedValue({ id: 'agent-1', companyId: routeCompany, role: 'ceo' });
  mocks.previewImport.mockResolvedValue({ ok: true });
  mocks.importBundle.mockResolvedValue({ company: { id: routeCompany, action: 'updated' }, agents: [], warnings: [] });
  mocks.resolveSource.mockResolvedValue({ type: 'inline', files: {}, expectedFileCount: 0 });
});

describe('company project repository import routes', () => {
  it('rejects a project_repository source from another company before resolving it', async () => {
    const app = await createApp({
      type: 'board', userId: 'user-1', source: 'session', companyIds: [routeCompany],
      memberships: [{ companyId: routeCompany, membershipRole: 'owner', status: 'active' }],
    });
    const response = await request(app).post(`/api/companies/${routeCompany}/imports/preview`).send(requestBody(otherCompany));
    expect(response.status).toBe(403);
    expect(response.body.error).toContain('must belong to the route company');
    expect(mocks.resolveSource).not.toHaveBeenCalled();
    expect(mocks.previewImport).not.toHaveBeenCalled();
  });

  it('rejects an agent whose company differs from the route before resolving a repository source', async () => {
    const app = await createApp({ type: 'agent', agentId: 'agent-other', companyId: otherCompany, source: 'agent_key', runId: 'run-1' });
    const response = await request(app).post(`/api/companies/${routeCompany}/imports/preview`).send(requestBody(routeCompany));
    expect(response.status).toBe(403);
    expect(response.body.error).toContain('another company');
    expect(mocks.resolveSource).not.toHaveBeenCalled();
    expect(mocks.previewImport).not.toHaveBeenCalled();
  });
});
