/**
 * Toca Ficha Dr. — EMR Dashboard Frontend
 *
 * Primary physician interface for EMR automation.
 * Supports template selection, complete workflow execution,
 * comprehensive dosage calculator, and real-time activity feed.
 */
const App = {
    eventSource: null,
    activities: [],
    selectedTemplate: null,
    templateLabels: {},
    templateShortcutMap: {},
    isExecuting: false,
    audioStatusTimer: null,
    auditRefreshTimer: null,

    // ═══════════════════════════════════════════════════════
    // Initialization
    // ═══════════════════════════════════════════════════════

    init() {
        this.loadTemplateMetadata();
        this.setupNavigation();
        this.setupKeyboardShortcuts();
        this.connectSSE();
        this.pollStatus();
        this.refreshAudioStatus();
        this.loadDailySummary();
        this.loadAuditSummary();
        this.preloadActivityFeed();
        // Poll status every 5 seconds
        setInterval(() => this.pollStatus(), 5000);
        this.audioStatusTimer = setInterval(() => this.refreshAudioStatus(), 4000);
        this.auditRefreshTimer = setInterval(() => this.refreshAuditWidgets(), 30000);
    },

    // ═══════════════════════════════════════════════════════
    // Template Metadata
    // ═══════════════════════════════════════════════════════

    loadTemplateMetadata() {
        this.templateLabels = {};
        this.templateShortcutMap = {};

        document.querySelectorAll('.tpl-btn').forEach((btn) => {
            const code = btn.dataset.tpl;
            const label = btn.dataset.label || code;
            const shortcutKey = btn.dataset.key;

            this.templateLabels[code] = label;
            if (shortcutKey) this.templateShortcutMap[shortcutKey] = code;
        });
    },

    // ═══════════════════════════════════════════════════════
    // Navigation
    // ═══════════════════════════════════════════════════════

    setupNavigation() {
        document.querySelectorAll('.nav-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
                btn.classList.add('active');
                const panel = document.getElementById('panel-' + btn.dataset.panel);
                if (panel) panel.classList.add('active');

                if (btn.dataset.panel === 'audit') {
                    this.loadAudit();
                    this.loadAuditSummary();
                }
                if (btn.dataset.panel === 'config') this.loadConfig();
                if (btn.dataset.panel === 'dosages') this.syncDosageWeight();
            });
        });
    },

    // ═══════════════════════════════════════════════════════
    // Keyboard Shortcuts
    // ═══════════════════════════════════════════════════════

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Don't trigger shortcuts when typing in inputs
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

            const templateCode = this.templateShortcutMap[e.key];
            if (templateCode) {
                this.selectTemplate(templateCode);
                return;
            }

            switch (e.key) {
                case 'Enter':
                    e.preventDefault();
                    this.executeWorkflow();
                    break;
                case 'd':
                case 'D':
                    this.action('discharge');
                    break;
                case 'm':
                case 'M':
                    this.action('medication');
                    break;
                case 'r':
                case 'R':
                    this.refreshPatient();
                    break;
            }
        });
    },

    // ═══════════════════════════════════════════════════════
    // SSE (Real-time Events)
    // ═══════════════════════════════════════════════════════

    connectSSE() {
        if (this.eventSource) this.eventSource.close();
        this.eventSource = new EventSource('/api/events', { withCredentials: true });

        this.eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.handleEvent(data);
            } catch (e) { /* ignore parse errors */ }
        };

        this.eventSource.onerror = () => {
            this.setConnectionStatus('offline', 'Offline');
        };

        this.eventSource.onopen = () => {
            this.setConnectionStatus('online', 'Online');
        };
    },

    handleEvent(data) {
        if (data.type === 'action_started') {
            this.addActivity(data.action, 'running', data.patient_id);
            this.setExecuting(true);
        }

        if (data.type === 'action_completed') {
            const status = data.success ? 'success' : 'failure';
            this.addActivity(data.action, status, data.patient_id, data.duration, data.error);
            this.toast(
                data.success
                    ? `${this.actionLabel(data.action)} concluido`
                    : `${this.actionLabel(data.action)} falhou${data.error ? ': ' + data.error : ''}`,
                data.success ? 'success' : 'error'
            );
            this.setExecuting(false);
            this.pollStatus();
            this.loadDailySummary();
            this.refreshAuditWidgets();
        }

        if (data.type === 'workflow_progress') {
            const steps = data.steps || [];
            const sub = steps.map(s => this.stepLabel(s)).join(' > ');
            const el = document.getElementById('exec-sub');
            if (el) el.textContent = sub || 'Processando...';
        }

        if (data.type === 'patient_changed') {
            // Core detected a new patient — update the patient card immediately
            // without waiting for the next 5-second poll cycle.
            this.updatePatientUI(data);
            this.pollStatus(); // also refresh status badge + dosages
        }

        if (data.type === 'config_updated') {
            this.toast('Configuracao atualizada', 'info');
        }
    },

    // ═══════════════════════════════════════════════════════
    // Status Polling
    // ═══════════════════════════════════════════════════════

    async pollStatus() {
        try {
            const res = await fetch('/api/status');
            const status = await res.json();
            this.updateStatusUI(status);

            if (status.current_patient) {
                const pRes = await fetch('/api/patient');
                const patient = await pRes.json();
                this.updatePatientUI(patient);
            } else {
                this.clearPatientUI();
            }
        } catch (e) {
            this.setConnectionStatus('offline', 'Offline');
            // Keep skeleton visible on error until next retry
        }
    },

    updateStatusUI(status) {
        if (status.running && status.driver_active) {
            this.setConnectionStatus(
                status.session_valid ? 'online' : 'warn',
                status.session_valid ? 'Online' : 'Sessao Invalida'
            );
        } else if (status.running) {
            this.setConnectionStatus('warn', 'Driver Inativo');
        } else {
            this.setConnectionStatus('offline', 'Standalone');
        }
    },

    setConnectionStatus(type, text) {
        const badge = document.getElementById('connection-status');
        badge.className = 'badge badge-' + type;
        badge.textContent = text;
    },

    // ═══════════════════════════════════════════════════════
    // Patient Info
    // ═══════════════════════════════════════════════════════

    updatePatientUI(patient) {
        const el = document.getElementById('patient-info');
        const skeleton = document.getElementById('patient-skeleton');
        if (!patient.intern_id) {
            this.clearPatientUI();
            return;
        }

        // Hide skeleton, show content
        if (skeleton) skeleton.classList.add('hidden');
        el.classList.remove('hidden');

        const pid = this.escapeHtml(patient.intern_id);
        const weightText = patient.weight ? `${this.escapeHtml(patient.weight)} kg` : 'N/A';
        const complaintHtml = patient.chief_complaint
            ? `<div class="patient-complaint">${this.escapeHtml(patient.chief_complaint)}</div>`
            : '';

        el.className = '';
        el.innerHTML = `
            <div class="patient-data">
                <div class="patient-header-row" id="patient-header-row"></div>
                <div class="patient-row">
                    <span class="p-label">ID</span>
                    <span class="p-value">${pid}</span>
                </div>
                <div class="patient-row weight-row">
                    <span class="p-label">Peso</span>
                    <span class="p-value">${weightText}</span>
                </div>
                ${complaintHtml}
            </div>
        `;

        // Build the name/age header row using textContent (XSS-safe)
        const headerRow = document.getElementById('patient-header-row');
        if (headerRow) {
            const nameSpan = document.createElement('span');
            nameSpan.className = 'patient-name';
            nameSpan.textContent = patient.patient_name || ('Paciente #' + (patient.intern_id || ''));
            headerRow.appendChild(nameSpan);
            if (patient.patient_age) {
                const ageSpan = document.createElement('span');
                ageSpan.className = 'patient-age';
                ageSpan.textContent = patient.patient_age;
                headerRow.appendChild(ageSpan);
            }
        }

        // Update dosage weight input
        if (patient.weight) {
            const wi = document.getElementById('dosage-weight');
            if (wi && !wi.value) wi.value = patient.weight;
        }

        // Show quick dosages (analgesics)
        if (patient.dosages && patient.dosages.length) {
            this.renderQuickDosages(patient.dosages, patient.weight);
        }
    },

    clearPatientUI() {
        const el = document.getElementById('patient-info');
        const skeleton = document.getElementById('patient-skeleton');
        // Show empty state, hide skeleton
        if (skeleton) skeleton.classList.add('hidden');
        el.classList.remove('hidden');
        el.className = 'patient-empty';
        el.innerHTML = '<div class="empty-icon">&#9899;</div><p>Aguardando paciente...</p>';
        document.getElementById('quick-dosages').classList.add('hidden');
    },

    renderQuickDosages(dosages, weight) {
        const qd = document.getElementById('quick-dosages');
        // Show analgesics + most common
        const quick = dosages.filter(d =>
            ['dipyrone', 'paracetamol', 'ibuprofen'].includes(d.id)
        );
        if (!quick.length) { qd.classList.add('hidden'); return; }

        qd.classList.remove('hidden');
        qd.innerHTML = `
            <h3>Dosagens rapidas (${this.escapeHtml(weight)}kg)</h3>
            ${quick.map(d => `
                <div class="qd-row">
                    <span class="qd-name">${this.escapeHtml(d.name)}</span>
                    <span class="qd-dose">${this.escapeHtml(d.practical)}</span>
                </div>
            `).join('')}
        `;
    },

    // ═══════════════════════════════════════════════════════
    // Template Selection & Workflow
    // ═══════════════════════════════════════════════════════

    selectTemplate(code) {
        this.selectedTemplate = code;
        document.querySelectorAll('.tpl-btn').forEach(btn => {
            btn.classList.toggle('selected', btn.dataset.tpl === code);
        });

        const execBtn = document.getElementById('btn-execute');
        const execTitle = document.getElementById('exec-title');
        const execSub = document.getElementById('exec-sub');

        execBtn.disabled = false;
        execTitle.textContent = 'EXECUTAR';
        execSub.textContent = this.templateLabel(code);
    },

    async executeWorkflow() {
        if (!this.selectedTemplate || this.isExecuting) return;

        const opts = {
            template: this.selectedTemplate,
            include_medication: document.getElementById('opt-medication').checked,
            include_attestation: document.getElementById('opt-attestation').checked,
            include_discharge: document.getElementById('opt-discharge').checked,
        };

        try {
            const res = await fetch('/api/actions/complete_workflow', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(opts),
            });
            let data = {};
            try { data = await res.json(); } catch (e) { /* ignore */ }
            if (!res.ok) {
                this.toast(data.error || 'Erro ao iniciar workflow', 'error');
                return;
            }
            if (data.error) {
                this.toast(data.error, 'error');
                return;
            }
            this.toast('Workflow iniciado...', 'info');
            this.setExecuting(true);
        } catch (e) {
            this.toast('Erro de conexao', 'error');
        }
    },

    setExecuting(running) {
        this.isExecuting = running;
        const btn = document.getElementById('btn-execute');
        const icon = document.getElementById('exec-icon');
        const sub = document.getElementById('exec-sub');

        if (running) {
            btn.classList.add('running');
            icon.innerHTML = '&#9881;'; // gear
            sub.textContent = 'Processando...';
        } else {
            btn.classList.remove('running');
            icon.innerHTML = '&#9654;'; // play
            if (this.selectedTemplate) {
                sub.textContent = this.templateLabel(this.selectedTemplate);
            } else {
                sub.textContent = 'Selecione um template acima';
            }
        }
    },

    // ═══════════════════════════════════════════════════════
    // Individual Actions
    // ═══════════════════════════════════════════════════════

    async action(name) {
        if (this.isExecuting) {
            this.toast('Operacao em andamento. Aguarde...', 'info');
            return;
        }
        try {
            const res = await fetch(`/api/actions/${name}`, { method: 'POST' });
            let data = {};
            try { data = await res.json(); } catch (e) { /* ignore */ }
            if (!res.ok) {
                this.toast(data.error || 'Erro ao iniciar acao', 'error');
                return;
            }
            if (data.error) {
                this.toast(data.error, 'error');
                return;
            }
            this.toast(`${this.actionLabel(name)} iniciado...`, 'info');
        } catch (e) {
            this.toast('Erro de conexao', 'error');
        }
    },

    async refreshPatient() {
        await this.action('refresh');
        setTimeout(() => this.pollStatus(), 2000);
    },

    // ═══════════════════════════════════════════════════════
    // Full Dosage Calculator
    // ═══════════════════════════════════════════════════════

    syncDosageWeight() {
        // If patient has weight, pre-fill the dosage calculator
        const wi = document.getElementById('dosage-weight');
        if (wi && !wi.value) {
            // Try to get from patient card
            const wRow = document.querySelector('.weight-row .p-value');
            if (wRow) {
                const m = wRow.textContent.match(/([\d.]+)/);
                if (m) wi.value = m[1];
            }
        }
        if (wi && wi.value) this.calculateFullDosages();
    },

    async calculateFullDosages() {
        const weight = document.getElementById('dosage-weight').value;
        if (!weight) {
            this.toast('Informe o peso', 'error');
            return;
        }

        try {
            const res = await fetch(`/api/dosages/full?weight=${weight}`);
            const data = await res.json();
            if (data && data.error) {
                this.toast(data.error, 'error');
                return;
            }
            // Endpoint now returns a flat array for type=pediatric (default).
            // Group locally so renderFullDosages keeps its by-category layout.
            const meds = Array.isArray(data) ? data : (data.medications || []);
            const by_category = {};
            for (const med of meds) {
                const cat = med.category || 'others';
                if (!by_category[cat]) by_category[cat] = [];
                by_category[cat].push(med);
            }
            const category_labels = {
                antibiotics: 'Antibióticos',
                analgesics: 'Analgésicos / Antitérmicos',
                corticoids: 'Corticoides',
                others: 'Outros',
            };
            this.renderFullDosages({ by_category, category_labels });
        } catch (e) {
            this.toast('Erro ao calcular dosagens', 'error');
        }
    },

    renderFullDosages(data) {
        const el = document.getElementById('dosage-results');
        const cats = data.by_category || {};
        const labels = data.category_labels || {};

        const order = ['antibiotics', 'analgesics', 'corticoids', 'others'];
        let html = '';

        for (const cat of order) {
            const meds = cats[cat];
            if (!meds || !meds.length) continue;

            html += `<div class="dosage-category"><h3>${this.escapeHtml(labels[cat] || cat)}</h3>`;
            for (const med of meds) {
                html += `
                    <div class="dose-card">
                        <div class="dose-main">
                            <div class="dose-name">${this.escapeHtml(med.name)}</div>
                            <div class="dose-detail">
                                ${med.per_dose_mg}mg/dose &middot; ${med.daily_dose_mg}mg/dia
                            </div>
                            <div class="dose-pres">${this.escapeHtml(med.presentation)}</div>
                        </div>
                        <div class="dose-side">
                            <div class="dose-value">
                                <div class="dose-practical">${this.escapeHtml(med.practical)}</div>
                                <div class="dose-freq">${this.escapeHtml(med.frequency)}</div>
                            </div>
                            <button class="btn-secondary btn-sm dose-action" onclick="App.exportDosageToEmr('${this.escapeHtml(med.id)}')">
                                Copiar p/ EMR
                            </button>
                        </div>
                        ${med.notes ? `<div class="dose-notes">${this.escapeHtml(med.notes)}</div>` : ''}
                    </div>
                `;
            }
            html += '</div>';
        }

        el.innerHTML = html || '<p class="text-muted center">Nenhuma dosagem calculada</p>';
    },

    // ═══════════════════════════════════════════════════════
    // Activity Feed
    // ═══════════════════════════════════════════════════════

    addActivity(action, status, patientId, duration, error) {
        const time = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        this.activities.unshift({ action, status, patientId, duration, error, time });
        if (this.activities.length > 25) this.activities.pop();
        this.renderActivities();
    },

    renderActivities() {
        const el = document.getElementById('activity-feed');
        if (!this.activities.length) {
            el.innerHTML = '<p class="text-muted">Aguardando acoes...</p>';
            return;
        }
        el.innerHTML = this.activities.map(a => {
            const icon = a.status === 'success' ? '&#10003;' :
                         a.status === 'failure' ? '&#10007;' :
                         a.status === 'running' ? '&#8635;' : '&#8226;';
            const dur = a.duration ? `<span class="act-dur">(${a.duration}s)</span>` : '';
            const err = a.error ? `<div class="act-err">${this.escapeHtml(a.error)}</div>` : '';
            return `
                <div class="act-item ${a.status}">
                    <div class="act-left">
                        <span class="act-icon">${icon}</span>
                        <span class="act-name">${this.actionLabel(a.action)}</span>
                        ${dur}
                    </div>
                    <span class="act-time">${a.time}</span>
                </div>
                ${err ? `<div style="padding:0 0 6px 26px">${err}</div>` : ''}
            `;
        }).join('');
    },

    // ═══════════════════════════════════════════════════════
    // Daily Summary
    // ═══════════════════════════════════════════════════════

    async loadDailySummary() {
        try {
            const res = await fetch('/api/audit/summary?days=1');
            const data = await res.json();
            document.getElementById('stat-total').textContent = data.total_actions || 0;
            document.getElementById('stat-success').textContent = data.success_count || 0;
            document.getElementById('stat-failure').textContent = data.failure_count || 0;
            this.showSummaryData();
        } catch (e) { /* ignore */ }
    },

    async loadAuditSummary() {
        try {
            const res = await fetch('/api/audit/summary?days=7');
            const data = await res.json();
            document.getElementById('audit-stat-total').textContent = data.total_actions || 0;
            document.getElementById('audit-stat-success').textContent = data.success_count || 0;
            document.getElementById('audit-stat-failure').textContent = data.failure_count || 0;
        } catch (e) { /* ignore */ }
    },

    showSummaryData() {
        const skeleton = document.getElementById('summary-skeleton');
        const data = document.getElementById('summary-data');
        if (skeleton) skeleton.classList.add('hidden');
        if (data) data.classList.remove('hidden');
    },

    refreshAuditWidgets() {
        this.loadAuditSummary();
        const auditPanel = document.getElementById('panel-audit');
        if (auditPanel && auditPanel.classList.contains('active')) {
            this.loadAudit();
        }
    },

    async preloadActivityFeed() {
        // Populate the activity feed with the last 20 audit entries so it isn't
        // empty after a page reload. New SSE events will prepend on top of these.
        try {
            const res = await fetch('/api/audit?limit=20');
            if (!res.ok) {
                this.showActivityFeed();
                return;
            }
            const data = await res.json();
            const entries = data.entries || [];
            // entries come newest-first from the API; add them oldest-first so the
            // most recent ends up at the top of the feed after unshift().
            for (let i = entries.length - 1; i >= 0; i--) {
                const e = entries[i];
                const ts = e.timestamp
                    ? new Date(e.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
                    : '';
                const status = e.success ? 'success' : 'failure';
                this.activities.push({
                    action: e.action_type || '',
                    status,
                    patientId: e.patient_id || null,
                    duration: e.duration_seconds || null,
                    error: e.error_message || null,
                    time: ts,
                });
            }
            if (this.activities.length > 25) this.activities = this.activities.slice(0, 25);
            this.renderActivities();
            this.showActivityFeed();
        } catch (e) {
            // Show feed even on error (will display empty state)
            this.showActivityFeed();
        }
    },

    showActivityFeed() {
        const skeleton = document.getElementById('activity-skeleton');
        const feed = document.getElementById('activity-feed');
        if (skeleton) skeleton.classList.add('hidden');
        if (feed) feed.classList.remove('hidden');
    },

    // ═══════════════════════════════════════════════════════
    // Audit Log
    // ═══════════════════════════════════════════════════════

    async loadAudit() {
        this.showAuditSkeleton();
        try {
            const action = document.getElementById('audit-filter-action')?.value || '';
            const patient = document.getElementById('audit-filter-patient')?.value || '';
            let url = '/api/audit?limit=100';
            if (action) url += `&action_type=${encodeURIComponent(action)}`;
            if (patient) url += `&patient_id=${encodeURIComponent(patient)}`;

            const res = await fetch(url);
            const data = await res.json();
            this.renderAuditTable(data.entries);
            this.showAuditData();
        } catch (e) {
            const tbody = document.getElementById('audit-body');
            tbody.innerHTML = '<tr><td colspan="7" class="text-muted">Erro ao carregar</td></tr>';
            this.showAuditData();
        }
    },

    showAuditSkeleton() {
        const skeleton = document.getElementById('audit-skeleton');
        const tbody = document.getElementById('audit-body');
        if (skeleton) skeleton.classList.remove('hidden');
        if (tbody) tbody.classList.add('hidden');
    },

    showAuditData() {
        const skeleton = document.getElementById('audit-skeleton');
        const tbody = document.getElementById('audit-body');
        if (skeleton) skeleton.classList.add('hidden');
        if (tbody) tbody.classList.remove('hidden');
    },

    renderAuditTable(entries) {
        const tbody = document.getElementById('audit-body');
        if (!entries || !entries.length) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-muted">Nenhum registro encontrado</td></tr>';
            return;
        }
        tbody.innerHTML = entries.map(e => {
            const ts = this.escapeHtml(e.timestamp ? new Date(e.timestamp).toLocaleString('pt-BR') : '');
            const badge = e.success ? '<span class="badge-ok">OK</span>' : '<span class="badge-fail">FALHA</span>';
            const dur = this.escapeHtml(e.duration_seconds ? `${e.duration_seconds}s` : '');
            const patientId = this.escapeHtml(e.patient_id || '');
            const action = this.escapeHtml(this.actionLabel(e.action_type || ''));
            const template = this.escapeHtml(e.template_used || '');
            const err = this.escapeHtml(e.error_message || '');
            return `<tr>
                <td>${ts}</td>
                <td>${patientId}</td>
                <td>${action}</td>
                <td>${template}</td>
                <td>${badge}</td>
                <td>${dur}</td>
                <td>${err}</td>
            </tr>`;
        }).join('');
    },

    async exportAudit() {
        try {
            const res = await fetch('/api/audit/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ days: 30 }),
            });
            if (!res.ok) {
                let msg = 'Erro ao exportar';
                try { const d = await res.json(); msg = d.error || msg; } catch (e) { /* ignore */ }
                this.toast(msg, 'error');
                return;
            }
            // Server now streams the file directly — trigger a browser download
            const blob = await res.blob();
            const disposition = res.headers.get('Content-Disposition') || '';
            const fnMatch = disposition.match(/filename="?([^";\n]+)"?/);
            const filename = fnMatch ? fnMatch[1] : 'audit_export.json';
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
            this.toast('Download iniciado', 'success');
        } catch (e) {
            this.toast('Erro ao exportar', 'error');
        }
    },

    async exportDosageToEmr(drug) {
        const weight = document.getElementById('dosage-weight')?.value || '';
        if (!weight) {
            this.toast('Calcule as dosagens antes de exportar', 'error');
            return;
        }

        const patientValue = document.querySelector('.patient-row .p-value');
        const patientId = patientValue ? patientValue.textContent : null;

        try {
            const res = await fetch('/api/dosages/export', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    drug,
                    weight,
                    patient_id: !patientId || patientId === 'N/A' || patientId === 'Aguardando paciente...' ? null : patientId,
                }),
            });
            const data = await res.json();
            if (!res.ok || data.error) {
                this.toast(data.error || 'Erro ao exportar dosagem', 'error');
                return;
            }

            this.toast('Dosagem inserida no EMR', 'success');
            this.refreshAuditWidgets();
            this.loadDailySummary();
        } catch (e) {
            this.toast('Erro ao exportar dosagem', 'error');
        }
    },

    // ═══════════════════════════════════════════════════════
    // Config
    // ═══════════════════════════════════════════════════════

    async loadConfig() {
        this.showConfigSkeleton();
        try {
            const res = await fetch('/api/config');
            const config = await res.json();
            this.renderConfigForm(config);
            this.showConfigData();
        } catch (e) {
            document.getElementById('config-sections').innerHTML =
                '<p class="text-muted">Erro ao carregar configuracao</p>';
            this.showConfigData();
        }
    },

    showConfigSkeleton() {
        const skeleton = document.getElementById('config-skeleton');
        const sections = document.getElementById('config-sections');
        if (skeleton) skeleton.classList.remove('hidden');
        if (sections) sections.classList.add('hidden');
    },

    showConfigData() {
        const skeleton = document.getElementById('config-skeleton');
        const sections = document.getElementById('config-sections');
        if (skeleton) skeleton.classList.add('hidden');
        if (sections) sections.classList.remove('hidden');
    },

    renderConfigForm(config) {
        const container = document.getElementById('config-sections');
        const sectionLabels = {
            'EMR': 'EMR (Sistema)',
            'Browser': 'Navegador',
            'Dosages': 'Dosagens (mg/kg/dia)',
            'Reliability': 'Confiabilidade',
            'ExternalScripts': 'Scripts Externos',
            'OpenAI': 'OpenAI (IA)',
        };
        const fieldLabels = {
            'base_url': 'URL Base',
            'username': 'Usuario (email)',
            'password': 'Senha',
            'timeout': 'Timeout (segundos)',
            'headless': 'Modo Headless',
            'chromedriver_path': 'Caminho ChromeDriver',
            'disable_ssl_verify': 'Desabilitar SSL',
            'manual_login_timeout': 'Timeout Login Manual (s)',
            'use_playwright': 'Usar Playwright',
            'amoxicillin_strep_dose': 'Amoxicilina Strep (mg/kg)',
            'amoxicillin_strep_max': 'Amoxicilina Strep Max (mg)',
            'amoxicillin_pneumonia_dose': 'Amoxicilina Pneumonia (mg/kg)',
            'amoxicillin_pneumonia_max': 'Amoxicilina Pneumonia Max (mg)',
            'cephalexin_dose': 'Cefalexina (mg/kg)',
            'cephalexin_max': 'Cefalexina Max (mg)',
            'concentration': 'Concentracao (mg/mL)',
            'max_retries': 'Tentativas Maximas',
            'retry_delay': 'Atraso entre Tentativas (s)',
            'audio_to_note_script': 'Script Audio para SOAP',
            'oauth_access_token': 'OAuth Access Token',
            'oauth_client_id': 'OAuth Client ID',
            'oauth_client_secret': 'OAuth Client Secret',
            'oauth_token_url': 'OAuth Token URL',
            'oauth_scopes': 'OAuth Scopes',
            'oauth_audience': 'OAuth Audience',
            'base_url': 'Base URL',
        };

        let html = '';
        for (const [section, options] of Object.entries(config)) {
            if (section.startsWith('_')) continue;
            const label = sectionLabels[section] || section;
            html += `<div class="config-section"><h3>${label}</h3>`;
            for (const [key, value] of Object.entries(options)) {
                const fieldLabel = fieldLabels[key] || key;
                const inputType = (
                    key === 'password'
                    || key === 'oauth_access_token'
                    || key === 'oauth_client_secret'
                ) ? 'password' : 'text';
                html += `<div class="config-field">
                    <label>${fieldLabel}</label>
                    <input type="${inputType}" name="${section}.${key}" value="${this.escapeHtml(value)}" />
                </div>`;
            }
            html += '</div>';
        }
        container.innerHTML = html;
    },

    async saveConfig(event) {
        event.preventDefault();
        const form = document.getElementById('config-form');
        const inputs = form.querySelectorAll('input');
        const updates = {};

        inputs.forEach(input => {
            const [section, key] = input.name.split('.');
            if (!updates[section]) updates[section] = {};
            updates[section][key] = input.value;
        });

        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updates),
            });
            const data = await res.json();
            if (data.errors) {
                this.toast('Erros: ' + data.errors.join(', '), 'error');
            } else {
                document.getElementById('config-status').textContent = 'Salvo!';
                setTimeout(() => { document.getElementById('config-status').textContent = ''; }, 3000);
                this.toast('Configuracao salva', 'success');
            }
        } catch (e) {
            this.toast('Erro ao salvar', 'error');
        }
    },

    // ═══════════════════════════════════════════════════════
    // Toast Notifications
    // ═══════════════════════════════════════════════════════

    toast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.textContent = message;
        container.appendChild(el);
        setTimeout(() => el.remove(), 4000);
    },

    // ═══════════════════════════════════════════════════════
    // Labels & Utilities
    // ═══════════════════════════════════════════════════════

    templateLabel(code) {
        return this.templateLabels[code] || code;
    },

    actionLabel(action) {
        const map = {
            audio_soap_fill: 'SOAP → EMR',
            dosage_export: 'Dosagem → EMR',
            discharge: 'Alta',
            medication: 'Medicacao',
            refresh: 'Atualizar',
            complete_workflow: 'Workflow Completo',
            manual_entry: 'Acao Manual',
        };
        return this.templateLabels[action] || map[action] || action;
    },

    stepLabel(step) {
        const map = {
            prescription: 'Prescricao',
            medication: 'Medicacao',
            attestation: 'Atestado',
            discharge: 'Alta',
        };
        return map[step] || step;
    },

    escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    },

    // ═══════════════════════════════════════════════════════
    // Audio & Manual Actions
    // ═══════════════════════════════════════════════════════

    async refreshAudioStatus() {
        const btn = document.getElementById('btn-mic');
        if (!btn) return;

        try {
            const res = await fetch('/api/audio/status');
            const data = await res.json();

            btn.disabled = !data.script_exists;
            btn.title = data.script_exists
                ? 'Audio Assistant'
                : `Script de audio nao encontrado: ${data.script_path || ''}`;

            if (!data.script_exists) {
                btn.classList.remove('recording');
                btn.innerHTML = '&#128263;'; // Muted speaker
                return;
            }

            if (data.recording) {
                btn.classList.add('recording');
                btn.innerHTML = '&#9209;'; // Stop square
            } else if (!btn.classList.contains('recording')) {
                btn.innerHTML = '&#127908;'; // Mic
            }
        } catch (e) {
            // Keep UI responsive even if status endpoint is temporarily unavailable.
            btn.disabled = false;
            btn.title = 'Audio Assistant';
        }
    },

    async toggleAudio() {
        const btn = document.getElementById('btn-mic');
        if (!btn || btn.disabled) return;

        if (btn.classList.contains('recording')) {
            // Stop
            btn.classList.remove('recording');
            btn.innerHTML = '&#9203;'; // Hourglass/waiting
            this.toast('Processando audio...', 'info');
            
            try {
                const res = await fetch('/api/audio/stop', { method: 'POST' });
                const data = await res.json();
                
                if (data.error) {
                    this.toast('Erro: ' + data.error, 'error');
                } else {
                    document.getElementById('soap-result').value = data.soap_note || '';
                    this.openModal('modal-soap');
                }
            } catch (e) {
                this.toast('Erro de conexao', 'error');
            } finally {
                btn.innerHTML = '&#127908;'; // Mic
                this.refreshAudioStatus();
            }
        } else {
            // Start
            try {
                const res = await fetch('/api/audio/start', { method: 'POST' });
                const data = await res.json();
                if (data.status === 'started') {
                    btn.classList.add('recording');
                    btn.innerHTML = '&#9209;'; // Stop square
                    this.toast('Gravando...', 'success');
                } else if (data.status === 'already_recording') {
                    btn.classList.add('recording');
                    btn.innerHTML = '&#9209;';
                } else {
                    this.toast('Erro ao iniciar gravacao: ' + (data.error || 'desconhecido'), 'error');
                }
            } catch (e) {
                this.toast('Erro de conexao', 'error');
            } finally {
                this.refreshAudioStatus();
            }
        }
    },

    openModal(id) {
        document.getElementById(id).classList.add('open');
    },

    closeModal(id) {
        document.getElementById(id).classList.remove('open');
    },

    openManualActionModal() {
        document.querySelectorAll('#modal-manual input[type="checkbox"]').forEach(c => c.checked = false);
        document.getElementById('manual-notes').value = '';
        this.openModal('modal-manual');
    },

    async saveManualAction() {
        const tags = Array.from(document.querySelectorAll('#modal-manual input:checked')).map(c => c.value);
        const notes = document.getElementById('manual-notes').value;
        const patientValue = document.querySelector('.patient-row .p-value');
        const patientId = patientValue ? patientValue.textContent : null;

        if (!tags.length && !notes) {
            this.toast('Selecione uma opcao ou escreva uma nota', 'error');
            return;
        }

        try {
            await fetch('/api/audit/manual', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    patient_id: !patientId || patientId === 'N/A' || patientId === 'Aguardando paciente...' ? null : patientId,
                    tags: tags,
                    notes: notes
                })
            });
            this.closeModal('modal-manual');
            this.toast('Acao registrada', 'success');
            this.refreshAuditWidgets();
        } catch (e) {
            this.toast('Erro ao salvar', 'error');
        }
    },

    async insertSoapToEmr() {
        const text = (document.getElementById('soap-result').value || '').trim();
        if (!text) {
            this.toast('Nota SOAP vazia', 'error');
            return;
        }

        try {
            const res = await fetch('/api/audio/insert', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ note: text }),
            });
            const data = await res.json();
            if (!res.ok || data.error) {
                this.toast('Falha ao inserir: ' + (data.error || 'erro desconhecido'), 'error');
                return;
            }
            this.toast('SOAP inserido no EMR', 'success');
            this.closeModal('modal-soap');
            this.refreshAuditWidgets();
            this.loadDailySummary();
        } catch (e) {
            this.toast('Erro ao inserir no EMR', 'error');
        }
    },

    copySoap() {
        const textarea = document.getElementById('soap-result');
        const text = (textarea && textarea.value) ? textarea.value : '';
        navigator.clipboard.writeText(text).then(() => {
            this.toast('Copiado!', 'success');
        }).catch(() => {
            // Fallback for browsers that block Clipboard API without user gesture
            if (textarea) {
                textarea.select();
                document.execCommand('copy');
                this.toast('Copiado para area de transferencia', 'success');
            }
        });
    }
};

// Boot
document.addEventListener('DOMContentLoaded', () => App.init());
