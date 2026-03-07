import SwiftUI

/// Compact row for an MCP server in the agent detail view
struct MCPServerRowView: View {
    let server: MCPServer
    let onEdit: () -> Void
    let onDelete: () -> Void

    @State private var showDeleteConfirm = false

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: server.serverType.iconName)
                .font(.body)
                .foregroundStyle(server.isEnabled ? .blue : .secondary)
                .frame(width: 20)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(server.name)
                        .font(.body.weight(.medium))
                        .lineLimit(1)

                    Text(server.serverType.displayName)
                        .font(.caption)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(.quaternary, in: Capsule())
                        .foregroundStyle(.secondary)

                    if !server.isEnabled {
                        Text("Disabled")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    }
                }

                Text(server.summary)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                if !server.env.isEmpty {
                    Text("\(server.env.count) env var\(server.env.count == 1 ? "" : "s")")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }

            Spacer()

            HStack(spacing: 4) {
                Button {
                    onEdit()
                } label: {
                    Image(systemName: "pencil")
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)

                Button(role: .destructive) {
                    showDeleteConfirm = true
                } label: {
                    Image(systemName: "trash")
                        .font(.caption)
                }
                .buttonStyle(.bordered)
                .tint(.red)
                .controlSize(.mini)
            }
        }
        .padding(.vertical, 8)
        .padding(.horizontal, 12)
        .confirmationDialog("Remove \"\(server.name)\"?", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
            Button("Remove Server", role: .destructive) { onDelete() }
            Button("Cancel", role: .cancel) {}
        }
    }
}
