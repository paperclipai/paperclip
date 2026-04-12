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
            Section {
                GoldNeuronSidebarHeader(
                    statusLabel: appModel.connectionState.label,
                    statusColor: statusColor(for: appModel.connectionState.label)
                )
                    .listRowInsets(EdgeInsets(top: 6, leading: 0, bottom: 6, trailing: 0))

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
            } header: {
                EmptyView()
            }

            Section("Áreas") {
                ForEach(NavigationSection.allCases) { section in
                    Label(section.title, systemImage: symbol(for: section))
                        .tag(section)
                }
            }
        }
        .navigationTitle("neurOS")
        .scrollContentBackground(.hidden)
        .listStyle(.sidebar)
        .listRowSeparator(.hidden)
        .background(GoldNeuronBrand.background)
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
        case .routines: "clock.arrow.circlepath"
        case .costs: "dollarsign.circle"
        case .runtime: "bolt.badge.clock"
        case .skills: "sparkles"
        case .adapters: "puzzlepiece.extension"
        case .plugins: "puzzlepiece.extension"
        case .organization: "building.2"
        case .settings: "gearshape"
        }
    }
}

private struct GoldNeuronSidebarHeader: View {
    let statusLabel: String
    let statusColor: Color

    var body: some View {
        HStack(spacing: 12) {
            Image("gn_isotipo_transparent", bundle: .module)
                .resizable()
                .interpolation(.high)
                .antialiased(true)
                .scaledToFit()
                .frame(width: 22, height: 22)
            Spacer()
            Text(statusLabel.uppercased())
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(statusColor.opacity(0.14), in: Capsule())
                .foregroundStyle(statusColor)
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
