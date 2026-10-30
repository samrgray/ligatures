import SwiftUI

/// The kinds of field you can make, as the web names them.
enum FieldType: String, CaseIterable, Identifiable {
    case text, longtext, date, url, checkbox
    var id: String { rawValue }
    var title: String {
        switch self {
        case .text: "Text"
        case .longtext: "Long text"
        case .date: "Date"
        case .url: "Link"
        case .checkbox: "Checkbox"
        }
    }
}

/// Your own fields: add, rename, change type, choose who they’re on, reorder and delete. Kept only
/// in Ligature, never sent to Google; the same fields as on the web.
struct FieldsView: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var editing: FieldTarget?

    /// A field being edited, or a new one.
    struct FieldTarget: Identifiable {
        let id = UUID()
        let field: FieldDef?
    }

    /// On every contact first, then each list’s own fields under the list’s name.
    private var sections: [(title: String, fields: [FieldDef])] {
        var out: [(String, [FieldDef])] = [("On Every Contact", store.fields.filter { $0.listId == nil })]
        var seen: [String] = []
        for f in store.fields where f.listId != nil {
            let k = "\(f.accountId ?? "")|\(f.listId ?? "")"
            if !seen.contains(k) { seen.append(k) }
        }
        for k in seen {
            let list = store.fields.filter { "\($0.accountId ?? "")|\($0.listId ?? "")" == k }
            let f = list[0]
            let name = f.listId.flatMap { store.listName($0, accountId: f.accountId ?? "") } ?? f.listName ?? "A deleted list"
            out.append(("Only in \(name)", list))
        }
        return out
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(sections, id: \.title) { section in
                    Section {
                        ForEach(section.fields) { f in
                            Button { editing = FieldTarget(field: f) } label: { row(f) }
                                .foregroundStyle(Theme.ink)
                        }
                        .onMove { from, to in move(section.fields, from, to) }
                    } header: {
                        Text(section.title)
                    }
                }
                Section {
                    Button { editing = FieldTarget(field: nil) } label: { Label("New Field", systemImage: "plus") }
                } footer: {
                    Text("Your fields are kept only in Ligature. They never sync to Google, your iPhone or your Mac.")
                }
            }
            .navigationTitle("Your Fields")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { EditButton() }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .sheet(item: $editing) { t in FieldForm(field: t.field) }
        }
        .storeAlert()
    }

    private func row(_ f: FieldDef) -> some View {
        HStack {
            Text(f.label)
            Spacer()
            Text(f.key != nil ? "Built in" : FieldType(rawValue: f.type)?.title ?? f.type)
                .foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
    }

    /// Reorder within a section; the rest keep their places.
    private func move(_ list: [FieldDef], _ from: IndexSet, _ to: Int) {
        var moved = list.map(\.id)
        moved.move(fromOffsets: from, toOffset: to)
        let ids = Set(moved)
        var it = moved.makeIterator()
        let order = store.fields.map { ids.contains($0.id) ? it.next()! : $0.id }
        Task { await store.orderFields(order) }
    }
}

/// Add a field, or change one: its name, its type, and whether it’s on every contact or only on
/// people in one list.
struct FieldForm: View {
    let field: FieldDef?
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @State private var type = FieldType.text.rawValue
    @State private var list: ListRef?
    @State private var saving = false
    @State private var confirmDelete = false

    private var builtIn: Bool { field?.key != nil }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $label)
                        .textInputAutocapitalization(.sentences)
                    Picker("Type", selection: $type) {
                        ForEach(FieldType.allCases) { t in Text(t.title).tag(t.rawValue) }
                    }
                    .disabled(builtIn)
                }
                Section {
                    Picker("On", selection: $list) {
                        Text("Every Contact").tag(ListRef?.none)
                        ForEach(store.accounts) { a in
                            ForEach(store.lists(for: a.id).filter { $0.id != "contactGroups/myContacts" }) { l in
                                Text(store.accounts.count > 1 ? "\(l.name) (\(a.label ?? a.providerName))" : l.name)
                                    .tag(Optional(ListRef(accountId: a.id, id: l.id)))
                            }
                        }
                    }
                    .disabled(builtIn)
                } footer: {
                    Text(builtIn ? "Built in, so it’s on every contact and its type can’t change."
                         : list == nil ? "On every contact." : "Only on people in that list, and shown as a column only while viewing it.")
                }
                if let field, !builtIn {
                    Section {
                        Button("Delete Field", role: .destructive) { confirmDelete = true }
                    }
                    .confirmationDialog("Delete “\(field.label)”?", isPresented: $confirmDelete, titleVisibility: .visible) {
                        Button("Delete Field", role: .destructive) {
                            Task {
                                await store.deleteField(field)
                                dismiss()
                            }
                        }
                    } message: {
                        Text("Its values on every contact are deleted too. This can’t be undone.")
                    }
                }
            }
            .navigationTitle(field == nil ? "New Field" : "Edit Field")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(field == nil ? "Add" : "Save") { Task { await save() } }
                        .bold()
                        .disabled(saving || label.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear {
                guard let field else { return }
                label = field.label
                type = field.type
                list = field.listId.map { ListRef(accountId: field.accountId ?? "", id: $0) }
            }
        }
        .storeAlert()
    }

    private func save() async {
        saving = true
        var ok: Bool
        if let field {
            ok = await store.updateField(field, label: label, type: type, list: list)
        } else {
            ok = await store.createField(label: label, type: type, list: list)
        }
        saving = false
        if ok { dismiss() }
    }
}
