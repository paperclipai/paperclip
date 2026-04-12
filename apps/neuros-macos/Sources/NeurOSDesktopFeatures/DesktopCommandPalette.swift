import SwiftUI
import NeurOSAppCore

struct DesktopCommandPalette: View {
    let appModel: AppModel
    let onNavigate: (NavigationSection) -> Void
    let onNewIssue: () -> Void
    let onNewAgent: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    var body: some View {
        NavigationStack {
            List(filteredEntries) { entry in
                Button {
                    handleSelection(entry)
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: entry.icon)
                            .foregroundStyle(GoldNeuronBrand.goldDeep)
                            .frame(width: 18)

                        VStack(alignment: .leading, spacing: 3) {
                            Text(entry.title)
                                .foregroundStyle(GoldNeuronBrand.textPrimary)
                            Text(entry.subtitle)
                                .font(.caption)
                                .foregroundStyle(GoldNeuronBrand.textSecondary)
                        }

                        Spacer()

                        Text(entry.scope)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                }
                .buttonStyle(.plain)
            }
            .navigationTitle("Command Palette")
            .searchable(text: $query, placement: .toolbar, prompt: "Buscar seções, issues, agentes e ações")
            .frame(minWidth: 620, minHeight: 480)
        }
    }

    private var filteredEntries: [PaletteEntry] {
        let base = allEntries
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.isEmpty == false else { return base }
        return base.filter { entry in
            let haystack = "\(entry.title) \(entry.subtitle) \(entry.scope)".localizedLowercase
            return haystack.contains(trimmed.localizedLowercase)
        }
    }

    private var allEntries: [PaletteEntry] {
        var entries: [PaletteEntry] = [
            PaletteEntry(
                id: "action:new-issue",
                title: "Nova Issue",
                subtitle: "Criar uma nova issue na empresa ativa",
                icon: "plus.square.on.square",
                scope: "Ação",
                perform: {
                    onNewIssue()
                }
            ),
            PaletteEntry(
                id: "action:new-agent",
                title: "Novo Agente",
                subtitle: "Abrir o fluxo de criação de agente",
                icon: "person.badge.plus",
                scope: "Ação",
                perform: {
                    onNewAgent()
                }
            ),
        ]

        entries += NavigationSection.allCases.map { section in
            PaletteEntry(
                id: "section:\(section.id)",
                title: section.title,
                subtitle: "Ir para \(section.title)",
                icon: symbol(for: section),
                scope: "Seção",
                perform: {
                    onNavigate(section)
                }
            )
        }

        entries += appModel.issues.prefix(8).map { issue in
            PaletteEntry(
                id: "issue:\(issue.id)",
                title: "\(issue.identifier) · \(issue.title)",
                subtitle: "\(issue.assigneeLabel) · \(issue.status) · \(issue.priority)",
                icon: "list.bullet.clipboard",
                scope: "Issue",
                perform: {
                    onNavigate(.queue)
                }
            )
        }

        entries += appModel.agents.prefix(8).map { agent in
            PaletteEntry(
                id: "agent:\(agent.id)",
                title: agent.name,
                subtitle: "\(agent.role) · \(agent.stateLabel)",
                icon: "person.3.sequence",
                scope: "Agente",
                perform: {
                    onNavigate(.agents)
                }
            )
        }

        entries += appModel.projects.prefix(8).map { project in
            PaletteEntry(
                id: "project:\(project.id)",
                title: project.name,
                subtitle: "\(project.workspaceCount) workspaces · \(project.goalCount) metas",
                icon: "folder.badge.gearshape",
                scope: "Projeto",
                perform: {
                    onNavigate(.projects)
                }
            )
        }

        entries += appModel.goals.prefix(8).map { goal in
            PaletteEntry(
                id: "goal:\(goal.id)",
                title: goal.title,
                subtitle: "\(goal.level) · \(goal.ownerLabel)",
                icon: "target",
                scope: "Meta",
                perform: {
                    onNavigate(.goals)
                }
            )
        }

        entries += appModel.approvals.prefix(8).map { approval in
            PaletteEntry(
                id: "approval:\(approval.id)",
                title: approval.title,
                subtitle: "\(approval.owner) · \(approval.priorityLabel)",
                icon: "checklist.checked",
                scope: "Aprovação",
                perform: {
                    onNavigate(.approvals)
                }
            )
        }

        return entries
    }

    private func handleSelection(_ entry: PaletteEntry) {
        dismiss()
        entry.perform()
    }

    private func symbol(for section: NavigationSection) -> String {
        switch section {
        case .operations: return "waveform.path.ecg.rectangle"
        case .inbox: return "tray.full"
        case .activity: return "clock.arrow.circlepath"
        case .goals: return "target"
        case .queue: return "list.bullet.clipboard"
        case .agents: return "person.3.sequence"
        case .projects: return "folder.badge.gearshape"
        case .approvals: return "checklist.checked"
        case .routines: return "clock.arrow.circlepath"
        case .costs: return "dollarsign.circle"
        case .organization: return "building.2"
        case .skills: return "sparkles"
        case .adapters: return "puzzlepiece.extension"
        case .runtime: return "bolt.badge.clock"
        case .plugins: return "puzzlepiece.extension"
        case .settings: return "gearshape"
        }
    }
}

private struct PaletteEntry: Identifiable {
    let id: String
    let title: String
    let subtitle: String
    let icon: String
    let scope: String
    let perform: () -> Void
}
