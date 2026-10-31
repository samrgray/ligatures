import SwiftUI

/// One column of the table, as the web defines it.
struct TableColumnDef: Identifiable {
    enum Kind { case name, text, lists, field(FieldDef) }
    let id: String
    let label: String
    let width: CGFloat
    let kind: Kind
    var numeric = false
    let value: (ContactRow) -> String
    var sortKey: ((ContactRow) -> String)?
}

private struct CellRef: Hashable, Identifiable {
    let contactId: String
    let fieldId: String
    var id: String { contactId + "|" + fieldId }
}

/// The table view: the same columns, widths and sort as the web, for each list. Your own fields
/// (and lists) can be edited right in their cells.
struct ContactsTable: View {
    let items: [ContactRow]
    let filter: ListFilter
    var selecting = false
    @Binding var selection: Set<String>
    /// Holding a photo starts selecting, with that person ticked.
    var startSelecting: (String) -> Void = { _ in }
    /// Choosing this view’s columns (from the layout menu).
    var showColumns: Binding<Bool> = .constant(false)
    let open: (String) -> Void

    @Environment(Store.self) private var store
    @State private var scrollX: CGFloat = 0
    @State private var editing: CellRef?
    @State private var text = ""
    @FocusState private var focused: Bool
    @State private var picking: CellRef?
    @State private var pickedDate = Date()
    @State private var listsFor: ContactRow?
    @State private var scrollBox = ScrollBox()

    /// The table’s UIKit scroll view, once found.
    final class ScrollBox { weak var view: UIScrollView? }

    @Environment(\.photoSize) private var photoSize
    /// Rows grow with the photos (pinch the table); text wraps onto the lines that fit.
    private var rowHeight: CGFloat { max(44, photoSize * 0.85 + 14) }
    private var textLines: Int { max(1, Int((rowHeight - 12) / 19)) }

    // MARK: Setup, shared with the web

    /// The web’s name for this view’s settings.
    private var key: String {
        if case let .list(accountId, id) = filter { return "list:\(accountId):\(id)" }
        return "all"
    }

    private var prefs: ViewPrefs {
        if let p = store.viewPrefs[key] { return p }
        var p = store.legacyView
        // A list you haven’t set up on the web shows its own fields too.
        if case .list = filter {
            var cols = p.columns ?? defaultColumns
            for f in store.fields where f.listId != nil && onView(f) && !cols.contains(where: { $0.id == "f:\(f.id)" }) {
                cols.append(ColumnPref(id: "f:\(f.id)"))
            }
            p.columns = cols
        }
        return p
    }

    private var defaultColumns: [ColumnPref] {
        let followUp = store.fields.first { $0.label.trimmingCharacters(in: .whitespaces).lowercased() == "follow up" }
        return (["name", "company", "email", "phone", "lists"] + (followUp.map { ["f:\($0.id)"] } ?? [])).map { ColumnPref(id: $0) }
    }

    private func onView(_ f: FieldDef) -> Bool {
        guard let listId = f.listId else { return true }
        if case let .list(accountId, id) = filter { return id == listId && accountId == f.accountId }
        return false
    }

    private var nameByFirst: Bool { prefs.nameSort == "first" }

    private var allColumns: [TableColumnDef] {
        let oneLine = { (s: String) in s.split(whereSeparator: \.isNewline).joined(separator: " ") }
        var cols: [TableColumnDef] = [
            TableColumnDef(id: "name", label: "Name", width: 220, kind: .name, value: { $0.displayName.isEmpty ? "No name" : $0.displayName },
                           sortKey: { c in nameByFirst ? "\(c.givenName) \(c.familyName)" : "\(c.familyName) \(c.givenName)" }),
            TableColumnDef(id: "first", label: "First name", width: 130, kind: .text, value: \.givenName),
            TableColumnDef(id: "last", label: "Last name", width: 140, kind: .text, value: \.familyName),
            TableColumnDef(id: "company", label: "Company", width: 180, kind: .text, value: \.organization),
            TableColumnDef(id: "title", label: "Job title", width: 160, kind: .text, value: \.title),
            TableColumnDef(id: "email", label: "Email", width: 230, kind: .text, value: \.email),
            TableColumnDef(id: "phone", label: "Phone", width: 175, kind: .text, numeric: true, value: \.phone),
            TableColumnDef(id: "address", label: "Address", width: 260, kind: .text, value: addressLine),
            TableColumnDef(id: "birthday", label: "Birthday", width: 140, kind: .text, value: { $0.birthday ?? "" }, sortKey: { $0.birthdayKey ?? "" }),
            TableColumnDef(id: "lists", label: "Lists", width: 180, kind: .lists, value: { c in
                store.lists(for: c.accountId).filter { c.groups.contains($0.id) }.map(\.name).joined(separator: ", ")
            }),
            TableColumnDef(id: "notes", label: "Notes", width: 260, kind: .text, value: { oneLine($0.notes ?? "") }),
        ]
        for f in store.fields where onView(f) {
            let w: CGFloat = f.type == "checkbox" ? 100 : f.type == "date" ? 130 : f.type == "longtext" ? 260 : 180
            cols.append(TableColumnDef(id: "f:\(f.id)", label: f.label, width: w, kind: .field(f), numeric: f.type == "date", value: { c in
                let v = c.fields[f.id] ?? ""
                if f.type == "checkbox" { return v == "1" ? "✓" : "" }
                if f.type == "date" { return Self.shortDay(v) }
                return oneLine(v)
            }, sortKey: { $0.fields[f.id] ?? "" }))
        }
        return cols
    }

    /// The columns you’ve chosen on the web, in your order and widths; Name always first.
    private var columns: [(def: TableColumnDef, width: CGFloat)] {
        let defs = Dictionary(allColumns.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var chosen = (prefs.columns ?? defaultColumns).compactMap { p in defs[p.id].map { d in (d, p.w.map { CGFloat($0) } ?? d.width) } }
        if chosen.isEmpty { chosen = defaultColumns.compactMap { p in defs[p.id].map { ($0, $0.width) } } }
        if let i = chosen.firstIndex(where: { $0.0.id == "name" }) {
            let n = chosen.remove(at: i)
            chosen.insert(n, at: 0)
        } else if let n = defs["name"] {
            chosen.insert((n, n.width), at: 0)
        }
        return chosen.map { (def: $0.0, width: $0.1) }
    }

    private var sort: SortPref { prefs.sort ?? SortPref(id: "name", dir: "asc") }

    private var rows: [ContactRow] {
        let defs = allColumns
        guard let def = defs.first(where: { $0.id == sort.id }) ?? defs.first else { return items }
        let key = def.sortKey ?? def.value
        let keyed = items.map { (c: $0, k: key($0), n: defs[0].sortKey?($0) ?? $0.displayName) }
        let desc = sort.dir == "desc"
        return keyed.sorted { a, b in
            // Blanks sink to the bottom whichever way you sort.
            if a.k.isEmpty != b.k.isEmpty { return !a.k.isEmpty }
            let r = a.k.localizedStandardCompare(b.k)
            if r != .orderedSame { return desc ? r == .orderedDescending : r == .orderedAscending }
            return a.n.localizedStandardCompare(b.n) == .orderedAscending
        }.map(\.c)
    }

    /// People shown together, as on the web: one block wherever the first of them sorts, with
    /// their photos stacked and one name, and a line each for the other columns. A list or
    /// search only shows the members it matches.
    private struct Entry: Identifiable {
        let members: [ContactRow]
        var id: String { members[0].id }
    }

    private var entries: [Entry] {
        let r = rows
        let groups = store.together
        guard !groups.isEmpty else { return r.map { Entry(members: [$0]) } }
        let shown = Set(r.map(\.id))
        var done = Set<String>()
        var out: [Entry] = []
        for c in r where !done.contains(c.id) {
            let members = (groups[c.id] ?? [c]).filter { shown.contains($0.id) }
            done.formUnion(members.map(\.id))
            out.append(Entry(members: members))
        }
        return out
    }

    private func setSort(_ id: String) {
        var p = prefs
        let s = sort
        p.sort = SortPref(id: id, dir: s.id == id && s.dir == "asc" ? "desc" : "asc")
        Task { await store.saveViewPrefs(key, p) }
    }

    // MARK: Body

    /// Lines have a fixed height, so a letter’s row is found by count and scrolled to directly,
    /// leaving the sideways scroll where it is.
    private func jump(to l: String) {
        guard let scroll = scrollBox.view, let nameKey = allColumns.first?.sortKey else { return }
        let es = entries
        guard let i = AlphaIndex.target(es.map { AlphaIndex.letter(nameKey($0.members[0])) }, pick: l, descending: sort.dir == "desc") else { return }
        let lines = es[..<i].reduce(0) { $0 + $1.members.count }
        let maxY = max(-scroll.adjustedContentInset.top, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
        let y = min(maxY, max(-scroll.adjustedContentInset.top, CGFloat(lines) * rowHeight - scroll.adjustedContentInset.top))
        scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: y), animated: false)
    }

    var body: some View {
        let cols = columns
        ScrollView([.horizontal, .vertical]) {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                Section {
                    ForEach(entries) { e in row(e, cols) }
                } header: {
                    header(cols)
                }
            }
            // No stretching past the edges, and one direction at a time.
            .background(ScrollTuner(bounces: false, directionalLock: true) { scrollBox.view = $0 })
        }
        .overlay(alignment: .trailing) {
            // A–Z down the side while sorted by name, as in Contacts.
            if sort.id == "name", rows.count >= 12 {
                AlphabetScrubber(available: Set(entries.compactMap { e in allColumns.first?.sortKey.map { AlphaIndex.letter($0(e.members[0])) } })) { l in jump(to: l) }
                    .padding(.top, 36)
                    .padding(.bottom, 12)
            }
        }
        .onScrollGeometryChange(for: CGFloat.self) { g in g.contentOffset.x + g.contentInsets.leading } action: { _, x in
            scrollX = max(0, x)
        }
        .sheet(item: $picking) { ref in datePicker(ref) }
        .sheet(item: $listsFor) { c in ListPickerView(ids: [c.id], accountId: c.accountId) }
        .sheet(isPresented: showColumns) {
            ColumnsSheet(choices: allColumns.map { ColumnsSheet.Choice(id: $0.id, label: $0.label) },
                         shown: columns.map { col in ColumnPref(id: col.def.id, w: prefs.columns?.first { $0.id == col.def.id }?.w) }) { cols in
                var p = prefs
                p.columns = cols
                Task { await store.saveViewPrefs(key, p) }
            }
        }
        .onChange(of: focused) { _, isFocused in if !isFocused { commit() } }
    }

    private var avatarSize: CGFloat { max(28, photoSize * 0.85) }
    /// The photos are the one column that stays put while you scroll sideways.
    private var photoColumn: CGFloat { avatarSize + 20 + (selecting ? checkWidth : 0) }
    /// While selecting, the ticks sit left of the photos, as in the list.
    private let checkWidth: CGFloat = 38
    private func width(_ i: Int, _ w: CGFloat) -> CGFloat { i == 0 ? max(100, w - 36) : w }

    private func header(_ cols: [(def: TableColumnDef, width: CGFloat)]) -> some View {
        HStack(spacing: 0) {
            Theme.card
                .frame(width: photoColumn, height: 30)
                .offset(x: scrollX)
                .zIndex(1)
            ForEach(Array(cols.enumerated()), id: \.element.def.id) { i, col in
                Button { setSort(col.def.id) } label: {
                    HStack(spacing: 3) {
                        Text(col.def.label).lineLimit(1)
                        if sort.id == col.def.id {
                            Image(systemName: sort.dir == "desc" ? "chevron.down" : "chevron.up").font(.app(.caption2, .bold))
                        }
                        Spacer(minLength: 0)
                    }
                    .font(.app(.caption, .semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 10)
                    .frame(width: width(i, col.width), height: 30, alignment: .leading)
                    .background(Theme.card)
                }
                .buttonStyle(.plain)
            }
        }
        .background(Theme.card)
        .overlay(alignment: .bottom) { Divider() }
    }

    /// One person’s row, or a block for people shown together (ticked and opened as one).
    private func row(_ e: Entry, _ cols: [(def: TableColumnDef, width: CGFloat)]) -> some View {
        let lead = e.members[0]
        let ids = e.members.map(\.id)
        let name = e.members.count > 1 ? Together.name(e.members) : lead.displayName
        let height = rowHeight * CGFloat(e.members.count)
        let ticked = selecting && ids.allSatisfy { selection.contains($0) }
        let ground = ticked ? Theme.selected : Theme.card
        return HStack(alignment: .top, spacing: 0) {
            Button { open(lead.id) } label: {
                HStack(spacing: 0) {
                    if selecting {
                        Image(systemName: ticked ? "checkmark.circle.fill" : "circle")
                            .font(.app(.title2))
                            .foregroundStyle(ticked ? Color.accentColor : Color.secondary)
                            .frame(width: checkWidth, alignment: .trailing)
                            .transition(.move(edge: .leading).combined(with: .opacity))
                    }
                    // Stacked down the column, so a pair is no wider than one person.
                    VStack(spacing: 4) {
                        ForEach(e.members) { m in
                            Avatar(url: m.photoUrl, initials: m.initials, size: avatarSize)
                                .overlay {
                                    if m.isDraft {
                                        Circle().strokeBorder(Theme.brand, style: StrokeStyle(lineWidth: 1.5, dash: [3, 2.5])).padding(-3)
                                    }
                                }
                        }
                    }
                    .frame(maxWidth: .infinity)
                }
                .frame(width: photoColumn, height: height)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .gesture(HoldToSelect(enabled: !selecting) {
                startSelecting(lead.id)
                selection.formUnion(ids)
            })
            .background(ground)
            .offset(x: scrollX)
            .zIndex(1)
            .accessibilityLabel("Open \(name)")
            if let first = cols.first {
                nameCell(e.members, name, lines: max(1, Int((height - 12) / 19)))
                    .frame(width: width(0, first.width), height: height, alignment: .leading)
                    .background(ground)
            }
            VStack(spacing: 0) {
                ForEach(e.members) { m in
                    HStack(spacing: 0) {
                        ForEach(Array(cols.enumerated()).dropFirst(), id: \.element.def.id) { i, col in
                            cell(m, col.def)
                                .frame(width: width(i, col.width), height: rowHeight, alignment: .leading)
                                .background(ground)
                        }
                    }
                }
            }
        }
        // While selecting, a tap anywhere on the row ticks it instead of opening or editing.
        .overlay {
            if selecting {
                Button {
                    if ticked { selection.subtract(ids) } else { selection.formUnion(ids) }
                } label: {
                    Color.clear.contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .zIndex(2)
                .accessibilityLabel(name)
                .accessibilityAddTraits(ticked ? [.isButton, .isSelected] : .isButton)
            }
        }
        .overlay(alignment: .bottom) { Divider() }
    }

    private func nameCell(_ members: [ContactRow], _ name: String, lines: Int) -> some View {
        let draft = members.contains { $0.isDraft }
        return Button { open(members[0].id) } label: {
            HStack(spacing: 8) {
                Text(name.isEmpty ? "No name" : name).fontWeight(.medium).italic(draft).lineLimit(lines)
                if draft { DraftTag() }
                Spacer(minLength: 0)
            }
            .padding(.trailing, 10)
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func cell(_ c: ContactRow, _ def: TableColumnDef) -> some View {
        switch def.kind {
        case .name:
            nameCell([c], def.value(c), lines: textLines)
        case .lists:
            Button { listsFor = c } label: {
                HStack(spacing: 4) {
                    ForEach(store.lists(for: c.accountId).filter { c.groups.contains($0.id) && $0.id != "contactGroups/myContacts" }) { l in
                        ListBadge(name: l.name, style: store.style(ListRef(accountId: c.accountId, id: l.id)))
                    }
                }
                .padding(.horizontal, 10)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .clipped()
                .contentShape(Rectangle())
                .accessibilityLabel(def.value(c))
            }
            .buttonStyle(.plain)
        case let .field(f):
            fieldCell(c, f, def)
        case .text:
            Button { open(c.id) } label: { textCell(def.value(c), numeric: def.numeric) }
                .buttonStyle(.plain)
        }
    }

    private func textCell(_ v: String, numeric: Bool) -> some View {
        Text(v)
            .font(numeric ? .app(.subheadline).monospacedDigit() : .app(.subheadline))
            .lineLimit(textLines)
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .contentShape(Rectangle())
    }

    // MARK: Editing your fields in place

    @ViewBuilder
    private func fieldCell(_ c: ContactRow, _ f: FieldDef, _ def: TableColumnDef) -> some View {
        let ref = CellRef(contactId: c.id, fieldId: f.id)
        if editing == ref {
            TextField(f.label, text: $text, axis: f.type == "longtext" ? .vertical : .horizontal)
                .font(.app(.subheadline))
                .lineLimit(1...3)
                .keyboardType(f.type == "url" ? .URL : .default)
                .textInputAutocapitalization(f.type == "url" || f.key == "signal_username" ? .never : .sentences)
                .autocorrectionDisabled(f.type == "url" || f.key == "signal_username")
                .focused($focused)
                .submitLabel(.done)
                .onSubmit { commit() }
                .padding(.horizontal, 10)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                .overlay { Rectangle().strokeBorder(Color.accentColor, lineWidth: 2) }
        } else {
            Button {
                commit()
                switch f.type {
                case "checkbox":
                    let on = c.fields[f.id] == "1"
                    Task { await store.saveField(c.id, fieldId: f.id, value: on ? "" : "1") }
                case "date":
                    pickedDate = FieldEditor.day.date(from: c.fields[f.id] ?? "") ?? Date()
                    picking = ref
                default:
                    text = c.fields[f.id] ?? ""
                    editing = ref
                    DispatchQueue.main.async { focused = true }
                }
            } label: {
                textCell(def.value(c), numeric: def.numeric)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(f.label): \(def.value(c).isEmpty ? "empty" : def.value(c))")
            .accessibilityHint("Edit")
        }
    }

    private func commit() {
        guard let ref = editing else { return }
        editing = nil
        let value = text
        let old = store.contacts.first { $0.id == ref.contactId }?.fields[ref.fieldId] ?? ""
        guard value != old else { return }
        Task { await store.saveField(ref.contactId, fieldId: ref.fieldId, value: value) }
    }

    private func datePicker(_ ref: CellRef) -> some View {
        let label = store.fields.first { $0.id == ref.fieldId }?.label ?? "Date"
        return NavigationStack {
            DatePicker(label, selection: $pickedDate, displayedComponents: .date)
                .datePickerStyle(.graphical)
                .padding()
                .navigationTitle(label)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Clear") {
                            Task { await store.saveField(ref.contactId, fieldId: ref.fieldId, value: "") }
                            picking = nil
                        }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") {
                            Task { await store.saveField(ref.contactId, fieldId: ref.fieldId, value: FieldEditor.day.string(from: pickedDate)) }
                            picking = nil
                        }
                        .bold()
                    }
                }
        }
        .presentationDetents([.medium])
    }

    // MARK: Values

    /// The first address, with the neighborhood (if you’ve filled it in) before the city.
    private func addressLine(_ c: ContactRow) -> String {
        let hoodId = store.fields.first { $0.key == "neighborhood" }?.id
        let hood = hoodId.flatMap { c.fields[$0] }?.trimmingCharacters(in: .whitespaces) ?? ""
        guard let p = c.addressParts, p.hood, !hood.isEmpty else { return c.address ?? "" }
        let cityRest = [p.city, p.rest].filter { !$0.isEmpty }.joined(separator: ", ")
        let city = [hood, cityRest].filter { !$0.isEmpty }.joined(separator: ", ")
        return [p.street, city, p.country].filter { !$0.isEmpty }.joined(separator: ", ")
    }

    /// “Oct 14”, with the year only when it isn’t this year.
    static func shortDay(_ iso: String) -> String {
        guard let d = FieldEditor.day.date(from: iso) else { return iso }
        let sameYear = Calendar.current.component(.year, from: d) == Calendar.current.component(.year, from: Date())
        return d.formatted(sameYear ? .dateTime.month(.abbreviated).day() : .dateTime.month(.abbreviated).day().year())
    }
}

/// Lets the table’s name cells be where a contact card grows from (and shrinks back to).
private struct ZoomSourceKey: EnvironmentKey { static let defaultValue: Namespace.ID? = nil }
extension EnvironmentValues {
    var cardZoomNamespace: Namespace.ID? {
        get { self[ZoomSourceKey.self] }
        set { self[ZoomSourceKey.self] = newValue }
    }
}

private struct ZoomSource: ViewModifier {
    let id: String
    @Environment(\.cardZoomNamespace) private var ns
    func body(content: Content) -> some View {
        if let ns { content.matchedTransitionSource(id: id, in: ns) } else { content }
    }
}

extension View {
    func matchedTransitionSourceIfAvailable(id: String) -> some View { modifier(ZoomSource(id: id)) }
}

/// Reaches the UIKit scroll view behind a SwiftUI one, for what SwiftUI doesn’t offer:
/// turning off the stretch at the edges and locking a drag to one direction.
struct ScrollTuner: UIViewRepresentable {
    var bounces: Bool
    var directionalLock: Bool
    /// Hands over the scroll view, for scrolling it directly.
    var found: (UIScrollView) -> Void = { _ in }

    func makeUIView(context: Context) -> TunerView {
        let v = TunerView(bounces: bounces, directionalLock: directionalLock)
        v.found = found
        return v
    }
    func updateUIView(_ view: TunerView, context: Context) { view.apply() }

    final class TunerView: UIView {
        let bounces: Bool
        let directionalLock: Bool
        var found: (UIScrollView) -> Void = { _ in }

        init(bounces: Bool, directionalLock: Bool) {
            self.bounces = bounces
            self.directionalLock = directionalLock
            super.init(frame: .zero)
            isUserInteractionEnabled = false
        }

        required init?(coder: NSCoder) { fatalError() }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            apply()
        }

        func apply() {
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                var v: UIView? = self.superview
                while let view = v, !(view is UIScrollView) { v = view.superview }
                guard let scroll = v as? UIScrollView else { return }
                scroll.bounces = self.bounces
                scroll.alwaysBounceVertical = false
                scroll.alwaysBounceHorizontal = false
                scroll.isDirectionalLockEnabled = self.directionalLock
                self.found(scroll)
            }
        }
    }
}

/// Which columns the table shows for this view, and in what order. Name always comes first.
/// Saved as you go, shared with the web.
struct ColumnsSheet: View {
    struct Choice: Identifiable {
        let id: String
        let label: String
    }

    let choices: [Choice]
    @State var shown: [ColumnPref]
    let save: ([ColumnPref]) -> Void
    @Environment(\.dismiss) private var dismiss

    private func label(_ id: String) -> String { choices.first { $0.id == id }?.label ?? id }
    private var hidden: [Choice] { choices.filter { c in !shown.contains { $0.id == c.id } } }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(shown, id: \.id) { c in
                        Text(label(c.id))
                            .moveDisabled(c.id == "name")
                            .deleteDisabled(c.id == "name")
                    }
                    .onMove { from, to in
                        shown.move(fromOffsets: from, toOffset: to)
                        // Name stays first.
                        if let i = shown.firstIndex(where: { $0.id == "name" }), i != 0 { shown.insert(shown.remove(at: i), at: 0) }
                        save(shown)
                    }
                    .onDelete { at in
                        shown.remove(atOffsets: at)
                        save(shown)
                    }
                } header: {
                    Text("Shown")
                } footer: {
                    Text("For this view only. Drag to reorder.")
                }
                if !hidden.isEmpty {
                    Section("Hidden") {
                        ForEach(hidden) { c in
                            Button {
                                shown.append(ColumnPref(id: c.id))
                                save(shown)
                            } label: {
                                Label {
                                    Text(c.label).foregroundStyle(Theme.ink)
                                } icon: {
                                    Image(systemName: "plus.circle.fill").foregroundStyle(.green)
                                }
                            }
                        }
                    }
                }
            }
            .environment(\.editMode, .constant(.active))
            .navigationTitle("Columns")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.bold() } }
        }
        .presentationDetents([.medium, .large])
    }
}
