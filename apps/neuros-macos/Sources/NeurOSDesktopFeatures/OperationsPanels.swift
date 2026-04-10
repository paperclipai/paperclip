import SwiftUI
import NeurOSAppCore

struct OperationsHeroView: View {
    let appModel: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Central Operacional")
                .font(.largeTitle.weight(.bold))
            Text("A home do neurOS macOS prioriza estado da operação, fila, agentes, sinais e aprovações para equipes que atuam na mesma rede.")
                .font(.body)
                .foregroundStyle(.secondary)

            HStack(spacing: 16) {
                metric("Empresas", value: "\(appModel.companies.count)")
                metric("Issues", value: "\(appModel.totalActiveIssues)")
                metric("Agentes", value: "\(appModel.totalActiveAgents)")
                metric("Sinais", value: "\(appModel.totalRecentSignals)")
            }
        }
        .padding(24)
        .background(
            LinearGradient(
                colors: [Color.blue.opacity(0.18), Color.cyan.opacity(0.12)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: 24)
        )
    }

    private func metric(_ title: String, value: String) -> some View {
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
        VStack(alignment: .leading, spacing: 14) {
            Text("Sinais e runtime")
                .font(.headline)

            ForEach(appModel.signals.prefix(3)) { signal in
                VStack(alignment: .leading, spacing: 4) {
                    Text(signal.title)
                        .font(.subheadline.weight(.semibold))
                    Text(signal.detail)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 6)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 20))
    }
}

struct ApprovalsQueueView: View {
    let appModel: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Aprovações pendentes")
                .font(.headline)

            ForEach(appModel.approvals.prefix(3)) { approval in
                HStack(alignment: .top) {
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
                        .background(.quaternary, in: Capsule())
                }
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 20))
    }
}

struct ActiveAgentsView: View {
    let appModel: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Agentes ativos")
                .font(.headline)

            ForEach(appModel.agents) { agent in
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(agent.name)
                            .font(.subheadline.weight(.semibold))
                        Text(agent.role)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 3) {
                        Text(agent.stateLabel)
                            .font(.subheadline.weight(.medium))
                        Text(agent.issueLabel)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 6)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 20))
    }
}
