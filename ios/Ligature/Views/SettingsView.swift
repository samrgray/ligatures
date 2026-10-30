import SwiftUI

struct SettingsView: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @AppStorage("sortByFirst") private var sortByFirst = false
    @AppStorage("appearance") private var appearance = Appearance.auto.rawValue
    @State private var confirmSignOut = false
    @State private var showFields = false

    var body: some View {
        NavigationStack {
            Form {
                if store.demo {
                    Section {
                        Button("Exit Demo") { switchDemo(false) }
                    } header: {
                        Text("Demo")
                    } footer: {
                        Text("You’re looking at made-up contacts, kept only on this iPhone. Nothing you do here reaches Google or your real contacts.")
                    }
                } else {
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
                }
                Section("Appearance") {
                    Picker("Appearance", selection: $appearance) {
                        ForEach(Appearance.allCases) { a in Text(a.title).tag(a.rawValue) }
                    }
                    .pickerStyle(.segmented)
                }
                Section("Contacts") {
                    NavigationLink {
                        FontPicker()
                    } label: {
                        LabeledContent("Font", value: store.font)
                    }
                    Toggle("Sort by first name", isOn: $sortByFirst)
                    Button("Your Fields…") { showFields = true }
                }
                Section {
                    Picker("Open Places In", selection: Binding(get: { store.mapsApp }, set: { app in Task { await store.setMapsApp(app) } })) {
                        ForEach(MapsApp.allCases) { a in Text(a.title).tag(a) }
                    }
                } header: {
                    Text("Maps")
                } footer: {
                    Text("Where the directions button on a contact’s map takes you. Also used on the web.")
                }
                if !store.demo {
                    Section {
                        Button("Demo Mode") { switchDemo(true) }
                    } footer: {
                        Text("Shows made-up contacts instead of yours, to try things or show Ligature to someone. Nothing reaches Google.")
                    }
                }
                Section {
                    if !store.demo {
                        Button("Sign Out", role: .destructive) { confirmSignOut = true }
                    }
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
        .sheet(isPresented: $showFields) { FieldsView() }
        .storeAlert()
    }

    private func switchDemo(_ on: Bool) {
        dismiss()
        Task { await store.setDemo(on) }
    }
}

/// Choose the font for all text, each shown in itself. The app redraws in it when Settings closes.
struct FontPicker: View {
    @Environment(Store.self) private var store

    var body: some View {
        List {
            Section {
                ForEach(AppFont.families, id: \.self) { f in
                    Button {
                        Task { await store.setFont(f) }
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(f).font(.custom(AppFont.name(.semibold, family: f), size: 17, relativeTo: .body))
                                Text("Ava Chen · (503) 555-0117")
                                    .font(.custom(AppFont.name(.regular, family: f), size: 15, relativeTo: .subheadline))
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if store.font == f {
                                Image(systemName: "checkmark").foregroundStyle(Color.accentColor).fontWeight(.semibold)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .foregroundStyle(Theme.ink)
                    .accessibilityAddTraits(store.font == f ? [.isButton, .isSelected] : .isButton)
                }
            } footer: {
                Text("Also used on the web.")
            }
        }
        .navigationTitle("Font")
        .navigationBarTitleDisplayMode(.inline)
    }
}
