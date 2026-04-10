import SwiftUI
import NeurOSAppCore
import NeurOSDesktopServices

public struct OperationsHomeView: View {
    let appModel: AppModel
    let coordinator: DesktopBootstrapCoordinator

    public init(appModel: AppModel, coordinator: DesktopBootstrapCoordinator) {
        self.appModel = appModel
        self.coordinator = coordinator
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                OperationsHeroView(appModel: appModel)
                ConnectionHealthView(appModel: appModel, coordinator: coordinator)

                HStack(alignment: .top, spacing: 20) {
                    RuntimeSummaryView(appModel: appModel)
                    ApprovalsQueueView(appModel: appModel)
                }

                ActiveAgentsView(appModel: appModel)
            }
            .padding(28)
        }
        .navigationTitle("Central Operacional")
    }
}

private struct ConnectionHealthView: View {
    let appModel: AppModel
    let coordinator: DesktopBootstrapCoordinator

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Operação híbrida")
                .font(.headline)
            Text(appModel.connectionState.label)
                .font(.title3.weight(.semibold))
            Text(appModel.statusMessage ?? "O neurOS macOS alterna entre instância local, remota e promoção manual de coordenação na rede.")
                .foregroundStyle(.secondary)

            HStack {
                Label("Modo \(appModel.runtimeMode.rawValue)", systemImage: "network")
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Assumir coordenação") {
                    Task { await coordinator.promoteCurrentMac(appModel: appModel) }
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(20)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
    }
}
