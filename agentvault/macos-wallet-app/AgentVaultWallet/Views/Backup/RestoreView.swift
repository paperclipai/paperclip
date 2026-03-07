import SwiftUI
import UniformTypeIdentifiers

/// Restore wallets from a backup file
struct RestoreView: View {
    @EnvironmentObject var walletStore: WalletStore
    @EnvironmentObject var appState: AppState
    @StateObject private var vm = BackupViewModel()
    @Environment(\.dismiss) private var dismiss
    @State private var showFileImporter = false

    var body: some View {
        VStack(spacing: 0) {
            // Header
            VStack(spacing: 8) {
                Image(systemName: "arrow.uturn.backward.circle.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(.foreground)
                Text("Restore from Backup")
                    .font(.title2.bold())
                Text("Recover your wallets from an encrypted backup file")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .padding(.top, 20)
            .padding(.bottom, 16)

            Divider()

            if vm.restoreComplete {
                restoreCompleteView
            } else {
                ScrollView {
                    VStack(spacing: 24) {
                        // File selection
                        fileSelectionSection

                        // Backup info (if file selected)
                        if let metadata = vm.backupMetadata {
                            backupInfoSection(metadata)
                        }

                        // Password
                        if vm.restoreFileURL != nil {
                            passwordSection
                        }
                    }
                    .padding(24)
                }

                Divider()

                // Footer
                HStack {
                    Button("Cancel") { dismiss() }
                        .buttonStyle(.bordered)
                    Spacer()

                    if vm.isRestoring {
                        ProgressView()
                            .controlSize(.small)
                    }

                    Button("Restore") {
                        Task {
                            await vm.restoreFromBackup(store: walletStore)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!vm.canRestore)
                }
                .padding(16)
            }
        }
        .frame(maxWidth: .infinity)
        .background(.background)
        .fileImporter(
            isPresented: $showFileImporter,
            allowedContentTypes: [
                UTType(filenameExtension: "avbackup") ?? .data,
                .json,
                .data
            ],
            allowsMultipleSelection: false
        ) { result in
            switch result {
            case .success(let urls):
                vm.restoreFileURL = urls.first
                vm.loadBackupMetadata()
            case .failure(let error):
                vm.errorMessage = error.localizedDescription
            }
        }
        .onAppear {
            vm.loadExistingBackups()
        }
        .alert("Restore Error", isPresented: Binding(
            get: { vm.errorMessage != nil },
            set: { if !$0 { vm.errorMessage = nil } }
        )) {
            Button("OK") { vm.errorMessage = nil }
        } message: {
            Text(vm.errorMessage ?? "")
        }
    }

    private var fileSelectionSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Select Backup File")
                .font(.headline)

            if let url = vm.restoreFileURL {
                HStack {
                    Image(systemName: "doc.zipper")
                        .font(.title3)
                        .foregroundStyle(.foreground)

                    VStack(alignment: .leading) {
                        Text(url.lastPathComponent)
                            .font(.callout)
                        Text(url.deletingLastPathComponent().path)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }

                    Spacer()

                    Button("Change") {
                        showFileImporter = true
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
                .padding(12)
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
            } else {
                // File picker button
                Button {
                    showFileImporter = true
                } label: {
                    VStack(spacing: 12) {
                        Image(systemName: "doc.badge.plus")
                            .font(.system(size: 32))
                            .foregroundStyle(.secondary)
                        Text("Select a backup file (.avbackup)")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, minHeight: 100)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(style: StrokeStyle(lineWidth: 2, dash: [8, 4]))
                            .foregroundStyle(.secondary.opacity(0.3))
                    )
                }
                .buttonStyle(.plain)

                // Recent backups
                if !vm.existingBackups.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Recent Backups")
                            .font(.subheadline.bold())
                            .foregroundStyle(.secondary)

                        ForEach(vm.existingBackups) { backup in
                            Button {
                                vm.restoreFileURL = backup.url
                                vm.loadBackupMetadata()
                            } label: {
                                HStack {
                                    Image(systemName: "doc.zipper")
                                        .foregroundStyle(.secondary)
                                    VStack(alignment: .leading) {
                                        Text(backup.filename)
                                            .font(.callout)
                                        HStack(spacing: 8) {
                                            Text(backup.createdAt.formatted(date: .abbreviated, time: .shortened))
                                            Text(backup.formattedSize)
                                            if let count = backup.walletCount {
                                                Text("\(count) wallets")
                                            }
                                        }
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                }
                            }
                            .buttonStyle(.plain)
                            .padding(8)
                            .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 6))
                        }
                    }
                }
            }
        }
    }

    private func backupInfoSection(_ backup: WalletBackup) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Backup Contents")
                .font(.headline)

            VStack(spacing: 0) {
                WalletInfoRow(label: "Created", value: backup.createdAt.formatted(date: .long, time: .shortened))
                Divider().padding(.leading)
                WalletInfoRow(label: "App Version", value: backup.appVersion)
                Divider().padding(.leading)
                WalletInfoRow(label: "Wallets", value: "\(backup.wallets.count)")
            }
            .background(.background, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(.secondary.opacity(0.15)))

            // Wallet list preview
            VStack(spacing: 4) {
                ForEach(backup.wallets) { entry in
                    HStack(spacing: 10) {
                        Image(systemName: entry.chain.iconName)
                            .foregroundStyle(entry.chain.color)
                            .frame(width: 20)
                        Text(entry.name)
                            .font(.callout)
                        Spacer()
                        Text(entry.chain.symbol)
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        // Show if wallet already exists
                        if walletStore.wallets.contains(where: { $0.address == entry.address && $0.chain == entry.chain }) {
                            Text("EXISTS")
                                .font(.caption2.bold())
                                .foregroundStyle(.orange)
                                .padding(.horizontal, 4)
                                .padding(.vertical, 1)
                                .background(.orange.opacity(0.15), in: Capsule())
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                }
            }
            .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))
        }
    }

    private var passwordSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Backup Password")
                .font(.headline)

            Text("Enter the password used when this backup was created.")
                .font(.caption)
                .foregroundStyle(.secondary)

            SecureField("Backup password", text: $vm.restorePassword)
                .textFieldStyle(.roundedBorder)
        }
    }

    private var restoreCompleteView: some View {
        VStack(spacing: 20) {
            Spacer()

            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 56))
                .foregroundStyle(.green)

            Text("Restore Complete!")
                .font(.title2.bold())

            Text("\(vm.restoredCount) wallet(s) restored successfully.")
                .font(.callout)
                .foregroundStyle(.secondary)

            if let metadata = vm.backupMetadata {
                let skipped = metadata.wallets.count - vm.restoredCount
                if skipped > 0 {
                    Text("\(skipped) wallet(s) were skipped because they already exist.")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }

            Spacer()

            Button("Done") { dismiss() }
                .buttonStyle(.borderedProminent)
                .padding(.bottom, 20)
        }
        .padding(24)
    }
}

/// Combined backup and restore view for the sidebar navigation
struct BackupRestoreView: View {
    @State private var selectedTab = 0

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $selectedTab) {
                Text("Backup").tag(0)
                Text("Restore").tag(1)
            }
            .pickerStyle(.segmented)
            .padding(16)

            if selectedTab == 0 {
                BackupView()
            } else {
                RestoreView()
            }
        }
        .navigationTitle("Backup & Restore")
    }
}
