import SwiftUI

/// Tick the lists a contact is in. Changes go to Google as you tap.
struct ListPickerView: View {
    let ids: [String]
    let accountId: String
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var busy: String?
    @State private var newName = ""

    private var people: [ContactRow] { store.contacts.filter { ids.contains($0.id) } }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(store.nestedLists(for: accountId), id: \.list.id) { item in
                        let list = item.list
                        let count = people.filter { $0.groups.contains(list.id) }.count
                        Button {
                            Task { await toggle(list, allIn: count == people.count) }
                        } label: {
                            HStack(spacing: 8) {
                                ListBadge(name: list.name, style: store.style(ListRef(accountId: accountId, id: list.id)), large: true)
                                    .padding(.leading, CGFloat(min(item.depth, 8)) * 18)
                                Spacer()
                                if busy == list.id {
                                    ProgressView()
                                } else if count == people.count, count > 0 {
                                    Image(systemName: "checkmark").foregroundStyle(Color.accentColor).fontWeight(.semibold)
                                } else if count > 0 {
                                    Image(systemName: "minus").foregroundStyle(Color.accentColor)
                                }
                            }
                        }
                        .disabled(busy != nil)
                    }
                }
                Section {
                    HStack {
                        TextField("New list", text: $newName)
                            .submitLabel(.done)
                            .onSubmit { Task { await create() } }
                        Button("Add") { Task { await create() } }
                            .disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty || busy != nil)
                    }
                } footer: {
                    Text("Lists are Google Contacts labels.")
                }
            }
            .navigationTitle(people.count == 1 ? (people.first?.displayName ?? "Lists") : "\(people.count) People")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .storeAlert()
    }

    private func toggle(_ list: ContactList, allIn: Bool) async {
        busy = list.id
        defer { busy = nil }
        let targets = allIn ? ids : people.filter { !$0.groups.contains(list.id) }.map(\.id)
        await store.setMembership(targets, list: list, accountId: accountId, add: !allIn)
    }

    private func create() async {
        let name = newName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, busy == nil else { return }
        busy = "new"
        defer { busy = nil }
        if let list = await store.createList(name, accountId: accountId) {
            newName = ""
            await store.setMembership(ids, list: list, accountId: accountId, add: true)
        }
    }
}

/// Create, rename and delete lists.
struct ManageListsView: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var naming: Naming?
    @State private var name = ""
    @State private var deleting: (list: ContactList, accountId: String)?
    @State private var styling: Styling?

    private struct Styling: Identifiable {
        let accountId: String
        let list: ContactList
        var id: String { "\(accountId)/\(list.id)" }
    }

    private struct Naming: Identifiable {
        let accountId: String
        let list: ContactList?
        var id: String { list?.id ?? "new-\(accountId)" }
    }

    var body: some View {
        NavigationStack {
            List {
                if !store.pinnedLists.isEmpty {
                    Section {
                        ForEach(store.pinnedLists) { item in
                            row(item.list, accountId: item.ref.accountId)
                        }
                        .onMove { from, to in Task { await store.movePinned(from: from, to: to) } }
                    } header: {
                        Text("Pinned")
                    } footer: {
                        Text("Pinned lists show as tabs above your contacts; swipe sideways to move between them.")
                    }
                }
                Section {
                    ForEach(store.unpinnedLists) { item in
                        row(item.list, accountId: item.ref.accountId)
                            .padding(.leading, CGFloat(store.depth(of: item.ref)) * 18)
                    }
                    .onMove { from, to in Task { await store.moveUnpinned(from: from, to: to) } }
                } header: {
                    Text(store.pinnedLists.isEmpty ? "" : "Lists")
                } footer: {
                    Text("Press and hold a list to drag it, put it inside another list, or give it a color and emoji (nesting, colors and emoji are only in Ligatures). Favorites, Family, Friends and Coworkers are built into Google: you can add people to them, but not rename or delete them.")
                }
            }
            .navigationTitle("Lists")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { name = ""; naming = Naming(accountId: store.accounts.first?.id ?? "", list: nil) } label: { Image(systemName: "plus") }
                        .accessibilityLabel("New List")
                        .disabled(store.accounts.isEmpty)
                }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .alert(naming?.list == nil ? "New List" : "Rename List", isPresented: Binding(get: { naming != nil }, set: { if !$0 { naming = nil } })) {
                TextField("Name", text: $name)
                Button("Cancel", role: .cancel) {}
                Button(naming?.list == nil ? "Create" : "Rename") {
                    // Read these now: closing the alert clears `naming` before a task would run.
                    let n = naming
                    let typed = name
                    Task { await finishNaming(n, typed) }
                }
            }
            .confirmationDialog(
                "Delete “\(deleting?.list.name ?? "")”?",
                isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                titleVisibility: .visible
            ) {
                Button("Delete List", role: .destructive) {
                    if let d = deleting { Task { await store.deleteList(d.list, accountId: d.accountId) } }
                }
            } message: {
                Text("The people in it stay; they’re just no longer in this list. The label is deleted in Google Contacts too.")
            }
            .sheet(item: $styling) { s in ListStyleView(list: s.list, accountId: s.accountId) }
        }
        .storeAlert()
    }

    @ViewBuilder
    private func row(_ g: ContactList, accountId: String) -> some View {
        let count = store.contacts.filter { $0.accountId == accountId && $0.groups.contains(g.id) }.count
        let pinned = store.isPinned(g, accountId: accountId)
        HStack(spacing: 8) {
            ListBadge(name: g.name, style: store.style(ListRef(accountId: accountId, id: g.id)), large: true)
            if store.accounts.count > 1, let a = store.accounts.first(where: { $0.id == accountId }) {
                Text(a.label ?? a.providerName).font(.app(.footnote)).foregroundStyle(.secondary)
            }
            Spacer()
            Text("\(count)").foregroundStyle(.secondary).monospacedDigit()
            Button { Task { await store.setPinned(g, accountId: accountId, !pinned) } } label: {
                Image(systemName: pinned ? "pin.fill" : "pin")
                    .foregroundStyle(pinned ? Color.accentColor : Color(.tertiaryLabel))
                    .frame(width: 32, height: 28)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(pinned ? "Unpin \(g.name)" : "Pin \(g.name)")
        }
        .contentShape(Rectangle())
        .onTapGesture {
            // Built-in lists can’t be renamed, but they can have a color and emoji.
            if g.system {
                styling = Styling(accountId: accountId, list: g)
            } else {
                name = g.name
                naming = Naming(accountId: accountId, list: g)
            }
        }
        .contextMenu {
            let ref = ListRef(accountId: accountId, id: g.id)
            Button { styling = Styling(accountId: accountId, list: g) } label: { Label("Color & Icon", systemImage: "paintpalette") }
            let inside = store.descendants(of: ref)
            let parent = store.parentOf(ref)
            Menu("Move Inside") {
                if parent != nil {
                    Button("Top Level") { Task { await store.nest(ref, inside: nil) } }
                }
                ForEach(store.nestedLists(for: accountId).filter { $0.list.id != g.id && $0.list.id != "contactGroups/myContacts" && !inside.contains($0.list.id) }, id: \.list.id) { item in
                    let t = item.list
                    let title = Store.indented(t.name, depth: item.depth)
                    Button { Task { await store.nest(ref, inside: t.id) } } label: {
                        if t.id == parent { Label(title, systemImage: "checkmark") } else { Text(title) }
                    }
                }
            }
        }
        .swipeActions {
            if !g.system {
                Button("Delete", role: .destructive) { deleting = (g, accountId) }
                Button("Rename") { name = g.name; naming = Naming(accountId: accountId, list: g) }
            }
            Button("Color") { styling = Styling(accountId: accountId, list: g) }.tint(.indigo)
        }
    }

    private func finishNaming(_ naming: Naming?, _ typed: String) async {
        guard let n = naming else { return }
        let trimmed = typed.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        if let list = n.list {
            if trimmed != list.name { await store.renameList(list, to: trimmed, accountId: n.accountId) }
        } else {
            await store.createList(trimmed, accountId: n.accountId)
        }
    }
}
