import SwiftUI

/// A contact’s screen. For people shown together, a switcher at the top moves between them.
struct PersonView: View {
    let id: String
    /// Everyone shown in the list you came from, in order (people shown together are one entry).
    /// Each is a card; swipe sideways to the next or previous one.
    var order: [[String]] = []
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var position: String?
    /// How far the card you’re on is pulled down.
    @State private var pull: CGFloat = 0
    @State private var closing = false

    private func closeCard() {
        guard !closing else { return }
        closing = true
        dismiss()
    }
    /// For people shown together: which of them each card shows.
    @State private var chosen: [String: String] = [:]

    /// Where the cards grow from: the list’s rows. Swiping a card down shrinks it back into its row.
    var zoom: Namespace.ID?

    init(id: String, order: [[String]] = [], zoom: Namespace.ID? = nil) {
        self.id = id
        self.order = order
        self.zoom = zoom
        let entry = order.first { $0.contains(id) }
        _position = State(initialValue: entry?.first ?? id)
        if let lead = entry?.first, lead != id { _chosen = State(initialValue: [lead: id]) }
    }

    /// The cards: the list you came from, or just this person (with whoever’s shown with them).
    private var entries: [[String]] {
        order.contains { $0.contains(id) } ? order : [[id]]
    }

    private static let inset: CGFloat = 14
    private static let gap: CGFloat = 8

    var body: some View {
        let current = position ?? id
        let members = store.together[chosen[current] ?? current] ?? store.together[current] ?? []
        ScrollView(.horizontal) {
            LazyHStack(spacing: Self.gap) {
                ForEach(entries.compactMap(\.first), id: \.self) { lead in
                    ContactDetailView(
                        id: chosen[lead] ?? lead,
                        active: lead == current,
                        onClose: { dismiss() },
                        members: store.together[lead] ?? [],
                        chosen: chosen[lead] ?? lead,
                        onChoose: { chosen[lead] = $0 },
                        onPull: { distance, released in
                            guard lead == current else { return }
                            if released && distance > 70 { closeCard() } else { pull = released ? 0 : distance }
                        }
                    )
                        .contentMargins(.bottom, 40, for: .scrollContent)
                        .scrollContentBackground(.hidden)
                        .background { ZStack { Theme.cardGround; Theme.grain.blendMode(.multiply).accessibilityHidden(true) } }
                        // Rounded at the top; the bottom runs off the screen.
                        .clipShape(UnevenRoundedRectangle(topLeadingRadius: 24, topTrailingRadius: 24, style: .continuous))
                        .overlay(
                            UnevenRoundedRectangle(topLeadingRadius: 24, topTrailingRadius: 24, style: .continuous)
                                .stroke(Color(.separator).opacity(0.5), lineWidth: 0.5)
                        )
                        .shadow(color: .black.opacity(0.12), radius: 14, y: 4)
                        .padding(.top, 8)
                        .containerRelativeFrame(.horizontal) { w, _ in w - Self.inset * 2 }
                        // Pulled down from the top, the card follows your finger.
                        .offset(y: lead == current ? pull * 0.9 : 0)
                        .scaleEffect(lead == current ? 1 - min(pull, 300) / 3000 : 1, anchor: .top)
                        // The ones beside it sit a little lower and smaller, and rise as they come in.
                        .scrollTransition(.interactive, axis: .horizontal) { content, phase in
                            content
                                .scaleEffect(1 - abs(phase.value) * 0.05, anchor: .bottom)
                                .offset(y: abs(phase.value) * 18)
                        }
                }
            }
            .scrollTargetLayout()
        }
        .contentMargins(.horizontal, Self.inset, for: .scrollContent)
        .scrollTargetBehavior(.viewAligned)
        .scrollPosition(id: $position)
        .scrollIndicators(.hidden)
        .scrollClipDisabled()
        .ignoresSafeArea(edges: .bottom)
        .background(PaperBackground())
        .sensoryFeedback(.selection, trigger: position)
        .modifier(CardZoom(zoom: zoom, source: current))
        .toolbar(.hidden, for: .navigationBar)
    }
}

/// Grows the cards out of the tapped row; swiping a card down shrinks it back into the row of
/// whoever it shows now.
private struct CardZoom: ViewModifier {
    let zoom: Namespace.ID?
    let source: String

    func body(content: Content) -> some View {
        if let zoom {
            content.navigationTransition(.zoom(sourceID: source, in: zoom))
        } else {
            content
        }
    }
}

/// The Relationships section of a contact.
struct RelationshipsSection: View {
    let id: String
    @Binding var editing: RelationshipEditTarget?
    @Environment(Store.self) private var store

    var body: some View {
        let rels = store.relationships(of: id)
        CardSection(title: "Relationships", note: "Only in Ligature.") {
            ForEach(Array(rels.enumerated()), id: \.element.id) { i, r in
                let other = r.other(than: id)
                let person = store.contacts.first { $0.id == other }
                HStack(spacing: 10) {
                    NavigationLink(value: other) {
                        HStack(spacing: 10) {
                            Avatar(url: person?.photoUrl ?? "", initials: person?.initials ?? "?", size: 32)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(r.label(for: id)).font(.caption).foregroundStyle(.secondary)
                                Text(person?.displayName ?? "No Name")
                            }
                            Spacer()
                            if r.combined {
                                Text("Together")
                                    .font(.caption.weight(.medium))
                                    .foregroundStyle(.secondary)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 3)
                                    .background(Capsule().fill(Theme.paper))
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Menu {
                        Button { editing = RelationshipEditTarget(me: id, existing: r) } label: { Label("Edit", systemImage: "pencil") }
                        Button(role: .destructive) { Task { await store.removeRelationship(r) } } label: { Label("Remove", systemImage: "trash") }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .frame(width: 30, height: 30)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Options for \(person?.displayName ?? "relationship")")
                }
                .cardRow(first: i == 0)
            }
            Button { editing = RelationshipEditTarget(me: id, existing: nil) } label: {
                Label("Add Relationship", systemImage: "plus").font(.body.weight(.medium))
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.accentColor)
            .cardRow(first: rels.isEmpty)
        }
    }
}

struct RelationshipEditTarget: Identifiable {
    let id = UUID()
    let me: String
    let existing: Relationship?
}

struct RelationshipEditor: View {
    let me: String
    let existing: Relationship?
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var other: String?
    @State private var role: RelationRole
    @State private var label: String
    @State private var together: Bool
    @State private var touched: Bool
    @State private var saving = false
    @State private var confirmRemove = false

    init(me: String, existing: Relationship?) {
        self.me = me
        self.existing = existing
        _other = State(initialValue: existing?.other(than: me))
        _role = State(initialValue: existing.map { RelationRole.of($0, me: me) } ?? .spouse)
        _label = State(initialValue: existing?.label ?? "")
        _together = State(initialValue: existing?.combined ?? true)
        _touched = State(initialValue: existing != nil)
    }

    private func person(_ id: String?) -> ContactRow? { id.flatMap { id in store.contacts.first { $0.id == id } } }
    private func first(_ c: ContactRow?) -> String {
        guard let c else { return "them" }
        return c.givenName.isEmpty ? c.displayName : c.givenName
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Person") {
                    if let o = person(other), existing != nil {
                        Text(o.displayName)
                    } else {
                        NavigationLink {
                            PersonPicker(exclude: me) { other = $0 }
                        } label: {
                            if let o = person(other) { Text(o.displayName) } else { Text("Choose…").foregroundStyle(Color.accentColor) }
                        }
                    }
                }
                Section {
                    Picker(other == nil ? "Who they are to \(first(person(me)))" : "\(first(person(other))) is \(first(person(me)))’s", selection: $role) {
                        ForEach(RelationRole.allCases) { Text($0.label).tag($0) }
                    }
                    if role == .other {
                        TextField("Relationship, like Godparent", text: $label)
                    }
                }
                Section {
                    Toggle("Show as One in the List", isOn: Binding(get: { together }, set: { together = $0; touched = true }))
                } footer: {
                    if together, other != nil { Text(preview) }
                }
                if existing != nil {
                    Section {
                        Button("Remove Relationship", role: .destructive) { confirmRemove = true }
                    }
                }
            }
            .navigationTitle(existing == nil ? "Add Relationship" : "Edit Relationship")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(existing == nil ? "Add" : "Save") { save() }
                        .disabled(other == nil || saving)
                }
            }
            .onChange(of: role) { _, r in if !touched { together = r.together } }
            .confirmationDialog("Remove this relationship?", isPresented: $confirmRemove, titleVisibility: .visible) {
                Button("Remove", role: .destructive) {
                    guard let existing else { return }
                    Task {
                        await store.removeRelationship(existing)
                        dismiss()
                    }
                }
            }
        }
    }

    /// The entry’s name once this joins them.
    private var preview: String {
        guard let other else { return "" }
        let (a, b) = role.otherIsA == true ? (other, me) : (me, other)
        var rels = store.relationships.filter { r in r.id != existing?.id && !((r.a == me && r.b == other) || (r.a == other && r.b == me)) }
        rels.append(Relationship(id: "preview", a: a, b: b, kind: role.kind, label: "", combined: true))
        let members = Together.groups(store.contacts, rels)[me] ?? []
        return "Shown as “\(Together.name(members))”."
    }

    private func save() {
        guard let other else { return }
        saving = true
        Task {
            let ok = await store.saveRelationship(me: me, other: other, role: role, label: label, together: together, replacing: existing)
            saving = false
            if ok { dismiss() }
        }
    }
}

/// Choose a contact by searching.
struct PersonPicker: View {
    let exclude: String
    let pick: (String) -> Void
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    var body: some View {
        let terms = query.lowercased().split(separator: " ").map(String.init)
        let people = store.contacts
            .filter { $0.id != exclude && (terms.isEmpty || terms.allSatisfy($0.search.contains)) }
            .sorted { $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending }
        List(people) { c in
            Button {
                pick(c.id)
                dismiss()
            } label: {
                HStack(spacing: 10) {
                    Avatar(url: c.photoUrl, initials: c.initials, size: 28)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(c.displayName.isEmpty ? "No Name" : c.displayName).foregroundStyle(Color.primary)
                        if !c.organization.isEmpty { Text(c.organization).font(.subheadline).foregroundStyle(.secondary) }
                    }
                }
            }
        }
        .listStyle(.plain)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search")
        .navigationTitle("Choose Person")
        .navigationBarTitleDisplayMode(.inline)
    }
}
