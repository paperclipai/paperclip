import Foundation

public enum NavigationSection: String, CaseIterable, Identifiable, Sendable {
    case operations
    case inbox
    case activity
    case goals
    case queue
    case agents
    case projects
    case approvals
    case routines
    case costs
    case organization
    case skills
    case adapters
    case runtime
    case plugins
    case settings

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .operations: "Central Operacional"
        case .inbox: "Inbox"
        case .activity: "Atividade"
        case .goals: "Metas"
        case .queue: "Fila e Issues"
        case .agents: "Agentes"
        case .projects: "Projetos e Workspaces"
        case .approvals: "Aprovações"
        case .routines: "Rotinas"
        case .costs: "Custos"
        case .organization: "Empresa e Equipe"
        case .skills: "Skills"
        case .adapters: "Adapters"
        case .runtime: "Runtime e Sinais"
        case .plugins: "Plugins"
        case .settings: "Configurações"
        }
    }
}
