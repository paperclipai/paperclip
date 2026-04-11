import SwiftUI
import NeurOSAppCore
import NeurOSDesktopServices

struct SurfaceCard<Content: View>: View {
    private let alignment: HorizontalAlignment
    private let content: Content

    init(
        alignment: HorizontalAlignment = .leading,
        @ViewBuilder content: () -> Content
    ) {
        self.alignment = alignment
        self.content = content()
    }

    var body: some View {
        VStack(alignment: alignment, spacing: 14) {
            content
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 22))
    }
}

struct SectionHeroView<Actions: View>: View {
    let title: String
    let subtitle: String
    private let actions: Actions

    init(
        title: String,
        subtitle: String,
        @ViewBuilder actions: () -> Actions
    ) {
        self.title = title
        self.subtitle = subtitle
        self.actions = actions()
    }

    var body: some View {
        HStack(alignment: .top, spacing: 20) {
            VStack(alignment: .leading, spacing: 10) {
                Text(title)
                    .font(.largeTitle.weight(.bold))
                Text(subtitle)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            actions
        }
    }
}

struct DashboardMetricsGrid: View {
    let appModel: AppModel
    private let columns = [GridItem(.adaptive(minimum: 180), spacing: 16)]

    var body: some View {
        LazyVGrid(columns: columns, spacing: 16) {
            MetricTile(title: "Tarefas abertas", value: "\(appModel.dashboard?.openTasks ?? appModel.totalActiveIssues)", accent: .blue)
            MetricTile(title: "Em andamento", value: "\(appModel.dashboard?.inProgressTasks ?? 0)", accent: .cyan)
            MetricTile(title: "Bloqueadas", value: "\(appModel.dashboard?.blockedTasks ?? 0)", accent: .orange)
            MetricTile(title: "Aprovações", value: "\(appModel.dashboard?.pendingApprovals ?? appModel.approvals.count)", accent: .yellow)
            MetricTile(title: "Agentes ativos", value: "\(appModel.dashboard?.activeAgents ?? appModel.totalActiveAgents)", accent: .green)
            MetricTile(title: "Budget do mês", value: formatCurrency(appModel.dashboard?.monthSpendCents ?? 0), accent: .mint)
        }
    }
}

struct MetricTile: View {
    let title: String
    let value: String
    let accent: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title.uppercased())
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.title2.weight(.bold))
            RoundedRectangle(cornerRadius: 999)
                .fill(accent.opacity(0.8))
                .frame(width: 48, height: 5)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 20))
    }
}

struct OperationsHeroView: View {
    let appModel: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(appModel.selectedCompanyName)
                        .font(.title.weight(.bold))
                    Text("Status \(appModel.selectedCompanyStatus.uppercased())")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(statusColor(for: appModel.selectedCompanyStatus))
                }
                Spacer()
                if let health = appModel.health {
                    VStack(alignment: .trailing, spacing: 6) {
                        Text("API \(health.version)")
                            .font(.headline)
                        Text(health.status.uppercased())
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(statusColor(for: health.status))
                    }
                }
            }

            HStack(spacing: 16) {
                heroMetric("Empresas", value: "\(appModel.companies.count)")
                heroMetric("Issues", value: "\(appModel.totalActiveIssues)")
                heroMetric("Agentes", value: "\(appModel.totalActiveAgents)")
                heroMetric("Sinais", value: "\(appModel.totalRecentSignals)")
            }
        }
        .padding(24)
        .background(
            LinearGradient(
                colors: [Color.blue.opacity(0.20), Color.cyan.opacity(0.12), Color.mint.opacity(0.10)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: 26)
        )
    }

    private func heroMetric(_ title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(value)
                .font(.title2.weight(.bold))
            Text(title)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct RuntimeSummaryView: View {
    let appModel: AppModel

    var body: some View {
        SurfaceCard {
            Text("Sinais e runtime")
                .font(.headline)

            if appModel.signals.isEmpty {
                EmptyCollectionState(message: "Nenhum sinal recente emitido pela instância.")
            } else {
                ForEach(appModel.signals.prefix(4)) { signal in
                    SummaryRow(
                        title: signal.title,
                        detail: signal.detail,
                        trailing: signal.occurredAt.formatted(date: .abbreviated, time: .shortened)
                    )
                }
            }
        }
    }
}

struct ApprovalsQueueView: View {
    let appModel: AppModel

    var body: some View {
        SurfaceCard {
            Text("Aprovações pendentes")
                .font(.headline)

            if appModel.approvals.isEmpty {
                EmptyCollectionState(message: "Não existem decisões pendentes para o board.")
            } else {
                ForEach(appModel.approvals.prefix(4)) { approval in
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(approval.title)
                                .font(.subheadline.weight(.semibold))
                            Text(approval.owner)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(approval.priorityLabel)
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(priorityColor(for: approval.priorityLabel).opacity(0.14), in: Capsule())
                    }
                }
            }
        }
    }
}

struct QueuePreviewView: View {
    let appModel: AppModel

    var body: some View {
        SurfaceCard {
            Text("Fila de issues")
                .font(.headline)

            if appModel.issues.isEmpty {
                EmptyCollectionState(message: "Nenhuma issue ativa para a empresa selecionada.")
            } else {
                ForEach(appModel.issues.prefix(5)) { issue in
                    SummaryRow(
                        title: "\(issue.identifier) · \(issue.title)",
                        detail: "Responsável: \(issue.assigneeLabel)",
                        trailing: issue.status.uppercased()
                    )
                }
            }
        }
    }
}

struct ProjectsPreviewView: View {
    let appModel: AppModel

    var body: some View {
        SurfaceCard {
            Text("Projetos em foco")
                .font(.headline)

            if appModel.projects.isEmpty {
                EmptyCollectionState(message: "Nenhum projeto carregado para esta empresa.")
            } else {
                ForEach(appModel.projects.prefix(4)) { project in
                    SummaryRow(
                        title: project.name,
                        detail: "\(project.workspaceCount) workspaces · \(project.goalCount) goals",
                        trailing: project.status.uppercased()
                    )
                }
            }
        }
    }
}

struct ActiveAgentsView: View {
    let appModel: AppModel

    var body: some View {
        SurfaceCard {
            Text("Agentes ativos")
                .font(.headline)

            if appModel.agents.isEmpty {
                EmptyCollectionState(message: "Nenhum agente retornado pelo backend.")
            } else {
                ForEach(appModel.agents) { agent in
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(agent.name)
                                .font(.subheadline.weight(.semibold))
                            Text(agent.role)
                                .foregroundStyle(.secondary)
                            Text(agent.issueLabel)
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 3) {
                            Text(agent.stateLabel)
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(statusColor(for: agent.stateLabel))
                            Text(agent.budgetLabel)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 6)
                }
            }
        }
    }
}

public struct QueueSectionView: View {
    let appModel: AppModel
    let coordinator: DesktopBootstrapCoordinator

    public init(appModel: AppModel, coordinator: DesktopBootstrapCoordinator) {
        self.appModel = appModel
        self.coordinator = coordinator
    }

    public var body: some View {
        OperationalSectionScaffold(
            title: "Fila e Issues",
            subtitle: "Monitoramento das issues abertas, prioridades e distribuição operacional.",
            coordinator: coordinator,
            appModel: appModel
        ) {
            MetricTile(title: "Issues ativas", value: "\(appModel.issues.count)", accent: .blue)
            MetricTile(title: "Críticas", value: "\(appModel.issues.filter { $0.priority == "critical" }.count)", accent: .red)
            MetricTile(title: "Alta prioridade", value: "\(appModel.issues.filter { $0.priority == "high" }.count)", accent: .orange)
            MetricTile(title: "Em revisão", value: "\(appModel.issues.filter { $0.status.contains("review") }.count)", accent: .yellow)
        } content: {
            SurfaceCard {
                Text("Issues abertas")
                    .font(.headline)
                if appModel.issues.isEmpty {
                    EmptyCollectionState(message: "Nenhuma issue ativa encontrada.")
                } else {
                    ForEach(appModel.issues) { issue in
                        SummaryRow(
                            title: "\(issue.identifier) · \(issue.title)",
                            detail: "\(issue.assigneeLabel) · prioridade \(issue.priority)",
                            trailing: issue.updatedAt.formatted(date: .abbreviated, time: .shortened)
                        )
                    }
                }
            }
        }
    }
}

public struct AgentsSectionView: View {
    let appModel: AppModel
    let coordinator: DesktopBootstrapCoordinator

    public init(appModel: AppModel, coordinator: DesktopBootstrapCoordinator) {
        self.appModel = appModel
        self.coordinator = coordinator
    }

    public var body: some View {
        OperationalSectionScaffold(
            title: "Agentes",
            subtitle: "Estado, papel, alocação e consumo operacional dos agentes da empresa selecionada.",
            coordinator: coordinator,
            appModel: appModel
        ) {
            MetricTile(title: "Ativos", value: "\(appModel.dashboard?.activeAgents ?? appModel.agents.count)", accent: .green)
            MetricTile(title: "Executando", value: "\(appModel.dashboard?.runningAgents ?? 0)", accent: .cyan)
            MetricTile(title: "Pausados", value: "\(appModel.dashboard?.pausedAgents ?? 0)", accent: .orange)
            MetricTile(title: "Erros", value: "\(appModel.dashboard?.erroredAgents ?? 0)", accent: .red)
        } content: {
            ActiveAgentsView(appModel: appModel)
        }
    }
}

public struct ProjectsSectionView: View {
    let appModel: AppModel
    let coordinator: DesktopBootstrapCoordinator
    @State private var selectedProjectID: String?
    @State private var workspaces: [ProjectWorkspaceDetail] = []
    @State private var isLoadingWorkspaces = false
    @State private var runtimeActionInFlight: String?
    @State private var runtimeOutput: String?
    @State private var errorMessage: String?

    public init(appModel: AppModel, coordinator: DesktopBootstrapCoordinator) {
        self.appModel = appModel
        self.coordinator = coordinator
    }

    public var body: some View {
        OperationalSectionScaffold(
            title: "Projetos e Workspaces",
            subtitle: "Portfólio de projetos da empresa, com visibilidade de metas, workspaces e prazos.",
            coordinator: coordinator,
            appModel: appModel
        ) {
            MetricTile(title: "Projetos", value: "\(appModel.projects.count)", accent: .blue)
            MetricTile(title: "Workspaces", value: "\(appModel.projects.reduce(0) { $0 + $1.workspaceCount })", accent: .mint)
            MetricTile(title: "Goals", value: "\(appModel.projects.reduce(0) { $0 + $1.goalCount })", accent: .cyan)
            MetricTile(title: "Pausados", value: "\(appModel.dashboard?.pausedProjects ?? 0)", accent: .orange)
        } content: {
            HStack(alignment: .top, spacing: 20) {
                SurfaceCard {
                    Text("Projetos")
                        .font(.headline)

                    if appModel.projects.isEmpty {
                        EmptyCollectionState(message: "Nenhum projeto carregado para esta empresa.")
                    } else {
                        ForEach(appModel.projects) { project in
                            SelectableRow(
                                title: project.name,
                                detail: "\(project.workspaceCount) workspaces · \(project.goalCount) goals",
                                trailing: project.status.uppercased(),
                                isSelected: selectedProjectID == project.id
                            ) {
                                selectedProjectID = project.id
                                runtimeOutput = nil
                            }
                        }
                    }
                }

                SurfaceCard {
                    if let errorMessage {
                        InlineErrorView(message: errorMessage)
                    }

                    if let selectedProject {
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(selectedProject.name)
                                    .font(.title3.weight(.bold))
                                Text("Status \(selectedProject.status.uppercased()) · alvo \(selectedProject.targetDateLabel)")
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if isLoadingWorkspaces {
                                ProgressView()
                                    .controlSize(.small)
                            }
                        }

                        if workspaces.isEmpty {
                            EmptyCollectionState(message: "Nenhum workspace encontrado para esse projeto.")
                        } else {
                            ForEach(workspaces) { workspace in
                                WorkspaceDetailCard(
                                    workspace: workspace,
                                    runtimeActionInFlight: runtimeActionInFlight,
                                    onAction: { action in
                                        Task { await runWorkspaceAction(action, workspaceID: workspace.id) }
                                    }
                                )
                            }
                        }

                        if let runtimeOutput, runtimeOutput.isEmpty == false {
                            Divider()
                            Text("Saída da última operação")
                                .font(.headline)
                            ScrollView {
                                Text(runtimeOutput)
                                    .font(.system(.caption, design: .monospaced))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .frame(minHeight: 110, maxHeight: 180)
                        }
                    } else {
                        EmptyCollectionState(message: "Selecione um projeto para operar os workspaces.")
                    }
                }
            }
        }
        .task(id: appModel.projects.map(\.id).joined(separator: "|")) {
            syncSelectedProject()
        }
        .task(id: selectedProjectID) {
            await loadSelectedProject()
        }
    }

    private var selectedProject: ProjectSummary? {
        appModel.projects.first(where: { $0.id == selectedProjectID }) ?? appModel.projects.first
    }

    @MainActor
    private func syncSelectedProject() {
        if let selectedProjectID, appModel.projects.contains(where: { $0.id == selectedProjectID }) {
            return
        }
        selectedProjectID = appModel.projects.first?.id
    }

    @MainActor
    private func loadSelectedProject() async {
        guard let selectedProject else {
            workspaces = []
            return
        }

        isLoadingWorkspaces = true
        errorMessage = nil
        do {
            workspaces = try await coordinator.loadProjectWorkspaces(
                projectID: selectedProject.id,
                appModel: appModel
            )
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoadingWorkspaces = false
    }

    @MainActor
    private func runWorkspaceAction(_ action: WorkspaceRuntimeAction, workspaceID: String) async {
        guard let selectedProject else { return }
        runtimeActionInFlight = workspaceID + ":" + action.rawValue
        errorMessage = nil
        do {
            let result = try await coordinator.performWorkspaceRuntimeAction(
                projectID: selectedProject.id,
                workspaceID: workspaceID,
                action: action,
                appModel: appModel
            )
            if let index = workspaces.firstIndex(where: { $0.id == workspaceID }) {
                workspaces[index] = result.workspace
            } else {
                workspaces.append(result.workspace)
            }
            runtimeOutput = result.outputSummary
        } catch {
            errorMessage = error.localizedDescription
        }
        runtimeActionInFlight = nil
    }
}

public struct ApprovalsSectionView: View {
    let appModel: AppModel
    let coordinator: DesktopBootstrapCoordinator
    @State private var selectedApprovalID: String?
    @State private var approvalDetail: ApprovalDetail?
    @State private var actionNote = ""
    @State private var commentBody = ""
    @State private var isLoadingDetail = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    public init(appModel: AppModel, coordinator: DesktopBootstrapCoordinator) {
        self.appModel = appModel
        self.coordinator = coordinator
    }

    public var body: some View {
        OperationalSectionScaffold(
            title: "Aprovações",
            subtitle: "Itens que dependem de decisão humana ou de validação do board.",
            coordinator: coordinator,
            appModel: appModel
        ) {
            MetricTile(title: "Pendentes", value: "\(appModel.approvals.count)", accent: .yellow)
            MetricTile(title: "Sinais ativos", value: "\(appModel.signals.count)", accent: .blue)
        } content: {
            HStack(alignment: .top, spacing: 20) {
                SurfaceCard {
                    Text("Fila pendente")
                        .font(.headline)

                    if appModel.approvals.isEmpty {
                        EmptyCollectionState(message: "Não existem decisões pendentes para o board.")
                    } else {
                        ForEach(appModel.approvals) { approval in
                            SelectableRow(
                                title: approval.title,
                                detail: approval.owner,
                                trailing: approval.priorityLabel,
                                trailingColor: priorityColor(for: approval.priorityLabel),
                                isSelected: selectedApprovalID == approval.id
                            ) {
                                selectedApprovalID = approval.id
                            }
                        }
                    }
                }

                SurfaceCard {
                    if let errorMessage {
                        InlineErrorView(message: errorMessage)
                    }

                    if isLoadingDetail {
                        ProgressView("Carregando aprovação...")
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else if let approvalDetail {
                        VStack(alignment: .leading, spacing: 16) {
                            HStack(alignment: .top) {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(approvalDetail.title)
                                        .font(.title3.weight(.bold))
                                    Text("\(approvalDetail.type) · \(approvalDetail.owner)")
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                StatusPill(label: approvalDetail.status, color: statusColor(for: approvalDetail.status))
                            }

                            if let decisionNote = approvalDetail.decisionNote, decisionNote.isEmpty == false {
                                Text("Decisão atual")
                                    .font(.headline)
                                Text(decisionNote)
                                    .foregroundStyle(.secondary)
                            }

                            if approvalDetail.payloadFields.isEmpty == false {
                                Divider()
                                Text("Payload")
                                    .font(.headline)
                                ForEach(approvalDetail.payloadFields) { field in
                                    SummaryRow(title: field.key, detail: field.value, trailing: "")
                                }
                            }

                            Divider()
                            Text("Issues vinculadas")
                                .font(.headline)
                            if approvalDetail.linkedIssues.isEmpty {
                                EmptyCollectionState(message: "Nenhuma issue vinculada a esta aprovação.")
                            } else {
                                ForEach(approvalDetail.linkedIssues) { issue in
                                    SummaryRow(
                                        title: "\(issue.identifier) · \(issue.title)",
                                        detail: issue.assigneeLabel,
                                        trailing: issue.status.uppercased()
                                    )
                                }
                            }

                            Divider()
                            Text("Decidir")
                                .font(.headline)
                            TextEditor(text: $actionNote)
                                .frame(minHeight: 90)
                                .padding(10)
                                .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 16))

                            HStack {
                                ForEach(ApprovalDecisionAction.allCases) { action in
                                    Button(action.label) {
                                        Task { await runApprovalAction(action) }
                                    }
                                    .buttonStyle(.borderedProminent)
                                    .tint(buttonTint(for: action))
                                    .disabled(isSubmitting)
                                }
                            }

                            Divider()
                            Text("Comentários")
                                .font(.headline)
                            if approvalDetail.comments.isEmpty {
                                EmptyCollectionState(message: "Ainda não existem comentários.")
                            } else {
                                ForEach(approvalDetail.comments) { comment in
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(comment.authorLabel)
                                            .font(.subheadline.weight(.semibold))
                                        Text(comment.body)
                                            .foregroundStyle(.secondary)
                                        Text(comment.createdAt.formatted(date: .abbreviated, time: .shortened))
                                            .font(.caption)
                                            .foregroundStyle(.tertiary)
                                    }
                                    .padding(.vertical, 6)
                                }
                            }

                            TextField("Adicionar comentário operacional", text: $commentBody, axis: .vertical)
                                .textFieldStyle(.roundedBorder)
                            Button("Publicar comentário") {
                                Task { await publishApprovalComment() }
                            }
                            .buttonStyle(.bordered)
                            .disabled(commentBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSubmitting)
                        }
                    } else {
                        EmptyCollectionState(message: "Selecione uma aprovação para abrir o detalhe operacional.")
                    }
                }
            }
        }
        .task(id: appModel.approvals.map(\.id).joined(separator: "|")) {
            syncSelectedApproval()
        }
        .task(id: selectedApprovalID) {
            await loadSelectedApproval()
        }
    }

    @MainActor
    private func syncSelectedApproval() {
        if let selectedApprovalID, appModel.approvals.contains(where: { $0.id == selectedApprovalID }) {
            return
        }
        selectedApprovalID = appModel.approvals.first?.id
    }

    @MainActor
    private func loadSelectedApproval() async {
        guard let selectedApprovalID else {
            approvalDetail = nil
            return
        }

        isLoadingDetail = true
        errorMessage = nil
        do {
            approvalDetail = try await coordinator.loadApprovalDetail(
                approvalID: selectedApprovalID,
                appModel: appModel
            )
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoadingDetail = false
    }

    @MainActor
    private func runApprovalAction(_ action: ApprovalDecisionAction) async {
        guard let selectedApprovalID else { return }
        isSubmitting = true
        errorMessage = nil
        do {
            approvalDetail = try await coordinator.performApprovalAction(
                approvalID: selectedApprovalID,
                action: action,
                note: actionNote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : actionNote,
                appModel: appModel
            )
            actionNote = ""
        } catch {
            errorMessage = error.localizedDescription
        }
        isSubmitting = false
    }

    @MainActor
    private func publishApprovalComment() async {
        guard let selectedApprovalID else { return }
        let trimmedComment = commentBody.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmedComment.isEmpty == false else { return }

        isSubmitting = true
        errorMessage = nil
        do {
            approvalDetail = try await coordinator.addApprovalComment(
                approvalID: selectedApprovalID,
                body: trimmedComment,
                appModel: appModel
            )
            commentBody = ""
        } catch {
            errorMessage = error.localizedDescription
        }
        isSubmitting = false
    }

    private func buttonTint(for action: ApprovalDecisionAction) -> Color {
        switch action {
        case .approve:
            .green
        case .reject:
            .red
        case .requestRevision:
            .orange
        case .resubmit:
            .blue
        }
    }
}

public struct RuntimeSectionView: View {
    let appModel: AppModel
    let coordinator: DesktopBootstrapCoordinator

    public init(appModel: AppModel, coordinator: DesktopBootstrapCoordinator) {
        self.appModel = appModel
        self.coordinator = coordinator
    }

    public var body: some View {
        OperationalSectionScaffold(
            title: "Runtime e Sinais",
            subtitle: "Saúde da instância, topologia de execução e eventos recentes emitidos pelo backend.",
            coordinator: coordinator,
            appModel: appModel
        ) {
            MetricTile(title: "Modo", value: appModel.runtimeMode.rawValue, accent: .blue)
            MetricTile(title: "Status API", value: appModel.health?.status ?? "unknown", accent: statusColor(for: appModel.health?.status ?? "unknown"))
            MetricTile(title: "Budget incidents", value: "\(appModel.dashboard?.activeBudgetIncidents ?? 0)", accent: .orange)
        } content: {
            VStack(alignment: .leading, spacing: 20) {
                SurfaceCard {
                    Text("Saúde da instância")
                        .font(.headline)
                    if let health = appModel.health {
                        SummaryRow(title: "Versão", detail: health.version, trailing: health.status.uppercased())
                        SummaryRow(title: "Modo", detail: health.deploymentMode ?? "unknown", trailing: health.deploymentExposure ?? "unknown")
                    } else {
                        EmptyCollectionState(message: "A instância ainda não respondeu ao health check.")
                    }
                }
                RuntimeSummaryView(appModel: appModel)
            }
        }
    }
}

public struct PluginsSectionView: View {
    let appModel: AppModel
    let coordinator: DesktopBootstrapCoordinator
    @State private var selectedPluginID: String?
    @State private var pluginSnapshot: PluginConsoleSnapshot?
    @State private var disableReason = ""
    @State private var targetVersion = ""
    @State private var isLoadingPlugin = false
    @State private var isMutatingPlugin = false
    @State private var errorMessage: String?

    public init(appModel: AppModel, coordinator: DesktopBootstrapCoordinator) {
        self.appModel = appModel
        self.coordinator = coordinator
    }

    public var body: some View {
        OperationalSectionScaffold(
            title: "Plugins",
            subtitle: "Pacotes carregados pela instância para estender adapters, UI e automações.",
            coordinator: coordinator,
            appModel: appModel
        ) {
            MetricTile(title: "Instalados", value: "\(appModel.plugins.count)", accent: .purple)
            MetricTile(title: "Prontos", value: "\(appModel.plugins.filter { $0.status == "ready" }.count)", accent: .green)
        } content: {
            HStack(alignment: .top, spacing: 20) {
                SurfaceCard {
                    Text("Catálogo instalado")
                        .font(.headline)

                    if appModel.plugins.isEmpty {
                        EmptyCollectionState(message: "Nenhum plugin instalado foi retornado pela API.")
                    } else {
                        ForEach(appModel.plugins) { plugin in
                            SelectableRow(
                                title: plugin.displayName,
                                detail: "\(plugin.packageName) · \(plugin.version)",
                                trailing: plugin.status.uppercased(),
                                trailingColor: statusColor(for: plugin.status),
                                isSelected: selectedPluginID == plugin.id
                            ) {
                                selectedPluginID = plugin.id
                            }
                        }
                    }
                }

                SurfaceCard {
                    if let errorMessage {
                        InlineErrorView(message: errorMessage)
                    }

                    if isLoadingPlugin {
                        ProgressView("Carregando plugin...")
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else if let pluginSnapshot {
                        VStack(alignment: .leading, spacing: 16) {
                            HStack(alignment: .top) {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(pluginSnapshot.detail.displayName)
                                        .font(.title3.weight(.bold))
                                    Text("\(pluginSnapshot.detail.packageName) · API \(pluginSnapshot.detail.apiVersion)")
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                StatusPill(label: pluginSnapshot.detail.status, color: statusColor(for: pluginSnapshot.detail.status))
                            }

                            SummaryRow(
                                title: "Versão",
                                detail: pluginSnapshot.detail.version,
                                trailing: pluginSnapshot.detail.pluginKey
                            )
                            SummaryRow(
                                title: "Categorias",
                                detail: pluginSnapshot.detail.categories.isEmpty ? "Sem categorias" : pluginSnapshot.detail.categories.joined(separator: ", "),
                                trailing: "\(pluginSnapshot.detail.slotCount) slots · \(pluginSnapshot.detail.launcherCount) launchers"
                            )
                            if let lastError = pluginSnapshot.detail.lastError, lastError.isEmpty == false {
                                InlineErrorView(message: lastError)
                            }

                            Divider()
                            Text("Saúde")
                                .font(.headline)
                            ForEach(pluginSnapshot.health.checks) { check in
                                SummaryRow(
                                    title: check.name,
                                    detail: check.message ?? "Sem detalhe",
                                    trailing: check.passed ? "OK" : "FAIL"
                                )
                            }

                            Divider()
                            Text("Ações")
                                .font(.headline)
                            HStack {
                                Button("Atualizar painel") {
                                    Task { await loadSelectedPlugin() }
                                }
                                .buttonStyle(.bordered)

                                Button("Habilitar") {
                                    Task { await mutatePluginEnabled(true) }
                                }
                                .buttonStyle(.borderedProminent)
                                .tint(.green)
                                .disabled(isMutatingPlugin)

                                Button("Desabilitar") {
                                    Task { await mutatePluginEnabled(false) }
                                }
                                .buttonStyle(.borderedProminent)
                                .tint(.orange)
                                .disabled(isMutatingPlugin)
                            }

                            TextField("Motivo da desativação (opcional)", text: $disableReason)
                                .textFieldStyle(.roundedBorder)

                            HStack {
                                TextField("Versão alvo para upgrade (opcional)", text: $targetVersion)
                                    .textFieldStyle(.roundedBorder)
                                Button("Upgrade") {
                                    Task { await upgradeSelectedPlugin() }
                                }
                                .buttonStyle(.borderedProminent)
                                .disabled(isMutatingPlugin)
                            }

                            Divider()
                            Text("Logs recentes")
                                .font(.headline)
                            if pluginSnapshot.logs.isEmpty {
                                EmptyCollectionState(message: "Nenhum log recente para este plugin.")
                            } else {
                                ForEach(pluginSnapshot.logs) { log in
                                    VStack(alignment: .leading, spacing: 4) {
                                        HStack {
                                            StatusPill(label: log.level, color: statusColor(for: log.level))
                                            Spacer()
                                            Text(log.createdAt.formatted(date: .abbreviated, time: .shortened))
                                                .font(.caption)
                                                .foregroundStyle(.tertiary)
                                        }
                                        Text(log.message)
                                            .font(.subheadline.weight(.medium))
                                        if let metaSummary = log.metaSummary, metaSummary.isEmpty == false {
                                            Text(metaSummary)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }
                                    }
                                    .padding(.vertical, 6)
                                }
                            }
                        }
                    } else {
                        EmptyCollectionState(message: "Selecione um plugin para abrir o console operacional.")
                    }
                }
            }
        }
        .task(id: appModel.plugins.map(\.id).joined(separator: "|")) {
            syncSelectedPlugin()
        }
        .task(id: selectedPluginID) {
            await loadSelectedPlugin()
        }
    }

    @MainActor
    private func syncSelectedPlugin() {
        if let selectedPluginID, appModel.plugins.contains(where: { $0.id == selectedPluginID }) {
            return
        }
        selectedPluginID = appModel.plugins.first?.id
    }

    @MainActor
    private func loadSelectedPlugin() async {
        guard let selectedPluginID else {
            pluginSnapshot = nil
            return
        }

        isLoadingPlugin = true
        errorMessage = nil
        do {
            pluginSnapshot = try await coordinator.loadPluginConsoleSnapshot(
                pluginID: selectedPluginID,
                logLimit: 40,
                appModel: appModel
            )
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoadingPlugin = false
    }

    @MainActor
    private func mutatePluginEnabled(_ isEnabled: Bool) async {
        guard let selectedPluginID else { return }
        isMutatingPlugin = true
        errorMessage = nil
        do {
            pluginSnapshot = try await coordinator.setPluginEnabled(
                pluginID: selectedPluginID,
                isEnabled: isEnabled,
                reason: disableReason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : disableReason,
                appModel: appModel
            )
            if isEnabled == false {
                disableReason = ""
            }
        } catch {
            errorMessage = error.localizedDescription
        }
        isMutatingPlugin = false
    }

    @MainActor
    private func upgradeSelectedPlugin() async {
        guard let selectedPluginID else { return }
        isMutatingPlugin = true
        errorMessage = nil
        do {
            pluginSnapshot = try await coordinator.upgradePlugin(
                pluginID: selectedPluginID,
                targetVersion: targetVersion.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : targetVersion,
                appModel: appModel
            )
            targetVersion = ""
        } catch {
            errorMessage = error.localizedDescription
        }
        isMutatingPlugin = false
    }
}

public struct OrganizationSectionView: View {
    let appModel: AppModel
    let coordinator: DesktopBootstrapCoordinator

    public init(appModel: AppModel, coordinator: DesktopBootstrapCoordinator) {
        self.appModel = appModel
        self.coordinator = coordinator
    }

    public var body: some View {
        OperationalSectionScaffold(
            title: "Empresa e Equipe",
            subtitle: "Contexto organizacional da instância, com foco na empresa selecionada e na distribuição operacional.",
            coordinator: coordinator,
            appModel: appModel
        ) {
            MetricTile(title: "Empresas", value: "\(appModel.companies.count)", accent: .blue)
            MetricTile(title: "Agentes", value: "\(appModel.totalActiveAgents)", accent: .green)
            MetricTile(title: "Issues", value: "\(appModel.totalActiveIssues)", accent: .orange)
        } content: {
            VStack(alignment: .leading, spacing: 20) {
                SurfaceCard {
                    Text("Empresa ativa")
                        .font(.headline)
                    SummaryRow(
                        title: appModel.selectedCompanyName,
                        detail: "Status \(appModel.selectedCompanyStatus)",
                        trailing: "\(appModel.dashboard?.pendingApprovals ?? appModel.approvals.count) aprovações"
                    )
                    if let selectedCompany = appModel.selectedCompany {
                        SummaryRow(
                            title: "Capacidade",
                            detail: "\(selectedCompany.activeAgentsCount) agentes · \(selectedCompany.activeIssuesCount) issues",
                            trailing: "\(selectedCompany.recentSignalsCount) sinais"
                        )
                    }
                }

                SurfaceCard {
                    Text("Todas as empresas")
                        .font(.headline)
                    if appModel.companies.isEmpty {
                        EmptyCollectionState(message: "A instância não possui empresas disponíveis.")
                    } else {
                        ForEach(appModel.companies) { company in
                            SummaryRow(
                                title: company.name,
                                detail: "\(company.activeAgentsCount) agentes · \(company.activeIssuesCount) issues",
                                trailing: company.status.uppercased()
                            )
                        }
                    }
                }
            }
        }
    }
}

struct OperationalSectionScaffold<Metrics: View, Content: View>: View {
    let title: String
    let subtitle: String
    private let metrics: Metrics
    let coordinator: DesktopBootstrapCoordinator
    let appModel: AppModel
    private let content: Content

    init(
        title: String,
        subtitle: String,
        coordinator: DesktopBootstrapCoordinator,
        appModel: AppModel,
        @ViewBuilder metrics: () -> Metrics,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.subtitle = subtitle
        self.coordinator = coordinator
        self.appModel = appModel
        self.metrics = metrics()
        self.content = content()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                SectionHeroView(title: title, subtitle: subtitle) {
                    Button {
                        Task { await coordinator.refresh(appModel: appModel) }
                    } label: {
                        Label("Atualizar", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.borderedProminent)
                }

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: 16)], spacing: 16) {
                    metrics
                }

                content
            }
            .padding(28)
        }
        .navigationTitle(title)
    }
}

struct SummaryRow: View {
    let title: String
    let detail: String
    let trailing: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Text(trailing)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing)
        }
        .padding(.vertical, 6)
    }
}

struct EmptyCollectionState: View {
    let message: String

    var body: some View {
        Text(message)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 12)
    }
}

private struct InlineErrorView: View {
    let message: String

    var body: some View {
        Text(message)
            .font(.subheadline)
            .foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
    }
}

struct StatusPill: View {
    let label: String
    let color: Color

    var body: some View {
        Text(label.uppercased())
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(color.opacity(0.14), in: Capsule())
            .foregroundStyle(color)
    }
}

private struct SelectableRow: View {
    let title: String
    let detail: String
    let trailing: String
    var trailingColor: Color = .secondary
    let isSelected: Bool
    let onSelect: () -> Void

    var body: some View {
        Button(action: onSelect) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                    Text(detail)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(trailing)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(trailingColor)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isSelected ? Color.accentColor.opacity(0.10) : Color.primary.opacity(0.03), in: RoundedRectangle(cornerRadius: 18))
        }
        .buttonStyle(.plain)
    }
}

private struct WorkspaceDetailCard: View {
    let workspace: ProjectWorkspaceDetail
    let runtimeActionInFlight: String?
    let onAction: (WorkspaceRuntimeAction) -> Void

    private func isRunning(_ action: WorkspaceRuntimeAction) -> Bool {
        runtimeActionInFlight == workspace.id + ":" + action.rawValue
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(workspace.name)
                            .font(.headline)
                        if workspace.isPrimary {
                            StatusPill(label: "Primary", color: .blue)
                        }
                    }
                    Text("\(workspace.sourceType) · \(workspace.visibility) · \(workspace.desiredState)")
                        .foregroundStyle(.secondary)
                    if let cwd = workspace.cwd, cwd.isEmpty == false {
                        Text(cwd)
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
                Spacer()
                HStack {
                    ForEach(WorkspaceRuntimeAction.allCases) { action in
                        Button(action.label) {
                            onAction(action)
                        }
                        .buttonStyle(.bordered)
                        .disabled(runtimeActionInFlight != nil)
                        .overlay(alignment: .trailing) {
                            if isRunning(action) {
                                ProgressView()
                                    .controlSize(.small)
                            }
                        }
                    }
                }
            }

            if workspace.runtimeServices.isEmpty {
                EmptyCollectionState(message: "Nenhum runtime service ativo neste workspace.")
            } else {
                ForEach(workspace.runtimeServices) { service in
                    SummaryRow(
                        title: service.serviceName,
                        detail: [service.lifecycle, service.url, service.port.map { ":\($0)" }].compactMap { $0 }.joined(separator: " · "),
                        trailing: "\(service.status.uppercased()) · \(service.healthStatus.uppercased())"
                    )
                }
            }
        }
        .padding(18)
        .background(Color.primary.opacity(0.03), in: RoundedRectangle(cornerRadius: 18))
    }
}

func statusColor(for value: String) -> Color {
    switch value.lowercased() {
    case "ok", "ready", "active", "running", "achieved", "completed", "pronta", "monitorando": .green
    case "in_progress", "executando", "connecting": .blue
    case "paused", "pending", "in_review", "planned": .orange
    case "error", "unhealthy", "degraded", "critical", "blocked": .red
    case "cancelled": .secondary
    default: .secondary
    }
}

private func priorityColor(for value: String) -> Color {
    switch value.lowercased() {
    case "critical", "alta", "high": .red
    case "média", "medium": .orange
    case "low", "baixa": .yellow
    default: .secondary
    }
}

func formatCurrency(_ cents: Int) -> String {
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.currencyCode = "BRL"
    formatter.locale = Locale(identifier: "pt_BR")
    let value = NSNumber(value: Double(cents) / 100.0)
    return formatter.string(from: value) ?? "R$ 0,00"
}
