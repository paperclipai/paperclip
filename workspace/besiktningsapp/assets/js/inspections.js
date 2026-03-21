/**
 * inspections.js — Besiktningsappen
 * Inspection list, wizard (4 steps), room wizard, checklists, summary
 */

'use strict';

const InspectionsModule = (() => {

  let _checklists = null;
  let _inspectionTypes = null;
  let _currentInspectionId = null;
  let _currentRoomIndex = null;
  let _wizardStep = 1;
  let _wizardData = {};
  let _wizardSteps = ['grunduppgifter', 'parter', 'handlingar', 'startmote']; // default

  // Default inspection types if JSON not loaded
  const DEFAULT_TYPES = [
    'Slutbesiktning',
    '§59-besiktning (Tvåårsbesiktning)',
    'Förbesiktning',
    'Särskild besiktning',
    'Efterbesiktning',
    'Kontrollbesiktning',
    'Statusbesiktning',
  ];

  // Default rooms
  const DEFAULT_ROOMS = [
    // Invändigt
    { id: 'entre',     name: 'Entré',            icon: '🚪', category: 'Invändigt' },
    { id: 'kok',       name: 'Kök',               icon: '🍳', category: 'Invändigt' },
    { id: 'vardagsrum',name: 'Vardagsrum',        icon: '🛋️', category: 'Invändigt' },
    { id: 'sovrum1',   name: 'Sovrum 1',          icon: '🛏️', category: 'Invändigt' },
    { id: 'sovrum2',   name: 'Sovrum 2',          icon: '🛏️', category: 'Invändigt' },
    { id: 'badrum',    name: 'Badrum/Våtrum',     icon: '🚿', category: 'Invändigt' },
    { id: 'wc',        name: 'WC',                icon: '🚽', category: 'Invändigt' },
    { id: 'tvattstuga',name: 'Tvättstuga/Teknik', icon: '🔧', category: 'Invändigt' },
    { id: 'forrad',    name: 'Förråd',            icon: '📦', category: 'Invändigt' },
    { id: 'trappa',    name: 'Trappor',           icon: '🪜', category: 'Invändigt' },
    { id: 'vind',      name: 'Vind',              icon: '🏠', category: 'Invändigt' },
    // Utvändigt
    { id: 'tak',       name: 'Yttertak',          icon: '🏚️', category: 'Utvändigt' },
    { id: 'fasad',     name: 'Fasader',           icon: '🧱', category: 'Utvändigt' },
    { id: 'fonster',   name: 'Fönster/Dörrar',   icon: '🪟', category: 'Utvändigt' },
    { id: 'balkong',   name: 'Balkong/Altan',     icon: '🌿', category: 'Utvändigt' },
    { id: 'stuprannor',name: 'Stuprör',           icon: '💧', category: 'Utvändigt' },
    { id: 'mark',      name: 'Mark',              icon: '🌱', category: 'Utvändigt' },
    { id: 'garage',    name: 'Garage',            icon: '🚗', category: 'Utvändigt' },
    { id: 'grundlaggning', name: 'Grundläggning', icon: '🪨', category: 'Utvändigt' },
  ];

  // Default checklist points per room type
  const DEFAULT_CHECKLISTS = {
    generellt: [
      'Golv: buktighet, ytkvalitet, fogsprång',
      'Väggar: buktighet, ytbehandling, sprickor',
      'Tak: ytbehandling, sprickor',
      'Listverk: montering, ytbehandling',
      'Dörrar: funktion, beslag, lås',
      'Fönster: funktion, tätning, kondensering',
      'Belysning: monterad och i funktion',
      'Eluttag: monterade och i funktion',
    ],
    kok: [
      'Inredning: monterad enligt handlingar',
      'Vitvaror: funktion och anslutning',
      'Diskmaskin: anslutning, funktion, tätning',
      'Spis/Spishäll: funktion, säkerhet',
      'Köksfläkt: funktion, ventilation',
      'Vattenkran: funktion, tätning',
      'Avlopp: tätning, funktion',
      'Barnsäkerhetslås på underskåp',
      'Bänkskiva: montage, tätning mot vägg',
      'Kakel/klinker: fogar, fästning',
      'Vattenventiler: åtkomst',
      'Elcentral: placering, märkning',
    ],
    badrum: [
      'Golvfall: mot golvbrunn, inga bakfall',
      'Tätskikt: synliga skador, certifikat',
      'Golvbrunn: höjdsatt, tätt, rens',
      'Väggar: tätskikt bakom blandare, duschplats',
      'Blandare: tätning, funktion',
      'Dusch/badkar: tätning, funktion',
      'Ventilation: drift, luftflöde',
      'Spegel/spegelskåp: montering',
      'WC-stol: tätning, funktion, fixtur',
      'Tvättställ: tätning, funktion',
      'Kakel/klinker: fogar, fästning, fogsprång',
      'Golvvärme: funktion (om aktuellt)',
      'Handdukstork: funktion, montage',
      'Elinstallationer: jordfelsbrytare, placering',
    ],
    tvattstuga: [
      'Tvättmaskinanslutning: tätning, funktion',
      'Torktumlare: ventilation, anslutning',
      'Värmeanläggning: funktion, skötsel',
      'Varmvattenberedare: isolering, ventil',
      'Elcentral: märkning, säkringsautomater',
      'Jordfelsbrytare: funktion',
      'Ventilation: OVK-intyg',
      'Avlopp: tätning, funktion',
      'Golvbrunn: tätning',
      'Brandskydd: brandsläckare, brandvarnare',
    ],
    tak: [
      'Takpannor/-plattor: skador, förskjutning',
      'Nocktegel: tätning, fästning',
      'Hängrännor: funktion, lutning, fästning',
      'Stuprör: anslutning, utlopp',
      'Vindsutrymme: luftning, isolering, ångspärr',
      'Takstolar: skador, röta',
      'Snörasskydd: monterat',
      'Skorsten: tätning, skick',
    ],
    fasad: [
      'Fasadmaterial: skador, sprickor',
      'Puts/puts: sprickbildning, fästning',
      'Dränering: funktion, lutning från hus',
      'Sockelmålning: skick',
      'Balkongbräcken: stabilitet, tätning',
      'Plåtarbeten: tätning, korrosion',
    ],
    generellt_utvandigt: [
      'Utformning: enl. handlingar',
      'Markarbeten: lutning, markbeläggning',
      'Staket/plank: montering, skick',
      'Belysning utomhus: funktion',
    ],
  };

  // ============================================================
  // Public API
  // ============================================================
  function setData(checklists, inspectionTypes, terms) {
    _checklists = checklists;
    _inspectionTypes = inspectionTypes;
  }

  async function init() {
    await _loadInspectionsList();
    _initEventListeners();
  }

  // ============================================================
  // List view
  // ============================================================
  async function _loadInspectionsList() {
    const allInspections = await StorageModule.getAll();
    const ongoing = allInspections.filter(i => i.status !== 'completed' && i.status !== 'signed');
    const completed = allInspections.filter(i => i.status === 'completed' || i.status === 'signed');

    _renderInspectionCards(ongoing, 'ongoing-inspections', 'ongoing-empty');
    _renderInspectionCards(completed, 'completed-inspections', 'completed-empty');

    const badgeOngoing = document.getElementById('badge-ongoing');
    const badgeCompleted = document.getElementById('badge-completed');
    if (badgeOngoing) {
      badgeOngoing.textContent = ongoing.length;
      badgeOngoing.style.display = ongoing.length ? '' : 'none';
    }
    if (badgeCompleted) {
      badgeCompleted.textContent = completed.length;
      badgeCompleted.style.display = completed.length ? '' : 'none';
    }
  }

  function _renderInspectionCards(list, gridId, emptyId) {
    const grid = document.getElementById(gridId);
    const empty = document.getElementById(emptyId);
    if (!grid) return;

    grid.innerHTML = '';

    if (!list.length) {
      if (empty) empty.style.display = 'flex';
      return;
    }
    if (empty) empty.style.display = 'none';

    list.forEach(inspection => {
      const card = _buildInspectionCard(inspection);
      grid.appendChild(card);
    });
  }

  function _buildInspectionCard(inspection) {
    const card = document.createElement('div');
    card.className = 'inspection-card';

    const address = inspection.objekt?.adress || 'Okänd adress';
    const fastbet = inspection.objekt?.fastighetsbeteckning || '';
    const date = inspection.datum ? new Date(inspection.datum).toLocaleDateString('sv-SE') : '–';
    const type = inspection.typ || 'Besiktning';

    // Calculate progress
    const total = _countTotalPoints(inspection);
    const done = _countDonePoints(inspection);
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;

    const statusLabel = { 'ongoing': 'Pågående', 'completed': 'Klar', 'signed': 'Signerad' }[inspection.status] || 'Pågående';
    const statusClass = { 'ongoing': 'anm', 'completed': 'ok', 'signed': 'ok' }[inspection.status] || 'anm';

    card.innerHTML = `
      <div class="inspection-card-header">
        <div class="inspection-card-header-info">
          <div class="inspection-card-title">${_escHtml(address)}</div>
          ${fastbet ? `<div style="font-size:var(--font-size-sm);color:var(--color-text-muted)">${_escHtml(fastbet)}</div>` : ''}
        </div>
        <div class="inspection-card-header-right">
          <span class="inspection-card-type">${_escHtml(type)}</span>
          <button class="btn-delete-inspection" aria-label="Radera besiktning" title="Radera">🗑️</button>
        </div>
      </div>
      <div class="inspection-card-meta">
        <span class="inspection-card-meta-item">📅 ${date}</span>
        <span class="inspection-card-meta-item">
          <span class="status-badge ${statusClass}">${statusLabel}</span>
        </span>
      </div>
      <div class="inspection-card-progress">
        <div style="display:flex;justify-content:space-between;font-size:var(--font-size-xs);color:var(--color-text-muted);margin-bottom:4px">
          <span>Framsteg</span>
          <span>${done}/${total} (${pct}%)</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${pct}%"></div>
        </div>
      </div>
    `;

    card.querySelector('.btn-delete-inspection').addEventListener('click', (e) => {
      e.stopPropagation();
      _confirmDeleteInspection(inspection.id, address);
    });

    card.addEventListener('click', () => _openInspection(inspection.id));
    return card;
  }

  async function _confirmDeleteInspection(id, address) {
    _showConfirm(`Radera besiktningen "${address}"?\nDetta kan inte ångras.`, 'Radera', async () => {
      try {
        await StorageModule.remove(id);
        window.showToast && showToast('Besiktning raderad', 'info');
        await _loadInspectionsList();
      } catch (err) {
        console.error('[Inspections] Delete failed:', err);
        window.showToast && showToast('Kunde inte radera besiktning', 'error');
      }
    });
  }

  function _countTotalPoints(inspection) {
    if (!inspection.rum) return 0;
    return inspection.rum.reduce((acc, rum) => acc + (rum.kontrollpunkter?.length || 0), 0);
  }

  function _countDonePoints(inspection) {
    if (!inspection.rum) return 0;
    return inspection.rum.reduce((acc, rum) => {
      return acc + (rum.kontrollpunkter || []).filter(k => k.status && k.status !== 'ej').length;
    }, 0);
  }

  // ============================================================
  // Wizard — New Inspection
  // ============================================================
  const _WIZARD_SESSION_KEY = 'besiktning_wizard_session';

  function _saveWizardSession() {
    try {
      sessionStorage.setItem(_WIZARD_SESSION_KEY, JSON.stringify({ step: _wizardStep, data: _wizardData }));
    } catch (_) { /* ignore quota errors */ }
  }

  function _clearWizardSession() {
    try { sessionStorage.removeItem(_WIZARD_SESSION_KEY); } catch (_) {}
  }

  function startNewInspection() {
    _wizardStep = 1;
    _wizardData = {
      typ: DEFAULT_TYPES[0],
      datum: new Date().toISOString().split('T')[0],
      tid: new Date().toTimeString().slice(0,5),
      objekt: { fastighetsbeteckning: '', kommun: '', adress: '', objektId: '' },
      parter: { bestallare: {}, entreprenor: {}, husleverantor: {}, ka: {} },
      narvarande: [],
      handlingar: { avtal: [], dokumentation: {} },
      startmote: { kallelse: null, jav: null, jav_text: '', anteckningar: '' },
    };

    // Restore from sessionStorage if available (handles accidental page reload)
    try {
      const saved = sessionStorage.getItem(_WIZARD_SESSION_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.data) {
          _wizardData = Object.assign(_wizardData, parsed.data);
          _wizardStep = parsed.step || 1;
        }
      }
    } catch (_) {}

    _showWizard();
    _renderWizardStep(_wizardStep);
  }

  function _showWizard() {
    document.getElementById('inspections-list-view').style.display = 'none';
    document.getElementById('inspection-wizard').style.display = '';
    document.getElementById('inspection-active').style.display = 'none';
    document.getElementById('inspection-summary').style.display = 'none';
  }

  function _showListView() {
    document.getElementById('inspections-list-view').style.display = '';
    document.getElementById('inspection-wizard').style.display = 'none';
    document.getElementById('inspection-active').style.display = 'none';
    document.getElementById('inspection-summary').style.display = 'none';
    _clearWizardSession();
    _loadInspectionsList();
  }

  // Map step id to builder function
  const _stepBuilders = {
    grunduppgifter: () => _buildStep1(),
    parter:         () => _buildStep2(),
    handlingar:     () => _buildStep3(),
    startmote:      () => _buildStep4(),
  };

  function _getActiveSteps() {
    // Look up steps from loaded inspection types based on current selection
    if (_inspectionTypes && _inspectionTypes.types) {
      const typObj = _inspectionTypes.types.find(t => t.id === _wizardData.typ);
      if (typObj && typObj.steps) {
        // Filter to wizard-relevant steps (exclude rum-wizard, slutsammanstrade etc)
        return typObj.steps.filter(s => _stepBuilders[s]);
      }
    }
    return _wizardSteps;
  }

  function _renderWizardStep(stepIdx) {
    const content = document.getElementById('wizard-content');
    if (!content) return;

    const steps = _getActiveSteps();
    const totalSteps = steps.length;
    const stepId = steps[stepIdx - 1];

    // Update step indicators
    document.querySelectorAll('.wizard-step').forEach(s => {
      const n = parseInt(s.dataset.step);
      s.classList.toggle('active', n === stepIdx);
      s.classList.toggle('completed', n < stepIdx);
    });

    // Navigation buttons
    document.getElementById('wizard-prev').style.display = stepIdx > 1 ? '' : 'none';
    document.getElementById('wizard-next').style.display = stepIdx < totalSteps ? '' : 'none';
    document.getElementById('wizard-finish').style.display = stepIdx === totalSteps ? '' : 'none';

    if (_stepBuilders[stepId]) {
      content.innerHTML = '';
      content.appendChild(_stepBuilders[stepId]());
    }

    _wizardStep = stepIdx;
  }

  function _buildStep1() {
    const div = document.createElement('div');
    div.innerHTML = `<h2 class="wizard-step-title">📋 Grunduppgifter</h2>`;

    const types = (_inspectionTypes && _inspectionTypes.types) ? _inspectionTypes.types : DEFAULT_TYPES;
    const typeOptions = types.map(t => {
      const id = typeof t === 'object' ? (t.id || '') : t;
      const name = typeof t === 'object' ? (t.name || t.id || '') : t;
      return `<option value="${_escAttr(id)}" ${id === _wizardData.typ ? 'selected' : ''}>${_escHtml(name)}</option>`;
    }).join('');

    div.innerHTML += `
      <div class="form-group">
        <label class="form-label" for="wiz-typ">Besiktningstyp</label>
        <select id="wiz-typ" class="form-select">${typeOptions}</select>
      </div>
      <div class="form-group">
        <label class="form-label" for="wiz-datum">Datum</label>
        <input type="date" id="wiz-datum" class="form-input" value="${_wizardData.datum}">
      </div>
      <div class="form-group">
        <label class="form-label" for="wiz-tid">Tid</label>
        <input type="time" id="wiz-tid" class="form-input" value="${_wizardData.tid}">
      </div>
      <div class="form-group">
        <label class="form-label" for="wiz-fastbet">Fastighetsbeteckning</label>
        <input type="text" id="wiz-fastbet" class="form-input" placeholder="Stadsplan 1:23" value="${_escAttr(_wizardData.objekt.fastighetsbeteckning)}">
      </div>
      <div class="form-group">
        <label class="form-label" for="wiz-kommun">Kommun</label>
        <input type="text" id="wiz-kommun" class="form-input" placeholder="Gällivare" value="${_escAttr(_wizardData.objekt.kommun)}">
      </div>
      <div class="form-group">
        <label class="form-label" for="wiz-adress">Gatuadress</label>
        <input type="text" id="wiz-adress" class="form-input" placeholder="Storgatan 1, 97231 Gällivare" value="${_escAttr(_wizardData.objekt.adress)}">
      </div>
      <div class="form-group">
        <label class="form-label" for="wiz-objektid">Objekt-ID / Avtalsnummer (valfritt)</label>
        <input type="text" id="wiz-objektid" class="form-input" placeholder="BES-2024-001" value="${_escAttr(_wizardData.objekt.objektId)}">
      </div>
    `;
    return div;
  }

  function _buildStep2() {
    const div = document.createElement('div');
    const b = _wizardData.parter;
    div.innerHTML = `
      <h2 class="wizard-step-title">👥 Parter</h2>
      <div class="card" style="margin-bottom:var(--space-md)">
        <div class="card-header"><h3 class="card-title">🏠 Beställare (B)</h3></div>
        <div class="card-body">
          <div class="form-group"><label class="form-label">Namn</label><input type="text" id="wiz-b-namn" class="form-input" value="${_escAttr(b.bestallare.namn||'')}" placeholder="För- och efternamn"></div>
          <div class="form-group"><label class="form-label">Telefon</label><input type="tel" id="wiz-b-tel" class="form-input" value="${_escAttr(b.bestallare.telefon||'')}" placeholder="+46 70 000 00 00"></div>
          <div class="form-group"><label class="form-label">E-post</label><input type="email" id="wiz-b-epost" class="form-input" value="${_escAttr(b.bestallare.epost||'')}" placeholder="namn@email.se"></div>
        </div>
      </div>
      <div class="card" style="margin-bottom:var(--space-md)">
        <div class="card-header"><h3 class="card-title">🔨 Entreprenör (E)</h3></div>
        <div class="card-body">
          <div class="form-group"><label class="form-label">Företag</label><input type="text" id="wiz-e-foretag" class="form-input" value="${_escAttr(b.entreprenor.foretag||'')}" placeholder="Byggnads AB"></div>
          <div class="form-group"><label class="form-label">Kontaktperson</label><input type="text" id="wiz-e-kontakt" class="form-input" value="${_escAttr(b.entreprenor.kontakt||'')}" placeholder="Namn"></div>
          <div class="form-group"><label class="form-label">Telefon</label><input type="tel" id="wiz-e-tel" class="form-input" value="${_escAttr(b.entreprenor.telefon||'')}" placeholder="+46 70 000 00 00"></div>
        </div>
      </div>
      <div class="card" style="margin-bottom:var(--space-md)">
        <div class="card-header"><h3 class="card-title">🏭 Husleverantör (valfritt)</h3></div>
        <div class="card-body">
          <div class="form-group"><label class="form-label">Företag</label><input type="text" id="wiz-hl-foretag" class="form-input" value="${_escAttr(b.husleverantor.foretag||'')}" placeholder="Hustillverkare AB"></div>
          <div class="form-group"><label class="form-label">Kontaktperson</label><input type="text" id="wiz-hl-kontakt" class="form-input" value="${_escAttr(b.husleverantor.kontakt||'')}" placeholder="Namn"></div>
        </div>
      </div>
      <div class="card" style="margin-bottom:var(--space-md)">
        <div class="card-header"><h3 class="card-title">📋 Kontrollansvarig (valfritt)</h3></div>
        <div class="card-body">
          <div class="form-group"><label class="form-label">Namn</label><input type="text" id="wiz-ka-namn" class="form-input" value="${_escAttr(b.ka.namn||'')}" placeholder="För- och efternamn"></div>
          <div class="form-group"><label class="form-label">Telefon</label><input type="tel" id="wiz-ka-tel" class="form-input" value="${_escAttr(b.ka.telefon||'')}" placeholder="+46 70 000 00 00"></div>
        </div>
      </div>
    `;
    return div;
  }

  function _buildStep3() {
    const div = document.createElement('div');
    const dok = _wizardData.handlingar.dokumentation;
    const dokItems = [
      { id: 'egenkontroll_grund',  label: 'Egenkontroll – Grund' },
      { id: 'egenkontroll_bygg',   label: 'Egenkontroll – Bygg' },
      { id: 'egenkontroll_el',     label: 'Egenkontroll – El' },
      { id: 'egenkontroll_vvs',    label: 'Egenkontroll – VVS' },
      { id: 'isolationsprovning',  label: 'Isolationsprovning' },
      { id: 'jordfelsbrytartest',  label: 'Jordfelsbrytartest' },
      { id: 'vatrumsintyg',        label: 'Våtrumsintyg (GVK/BBV/MVK)' },
      { id: 'saker_vatten',        label: 'Säker vatteninstallation' },
      { id: 'ovk',                 label: 'OVK-kontroll' },
      { id: 'rokkanalinspektion',  label: 'Inspektion rökkanal' },
      { id: 'fasadintyg',          label: 'Fasadmurning/puts-intyg' },
      { id: 'solceller',           label: 'Solceller (om aktuellt)' },
    ];

    div.innerHTML = `
      <h2 class="wizard-step-title">📁 Entreprenadhandlingar</h2>
      <div class="form-group">
        <label class="form-label">Avtal som ingår</label>
        <div id="avtal-list" style="margin-bottom:var(--space-sm)">
          ${(_wizardData.handlingar.avtal || []).map((a, i) => `
            <div class="avtal-item" style="display:flex;gap:var(--space-sm);margin-bottom:var(--space-xs)">
              <input type="text" class="form-input" value="${_escAttr(a.namn)}" placeholder="Avtalets namn">
              <input type="date" class="form-input" style="max-width:140px" value="${a.datum}">
            </div>
          `).join('')}
        </div>
        <button class="btn btn-outline btn-sm" id="btn-add-avtal">+ Lägg till avtal</button>
      </div>
      <div class="form-group">
        <label class="form-label">Dokumentation – status</label>
        <div class="checkbox-group">
          ${dokItems.map(item => `
            <label class="checkbox-item">
              <input type="checkbox" id="dok-${item.id}" ${dok[item.id] ? 'checked' : ''}>
              <span>${_escHtml(item.label)}</span>
            </label>
          `).join('')}
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="wiz-dok-notering">Notering om saknade dokument</label>
        <textarea id="wiz-dok-notering" class="form-textarea" placeholder="Ange saknade handlingar...">${_escHtml(_wizardData.handlingar.notering||'')}</textarea>
      </div>
    `;

    // Bind add-avtal button
    setTimeout(() => {
      const btn = document.getElementById('btn-add-avtal');
      if (btn) btn.addEventListener('click', () => {
        const list = document.getElementById('avtal-list');
        const row = document.createElement('div');
        row.className = 'avtal-item';
        row.style.cssText = 'display:flex;gap:var(--space-sm);margin-bottom:var(--space-xs)';
        row.innerHTML = `
          <input type="text" class="form-input" placeholder="Avtalets namn">
          <input type="date" class="form-input" style="max-width:140px">
        `;
        list.appendChild(row);
      });
    }, 0);

    return div;
  }

  function _buildStep4() {
    const sm = _wizardData.startmote;
    const div = document.createElement('div');
    div.innerHTML = `
      <h2 class="wizard-step-title">🤝 Startmöte</h2>
      <div class="form-group">
        <label class="form-label">Kallelse utsänd i behörig ordning?</label>
        <div style="display:flex;gap:var(--space-sm)">
          <button class="btn ${sm.kallelse === true ? 'btn-success' : 'btn-secondary'}" id="kallelse-ja">✓ Ja</button>
          <button class="btn ${sm.kallelse === false ? 'btn-danger active-no' : 'btn-secondary'}" id="kallelse-nej">✗ Nej</button>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Jäv?</label>
        <div style="display:flex;gap:var(--space-sm)">
          <button class="btn ${sm.jav === true ? 'btn-danger' : 'btn-secondary'}" id="jav-ja">✓ Ja</button>
          <button class="btn ${sm.jav === false ? 'btn-danger' : 'btn-secondary'}" id="jav-nej">✗ Nej</button>
        </div>
      </div>
      <div class="form-group" id="jav-text-group" style="${sm.jav ? '' : 'display:none'}">
        <label class="form-label" for="wiz-jav-text">Förklaring jäv</label>
        <textarea id="wiz-jav-text" class="form-textarea" placeholder="Beskriv jävssituationen...">${_escHtml(sm.jav_text||'')}</textarea>
      </div>
      <div class="form-group">
        <label class="form-label" for="wiz-overens">Överenskommelser som inte tidigare meddelats?</label>
        <textarea id="wiz-overens" class="form-textarea" placeholder="Ange eventuella överenskommelser...">${_escHtml(sm.overenskommelser||'')}</textarea>
      </div>
      <div class="form-group">
        <label class="form-label" for="wiz-anteckningar">Anteckningar från startmötet</label>
        <textarea id="wiz-anteckningar" class="form-textarea" style="min-height:100px" placeholder="Fritext...">${_escHtml(sm.anteckningar||'')}</textarea>
      </div>
    `;

    // Bind buttons after insert — update in-place to preserve textarea content (fix #15)
    setTimeout(() => {
      function _toggleKallelse(val) {
        _wizardData.startmote.kallelse = val;
        const ja = document.getElementById('kallelse-ja');
        const nej = document.getElementById('kallelse-nej');
        if (ja)  { ja.className  = 'btn ' + (val === true  ? 'btn-success' : 'btn-secondary'); }
        if (nej) { nej.className = 'btn ' + (val === false ? 'btn-danger active-no' : 'btn-secondary'); }
      }
      function _toggleJav(val) {
        _wizardData.startmote.jav = val;
        const ja  = document.getElementById('jav-ja');
        const nej = document.getElementById('jav-nej');
        if (ja)  { ja.className  = 'btn ' + (val === true  ? 'btn-danger' : 'btn-secondary'); }
        if (nej) { nej.className = 'btn ' + (val === false ? 'btn-danger' : 'btn-secondary'); }
        const javGroup = document.getElementById('jav-text-group');
        if (javGroup) javGroup.style.display = val ? '' : 'none';
      }

      document.getElementById('kallelse-ja')?.addEventListener('click', () => _toggleKallelse(true));
      document.getElementById('kallelse-nej')?.addEventListener('click', () => _toggleKallelse(false));
      document.getElementById('jav-ja')?.addEventListener('click', () => _toggleJav(true));
      document.getElementById('jav-nej')?.addEventListener('click', () => _toggleJav(false));
    }, 0);

    return div;
  }

  function _validateWizardStep(step) {
    const steps = _getActiveSteps();
    const stepId = steps[step - 1] || '';
    if (stepId === 'grunduppgifter') {
      const adress = document.getElementById('wiz-adress')?.value?.trim() || '';
      if (!adress) {
        const field = document.getElementById('wiz-adress');
        if (field) {
          field.focus();
          field.classList.add('input-error');
          field.addEventListener('input', () => field.classList.remove('input-error'), { once: true });
        }
        window.showToast && showToast('Ange fastighetens adress för att fortsätta', 'warning');
        return false;
      }
    }
    return true;
  }

  function _collectWizardStep(step) {
    const steps = _getActiveSteps();
    const stepId = steps[step - 1] || '';

    if (stepId === 'grunduppgifter') {
      _wizardData.typ    = document.getElementById('wiz-typ')?.value || _wizardData.typ;
      _wizardData.datum  = document.getElementById('wiz-datum')?.value || _wizardData.datum;
      _wizardData.tid    = document.getElementById('wiz-tid')?.value || _wizardData.tid;
      _wizardData.objekt.fastighetsbeteckning = document.getElementById('wiz-fastbet')?.value || '';
      _wizardData.objekt.kommun = document.getElementById('wiz-kommun')?.value || '';
      _wizardData.objekt.adress = document.getElementById('wiz-adress')?.value || '';
      _wizardData.objekt.objektId = document.getElementById('wiz-objektid')?.value || '';
    }
    if (stepId === 'parter') {
      _wizardData.parter.bestallare = {
        namn: document.getElementById('wiz-b-namn')?.value || '',
        telefon: document.getElementById('wiz-b-tel')?.value || '',
        epost: document.getElementById('wiz-b-epost')?.value || '',
      };
      _wizardData.parter.entreprenor = {
        foretag: document.getElementById('wiz-e-foretag')?.value || '',
        kontakt: document.getElementById('wiz-e-kontakt')?.value || '',
        telefon: document.getElementById('wiz-e-tel')?.value || '',
      };
      _wizardData.parter.husleverantor = {
        foretag: document.getElementById('wiz-hl-foretag')?.value || '',
        kontakt: document.getElementById('wiz-hl-kontakt')?.value || '',
      };
      _wizardData.parter.ka = {
        namn: document.getElementById('wiz-ka-namn')?.value || '',
        telefon: document.getElementById('wiz-ka-tel')?.value || '',
      };
    }
    if (stepId === 'handlingar') {
      const dokKeys = ['egenkontroll_grund','egenkontroll_bygg','egenkontroll_el','egenkontroll_vvs',
        'isolationsprovning','jordfelsbrytartest','vatrumsintyg','saker_vatten','ovk',
        'rokkanalinspektion','fasadintyg','solceller'];
      dokKeys.forEach(k => {
        _wizardData.handlingar.dokumentation[k] = document.getElementById('dok-'+k)?.checked || false;
      });
      _wizardData.handlingar.notering = document.getElementById('wiz-dok-notering')?.value || '';
      _wizardData.handlingar.avtal = [];
      document.querySelectorAll('.avtal-item').forEach(row => {
        const inputs = row.querySelectorAll('input');
        if (inputs[0]?.value) {
          _wizardData.handlingar.avtal.push({ namn: inputs[0].value, datum: inputs[1]?.value || '' });
        }
      });
    }
    if (stepId === 'startmote') {
      _wizardData.startmote.jav_text = document.getElementById('wiz-jav-text')?.value || '';
      _wizardData.startmote.overenskommelser = document.getElementById('wiz-overens')?.value || '';
      _wizardData.startmote.anteckningar = document.getElementById('wiz-anteckningar')?.value || '';
    }
  }

  async function _finishWizard() {
    if (!_validateWizardStep(_wizardStep)) return;
    _collectWizardStep(_wizardStep);
    _clearWizardSession();

    // Build default rooms with checklists
    const rum = DEFAULT_ROOMS.map(room => ({
      ...room,
      kontrollpunkter: _getChecklistForRoom(room.id),
    }));

    const inspection = {
      id: 'bes-' + Date.now(),
      status: 'ongoing',
      skapad: new Date().toISOString(),
      andrad: new Date().toISOString(),
      ..._wizardData,
      rum,
      slutsammantrande: { godkand: null, anledning: '', reklamationsfrist: null, avhjaljandetid: '2 månader' },
    };

    await StorageModule.create(inspection);
    window.showToast && showToast('Besiktning skapad! ✓', 'success');
    _openInspection(inspection.id);
  }

  // ============================================================
  // Checklists
  // ============================================================
  function _getChecklistForRoom(roomId) {
    // Map UI room IDs to checklists.json room IDs
    const roomToChecklist = {
      entre: 'entre',
      kok: 'kok',
      vardagsrum: 'rum',
      sovrum1: 'rum',
      sovrum2: 'rum',
      badrum: 'vatrum',
      wc: 'vatrum',
      tvattstuga: 'tvatt-teknik',
      forrad: 'forrad',
      trappa: null,        // Inga specifika checkpoints i boken
      vind: 'vind',
      tak: 'yttertak',
      fasad: 'fasader',
      fonster: 'fonster-dorrar',
      balkong: 'balkonger',
      stuprannor: 'stupror',
      mark: 'mark',
      garage: 'garage',
      grundlaggning: 'grundlaggning',
    };

    const checklistId = roomToChecklist[roomId];
    
    // Try loaded checklists.json first (data from Besiktningsmannaboken)
    if (_checklists && _checklists.rooms) {
      // Hämta generella kontrollpunkter (gäller alla invändiga rum)
      const generalRoom = _checklists.rooms.find(r => r.id === 'generellt');
      const specificRoom = checklistId ? _checklists.rooms.find(r => r.id === checklistId) : null;
      
      const isInvandigt = ['entre','kok','vardagsrum','sovrum1','sovrum2','badrum','wc','tvattstuga','forrad','trappa','vind'].includes(roomId);
      
      let points = [];
      // Invändiga rum: generella + rumspecifika
      if (isInvandigt && generalRoom) {
        points = [...generalRoom.checkpoints];
      }
      if (specificRoom) {
        points = [...points, ...specificRoom.checkpoints];
      }
      
      if (points.length > 0) {
        return points.map((cp, i) => {
          const text = typeof cp === 'object' ? cp.text : cp;
          const toleranceRef = typeof cp === 'object' ? (cp.toleranceRef || null) : null;
          return {
            id: roomId + '_' + i,
            text,
            toleranceRef,
            status: 'ej',
            felkategori: null,
            foton: [],
            note: '',
            anteckning: '',
            referens: '',
          };
        });
      }
    }

    // Fallback: hardcoded checklists
    const keyMap = {
      kok: 'kok',
      badrum: 'badrum',
      wc: 'badrum',
      tvattstuga: 'tvattstuga',
      tak: 'tak',
      fasad: 'fasad',
      stuprannor: 'stupror',
      mark: 'generellt_utvandigt',
      garage: 'generellt_utvandigt',
    };
    const key = keyMap[roomId];
    if (!key) return []; // Inget fallback = inga irrelevanta punkter
    const points = DEFAULT_CHECKLISTS[key] || [];

    return points.map((text, i) => ({
      id: roomId + '_' + i,
      text,
      status: 'ej',
      felkategori: null,
      foton: [],
      anteckning: '',
      referens: '',
    }));
  }

  // ============================================================
  // Active inspection view
  // ============================================================
  async function _openInspection(id) {
    _currentInspectionId = id;
    const inspection = await StorageModule.get(id);
    if (!inspection) { showToast('Besiktning hittades inte', 'error'); return; }

    document.getElementById('inspections-list-view').style.display = 'none';
    document.getElementById('inspection-wizard').style.display = 'none';
    document.getElementById('inspection-active').style.display = '';
    document.getElementById('inspection-summary').style.display = 'none';

    document.getElementById('active-inspection-title').textContent = inspection.typ || 'Besiktning';
    document.getElementById('active-inspection-address').textContent = inspection.objekt?.adress || '';

    _renderRoomNav(inspection);
    if (inspection.rum && inspection.rum.length) {
      _openRoom(inspection, 0);
      _initSwipe(inspection);
    }
  }

  function _getRoomProgressIcon(room) {
    const points = room.kontrollpunkter || [];
    if (!points.length) return '<span class="room-progress-icon neutral" title="Inga checkpunkter">⚪</span>';
    const hasFel = points.some(p => p.status === 'fel' || p.status === 'anm');
    const allDone = points.every(p => p.status !== 'ej');
    if (hasFel) return '<span class="room-progress-icon red" title="Har anmärkningar">🔴</span>';
    if (allDone) return '<span class="room-progress-icon green" title="Allt OK">🟢</span>';
    return '<span class="room-progress-icon grey" title="Ej påbörjat">⚫</span>';
  }

  function _renderRoomNav(inspection) {
    const list = document.getElementById('room-list');
    if (!list) return;
    list.innerHTML = '';

    const rooms = inspection.rum || [];
    const categories = ['Invändigt', 'Utvändigt'];

    categories.forEach(cat => {
      const catRooms = rooms.map((r, idx) => ({ room: r, idx })).filter(({ room }) => (room.category || '').toLowerCase() === cat.toLowerCase());
      if (!catRooms.length) return;

      // Category header
      const header = document.createElement('div');
      header.className = 'room-category-header';
      header.textContent = cat;
      list.appendChild(header);

      catRooms.forEach(({ room, idx }) => {
        const felCount = (room.kontrollpunkter || []).filter(k => k.status === 'fel').length;
        const item = document.createElement('button');
        item.className = 'room-item' + (idx === _currentRoomIndex ? ' active' : '');
        item.dataset.roomIdx = idx;
        item.innerHTML = `
          <span class="room-item-icon">${room.icon || '🏠'}</span>
          <span class="room-item-name">${_escHtml(room.name)}</span>
          <span style="margin-left:auto;display:flex;align-items:center;gap:4px">
            ${_getRoomProgressIcon(room)}
            ${felCount > 0 ? `<span class="room-item-count">${felCount}</span>` : ''}
          </span>
        `;
        item.addEventListener('click', () => _openRoom(inspection, idx));
        list.appendChild(item);
      });
    });

    // Rooms without category (fallback)
    const uncatRooms = rooms.map((r, idx) => ({ room: r, idx })).filter(({ room }) => !['Invändigt','Utvändigt'].includes(room.category));
    uncatRooms.forEach(({ room, idx }) => {
      const item = document.createElement('button');
      item.className = 'room-item' + (idx === _currentRoomIndex ? ' active' : '');
      item.dataset.roomIdx = idx;
      item.innerHTML = `
        <span class="room-item-icon">${room.icon || '🏠'}</span>
        <span class="room-item-name">${_escHtml(room.name)}</span>
        <span style="margin-left:auto">${_getRoomProgressIcon(room)}</span>
      `;
      item.addEventListener('click', () => _openRoom(inspection, idx));
      list.appendChild(item);
    });

    // Point 7: "Lägg till rum" button
    const addBtn = document.createElement('button');
    addBtn.className = 'room-item room-add-btn';
    addBtn.innerHTML = `<span class="room-item-icon">➕</span><span class="room-item-name">Lägg till rum</span>`;
    addBtn.addEventListener('click', () => _showAddRoomModal(inspection));
    list.appendChild(addBtn);
  }

  async function _openRoom(inspection, roomIdx) {
    _currentRoomIndex = roomIdx;
    const room = inspection.rum[roomIdx];
    if (!room) return;

    // Update nav highlights
    document.querySelectorAll('.room-item').forEach((el, i) => {
      el.classList.toggle('active', i === roomIdx);
    });

    // Update checklist header
    const title = document.getElementById('checklist-room-title');
    if (title) title.textContent = `${room.icon || ''} ${room.name}`;

    _renderChecklist(inspection, room, roomIdx);
    _updateStats(room);
  }

  function _renderChecklist(inspection, room, roomIdx) {
    const container = document.getElementById('checklist-items');
    if (!container) return;
    // Preserve scroll position across re-renders (e.g. after foto add/remove)
    const scrollParent = container.closest('.checklist-panel') || container.parentElement;
    const savedScroll = scrollParent ? scrollParent.scrollTop : 0;
    container.innerHTML = '';

    (room.kontrollpunkter || []).forEach((point, pointIdx) => {
      const item = _buildChecklistItem(inspection, room, roomIdx, point, pointIdx);
      container.appendChild(item);
    });
    if (scrollParent) scrollParent.scrollTop = savedScroll;
  }

  function _buildChecklistItem(inspection, room, roomIdx, point, pointIdx) {
    const el = document.createElement('div');
    el.className = `checklist-item status-${point.status || 'ej'}`;
    el.id = `point-${room.id}-${pointIdx}`;

    const foton = point.foton || [];
    const fotoCount = foton.length;
    const maxFoton = 5;

    const fotonHtml = foton.map((foto, fi) => `
      <div class="foto-thumb" data-foto-idx="${fi}">
        <img src="${_escAttr(foto)}" alt="Foto ${fi+1}" loading="lazy">
        <button class="foto-remove" data-foto-idx="${fi}" aria-label="Ta bort foto">✕</button>
      </div>
    `).join('');

    const badgeHtml = fotoCount > 0
      ? `<span class="foto-badge">${fotoCount}</span>`
      : '';

    const showNote = point.status === 'fel' || point.status === 'anm';
    const hasNote = !!(point.note || '').trim();
    const noteIconHtml = hasNote ? `<span class="note-icon" title="Har anteckning">📝</span>` : '';
    const toleranceBtn = point.toleranceRef
      ? `<button class="tolerance-btn" data-ref="${_escAttr(point.toleranceRef)}" aria-label="Visa toleransvärde" title="Toleransvärde">ℹ️</button>`
      : '';

    el.innerHTML = `
      <div class="checklist-item-header">
        <div class="checklist-item-text">${_escHtml(point.text)}</div>
        <div class="checklist-item-header-icons">${noteIconHtml}${toleranceBtn}</div>
      </div>
      ${point.toleranceRef ? `<div class="tolerance-box" style="display:none"></div>` : ''}
      <div class="checklist-item-controls">
        <div class="status-toggle">
          <button class="status-btn ${point.status==='ok'?'active':''}" data-status="ok">
            <span>✅</span><span>OK</span>
          </button>
          <button class="status-btn ${point.status==='fel'?'active':''}" data-status="fel">
            <span>❌</span><span>Fel</span>
          </button>
          <button class="status-btn ${point.status==='ej'?'active':''}" data-status="ej">
            <span>➖</span><span>Ej bes.</span>
          </button>
          <button class="status-btn ${point.status==='anm'?'active':''}" data-status="anm">
            <span>⚠️</span><span>Anm.</span>
          </button>
        </div>

        <div class="kategori-wrapper"${point.status !== 'fel' ? ' style="display:none"' : ''}>
          <div style="font-size:var(--font-size-xs);font-weight:600;color:var(--color-text-muted);margin-bottom:var(--space-xs)">FELKATEGORI</div>
          <div class="kategori-selector">
            ${['E','B','A','S','U'].map(k => `
              <button class="kategori-btn ${point.felkategori===k?'active':''}" data-kategori="${k}" title="${_kategoriDesc(k)}">${k}</button>
            `).join('')}
          </div>
        </div>

        <div class="checklist-item-actions">
          <div class="foto-btn-wrapper">
            <button class="foto-btn${fotoCount >= maxFoton ? ' foto-btn-full' : ''}" aria-label="Ta foto" title="${fotoCount >= maxFoton ? 'Max 5 foton uppnått' : 'Lägg till foto'}">📷${badgeHtml}</button>
            <input type="file" accept="image/*" capture="environment" style="display:none" class="foto-input" aria-hidden="true">
          </div>
        </div>

        ${fotonHtml ? `<div class="foto-list">${fotonHtml}</div>` : ''}

        <div class="note-wrapper${showNote ? ' note-visible' : ''}">
          <textarea class="note-input" placeholder="Beskriv anmärkning..." aria-label="Anteckning">${_escHtml(point.note || point.anteckning || '')}</textarea>
        </div>
      </div>
    `;

    // Bind status buttons — update in-place to preserve scroll position
    el.querySelectorAll('.status-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const newStatus = btn.dataset.status;
        point.status = newStatus;
        el.className = `checklist-item status-${newStatus}`;
        // Update button active states in-place
        el.querySelectorAll('.status-btn').forEach(b => b.classList.toggle('active', b.dataset.status === newStatus));
        // Toggle felkategori section
        const kategoriwrapper = el.querySelector('.kategori-wrapper');
        if (kategoriwrapper) kategoriwrapper.style.display = newStatus === 'fel' ? '' : 'none';
        // Toggle note wrapper
        const noteWrapper = el.querySelector('.note-wrapper');
        if (noteWrapper) noteWrapper.classList.toggle('note-visible', newStatus === 'fel' || newStatus === 'anm');
        await StorageModule.update(inspection.id, inspection);
        _updateStats(room);
        _renderRoomNav(inspection);
      });
    });

    // Tolerance info button
    const toleranceBtnEl = el.querySelector('.tolerance-btn');
    const toleranceBox = el.querySelector('.tolerance-box');
    if (toleranceBtnEl && toleranceBox) {
      toleranceBtnEl.addEventListener('click', () => {
        const isOpen = toleranceBox.style.display !== 'none';
        if (isOpen) {
          toleranceBox.style.display = 'none';
          toleranceBtnEl.classList.remove('active');
        } else {
          if (!toleranceBox.dataset.loaded) {
            toleranceBox.dataset.loaded = '1';
            toleranceBox.innerHTML = '<span class="tolerance-loading">Laddar...</span>';
            _loadToleranceContent(point.toleranceRef, toleranceBox);
          }
          toleranceBox.style.display = '';
          toleranceBtnEl.classList.add('active');
        }
      });
    }

    // Bind kategori buttons — update in-place
    el.querySelectorAll('.kategori-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        point.felkategori = btn.dataset.kategori;
        el.querySelectorAll('.kategori-btn').forEach(b => b.classList.toggle('active', b.dataset.kategori === point.felkategori));
        await StorageModule.update(inspection.id, inspection);
      });
    });

    // Bind foto
    const fotoBtn = el.querySelector('.foto-btn');
    const fotoInput = el.querySelector('.foto-input');
    fotoBtn.addEventListener('click', () => {
      point.foton = point.foton || [];
      if (point.foton.length >= maxFoton) {
        window.showToast && showToast(`Max ${maxFoton} foton per punkt`, 'warning');
        return;
      }
      fotoInput.click();
    });
    fotoInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      fotoInput.value = ''; // reset so same file can be picked again
      try {
        const resized = await _resizeImage(file, 1200);
        point.foton = point.foton || [];
        if (point.foton.length >= maxFoton) return;
        point.foton.push(resized);
        await StorageModule.update(inspection.id, inspection);
        _renderChecklist(inspection, room, roomIdx);
      } catch (err) {
        console.error('[Foto] Resize error:', err);
        window.showToast && showToast('Kunde inte bearbeta bilden', 'error');
      }
    });

    // Bind note — auto-expand textarea
    const noteInput = el.querySelector('.note-input');
    const noteWrapper = el.querySelector('.note-wrapper');
    let noteTimeout;

    function _autoExpandNote() {
      noteInput.style.height = 'auto';
      const scrollH = noteInput.scrollHeight;
      const minH = 56;  // ~2 rows
      const maxH = 168; // ~6 rows
      noteInput.style.height = Math.min(Math.max(scrollH, minH), maxH) + 'px';
    }

    noteInput.addEventListener('input', () => {
      _autoExpandNote();
      clearTimeout(noteTimeout);
      noteTimeout = setTimeout(async () => {
        point.note = noteInput.value;
        point.anteckning = noteInput.value; // keep legacy field in sync
        // Update note icon visibility without full re-render
        const headerIcons = el.querySelector('.checklist-item-header-icons');
        if (headerIcons) {
          const existing = headerIcons.querySelector('.note-icon');
          if (point.note.trim() && !existing) {
            const icon = document.createElement('span');
            icon.className = 'note-icon';
            icon.title = 'Har anteckning';
            icon.textContent = '📝';
            headerIcons.insertBefore(icon, headerIcons.firstChild);
          } else if (!point.note.trim() && existing) {
            existing.remove();
          }
        }
        await StorageModule.update(inspection.id, inspection);
      }, 500);
    });

    // Initial expand if has content
    if (noteInput.value) setTimeout(_autoExpandNote, 0);

    // Bind foto thumbnail click → fullscreen viewer
    el.querySelectorAll('.foto-thumb img').forEach(img => {
      img.addEventListener('click', (e) => {
        e.stopPropagation();
        const thumbEl = img.closest('.foto-thumb');
        const startIdx = parseInt(thumbEl.dataset.fotoIdx);
        _showFotoViewer(point.foton, startIdx);
      });
    });

    // Bind foto remove (with custom confirmation — window.confirm blocked in PWA/WebView)
    el.querySelectorAll('.foto-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.fotoIdx);
        _showConfirm('Ta bort detta foto?', 'Ta bort', async () => {
          point.foton.splice(idx, 1);
          await StorageModule.update(inspection.id, inspection);
          _renderChecklist(inspection, room, roomIdx);
        });
      });
    });

    return el;
  }

  // ============================================================
  // Resize image using canvas (max maxWidth px wide)
  // ============================================================
  function _resizeImage(file, maxWidth) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = (ev) => {
        const img = new Image();
        img.onerror = () => reject(new Error('Image load failed'));
        img.onload = () => {
          let { width, height } = img;
          if (width > maxWidth) {
            height = Math.round(height * (maxWidth / width));
            width = maxWidth;
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.82));
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ============================================================
  // Fullscreen photo viewer with swipe
  // ============================================================
  function _showFotoViewer(foton, startIdx) {
    // Remove any existing viewer
    document.getElementById('foto-viewer-overlay')?.remove();

    let currentIdx = startIdx || 0;

    const overlay = document.createElement('div');
    overlay.id = 'foto-viewer-overlay';
    overlay.innerHTML = `
      <div class="foto-viewer-inner">
        <button class="foto-viewer-close" aria-label="Stäng">✕</button>
        <div class="foto-viewer-counter"></div>
        <div class="foto-viewer-img-wrap">
          <img class="foto-viewer-img" src="" alt="Foto">
        </div>
        <div class="foto-viewer-nav">
          <button class="foto-viewer-prev" aria-label="Föregående">‹</button>
          <button class="foto-viewer-next" aria-label="Nästa">›</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const imgEl = overlay.querySelector('.foto-viewer-img');
    const counterEl = overlay.querySelector('.foto-viewer-counter');

    function renderAt(idx) {
      currentIdx = Math.max(0, Math.min(idx, foton.length - 1));
      imgEl.src = foton[currentIdx];
      counterEl.textContent = `${currentIdx + 1} / ${foton.length}`;
      overlay.querySelector('.foto-viewer-prev').style.visibility = currentIdx > 0 ? 'visible' : 'hidden';
      overlay.querySelector('.foto-viewer-next').style.visibility = currentIdx < foton.length - 1 ? 'visible' : 'hidden';
    }

    renderAt(currentIdx);

    overlay.querySelector('.foto-viewer-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('.foto-viewer-prev').addEventListener('click', () => renderAt(currentIdx - 1));
    overlay.querySelector('.foto-viewer-next').addEventListener('click', () => renderAt(currentIdx + 1));

    // Swipe support
    let touchStartX = 0;
    overlay.addEventListener('touchstart', (e) => { touchStartX = e.touches[0].clientX; }, { passive: true });
    overlay.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(dx) > 50) {
        renderAt(currentIdx + (dx < 0 ? 1 : -1));
      }
    }, { passive: true });

    // Keyboard
    const onKey = (e) => {
      if (e.key === 'ArrowLeft') renderAt(currentIdx - 1);
      if (e.key === 'ArrowRight') renderAt(currentIdx + 1);
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('remove', () => document.removeEventListener('keydown', onKey));
  }

  // ============================================================
  // Tolerance content loader
  // ============================================================
  let _handbookCache = null;

  async function _getHandbook() {
    if (_handbookCache) return _handbookCache;
    try {
      const res = await fetch('/data/handbook.json');
      _handbookCache = await res.json();
    } catch (e) {
      _handbookCache = null;
    }
    return _handbookCache;
  }

  function _findHandbookSection(handbook, refPath) {
    if (!handbook || !refPath) return null;
    const parts = refPath.split('.');
    // Navigate sections
    let sections = handbook.sections || [];
    for (const part of parts) {
      let found = sections.find(s => s.id === part);
      if (!found) {
        // Check subsections of all sections
        for (const sec of sections) {
          const sub = (sec.subsections || []).find(s => s.id === part);
          if (sub) { found = sub; break; }
        }
      }
      if (!found) return null;
      sections = found.subsections || [];
      if (parts.indexOf(part) === parts.length - 1) return found;
    }
    return null;
  }

  async function _loadToleranceContent(ref, container) {
    const handbook = await _getHandbook();
    const section = _findHandbookSection(handbook, ref);
    if (!section) {
      container.innerHTML = '<span style="color:var(--color-text-muted);font-size:var(--font-size-sm)">Toleransdata saknas</span>';
      return;
    }
    // Extract first ~600 chars of content
    const content = section.content || '';
    // Highlight tolerance numbers with bold
    const formatted = _escHtml(content.slice(0, 600))
      .replace(/±[\d,\. ]+mm/g, '<strong>$&</strong>')
      .replace(/klass [AB]/g, '<strong>$&</strong>')
      + (content.length > 600 ? '...' : '');
    container.innerHTML = `
      <div class="tolerance-title">📐 ${_escHtml(section.title)}</div>
      <div class="tolerance-content">${formatted}</div>
    `;
  }

  function _kategoriDesc(k) {
    const desc = { E: 'Entreprenörens ansvar', B: 'Beställarens anmärkning', A: 'Beställaren påtalat', S: 'Uppskjuts', U: 'Utredning' };
    return desc[k] || k;
  }

  function _updateStats(room) {
    const points = room.kontrollpunkter || [];
    const ok  = points.filter(p => p.status === 'ok').length;
    const fel = points.filter(p => p.status === 'fel').length;
    const anm = points.filter(p => p.status === 'anm').length;

    const statOk  = document.getElementById('stat-ok');
    const statFel = document.getElementById('stat-fel');
    const statAnm = document.getElementById('stat-anm');
    if (statOk)  statOk.textContent  = ok + ' OK';
    if (statFel) statFel.textContent = fel + ' Fel';
    if (statAnm) statAnm.textContent = anm + ' Anm.';
  }

  // ============================================================
  // Summary + Utlåtande-mall
  // ============================================================
  async function _showSummary(inspectionId) {
    const inspection = await StorageModule.get(inspectionId);
    if (!inspection) return;

    document.getElementById('inspection-active').style.display = 'none';
    const summaryEl = document.getElementById('inspection-summary');
    summaryEl.style.display = '';

    // Collect all issues grouped by room
    const felPerRum = [];
    const anmPerRum = [];

    (inspection.rum || []).forEach(room => {
      const roomFel = (room.kontrollpunkter || []).filter(p => p.status === 'fel');
      const roomAnm = (room.kontrollpunkter || []).filter(p => p.status === 'anm');
      if (roomFel.length) felPerRum.push({ room, punkter: roomFel });
      if (roomAnm.length) anmPerRum.push({ room, punkter: roomAnm });
    });

    const totalFel = felPerRum.reduce((a, r) => a + r.punkter.length, 0);
    const totalAnm = anmPerRum.reduce((a, r) => a + r.punkter.length, 0);

    const today = new Date().toISOString().split('T')[0];
    const settings = JSON.parse(localStorage.getItem('besiktning_settings') || '{}');
    const besiktningsmanNamn = settings.namn || '';

    const kategorier = ['E', 'B', 'A', 'S', 'U'];

    summaryEl.innerHTML = `
      <div class="summary-wrapper">
        <!-- Header -->
        <div class="summary-topbar">
          <button class="btn-back" id="summary-back">← Tillbaka</button>
          <h2 class="summary-title">📄 Besiktningsutlåtande</h2>
          <button class="btn btn-primary btn-sm" id="btn-export-pdf">
            <span>📥</span> Exportera PDF
          </button>
        </div>

        <!-- Grunduppgifter (skrivskyddade) -->
        <div class="card summary-card">
          <div class="card-header"><h3 class="card-title">📋 Grunduppgifter</h3></div>
          <div class="card-body summary-info-grid">
            <div class="summary-info-row"><span class="summary-info-label">Adress</span><span class="summary-info-value">${_escHtml(inspection.objekt?.adress || '–')}</span></div>
            <div class="summary-info-row"><span class="summary-info-label">Fastighetsbeteckning</span><span class="summary-info-value">${_escHtml(inspection.objekt?.fastighetsbeteckning || '–')}</span></div>
            <div class="summary-info-row"><span class="summary-info-label">Besiktningstyp</span><span class="summary-info-value">${_escHtml(inspection.typ || '–')}</span></div>
            <div class="summary-info-row"><span class="summary-info-label">Besiktningsdatum</span><span class="summary-info-value">${_escHtml(inspection.datum || '–')}</span></div>
            <div class="summary-info-row"><span class="summary-info-label">Beställare</span><span class="summary-info-value">${_escHtml(inspection.parter?.bestallare?.namn || '–')}</span></div>
            <div class="summary-info-row"><span class="summary-info-label">Entreprenör</span><span class="summary-info-value">${_escHtml(inspection.parter?.entreprenor?.foretag || '–')}</span></div>
          </div>
        </div>

        <!-- Stats overview -->
        <div class="summary-stats-row">
          <div class="summary-stat-box summary-stat-fel">
            <div class="summary-stat-num">${totalFel}</div>
            <div class="summary-stat-label">Fel</div>
          </div>
          <div class="summary-stat-box summary-stat-anm">
            <div class="summary-stat-num">${totalAnm}</div>
            <div class="summary-stat-label">Anmärkningar</div>
          </div>
        </div>

        <!-- FEL-sektion grupperad per rum -->
        ${totalFel > 0 ? `
        <div class="card summary-card">
          <div class="card-header summary-section-header-fel">
            <h3 class="card-title">❌ Fel (${totalFel} st)</h3>
          </div>
          <div class="card-body" style="padding:0">
            ${felPerRum.map(({ room, punkter }) => `
              <div class="summary-room-group">
                <div class="summary-room-header">
                  <span>${_escHtml(room.icon || '')} ${_escHtml(room.name)}</span>
                  <span class="summary-room-count">${punkter.length} st</span>
                </div>
                <div class="summary-room-items">
                  ${punkter.map((p, i) => `
                    <div class="summary-point-item">
                      <span class="summary-point-num">${i + 1}.</span>
                      <div class="summary-point-body">
                        <div class="summary-point-text">${_escHtml(p.text)}</div>
                        ${p.felkategori ? `<span class="summary-point-kat kat-${p.felkategori.toLowerCase()}">${p.felkategori} – ${_kategoriDesc(p.felkategori)}</span>` : ''}
                        ${p.anteckning ? `<div class="summary-point-note">${_escHtml(p.anteckning)}</div>` : ''}
                        ${(p.foton || []).length ? `<div class="summary-point-foton">${(p.foton).slice(0, 3).map((f, fi) => `<img src="${_escAttr(f)}" alt="Foto ${fi+1}" class="summary-thumb" data-room="${_escAttr(room.name)}" data-text="${_escAttr(p.text)}">`).join('')}</div>` : ''}
                      </div>
                    </div>
                  `).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
        ` : ''}

        <!-- ANM-sektion grupperad per rum -->
        ${totalAnm > 0 ? `
        <div class="card summary-card">
          <div class="card-header summary-section-header-anm">
            <h3 class="card-title">⚠️ Anmärkningar (${totalAnm} st)</h3>
          </div>
          <div class="card-body" style="padding:0">
            ${anmPerRum.map(({ room, punkter }) => `
              <div class="summary-room-group">
                <div class="summary-room-header">
                  <span>${_escHtml(room.icon || '')} ${_escHtml(room.name)}</span>
                  <span class="summary-room-count">${punkter.length} st</span>
                </div>
                <div class="summary-room-items">
                  ${punkter.map((p, i) => `
                    <div class="summary-point-item">
                      <span class="summary-point-num">${i + 1}.</span>
                      <div class="summary-point-body">
                        <div class="summary-point-text">${_escHtml(p.text)}</div>
                        ${p.anteckning ? `<div class="summary-point-note">${_escHtml(p.anteckning)}</div>` : ''}
                        ${(p.foton || []).length ? `<div class="summary-point-foton">${(p.foton).slice(0, 3).map((f, fi) => `<img src="${_escAttr(f)}" alt="Foto ${fi+1}" class="summary-thumb">`).join('')}</div>` : ''}
                      </div>
                    </div>
                  `).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
        ` : ''}

        ${totalFel === 0 && totalAnm === 0 ? `
          <div class="empty-state" style="margin:var(--space-lg) 0">
            <p class="empty-icon">✅</p>
            <h2>Inga fel eller anmärkningar!</h2>
            <p>Besiktningen är utan anmärkning.</p>
          </div>
        ` : ''}

        <!-- Sammanfattningstext -->
        <div class="card summary-card">
          <div class="card-header"><h3 class="card-title">📝 Sammanfattning / Övriga noteringar</h3></div>
          <div class="card-body">
            <textarea id="summary-fritext" class="form-textarea" style="min-height:120px" placeholder="Ange övergripande sammanfattning, observationer eller annat som ska framgå av utlåtandet...">${_escHtml(inspection.sammanfattning || '')}</textarea>
          </div>
        </div>

        <!-- Underskrift -->
        <div class="card summary-card">
          <div class="card-header"><h3 class="card-title">✍️ Underskrift</h3></div>
          <div class="card-body">
            <div class="form-group">
              <label class="form-label" for="summary-datum">Datum</label>
              <input type="date" id="summary-datum" class="form-input" value="${today}">
            </div>
            <div class="form-group">
              <label class="form-label" for="summary-ort">Ort</label>
              <input type="text" id="summary-ort" class="form-input" placeholder="t.ex. Gällivare" value="${_escAttr(inspection.ort || settings.ort || '')}">
            </div>
            <div class="form-group">
              <label class="form-label" for="summary-sign-name">Besiktningsmannens namn</label>
              <input type="text" id="summary-sign-name" class="form-input" placeholder="För- och efternamn" value="${_escAttr(besiktningsmanNamn)}">
            </div>
            <div class="form-group">
              <label class="form-label" for="summary-sign-cert">Certifieringsnummer</label>
              <input type="text" id="summary-sign-cert" class="form-input" placeholder="SBR-nummer" value="${_escAttr(settings.cert || '')}">
            </div>
          </div>
        </div>

        <!-- Spara & Exportera -->
        <div class="summary-actions">
          <button class="btn btn-secondary btn-lg" id="btn-save-summary">💾 Spara utlåtande</button>
          <button class="btn btn-primary btn-lg" id="btn-export-pdf-bottom">📥 Exportera PDF</button>
        </div>
      </div>
    `;

    // --- Back button ---
    document.getElementById('summary-back')?.addEventListener('click', () => {
      _saveSummaryFields(inspection);
      summaryEl.style.display = 'none';
      document.getElementById('inspection-active').style.display = '';
    });

    // --- Save summary fields ---
    document.getElementById('btn-save-summary')?.addEventListener('click', async () => {
      await _saveSummaryFields(inspection);
      window.showToast && showToast('Utlåtande sparat ✓', 'success');
    });

    // --- Thumbnail click → fullscreen ---
    summaryEl.querySelectorAll('.summary-thumb').forEach(img => {
      img.addEventListener('click', () => {
        const parent = img.closest('.summary-point-foton');
        const allImgs = [...parent.querySelectorAll('img')].map(i => i.src);
        const idx = [...parent.querySelectorAll('img')].indexOf(img);
        _showFotoViewer(allImgs, idx);
      });
    });

    // --- PDF export ---
    const doExport = () => {
      _saveSummaryFields(inspection).then(() => {
        _exportPdf(inspection);
      });
    };
    document.getElementById('btn-export-pdf')?.addEventListener('click', doExport);
    document.getElementById('btn-export-pdf-bottom')?.addEventListener('click', doExport);
  }

  async function _saveSummaryFields(inspection) {
    inspection.sammanfattning = document.getElementById('summary-fritext')?.value || inspection.sammanfattning || '';
    inspection.ort = document.getElementById('summary-ort')?.value || inspection.ort || '';
    inspection.underskriftDatum = document.getElementById('summary-datum')?.value || '';
    inspection.underskriftNamn = document.getElementById('summary-sign-name')?.value || '';
    inspection.underskriftCert = document.getElementById('summary-sign-cert')?.value || '';
    await StorageModule.update(inspection.id, inspection);
  }

  // ============================================================
  // PDF Export
  // ============================================================
  async function _exportPdf(inspection) {
    // Reload fresh from storage to get latest saved data
    const insp = await StorageModule.get(inspection.id);
    if (!insp) return;

    window.showToast && showToast('Genererar PDF...', 'info');

    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

      const pageW = 210;
      const pageH = 297;
      const margin = 15;
      const contentW = pageW - margin * 2;
      let y = margin;

      // ---- Color palette ----
      const colorBlue   = [26, 82, 118];
      const colorRed    = [192, 57, 43];
      const colorOrange = [211, 84, 0];
      const colorGreen  = [39, 174, 96];
      const colorGrey   = [120, 120, 120];
      const colorLight  = [245, 247, 250];
      const colorBorder = [200, 210, 220];

      // ---- Helpers ----
      function checkPageBreak(needed) {
        if (y + needed > pageH - margin) {
          doc.addPage();
          y = margin;
        }
      }

      function drawHRule(color) {
        doc.setDrawColor(...(color || colorBorder));
        doc.line(margin, y, pageW - margin, y);
        y += 2;
      }

      function drawSectionHeader(title, bgColor) {
        checkPageBreak(14);
        doc.setFillColor(...(bgColor || colorBlue));
        doc.roundedRect(margin, y, contentW, 10, 2, 2, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.setTextColor(255, 255, 255);
        doc.text(title, margin + 4, y + 6.5);
        doc.setTextColor(0);
        y += 14;
      }

      function drawInfoRow(label, value) {
        checkPageBreak(7);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.5);
        doc.setTextColor(...colorGrey);
        doc.text(label + ':', margin, y);
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(30, 30, 30);
        doc.text(String(value || '–'), margin + 55, y);
        y += 6;
      }

      // ---- HEADER ----
      doc.setFillColor(...colorBlue);
      doc.rect(0, 0, pageW, 38, 'F');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(20);
      doc.setTextColor(255, 255, 255);
      doc.text('BESIKTNINGSUTLÅTANDE', pageW / 2, 16, { align: 'center' });

      doc.setFontSize(10);
      doc.setFont('helvetica', 'normal');
      doc.text(insp.typ || 'Besiktning', pageW / 2, 24, { align: 'center' });
      doc.text(insp.objekt?.adress || '', pageW / 2, 31, { align: 'center' });

      y = 46;

      // ---- GRUNDUPPGIFTER ----
      drawSectionHeader('GRUNDUPPGIFTER');
      drawInfoRow('Adress', insp.objekt?.adress);
      drawInfoRow('Fastighetsbeteckning', insp.objekt?.fastighetsbeteckning);
      drawInfoRow('Kommun', insp.objekt?.kommun);
      drawInfoRow('Besiktningstyp', insp.typ);
      drawInfoRow('Datum', insp.datum);
      drawInfoRow('Tid', insp.tid);
      y += 2;

      // ---- PARTER ----
      checkPageBreak(10);
      drawSectionHeader('PARTER');
      const p = insp.parter || {};
      if (p.bestallare?.namn) drawInfoRow('Beställare', p.bestallare.namn + (p.bestallare.telefon ? '  ' + p.bestallare.telefon : ''));
      if (p.entreprenor?.foretag) drawInfoRow('Entreprenör', p.entreprenor.foretag + (p.entreprenor.kontakt ? ' / ' + p.entreprenor.kontakt : ''));
      if (p.husleverantor?.foretag) drawInfoRow('Husleverantör', p.husleverantor.foretag);
      if (p.ka?.namn) drawInfoRow('Kontrollansvarig', p.ka.namn);
      y += 2;

      // ---- FEL & ANMÄRKNINGAR per rum ----
      const felPerRum = [];
      const anmPerRum = [];
      (insp.rum || []).forEach(room => {
        const fel = (room.kontrollpunkter || []).filter(p => p.status === 'fel');
        const anm = (room.kontrollpunkter || []).filter(p => p.status === 'anm');
        if (fel.length) felPerRum.push({ room, punkter: fel });
        if (anm.length) anmPerRum.push({ room, punkter: anm });
      });

      // ---- FEL ----
      if (felPerRum.length) {
        drawSectionHeader('FEL', colorRed);

        for (const { room, punkter } of felPerRum) {
          checkPageBreak(12);
          // Room sub-header
          doc.setFillColor(...colorLight);
          doc.roundedRect(margin, y, contentW, 8, 1, 1, 'F');
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(9);
          doc.setTextColor(...colorRed);
          doc.text(room.name, margin + 3, y + 5.5);
          doc.setTextColor(0);
          y += 10;

          // Table for this room
          const rows = punkter.map((pt, i) => [
            String(i + 1),
            pt.text || '',
            pt.felkategori || '–',
            pt.anteckning || '',
          ]);

          doc.autoTable({
            startY: y,
            head: [['#', 'Kontrollpunkt', 'Kat.', 'Anteckning']],
            body: rows,
            margin: { left: margin, right: margin },
            styles: { fontSize: 8, cellPadding: 2.5, overflow: 'linebreak' },
            headStyles: { fillColor: [220, 100, 80], textColor: 255, fontStyle: 'bold', fontSize: 8 },
            columnStyles: {
              0: { cellWidth: 8 },
              1: { cellWidth: 75 },
              2: { cellWidth: 14 },
              3: { cellWidth: contentW - 97 },
            },
            alternateRowStyles: { fillColor: [255, 245, 245] },
            tableLineColor: colorBorder,
            tableLineWidth: 0.2,
          });

          y = doc.lastAutoTable.finalY + 4;

          // Photos for this room (max 2 per page)
          let photoCount = 0;
          for (const pt of punkter) {
            for (const foto of (pt.foton || []).slice(0, 2)) {
              if (photoCount >= 2) { doc.addPage(); y = margin; photoCount = 0; }
              checkPageBreak(70);
              try {
                const imgFormat = foto.startsWith('data:image/png') ? 'PNG' : 'JPEG';
                // Scale image to fit width / 2
                const imgW = contentW / 2 - 5;
                const imgH = 50;
                const xPos = margin + (photoCount % 2) * (imgW + 10);
                doc.addImage(foto, imgFormat, xPos, y, imgW, imgH);
                doc.setFontSize(7);
                doc.setTextColor(...colorGrey);
                doc.text(`${room.name}: ${pt.text.substring(0, 50)}`, xPos, y + imgH + 3, { maxWidth: imgW });
                if (photoCount % 2 === 1) y += imgH + 10;
                photoCount++;
              } catch (e) {
                console.warn('[PDF] Foto-fel:', e);
              }
            }
          }
          if (photoCount % 2 !== 0) y += 55;
        }
      }

      // ---- ANMÄRKNINGAR ----
      if (anmPerRum.length) {
        checkPageBreak(20);
        drawSectionHeader('ANMÄRKNINGAR', colorOrange);

        for (const { room, punkter } of anmPerRum) {
          checkPageBreak(12);
          doc.setFillColor(...colorLight);
          doc.roundedRect(margin, y, contentW, 8, 1, 1, 'F');
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(9);
          doc.setTextColor(...colorOrange);
          doc.text(room.name, margin + 3, y + 5.5);
          doc.setTextColor(0);
          y += 10;

          const rows = punkter.map((pt, i) => [
            String(i + 1),
            pt.text || '',
            pt.anteckning || '',
          ]);

          doc.autoTable({
            startY: y,
            head: [['#', 'Kontrollpunkt', 'Anteckning']],
            body: rows,
            margin: { left: margin, right: margin },
            styles: { fontSize: 8, cellPadding: 2.5, overflow: 'linebreak' },
            headStyles: { fillColor: [211, 130, 50], textColor: 255, fontStyle: 'bold', fontSize: 8 },
            columnStyles: {
              0: { cellWidth: 8 },
              1: { cellWidth: 90 },
              2: { cellWidth: contentW - 98 },
            },
            alternateRowStyles: { fillColor: [255, 252, 245] },
            tableLineColor: colorBorder,
            tableLineWidth: 0.2,
          });

          y = doc.lastAutoTable.finalY + 4;
        }
      }

      // ---- SAMMANFATTNING ----
      if (insp.sammanfattning) {
        checkPageBreak(30);
        drawSectionHeader('SAMMANFATTNING');
        const lines = doc.splitTextToSize(insp.sammanfattning, contentW);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9);
        doc.setTextColor(30, 30, 30);
        const linesNeeded = lines.length * 5;
        checkPageBreak(linesNeeded + 4);
        doc.text(lines, margin, y);
        y += linesNeeded + 6;
      }

      // ---- UNDERSKRIFT ----
      checkPageBreak(40);
      drawSectionHeader('UNDERSKRIFT');

      const ort = insp.ort || '';
      const datum = insp.underskriftDatum || insp.datum || '';
      const namn = insp.underskriftNamn || '';
      const cert = insp.underskriftCert || '';

      doc.setFontSize(9);
      doc.setTextColor(50, 50, 50);
      doc.text(`Ort och datum: ${ort ? ort + ', ' : ''}${datum}`, margin, y);
      y += 14;

      // Signature line
      doc.setDrawColor(...colorGrey);
      doc.line(margin, y, margin + 80, y);
      doc.setFontSize(8);
      doc.setTextColor(...colorGrey);
      doc.text('Underskrift', margin, y + 4);
      y += 10;

      doc.setFontSize(9);
      doc.setTextColor(30, 30, 30);
      doc.setFont('helvetica', 'bold');
      doc.text(namn, margin, y);
      y += 5;
      if (cert) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(...colorGrey);
        doc.text('Certifiering: ' + cert, margin, y);
        y += 5;
      }

      // ---- FOOTER on all pages ----
      const totalPages = doc.internal.getNumberOfPages();
      for (let pg = 1; pg <= totalPages; pg++) {
        doc.setPage(pg);
        doc.setFontSize(7);
        doc.setTextColor(...colorGrey);
        doc.text(
          `${insp.objekt?.adress || 'Besiktningsutlåtande'} — ${insp.datum || ''} — Sida ${pg} / ${totalPages}`,
          pageW / 2,
          pageH - 7,
          { align: 'center' }
        );
      }

      // ---- Save ----
      const adress = (insp.objekt?.adress || 'besiktning').replace(/[^a-zA-Z0-9åäöÅÄÖ\s]/g, '').replace(/\s+/g, '_').substring(0, 40);
      const datumStr = (insp.datum || today).replace(/-/g, '');
      doc.save(`utlatande_${adress}_${datumStr}.pdf`);
      window.showToast && showToast('PDF exporterad! ✓', 'success');

    } catch (err) {
      console.error('[PDF] Export-fel:', err);
      window.showToast && showToast('PDF-export misslyckades: ' + err.message, 'error');
    }
  }

  // ============================================================
  // Add room modal (Point 7)
  // ============================================================
  async function _showAddRoomModal(inspection) {
    const overlay = document.getElementById('modal-overlay');
    const content = document.getElementById('modal-content');
    if (!overlay || !content) return;

    const extraRooms = [
      { id: 'sovrum', name: 'Sovrum', icon: '🛏️', category: 'Invändigt' },
      { id: 'badrum', name: 'Badrum', icon: '🚿', category: 'Invändigt' },
      { id: 'wc', name: 'WC', icon: '🚽', category: 'Invändigt' },
      { id: 'forrad', name: 'Förråd', icon: '📦', category: 'Invändigt' },
      { id: 'kontor', name: 'Kontor/Arbetsrum', icon: '💼', category: 'Invändigt' },
      { id: 'hall', name: 'Hall', icon: '🚪', category: 'Invändigt' },
      { id: 'hobbyrum', name: 'Hobbyrum', icon: '🎨', category: 'Invändigt' },
      { id: 'balkong', name: 'Balkong/Altan', icon: '🌿', category: 'Utvändigt' },
      { id: 'carport', name: 'Carport', icon: '🚗', category: 'Utvändigt' },
      { id: 'forrad_utv', name: 'Utvändigt förråd', icon: '🏚️', category: 'Utvändigt' },
    ];

    content.innerHTML = `
      <h2 style="font-size:var(--font-size-xl);font-weight:700;margin-bottom:var(--space-lg)">➕ Lägg till rum</h2>
      <div class="form-group">
        <label class="form-label">Välj rumstyp</label>
        <select id="add-room-type" class="form-select">
          ${extraRooms.map(r => `<option value="${r.id}">${r.name}</option>`).join('')}
          <option value="custom">Eget (ange nedan)</option>
        </select>
      </div>
      <div class="form-group" id="custom-room-group" style="display:none">
        <label class="form-label">Eget rumsnamn</label>
        <input type="text" id="custom-room-name" class="form-input" placeholder="t.ex. Allrum">
      </div>
      <div class="form-group">
        <label class="form-label">Kategori</label>
        <select id="add-room-cat" class="form-select">
          <option value="Invändigt">Invändigt</option>
          <option value="Utvändigt">Utvändigt</option>
        </select>
      </div>
      <div style="display:flex;gap:var(--space-sm);justify-content:flex-end;margin-top:var(--space-lg)">
        <button class="btn btn-secondary" id="add-room-cancel">Avbryt</button>
        <button class="btn btn-primary" id="add-room-save">Lägg till</button>
      </div>
    `;
    overlay.style.display = 'flex';

    // Show/hide custom name field
    document.getElementById('add-room-type').addEventListener('change', e => {
      document.getElementById('custom-room-group').style.display = e.target.value === 'custom' ? '' : 'none';
      // Auto-set category
      const found = extraRooms.find(r => r.id === e.target.value);
      if (found) document.getElementById('add-room-cat').value = found.category;
    });

    document.getElementById('add-room-cancel').addEventListener('click', () => overlay.style.display = 'none');
    document.getElementById('add-room-save').addEventListener('click', async () => {
      const typeVal = document.getElementById('add-room-type').value;
      const cat = document.getElementById('add-room-cat').value;
      let name, icon, baseId;

      if (typeVal === 'custom') {
        name = document.getElementById('custom-room-name').value.trim() || 'Rum';
        icon = '🏠';
        baseId = 'rum_custom';
      } else {
        const found = extraRooms.find(r => r.id === typeVal);
        name = found ? found.name : typeVal;
        icon = found ? found.icon : '🏠';
        baseId = typeVal;
      }

      // Unique suffix for duplicates
      const existingCount = (inspection.rum || []).filter(r => r.id.startsWith(baseId)).length;
      const uid = baseId + (existingCount > 0 ? '_' + (existingCount + 1) : '_extra');

      const newRoom = {
        id: uid,
        name: existingCount > 0 ? `${name} ${existingCount + 1}` : name,
        icon,
        category: cat,
        kontrollpunkter: _getChecklistForRoom(typeVal !== 'custom' ? typeVal : 'generellt'),
      };

      inspection.rum = inspection.rum || [];
      inspection.rum.push(newRoom);
      await StorageModule.update(inspection.id, inspection);
      overlay.style.display = 'none';
      _renderRoomNav(inspection);
      _openRoom(inspection, inspection.rum.length - 1);
      window.showToast && showToast(`${newRoom.name} tillagd ✓`, 'success');
    });

    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.style.display = 'none'; }, { once: true });
  }

  // ============================================================
  // Swipe between rooms (Point 8)
  // ============================================================
  function _initSwipe(inspection) {
    const container = document.getElementById('checklist-items');
    if (!container) return;

    let startX = 0;
    let startY = 0;
    let isDragging = false;

    container.addEventListener('touchstart', e => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      isDragging = true;
    }, { passive: true });

    container.addEventListener('touchend', e => {
      if (!isDragging) return;
      isDragging = false;
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;

      // Only horizontal swipe, ignore vertical scroll
      if (Math.abs(dx) < 60 || Math.abs(dy) > Math.abs(dx)) return;

      const rooms = inspection.rum || [];
      const newIdx = dx < 0
        ? Math.min(_currentRoomIndex + 1, rooms.length - 1)  // swipe left → next
        : Math.max(_currentRoomIndex - 1, 0);                 // swipe right → prev

      if (newIdx !== _currentRoomIndex) {
        _openRoom(inspection, newIdx);
        // Scroll room nav to show active item
        const roomList = document.getElementById('room-list');
        const activeBtn = roomList?.querySelector(`.room-item[data-room-idx="${newIdx}"]`);
        activeBtn?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      }
    }, { passive: true });
  }

  // ============================================================
  // Event listeners
  // ============================================================
  function _initEventListeners() {
    document.getElementById('btn-new-inspection')?.addEventListener('click', startNewInspection);

    document.getElementById('wizard-back')?.addEventListener('click', () => {
      if (_wizardStep === 1) {
        _showListView();
      } else {
        _collectWizardStep(_wizardStep);
        _renderWizardStep(_wizardStep - 1);
      }
    });

    document.getElementById('wizard-next')?.addEventListener('click', () => {
      if (!_validateWizardStep(_wizardStep)) return;
      _collectWizardStep(_wizardStep);
      _saveWizardSession();
      _renderWizardStep(_wizardStep + 1);
    });

    document.getElementById('wizard-prev')?.addEventListener('click', () => {
      _collectWizardStep(_wizardStep);
      _saveWizardSession();
      _renderWizardStep(_wizardStep - 1);
    });

    document.getElementById('wizard-finish')?.addEventListener('click', _finishWizard);

    document.getElementById('inspection-back')?.addEventListener('click', _showListView);

    document.getElementById('btn-finish-inspection')?.addEventListener('click', () => {
      if (_currentInspectionId) _showSummary(_currentInspectionId);
    });

    document.getElementById('btn-add-time')?.addEventListener('click', () => {
      _showAddTimeModal();
    });
  }

  async function _showAddTimeModal() {
    const overlay = document.getElementById('modal-overlay');
    const content = document.getElementById('modal-content');
    if (!overlay || !content) return;

    content.innerHTML = `
      <h2 style="font-size:var(--font-size-xl);font-weight:700;margin-bottom:var(--space-lg)">+ Lägg till tidspost</h2>
      <div class="form-group">
        <label class="form-label">Typ av arbete</label>
        <input type="text" id="time-typ" class="form-input" placeholder="t.ex. Besiktning, Restid, Protokoll">
      </div>
      <div class="form-group">
        <label class="form-label">Tid (timmar)</label>
        <input type="number" id="time-timmar" class="form-input" step="0.25" min="0" placeholder="1.5">
      </div>
      <div class="form-group">
        <label class="form-label">Anteckning</label>
        <input type="text" id="time-anm" class="form-input" placeholder="Valfritt">
      </div>
      <div style="display:flex;gap:var(--space-sm);justify-content:flex-end;margin-top:var(--space-lg)">
        <button class="btn btn-secondary" id="time-cancel">Avbryt</button>
        <button class="btn btn-primary" id="time-save">Spara</button>
      </div>
    `;
    overlay.style.display = 'flex';

    document.getElementById('time-cancel').addEventListener('click', () => overlay.style.display = 'none');
    document.getElementById('time-save').addEventListener('click', async () => {
      const inspection = await StorageModule.get(_currentInspectionId);
      if (!inspection) return;
      inspection.tidsposter = inspection.tidsposter || [];
      inspection.tidsposter.push({
        typ: document.getElementById('time-typ').value,
        timmar: parseFloat(document.getElementById('time-timmar').value) || 0,
        anteckning: document.getElementById('time-anm').value,
        datum: new Date().toISOString(),
      });
      await StorageModule.update(_currentInspectionId, inspection);
      overlay.style.display = 'none';
      window.showToast && showToast('Tidspost sparad ✓', 'success');
    });

    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; }, { once: true });
  }

  // ============================================================
  // Helpers
  // ============================================================

  // Custom confirm dialog — replaces window.confirm() which is blocked in PWA/WebView
  function _showConfirm(message, confirmLabel, onConfirm) {
    const overlay = document.getElementById('modal-overlay');
    const content = document.getElementById('modal-content');
    if (!overlay || !content) {
      if (window.confirm(message)) onConfirm();
      return;
    }
    content.innerHTML = `
      <div style="font-size:var(--font-size-md);margin-bottom:var(--space-lg);white-space:pre-wrap">${_escHtml(message)}</div>
      <div style="display:flex;gap:var(--space-sm);justify-content:flex-end">
        <button class="btn btn-secondary" id="confirm-cancel">Avbryt</button>
        <button class="btn btn-danger" id="confirm-ok">${_escHtml(confirmLabel || 'Ta bort')}</button>
      </div>
    `;
    overlay.style.display = 'flex';
    const close = () => { overlay.style.display = 'none'; };
    document.getElementById('confirm-cancel').addEventListener('click', close);
    document.getElementById('confirm-ok').addEventListener('click', () => { close(); onConfirm(); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); }, { once: true });
  }

  function _escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _escAttr(str) { return _escHtml(str); }

  return { init, setData, startNewInspection };

})();

window.InspectionsModule = InspectionsModule;
