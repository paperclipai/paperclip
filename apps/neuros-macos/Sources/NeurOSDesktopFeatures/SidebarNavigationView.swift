import SwiftUI
import NeurOSAppCore

public struct SidebarNavigationView: View {
    @Binding private var selectedSection: NavigationSection

    public init(selectedSection: Binding<NavigationSection>) {
        _selectedSection = selectedSection
    }

    public var body: some View {
        List(NavigationSection.allCases, selection: $selectedSection) { section in
            Label(section.title, systemImage: symbol(for: section))
                .tag(section)
        }
        .navigationTitle("neurOS")
    }

    private func symbol(for section: NavigationSection) -> String {
        switch section {
        case .operations: "waveform.path.ecg.rectangle"
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
