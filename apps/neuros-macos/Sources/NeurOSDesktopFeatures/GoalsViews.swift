import SwiftUI
import NeurOSAppCore
import NeurOSDesktopServices

public struct GoalsSectionView: View {
    let appModel: AppModel
    let coordinator: DesktopBootstrapCoordinator

    @State private var selectedGoalID: String?
    @State private var expandedGoalIDs: Set<String> = []

    public init(appModel: AppModel, coordinator: DesktopBootstrapCoordinator) {
        self.appModel = appModel
        self.coordinator = coordinator
    }

    public var body: some View {
        OperationalSectionScaffold(
            title: "Metas",
            subtitle: "Hierarquia estratégica da empresa com foco em owner, progresso e vínculo com projetos.",
            coordinator: coordinator,
            appModel: appModel
        ) {
            MetricTile(title: "Metas", value: "\(appModel.goals.count)", accent: .blue)
            MetricTile(title: "Ativas", value: "\(appModel.goals.filter { $0.status == "active" }.count)", accent: .green)
            MetricTile(title: "Raiz", value: "\(rootGoals.count)", accent: .cyan)
            MetricTile(title: "Com projetos", value: "\(linkedGoalCount)", accent: .orange)
        } content: {
            HStack(alignment: .top, spacing: 20) {
                goalsTreeCard
                goalDetailCard
            }
        }
        .task(id: appModel.goals.map(\.id).joined(separator: "|")) {
            syncSelection()
            syncExpansion()
        }
    }

    private var rootGoals: [GoalSummary] {
        let availableIDs = Set(appModel.goals.map(\.id))
        return appModel.goals
            .filter { goal in
                guard let parentID = goal.parentID else { return true }
                return availableIDs.contains(parentID) == false
            }
            .sorted(by: compareGoals)
    }

    private var selectedGoal: GoalSummary? {
        appModel.goals.first(where: { $0.id == selectedGoalID }) ?? rootGoals.first
    }

    private var linkedGoalCount: Int {
        Set(appModel.projects.flatMap(\.goalIDs)).count
    }

    private var goalsTreeCard: some View {
        SurfaceCard {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Mapa de metas")
                        .font(.headline)
                    Text("Selecione uma meta para ver contexto, subníveis e projetos relacionados.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text("\(appModel.goals.count)")
                    .font(.title3.weight(.bold))
            }

            if appModel.goals.isEmpty {
                EmptyCollectionState(message: "Nenhuma meta carregada para a empresa selecionada.")
            } else {
                ForEach(rootGoals) { goal in
                    GoalTreeNodeRows(
                        goal: goal,
                        allGoals: appModel.goals,
                        depth: 0,
                        selectedGoalID: selectedGoalID,
                        expandedGoalIDs: $expandedGoalIDs,
                        onSelect: selectGoal
                    )
                }
            }
        }
        .frame(maxWidth: 420, alignment: .leading)
    }

    private var goalDetailCard: some View {
        SurfaceCard {
            if let selectedGoal {
                let childGoals = childGoals(for: selectedGoal.id)
                let linkedProjects = linkedProjects(for: selectedGoal.id)
                let parentGoal = selectedGoal.parentID.flatMap(findGoal)

                VStack(alignment: .leading, spacing: 18) {
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(selectedGoal.title)
                                .font(.title3.weight(.bold))
                            Text(selectedGoal.level.capitalized)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        StatusPill(label: selectedGoal.status, color: statusColor(for: selectedGoal.status))
                    }

                    if let description = selectedGoal.description, description.isEmpty == false {
                        Text(description)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("Sem descrição registrada para esta meta.")
                            .font(.subheadline)
                            .foregroundStyle(.tertiary)
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        GoalMetaRow(label: "Owner", value: selectedGoal.ownerLabel)
                        GoalMetaRow(label: "Criada em", value: selectedGoal.createdAt.formatted(date: .abbreviated, time: .shortened))
                        GoalMetaRow(label: "Atualizada em", value: selectedGoal.updatedAt.formatted(date: .abbreviated, time: .shortened))
                        if let parentGoal {
                            GoalMetaRow(label: "Meta pai", value: parentGoal.title)
                        }
                    }

                    Divider()

                    VStack(alignment: .leading, spacing: 10) {
                        Text("Submetas")
                            .font(.headline)

                        if childGoals.isEmpty {
                            EmptyCollectionState(message: "Nenhuma submeta vinculada.")
                        } else {
                            ForEach(childGoals) { childGoal in
                                SummaryRow(
                                    title: childGoal.title,
                                    detail: "\(childGoal.level.capitalized) · owner \(childGoal.ownerLabel)",
                                    trailing: childGoal.status.uppercased()
                                )
                            }
                        }
                    }

                    Divider()

                    VStack(alignment: .leading, spacing: 10) {
                        Text("Projetos vinculados")
                            .font(.headline)

                        if linkedProjects.isEmpty {
                            EmptyCollectionState(message: "Nenhum projeto está ligado a esta meta.")
                        } else {
                            ForEach(linkedProjects) { project in
                                SummaryRow(
                                    title: project.name,
                                    detail: "\(project.workspaceCount) workspaces · alvo \(project.targetDateLabel)",
                                    trailing: project.status.uppercased()
                                )
                            }
                        }
                    }
                }
            } else {
                EmptyCollectionState(message: "Selecione uma meta na árvore para ver os detalhes.")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func childGoals(for goalID: String) -> [GoalSummary] {
        appModel.goals
            .filter { $0.parentID == goalID }
            .sorted(by: compareGoals)
    }

    private func linkedProjects(for goalID: String) -> [ProjectSummary] {
        appModel.projects
            .filter { $0.goalIDs.contains(goalID) }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    private func findGoal(id: String) -> GoalSummary? {
        appModel.goals.first(where: { $0.id == id })
    }

    @MainActor
    private func selectGoal(_ goalID: String) {
        selectedGoalID = goalID
        expandedGoalIDs.formUnion(ancestorIDs(for: goalID))
        expandedGoalIDs.insert(goalID)
    }

    @MainActor
    private func syncSelection() {
        if let selectedGoalID, appModel.goals.contains(where: { $0.id == selectedGoalID }) {
            return
        }
        selectedGoalID = rootGoals.first?.id ?? appModel.goals.first?.id
    }

    @MainActor
    private func syncExpansion() {
        expandedGoalIDs.formUnion(rootGoals.map(\.id))
        if let selectedGoalID {
            expandedGoalIDs.formUnion(ancestorIDs(for: selectedGoalID))
        }
    }

    private func ancestorIDs(for goalID: String) -> [String] {
        var ancestorIDs: [String] = []
        var currentParentID = findGoal(id: goalID)?.parentID

        while let parentID = currentParentID {
            ancestorIDs.append(parentID)
            currentParentID = findGoal(id: parentID)?.parentID
        }

        return ancestorIDs
    }

    private func compareGoals(_ lhs: GoalSummary, _ rhs: GoalSummary) -> Bool {
        if lhs.createdAt == rhs.createdAt {
            return lhs.title.localizedStandardCompare(rhs.title) == .orderedAscending
        }
        return lhs.createdAt < rhs.createdAt
    }
}

private struct GoalTreeNodeRows: View {
    let goal: GoalSummary
    let allGoals: [GoalSummary]
    let depth: Int
    let selectedGoalID: String?
    @Binding var expandedGoalIDs: Set<String>
    let onSelect: (String) -> Void

    private var childGoals: [GoalSummary] {
        allGoals
            .filter { $0.parentID == goal.id }
            .sorted {
                if $0.createdAt == $1.createdAt {
                    return $0.title.localizedStandardCompare($1.title) == .orderedAscending
                }
                return $0.createdAt < $1.createdAt
            }
    }

    private var hasChildren: Bool {
        childGoals.isEmpty == false
    }

    private var isExpanded: Bool {
        expandedGoalIDs.contains(goal.id)
    }

    private var isSelected: Bool {
        selectedGoalID == goal.id
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 10) {
                if hasChildren {
                    Button {
                        if isExpanded {
                            expandedGoalIDs.remove(goal.id)
                        } else {
                            expandedGoalIDs.insert(goal.id)
                        }
                    } label: {
                        Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                            .font(.caption.weight(.bold))
                            .frame(width: 16, height: 16)
                    }
                    .buttonStyle(.plain)
                } else {
                    Color.clear
                        .frame(width: 16, height: 16)
                }

                Button {
                    onSelect(goal.id)
                } label: {
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(goal.title)
                                .font(.subheadline.weight(.semibold))
                                .multilineTextAlignment(.leading)
                            Text("\(goal.level.capitalized) · \(goal.ownerLabel)")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        StatusPill(label: goal.status, color: statusColor(for: goal.status))
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        isSelected ? Color.accentColor.opacity(0.10) : Color.primary.opacity(0.03),
                        in: RoundedRectangle(cornerRadius: 18)
                    )
                }
                .buttonStyle(.plain)
            }
            .padding(.leading, CGFloat(depth) * 18)

            if hasChildren && isExpanded {
                ForEach(childGoals) { childGoal in
                    GoalTreeNodeRows(
                        goal: childGoal,
                        allGoals: allGoals,
                        depth: depth + 1,
                        selectedGoalID: selectedGoalID,
                        expandedGoalIDs: $expandedGoalIDs,
                        onSelect: onSelect
                    )
                }
            }
        }
    }
}

private struct GoalMetaRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(label.uppercased())
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 110, alignment: .leading)
            Text(value)
                .font(.subheadline)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
