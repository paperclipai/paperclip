import SwiftUI
import NeurOSAppCore
import NeurOSDesktopServices

public struct SidebarNavigationView: View {
    @Bindable private var appModel: AppModel
    private let coordinator: DesktopBootstrapCoordinator

    public init(appModel: AppModel, coordinator: DesktopBootstrapCoordinator) {
        self.appModel = appModel
        self.coordinator = coordinator
    }

    public var body: some View {
        List(selection: $appModel.selectedSection) {
            Section("Instância") {
                VStack(alignment: .leading, spacing: 8) {
                    Label(appModel.connectionState.label, systemImage: "network")
                        .font(.subheadline.weight(.semibold))
                    Text(appModel.serverConfiguration.trimmedBaseURLString)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let lastRefreshedAt = appModel.lastRefreshedAt {
                        Text("Atualizado em \(lastRefreshedAt.formatted(date: .abbreviated, time: .shortened))")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                }
                .padding(.vertical, 4)

                Picker("Empresa ativa", selection: companySelection) {
                    if appModel.companies.isEmpty {
                        Text("Nenhuma empresa").tag("")
                    } else {
                        ForEach(appModel.companies) { company in
                            Text(company.name).tag(company.id)
                        }
                    }
                }
                .labelsHidden()
                .disabled(appModel.companies.isEmpty)

                Button {
                    Task { await coordinator.refresh(appModel: appModel) }
                } label: {
                    Label("Atualizar agora", systemImage: "arrow.clockwise")
                }
            }

            Section("Áreas") {
                ForEach(NavigationSection.allCases) { section in
                    Label(section.title, systemImage: symbol(for: section))
                        .tag(section)
                }
            }
        }
        .navigationTitle("neurOS")
    }

    private var companySelection: Binding<String> {
        Binding(
            get: { appModel.selectedCompanyID ?? appModel.companies.first?.id ?? "" },
            set: { newValue in
                appModel.selectedCompanyID = newValue.isEmpty ? nil : newValue
                Task { await coordinator.refresh(appModel: appModel) }
            }
        )
    }

    private func symbol(for section: NavigationSection) -> String {
        switch section {
        case .operations: "waveform.path.ecg.rectangle"
        case .inbox: "tray.full"
        case .activity: "clock.arrow.circlepath"
        case .goals: "target"
        case .queue: "list.bullet.clipboard"
        case .agents: "person.3.sequence"
        case .projects: "folder.badge.gearshape"
        case .approvals: "checklist.checked"
        case .runtime: "bolt.badge.clock"
        case .plugins: "puzzlepiece.extension"
        case .organization: "building.2"
        case .settings: "gearshape"
        }
    }
}
