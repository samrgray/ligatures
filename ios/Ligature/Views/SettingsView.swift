import SwiftUI

struct SettingsView: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @AppStorage("sortByFirst") private var sortByFirst = false
    @AppStorage("appearance") private var appearance = Appearance.auto.rawValue
    @State private var confirmSignOut = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Server", value: store.server.replacingOccurrences(of: "https://", with: ""))
                    HStack {
                        Text("Last synced")
                        Spacer()
                        if store.syncing {
                            ProgressView()
                        } else if let t = store.lastSynced {
                            Text(t, style: .relative).foregroundStyle(.secondary) + Text(" ago").foregroundStyle(.secondary)
                        } else {
                            Text("Never").foregroundStyle(.secondary)
                        }
                    }
                    Button("Sync Now") { Task { await store.refresh(sync: true) } }
                        .disabled(store.syncing)
                } header: {
                    Text("Google")
                } footer: {
                    Text("Edits go to Google Contacts and reach your iPhone and Mac. Your own fields stay in Ligature.")
                }
                Section("Appearance") {
                    Picker("Appearance", selection: $appearance) {
                        ForEach(Appearance.allCases) { a in Text(a.title).tag(a.rawValue) }
                    }
                    .pickerStyle(.segmented)
                }
                Section("Contacts") {
                    Toggle("Sort by first name", isOn: $sortByFirst)
                }
                Section {
                    Button("Sign Out", role: .destructive) { confirmSignOut = true }
                } footer: {
                    Text("Ligature \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "") (\(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""))")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .confirmationDialog("Sign out of Ligature?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign Out", role: .destructive) {
                    Task {
                        dismiss()
                        await store.signOut()
                    }
                }
            } message: {
                Text("Your contacts stay in Google. This iPhone forgets them until you sign in again.")
            }
        }
        .storeAlert()
    }
}
