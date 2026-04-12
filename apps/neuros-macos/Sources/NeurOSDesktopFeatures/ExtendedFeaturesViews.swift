import SwiftUI
import NeurOSAppCore
import NeurOSDesktopServices

// MARK: - Routines

struct RoutinesSectionView: View {
    let appModel: AppModel
    let coordinator: DesktopBootstrapCoordinator

    @State private var routines: [RoutineSummary] = []
    @State private var selectedRoutineId: String?
    @State private var routineDetail: RoutineDetail?
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            SectionHeroView(title: "Rotinas", subtitle: "Automações recorrentes da operação")
                .padding(.bottom, 16)

            if isLoading {
                ProgressView("Carregando rotinas…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = errorMessage {
                EmptyCollectionState(icon: "exclamationmark.triangle", title: "Erro", subtitle: error)
            } else if routines.isEmpty {
                EmptyCollectionState(icon: "clock.arrow.circlepath", title: "Nenhuma rotina", subtitle: "Crie rotinas para automatizar tarefas recorrentes.")
            } else {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(routines) { routine in
                            SurfaceCard {
                                HStack {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(routine.title).font(.headline)
                                        HStack(spacing: 8) {
                                            StatusPill(label: routine.status, color: statusColor(for: routine.status))
                                            StatusPill(label: "⏱ \(routine.triggerCount)", color: .secondary)
                                            if let last = routine.lastRunStatus {
                                                StatusPill(label: last, color: last == "success" ? .green : .orange)
                                            }
                                        }
                                        if let project = routine.projectLabel {
                                            Text("📁 \(project)").font(.caption).foregroundColor(.secondary)
                                        }
                                    }
                                    Spacer()
                                    VStack(alignment: .trailing) {
                                        Text(routine.assigneeLabel).font(.caption).foregroundColor(.secondary)
                                        if let last = routine.lastRunAt {
                                            Text(last, style: .relative).font(.caption2).foregroundColor(.secondary)
                                        }
                                    }
                                }
                            }
                            .onTapGesture { selectedRoutineId = routine.id }
                        }
                    }
                    .padding(.horizontal)
                }
            }
        }
        .task { await loadRoutines() }
        .refreshable { await loadRoutines() }
        .sheet(item: $routineDetail) { detail in
            RoutineDetailView(detail: detail, coordinator: coordinator, appModel: appModel, onDismiss: { routineDetail = nil })
        }
        .onChange(of: selectedRoutineId) { _, newValue in
            guard let id = newValue else { return }
            Task { await loadRoutineDetail(id: id) }
        }
    }

    private func loadRoutines() async {
        isLoading = true
        errorMessage = nil
        do {
            routines = try await coordinator.listRoutines(appModel: appModel)
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func loadRoutineDetail(id: String) async {
        do {
            routineDetail = try await coordinator.loadRoutineDetail(routineId: id, appModel: appModel)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct RoutineDetailView: View {
    let detail: RoutineDetail
    let coordinator: DesktopBootstrapCoordinator
    let appModel: AppModel
    let onDismiss: () -> Void

    @State private var isRunning = false
    @State private var statusMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Detalhes") {
                    LabeledContent("Status", value: detail.status)
                    LabeledContent("Prioridade", value: detail.priority)
                    LabeledContent("Concurrency", value: detail.concurrencyPolicy)
                    LabeledContent("Catch-up", value: detail.catchUpPolicy)
                    LabeledContent("Assignee", value: detail.assigneeLabel)
                    if let project = detail.projectLabel { LabeledContent("Projeto", value: project) }
                }
                Section("Triggers") {
                    if detail.triggers.isEmpty {
                        Text("Nenhum trigger configurado").foregroundColor(.secondary)
                    } else {
                        ForEach(detail.triggers) { trigger in
                            VStack(alignment: .leading, spacing: 2) {
                                HStack {
                                    Text(trigger.label ?? trigger.kind).font(.subheadline.bold())
                                    Spacer()
                                    StatusPill(label: trigger.enabled ? "ON" : "OFF", color: trigger.enabled ? .green : .secondary)
                                }
                                if let next = trigger.nextRunAt {
                                    Text("Próxima: \(next, format: .dateTime)").font(.caption).foregroundColor(.secondary)
                                }
                            }
                        }
                    }
                }
                if !detail.recentRuns.isEmpty {
                    Section("Execuções Recentes") {
                        ForEach(detail.recentRuns) { run in
                            HStack {
                                StatusPill(label: run.status, color: run.status == "success" ? .green : .orange)
                                Text(run.source).font(.caption)
                                Spacer()
                                Text(run.triggeredAt, style: .relative).font(.caption).foregroundColor(.secondary)
                            }
                        }
                    }
                }
            }
            .navigationTitle(detail.title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Fechar", action: onDismiss) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Executar") {
                        Task { await triggerRun() }
                    }
                    .disabled(isRunning)
                }
            }
            .overlay(alignment: .bottom) {
                if let msg = statusMessage {
                    Text(msg).font(.caption).padding(8).background(.ultraThinMaterial).cornerRadius(8).padding(.bottom)
                }
            }
        }
    }

    private func triggerRun() async {
        isRunning = true
        statusMessage = "Executando rotina…"
        do {
            let _ = try await coordinator.triggerRoutineRun(routineId: detail.id, appModel: appModel)
            statusMessage = "Rotina executada!"
        } catch {
            statusMessage = "Erro: \(error.localizedDescription)"
        }
        isRunning = false
    }
}

// MARK: - Costs

struct CostsSectionView: View {
    let appModel: AppModel
    let coordinator: DesktopBootstrapCoordinator

    @State private var summary: CostSummarySnapshot?
    @State private var breakdown: [CostBreakdownEntry] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            SectionHeroView(title: "Custos", subtitle: "Uso e custos da operação")
                .padding(.bottom, 16)

            if isLoading {
                ProgressView("Carregando custos…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = errorMessage {
                EmptyCollectionState(icon: "exclamationmark.triangle", title: "Erro", subtitle: error)
            } else if let summary = summary {
                ScrollView {
                    VStack(spacing: 16) {
                        HStack(spacing: 12) {
                            MetricTile(title: "Total", value: String(format: "$%.2f", Double(summary.totalCostCents) / 100.0), icon: "dollarsign.circle")
                            MetricTile(title: "Eventos", value: "\(summary.eventCount)", icon: "chart.bar")
                        }
                        HStack(spacing: 12) {
                            MetricTile(title: "Agentes", value: "\(summary.agentCount)", icon: "person.2")
                            MetricTile(title: "Modelos", value: "\(summary.modelCount)", icon: "cpu")
                        }

                        if !breakdown.isEmpty {
                            SurfaceCard {
                                VStack(alignment: .leading, spacing: 8) {
                                    Text("Custos por Agente").font(.headline)
                                    ForEach(breakdown) { entry in
                                        HStack {
                                            Text(entry.label).font(.subheadline)
                                            Spacer()
                                            Text(String(format: "$%.2f", Double(entry.costCents) / 100.0)).font(.subheadline.monospacedDigit())
                                            Text("(\(entry.eventCount) eventos)").font(.caption).foregroundColor(.secondary)
                                        }
                                    }
                                }
                            }
                        }
                    }
                    .padding(.horizontal)
                }
            }
        }
        .task { await loadCosts() }
        .refreshable { await loadCosts() }
    }

    private func loadCosts() async {
        isLoading = true
        errorMessage = nil
        do {
            async let s = coordinator.loadCostSummary(appModel: appModel)
            async let b = coordinator.loadCostBreakdown(appModel: appModel)
            summary = try await s
            breakdown = try await b
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}

// MARK: - Skills

struct SkillsSectionView: View {
    let appModel: AppModel
    let coordinator: DesktopBootstrapCoordinator

    @State private var skills: [CompanySkillSummary] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            SectionHeroView(title: "Skills", subtitle: "Habilidades compartilhadas da empresa")
                .padding(.bottom, 16)

            if isLoading {
                ProgressView("Carregando skills…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = errorMessage {
                EmptyCollectionState(icon: "exclamationmark.triangle", title: "Erro", subtitle: error)
            } else if skills.isEmpty {
                EmptyCollectionState(icon: "sparkles", title: "Nenhuma skill", subtitle: "Adicione skills para equipar os agentes.")
            } else {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(skills) { skill in
                            SurfaceCard {
                                VStack(alignment: .leading, spacing: 4) {
                                    HStack {
                                        Text(skill.name).font(.headline)
                                        Spacer()
                                        StatusPill(label: skill.status, color: skill.status == "active" ? .green : .secondary)
                                    }
                                    if let desc = skill.description {
                                        Text(desc).font(.caption).foregroundColor(.secondary).lineLimit(2)
                                    }
                                    HStack(spacing: 12) {
                                        if let kind = skill.kind { Text(kind.capitalized).font(.caption2).foregroundColor(.secondary) }
                                        Text("\(skill.agentCount) agentes").font(.caption2).foregroundColor(.secondary)
                                    }
                                }
                            }
                        }
                    }
                    .padding(.horizontal)
                }
            }
        }
        .task { await loadSkills() }
        .refreshable { await loadSkills() }
    }

    private func loadSkills() async {
        isLoading = true
        errorMessage = nil
        do {
            skills = try await coordinator.listCompanySkills(appModel: appModel)
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}

// MARK: - Adapters

struct AdaptersSectionView: View {
    let appModel: AppModel
    let coordinator: DesktopBootstrapCoordinator

    @State private var adapters: [AdapterSummary] = []
    @State private var packageName = ""
    @State private var version = ""
    @State private var isLocalPath = false
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                SectionHeroView(title: "Adapters", subtitle: "Interfaces de conexão com modelos de IA") {
                    Button {
                        Task { await loadAdapters() }
                    } label: {
                        Label("Atualizar", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)
                }

                SurfaceCard {
                    VStack(alignment: .leading, spacing: 14) {
                        Text("Instalar adapter")
                            .font(.headline)

                        TextField("Pacote npm ou caminho local", text: $packageName)
                            .textFieldStyle(.roundedBorder)

                        HStack {
                            TextField("Versão opcional", text: $version)
                                .textFieldStyle(.roundedBorder)
                            Toggle("Caminho local", isOn: $isLocalPath)
                                .toggleStyle(.switch)
                        }

                        Button("Instalar") {
                            Task { await installAdapter() }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(packageName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isLoading)
                    }
                }

                if isLoading {
                    ProgressView("Carregando adapters…").frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let error = errorMessage {
                    EmptyCollectionState(icon: "exclamationmark.triangle", title: "Erro", subtitle: error)
                } else if adapters.isEmpty {
                    EmptyCollectionState(icon: "puzzlepiece.extension", title: "Nenhum adapter", subtitle: "Configure adapters para conectar modelos de IA.")
                } else {
                    LazyVStack(spacing: 8) {
                        ForEach(adapters) { adapter in
                            SurfaceCard {
                                VStack(alignment: .leading, spacing: 10) {
                                    HStack {
                                        Text(adapter.type).font(.headline)
                                        Spacer()
                                        StatusPill(label: adapter.source, color: adapter.source == "builtin" ? .blue : .purple)
                                        StatusPill(label: adapter.loaded ? "Loaded" : "Error",
                                            color: adapter.loaded ? .green : .red)
                                    }
                                    HStack(spacing: 12) {
                                        Text("\(adapter.modelsCount) modelos").font(.caption).foregroundColor(.secondary)
                                        if let v = adapter.version {
                                            Text("v\(v)").font(.caption).foregroundColor(.secondary)
                                        }
                                        Toggle("Desativado", isOn: Binding(
                                            get: { adapter.disabled },
                                            set: { _ in toggle(adapter: adapter) }
                                        ))
                                        .toggleStyle(.checkbox)
                                        .font(.caption)
                                    }

                                    HStack {
                                        if let packageName = adapter.packageName, packageName.isEmpty == false {
                                            Text(packageName)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                        if adapter.source == "external" {
                                            Button("Remover") {
                                                Task { await removeAdapter(adapter.type) }
                                            }
                                            .buttonStyle(.bordered)
                                            .tint(.red)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        .padding(20)
        .background(GoldNeuronSceneBackground())
        .task { await loadAdapters() }
        .refreshable { await loadAdapters() }
    }

    private func loadAdapters() async {
        isLoading = true
        errorMessage = nil
        do {
            adapters = try await coordinator.listAdapters(appModel: appModel)
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func toggle(adapter: AdapterSummary) {
        Task {
            do {
                adapters = try await coordinator.toggleAdapterDisabled(
                    type: adapter.type, disabled: !adapter.disabled, appModel: appModel
                )
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func installAdapter() async {
        isLoading = true
        errorMessage = nil
        do {
            adapters = try await coordinator.installAdapter(
                packageName: packageName.trimmingCharacters(in: .whitespacesAndNewlines),
                isLocalPath: isLocalPath,
                version: version.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : version.trimmingCharacters(in: .whitespacesAndNewlines),
                appModel: appModel
            )
            packageName = ""
            version = ""
            isLocalPath = false
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func removeAdapter(_ type: String) async {
        isLoading = true
        errorMessage = nil
        do {
            adapters = try await coordinator.removeAdapter(type: type, appModel: appModel)
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}

// MARK: - New Issue Sheet

struct NewIssueSheet: View {
    let appModel: AppModel
    let coordinator: DesktopBootstrapCoordinator
    @Environment(\.dismiss) private var dismiss

    @State private var title = ""
    @State private var description = ""
    @State private var priority = "medium"
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    let priorities = ["low", "medium", "high", "critical"]

    var body: some View {
        NavigationStack {
            Form {
                Section("Issue") {
                    TextField("Título", text: $title)
                    TextField("Descrição (opcional)", text: $description, axis: .vertical)
                    Picker("Prioridade", selection: $priority) {
                        ForEach(priorities, id: \.self) { Text($0.capitalized).tag($0) }
                    }
                }
                if let error = errorMessage {
                    Section { Text(error).foregroundColor(.red).font(.caption) }
                }
            }
            .navigationTitle("Nova Issue")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar", action: { dismiss() }) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Criar") {
                        Task { await submit() }
                    }
                    .disabled(title.isEmpty || isSubmitting)
                }
            }
        }
    }

    private func submit() async {
        isSubmitting = true
        errorMessage = nil
        do {
            _ = try await coordinator.createIssue(
                title: title, description: description.isEmpty ? nil : description,
                priority: priority, assigneeAgentId: nil, projectId: nil, goalId: nil,
                appModel: appModel
            )
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
        isSubmitting = false
    }
}

// MARK: - New Agent Sheet

struct NewAgentSheet: View {
    let appModel: AppModel
    let coordinator: DesktopBootstrapCoordinator
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var role = ""
    @State private var adapterType = "codex_local"
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    let adapterTypes = ["codex_local", "claude_local", "opencode_local"]

    var body: some View {
        NavigationStack {
            Form {
                Section("Agente") {
                    TextField("Nome", text: $name)
                    TextField("Role (opcional)", text: $role)
                    Picker("Adapter", selection: $adapterType) {
                        ForEach(adapterTypes, id: \.self) { Text($0).tag($0) }
                    }
                }
                if let error = errorMessage {
                    Section { Text(error).foregroundColor(.red).font(.caption) }
                }
            }
            .navigationTitle("Novo Agente")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar", action: { dismiss() }) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Criar") {
                        Task { await submit() }
                    }
                    .disabled(name.isEmpty || isSubmitting)
                }
            }
        }
    }

    private func submit() async {
        isSubmitting = true
        errorMessage = nil
        do {
            try await coordinator.createAgent(
                name: name, role: role.isEmpty ? nil : role,
                adapterType: adapterType, reportsTo: nil, appModel: appModel
            )
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
        isSubmitting = false
    }
}

// MARK: - Shared UI helpers (already defined elsewhere)
