import SwiftUI

/// Archived contacts: out of Google, kept in Ligature. Restore them, or delete them for good.
struct ArchivedView: View {
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var forget: ContactRow?
    @State private var query = ""

    var body: some View {
        let terms = query.lowercased().split(separator: " ").map(String.init)
        let people = store.archived
            .filter { c in terms.allSatisfy { c.search.contains($0) } }
            .sorted { $0.sortKey(byFirst: false).localizedStandardCompare($1.sortKey(byFirst: false)) == .orderedAscending }
        NavigationStack {
            List(people) { c in
                NavigationLink(value: c.id) {
                    ContactRowView(contact: c, sortByFirst: false)
                }
                .accessibilityIdentifier("archived-row")
                .swipeActions(edge: .trailing) {
                    Button("Delete", role: .destructive) { forget = c }
                    Button("Restore") { Task { await store.archive(.restore, ids: [c.id]) } }
                        .tint(.green)
                }
            }
            .listStyle(.plain)
            .overlay {
                if store.archived.isEmpty {
                    ContentUnavailableView("No Archived Contacts", systemImage: "archivebox",
                                           description: Text("Archive someone to take them out of Google Contacts while keeping everything here."))
                } else if people.isEmpty {
                    ContentUnavailableView.search(text: query)
                }
            }
            .searchable(text: $query, prompt: "Search")
            .navigationTitle("Archived")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { id in ContactDetailView(id: id).background(PaperBackground()) }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .confirmationDialog("Delete \(forget?.displayName ?? "this contact") forever?", isPresented: Binding(get: { forget != nil }, set: { if !$0 { forget = nil } }), titleVisibility: .visible) {
                Button("Delete Forever", role: .destructive) {
                    if let c = forget { Task { await store.archive(.forget, ids: [c.id]) } }
                }
            } message: {
                Text("Their details, your fields and relationships are removed from Ligatures. This can’t be undone.")
            }
            .storeAlert()
        }
    }
}
