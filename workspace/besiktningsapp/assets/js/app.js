/**
 * app.js — Besiktningsappen
 * Main entry point: view routing, data loading, SW registration
 */

'use strict';

// ============================================================
// State
// ============================================================
const App = {
  currentView: 'handbook',
  data: {
    handbook: null,
    checklists: null,
    inspectionTypes: null,
  },
  settings: null,
};

// ============================================================
// View routing
// ============================================================
function showView(viewName) {
  const views = document.querySelectorAll('.view');
  views.forEach(v => {
    v.style.display = 'none';
    v.classList.remove('active');
  });

  const target = document.getElementById('view-' + viewName);
  if (target) {
    target.style.display = '';
    target.classList.add('active');
  }

  // Update navigation state
  document.querySelectorAll('[data-view]').forEach(el => {
    el.classList.toggle('active', el.dataset.view === viewName);
  });

  App.currentView = viewName;

  // Trigger view-specific init
  if (viewName === 'handbook' && App.data.handbook !== null) {
    window.HandbookModule && HandbookModule.render(App.data.handbook);
  }
  if (viewName === 'inspections') {
    window.InspectionsModule && InspectionsModule.init();
  }
}

function initNavigation() {
  // Sidebar nav (desktop) + bottom nav (mobile)
  document.querySelectorAll('[data-view]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const view = e.currentTarget.dataset.view;
      if (view) showView(view);
    });
  });
}

// ============================================================
// JSON data loading
// ============================================================
async function loadJSON(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } catch (err) {
    console.warn(`[App] Could not load ${url}:`, err.message);
    return null;
  }
}

async function loadAllData() {
  const [handbook, checklists, inspectionTypes, terms] = await Promise.all([
    loadJSON('/data/handbook.json'),
    loadJSON('/data/checklists.json'),
    loadJSON('/data/inspection-types.json'),
    loadJSON('/data/terms.json'),
  ]);

  App.data.handbook = handbook;
  App.data.checklists = checklists;
  App.data.inspectionTypes = inspectionTypes;
  App.data.terms = terms;

  // Notify modules
  if (window.HandbookModule) {
    HandbookModule.setData(handbook, terms);
  }
  if (window.InspectionsModule) {
    InspectionsModule.setData(checklists, inspectionTypes, terms);
  }
}

// ============================================================
// Settings
// ============================================================
async function loadSettings() {
  try {
    const raw = localStorage.getItem('besiktning_settings');
    App.settings = raw ? { ...getDefaultSettings(), ...JSON.parse(raw) } : getDefaultSettings();
    applySettingsToForm();
    applyTheme(App.settings.theme);
  } catch (e) {
    App.settings = getDefaultSettings();
  }
}

function getDefaultSettings() {
  return {
    name: '',
    cert: '',
    phone: '',
    email: '',
    company: '',
    orgnr: '',
    address: '',
    logoDataUrl: null,
    theme: 'auto',
  };
}

function applyTheme(val) {
  const theme = val || 'auto';
  document.body.classList.toggle('dark-mode', theme === 'dark');
  document.documentElement.classList.toggle('light-mode', theme === 'light');
}

function applySettingsToForm() {
  const s = App.settings;
  const fields = ['name', 'cert', 'phone', 'email', 'company', 'orgnr', 'address'];
  fields.forEach(f => {
    const el = document.getElementById('setting-' + f);
    if (el && s[f]) el.value = s[f];
  });

  // Theme selector
  const themeEl = document.getElementById('setting-theme');
  if (themeEl) themeEl.value = s.theme || 'auto';

  if (s.logoDataUrl) {
    const preview = document.getElementById('logo-preview');
    const img = document.getElementById('logo-preview-img');
    if (preview && img) {
      img.src = s.logoDataUrl;
      preview.style.display = 'flex';
    }
  }
}

function saveSettings() {
  const fields = ['name', 'cert', 'phone', 'email', 'company', 'orgnr', 'address'];
  fields.forEach(f => {
    const el = document.getElementById('setting-' + f);
    if (el) App.settings[f] = el.value.trim();
  });

  // Save + apply theme immediately
  const themeEl = document.getElementById('setting-theme');
  if (themeEl) {
    App.settings.theme = themeEl.value;
    applyTheme(App.settings.theme);
  }

  try {
    localStorage.setItem('besiktning_settings', JSON.stringify(App.settings));
    showToast('Inställningar sparade! ✓', 'success');
  } catch (e) {
    showToast('Kunde inte spara inställningar', 'error');
  }
}

function initSettingsForm() {
  const saveBtn = document.getElementById('btn-save-settings');
  if (saveBtn) saveBtn.addEventListener('click', saveSettings);

  // Logo upload
  const logoInput = document.getElementById('setting-logo');
  if (logoInput) {
    logoInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        App.settings.logoDataUrl = ev.target.result;
        const preview = document.getElementById('logo-preview');
        const img = document.getElementById('logo-preview-img');
        if (preview && img) {
          img.src = ev.target.result;
          preview.style.display = 'flex';
        }
      };
      reader.readAsDataURL(file);
    });
  }

  const removeLogoBtn = document.getElementById('btn-remove-logo');
  if (removeLogoBtn) {
    removeLogoBtn.addEventListener('click', () => {
      App.settings.logoDataUrl = null;
      const preview = document.getElementById('logo-preview');
      if (preview) preview.style.display = 'none';
    });
  }

  // Offline status
  updateOfflineStatus();
  window.addEventListener('online',  updateOfflineStatus);
  window.addEventListener('offline', updateOfflineStatus);
}

function updateOfflineStatus() {
  const el = document.getElementById('offline-status');
  if (el) {
    if (navigator.onLine) {
      el.textContent = '🟢 Online';
      el.style.color = 'var(--color-ok)';
    } else {
      el.textContent = '🔴 Offline (appen fungerar ändå)';
      el.style.color = 'var(--color-anm)';
    }
  }

  // Global offline banner
  const banner = document.getElementById('offline-banner');
  if (banner) {
    banner.style.display = navigator.onLine ? 'none' : 'block';
  }
  document.body.classList.toggle('offline', !navigator.onLine);
}

// ============================================================
// Toast notifications
// ============================================================
function showToast(message, type = 'info', durationMs = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, durationMs);
}

// Export globally
window.App = App;
window.showView = showView;
window.showToast = showToast;

// ============================================================
// Service Worker
// ============================================================
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker.register('/sw.js').then(reg => {
    console.log('[App] SW registered, scope:', reg.scope);

    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          showToast('Ny version tillgänglig! Ladda om sidan.', 'info', 6000);
        }
      });
    });
  }).catch(err => {
    console.warn('[App] SW registration failed:', err);
  });
}

// ============================================================
// Tabs (Inspections)
// ============================================================
function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;
      if (!tabName) return;

      // Update tab state
      tab.closest('.tabs').querySelectorAll('.tab').forEach(t => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');

      // Show/hide panels
      const panels = tab.closest('.view').querySelectorAll('.tab-panel');
      panels.forEach(p => {
        p.classList.remove('active');
        p.style.display = 'none';
      });

      const panel = document.getElementById('tab-' + tabName);
      if (panel) {
        panel.classList.add('active');
        panel.style.display = '';
      }
    });
  });
}

// ============================================================
// Init
// ============================================================
async function init() {
  initNavigation();
  initTabs();
  await loadSettings();
  initSettingsForm();
  registerServiceWorker();

  // Load data in background
  loadAllData().then(() => {
    // If we're on handbook view, render after data loads
    if (App.currentView === 'handbook') {
      if (window.HandbookModule) HandbookModule.render(App.data.handbook);
    }
  });

  // Show initial view
  showView('handbook');
}

document.addEventListener('DOMContentLoaded', init);
