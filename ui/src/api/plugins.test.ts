import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pluginsApi } from './plugins';
import { api } from './client';

vi.mock('./client', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

describe('pluginsApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('list() should call GET /plugins', async () => {
    await pluginsApi.list();
    expect(api.get).toHaveBeenCalledWith('/plugins');
  });

  it('list("ready") should call GET /plugins?status=ready', async () => {
    await pluginsApi.list('ready');
    expect(api.get).toHaveBeenCalledWith('/plugins?status=ready');
  });

  it('get("plug-1") should call GET /plugins/plug-1', async () => {
    await pluginsApi.get('plug-1');
    expect(api.get).toHaveBeenCalledWith('/plugins/plug-1');
  });

  it('install() should call POST /plugins/install', async () => {
    const params = { packageName: 'test-plugin' };
    await pluginsApi.install(params);
    expect(api.post).toHaveBeenCalledWith('/plugins/install', params);
  });

  it('uninstall() should call DELETE /plugins/:id', async () => {
    await pluginsApi.uninstall('plug-1');
    expect(api.delete).toHaveBeenCalledWith('/plugins/plug-1');
  });

  it('uninstall() with purge should call DELETE /plugins/:id?purge=true', async () => {
    await pluginsApi.uninstall('plug-1', true);
    expect(api.delete).toHaveBeenCalledWith('/plugins/plug-1?purge=true');
  });

  it('enable() should call POST /plugins/:id/enable', async () => {
    await pluginsApi.enable('plug-1');
    expect(api.post).toHaveBeenCalledWith('/plugins/plug-1/enable', {});
  });

  it('disable() should call POST /plugins/:id/disable', async () => {
    await pluginsApi.disable('plug-1');
    expect(api.post).toHaveBeenCalledWith('/plugins/plug-1/disable', {});
  });

  it('disable() with reason should call POST /plugins/:id/disable', async () => {
    await pluginsApi.disable('plug-1', 'bad');
    expect(api.post).toHaveBeenCalledWith('/plugins/plug-1/disable', { reason: 'bad' });
  });

  it('health() should call GET /plugins/:id/health', async () => {
    await pluginsApi.health('plug-1');
    expect(api.get).toHaveBeenCalledWith('/plugins/plug-1/health');
  });

  it('upgrade() should call POST /plugins/:id/upgrade', async () => {
    await pluginsApi.upgrade('plug-1');
    expect(api.post).toHaveBeenCalledWith('/plugins/plug-1/upgrade', {});
  });

  it('upgrade() with version should call POST /plugins/:id/upgrade', async () => {
    await pluginsApi.upgrade('plug-1', '2.0.0');
    expect(api.post).toHaveBeenCalledWith('/plugins/plug-1/upgrade', { version: '2.0.0' });
  });

  it('listUiContributions() should call GET /plugins/ui-contributions', async () => {
    await pluginsApi.listUiContributions();
    expect(api.get).toHaveBeenCalledWith('/plugins/ui-contributions');
  });

  it('listUiContributions("c1") should scope GET /plugins/ui-contributions by company', async () => {
    await pluginsApi.listUiContributions('c1');
    expect(api.get).toHaveBeenCalledWith('/plugins/ui-contributions?companyId=c1');
  });

  it('listForCompany() should call GET /companies/:companyId/plugins', async () => {
    await pluginsApi.listForCompany('c1');
    expect(api.get).toHaveBeenCalledWith('/companies/c1/plugins');
  });

  it('listForCompany() should include available filter when provided', async () => {
    await pluginsApi.listForCompany('c1', true);
    expect(api.get).toHaveBeenCalledWith('/companies/c1/plugins?available=true');
  });

  it('getForCompany() should call GET /companies/:companyId/plugins/:pluginId', async () => {
    await pluginsApi.getForCompany('c1', 'plug-1');
    expect(api.get).toHaveBeenCalledWith('/companies/c1/plugins/plug-1');
  });

  it('saveForCompany() should call PUT /companies/:companyId/plugins/:pluginId', async () => {
    const params = { available: true, settingsJson: { mode: 'full' } };
    await pluginsApi.saveForCompany('c1', 'plug-1', params);
    expect(api.put).toHaveBeenCalledWith('/companies/c1/plugins/plug-1', params);
  });

  // Plugin config endpoints
  it('getConfig() should call GET /plugins/:id/config', async () => {
    await pluginsApi.getConfig('plug-1');
    expect(api.get).toHaveBeenCalledWith('/plugins/plug-1/config');
  });

  it('saveConfig() should call POST /plugins/:id/config', async () => {
    const configJson = { apiKey: 'test', baseUrl: 'https://example.com' };
    await pluginsApi.saveConfig('plug-1', configJson);
    expect(api.post).toHaveBeenCalledWith('/plugins/plug-1/config', { configJson });
  });

  it('testConfig() should call POST /plugins/:id/config/test', async () => {
    const configJson = { apiKey: 'test' };
    await pluginsApi.testConfig('plug-1', configJson);
    expect(api.post).toHaveBeenCalledWith('/plugins/plug-1/config/test', { configJson });
  });

  it('bridgeGetData() should include companyId when provided', async () => {
    await pluginsApi.bridgeGetData('plug-1', 'status', { scope: 'issue' }, 'c1');
    expect(api.post).toHaveBeenCalledWith('/plugins/plug-1/data/status', {
      companyId: 'c1',
      params: { scope: 'issue' },
      renderEnvironment: undefined,
    });
  });

  it('bridgePerformAction() should include companyId when provided', async () => {
    await pluginsApi.bridgePerformAction('plug-1', 'resync', { force: true }, 'c1');
    expect(api.post).toHaveBeenCalledWith('/plugins/plug-1/actions/resync', {
      companyId: 'c1',
      params: { force: true },
      renderEnvironment: undefined,
    });
  });

  it('bridgeGetData() should include renderEnvironment when provided', async () => {
    await pluginsApi.bridgeGetData(
      'plug-1',
      'status',
      { scope: 'issue' },
      'c1',
      { environment: 'hostOverlay', launcherId: 'sync-modal', bounds: 'wide' },
    );
    expect(api.post).toHaveBeenCalledWith('/plugins/plug-1/data/status', {
      companyId: 'c1',
      params: { scope: 'issue' },
      renderEnvironment: {
        environment: 'hostOverlay',
        launcherId: 'sync-modal',
        bounds: 'wide',
      },
    });
  });

  it('bridgePerformAction() should include renderEnvironment when provided', async () => {
    await pluginsApi.bridgePerformAction(
      'plug-1',
      'resync',
      { force: true },
      'c1',
      { environment: 'hostOverlay', launcherId: 'sync-modal', bounds: 'wide' },
    );
    expect(api.post).toHaveBeenCalledWith('/plugins/plug-1/actions/resync', {
      companyId: 'c1',
      params: { force: true },
      renderEnvironment: {
        environment: 'hostOverlay',
        launcherId: 'sync-modal',
        bounds: 'wide',
      },
    });
  });
});
