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
    /// Whose card is open, to mark their photo.
    var current: String? = nil
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
    @State private var colDrag: ColumnDrag?
    /// A heading held and let go without moving: its menu.
    @State private var columnMenu: TableColumnDef?
    @State private var editingField: FieldsView.FieldTarget?
    @State private var deletingField: FieldDef?

    /// A column heading held and being dragged sideways.
    struct ColumnDrag {
        let id: String
        /// The columns’ order as it stands, the held one in its current slot.
        var order: [String]
        /// Where the held column started, from the table’s left, and the sideways scroll then.
        let startLeft: CGFloat
        let startScroll: CGFloat
        var dx: CGFloat = 0
        /// The finger, across the window (for scrolling at the edges).
        var fingerX: CGFloat = 0
        /// Dragged at all; if not, letting go opens the column’s menu.
        var moved = false
    }

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

    /// The list you’re viewing, if any: where a new field starts out.
    private var viewedList: ListRef? {
        if case let .list(accountId, id) = filter, id != "contactGroups/myContacts" { return ListRef(accountId: accountId, id: id) }
        return nil
    }

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

    /// People shown together sit next to each other wherever the first of them sorts, each in
    /// their own row, with a “+” between them. A list or search only shows the members it matches.
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

    /// The columns as shown: while one is being dragged, in the order it’s making.
    private var shownColumns: [(def: TableColumnDef, width: CGFloat)] {
        let cols = columns
        guard let d = colDrag else { return cols }
        return d.order.compactMap { id in cols.first { $0.def.id == id } }
    }

    var body: some View {
        let cols = shownColumns
        ScrollView([.horizontal, .vertical]) {
            LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                Section {
                    ForEach(entries) { e in
                        ForEach(Array(e.members.enumerated()), id: \.element.id) { j, m in
                            row(m, above: j > 0, below: j < e.members.count - 1, cols)
                        }
                    }
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
        .confirmationDialog(columnMenu?.label ?? "", isPresented: Binding(get: { columnMenu != nil }, set: { if !$0 { columnMenu = nil } }),
                            titleVisibility: .visible, presenting: columnMenu) { def in
            Button("Hide Column") { hideColumn(def.id) }
            if case let .field(f) = def.kind {
                Button("Edit Field") { editingField = FieldsView.FieldTarget(field: f) }
                if f.key == nil {
                    Button("Delete Field", role: .destructive) { deletingField = f }
                }
            }
            Button("Columns & Fields…") { showColumns.wrappedValue = true }
        }
        .confirmationDialog("Delete “\(deletingField?.label ?? "")”?", isPresented: Binding(get: { deletingField != nil }, set: { if !$0 { deletingField = nil } }),
                            titleVisibility: .visible, presenting: deletingField) { f in
            Button("Delete Field", role: .destructive) { Task { await store.deleteField(f) } }
        } message: { _ in
            Text("Its values on every contact are deleted too. This can’t be undone.")
        }
        .sheet(item: $editingField) { t in FieldForm(field: t.field) }
        .sheet(isPresented: showColumns) {
            ColumnsSheet(choices: allColumns.map { d -> ColumnsSheet.Choice in
                             var field: FieldDef?
                             if case let .field(f) = d.kind { field = f }
                             return ColumnsSheet.Choice(id: d.id, label: d.label, field: field)
                         },
                         shown: columns.map { col in ColumnPref(id: col.def.id, w: prefs.columns?.first { $0.id == col.def.id }?.w) },
                         startList: viewedList, onView: onView) { cols in
                var p = prefs
                p.columns = cols
                Task { await store.saveViewPrefs(key, p) }
            }
        }
        .onChange(of: focused) { _, isFocused in if !isFocused { commit() } }
    }

    // MARK: Moving columns

    /// The sideways scroll, read straight from the scroll view while it’s moving under a drag.
    private var scrollNow: CGFloat {
        guard let v = scrollBox.view else { return scrollX }
        return v.contentOffset.x + v.adjustedContentInset.left
    }

    /// Where a column starts, from the left of the first column.
    private func left(_ id: String, _ cols: [(def: TableColumnDef, width: CGFloat)]) -> CGFloat {
        var x: CGFloat = 0
        for (i, c) in cols.enumerated() {
            if c.def.id == id { return x }
            x += width(i, c.width)
        }
        return x
    }

    /// The held column follows the finger (and the scroll); the rest sit in their slots.
    private func heldOffset(_ id: String, _ cols: [(def: TableColumnDef, width: CGFloat)]) -> CGFloat {
        guard let d = colDrag, d.id == id else { return 0 }
        return d.startLeft + d.dx + (scrollX - d.startScroll) - left(id, cols)
    }

    private func startColumnDrag(_ id: String, _ cols: [(def: TableColumnDef, width: CGFloat)]) {
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        withAnimation(.snappy(duration: 0.18)) {
            colDrag = ColumnDrag(id: id, order: cols.map(\.def.id), startLeft: left(id, cols), startScroll: scrollNow)
        }
        Task { await autoScrollColumns() }
    }

    private func dragColumn(_ dx: CGFloat) {
        colDrag?.dx = dx
        if abs(dx) > 8 { colDrag?.moved = true }
        reflowColumns()
    }

    /// The others make room once the held column’s middle passes theirs.
    private func reflowColumns() {
        guard var d = colDrag else { return }
        let cols = columns
        let widthOf = { (id: String) -> CGFloat in
            guard let i = d.order.firstIndex(of: id), let c = cols.first(where: { $0.def.id == id }) else { return 0 }
            return width(i, c.width)
        }
        let middle = d.startLeft + d.dx + (scrollNow - d.startScroll) + widthOf(d.id) / 2
        let others = d.order.filter { $0 != d.id }
        var slot = others.count
        var x: CGFloat = 0
        for (j, o) in others.enumerated() {
            let w = widthOf(o)
            if j > 0, middle < x + w / 2 {
                slot = j
                break
            }
            x += w
        }
        var order = others
        order.insert(d.id, at: slot)
        guard order != d.order else { return }
        UISelectionFeedbackGenerator().selectionChanged()
        withAnimation(.snappy(duration: 0.2)) {
            d.order = order
            colDrag = d
        }
    }

    private func hideColumn(_ id: String) {
        var p = prefs
        let widths = p.columns ?? []
        p.columns = columns.map(\.def.id).filter { $0 != id }.map { c in ColumnPref(id: c, w: widths.first { $0.id == c }?.w) }
        Task { await store.saveViewPrefs(key, p) }
    }

    private func endColumnDrag() {
        guard let d = colDrag else { return }
        let changed = d.order != columns.map(\.def.id)
        withAnimation(.snappy(duration: 0.2)) { colDrag = nil }
        if !d.moved, !changed {
            columnMenu = allColumns.first { $0.id == d.id }
            return
        }
        guard changed else { return }
        var p = prefs
        let widths = p.columns ?? []
        p.columns = d.order.map { id in ColumnPref(id: id, w: widths.first { $0.id == id }?.w) }
        Task { await store.saveViewPrefs(key, p) }
    }

    /// Holding a column near either edge scrolls the table that way.
    private func autoScrollColumns() async {
        while colDrag != nil {
            if let v = scrollBox.view, let d = colDrag, let w = v.window?.bounds.width {
                let edge: CGFloat = 44
                var step: CGFloat = 0
                if d.fingerX < photoColumn + edge { step = -min(14, max(3, (photoColumn + edge - d.fingerX) / 3)) }
                else if d.fingerX > w - edge { step = min(14, max(3, (d.fingerX - (w - edge)) / 3)) }
                if step != 0 {
                    let minX = -v.adjustedContentInset.left
                    let maxX = max(minX, v.contentSize.width - v.bounds.width + v.adjustedContentInset.right)
                    let x = min(maxX, max(minX, v.contentOffset.x + step))
                    if x != v.contentOffset.x {
                        v.setContentOffset(CGPoint(x: x, y: v.contentOffset.y), animated: false)
                        colDrag?.moved = true
                        reflowColumns()
                    }
                }
            }
            try? await Task.sleep(for: .milliseconds(16))
        }
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
                let held = colDrag?.id == col.def.id
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
                    .background(held ? Theme.selected : Theme.card)
                }
                .buttonStyle(.plain)
                // Press and hold a heading, then drag it sideways to move the column. Name stays first.
                .gesture(HoldToDrag(
                    enabled: col.def.id != "name" && !selecting,
                    began: { startColumnDrag(col.def.id, cols) },
                    changed: { dx in dragColumn(dx) },
                    ended: { endColumnDrag() },
                    at: { x in colDrag?.fingerX = x }
                ))
                .shadow(color: .black.opacity(held ? 0.18 : 0), radius: 6, y: 2)
                .offset(x: heldOffset(col.def.id, cols))
                .zIndex(held ? 0.5 : 0)
            }
            // After the last column: add a column, or make a new field for one.
            Button { showColumns.wrappedValue = true } label: {
                Image(systemName: "plus")
                    .font(.app(.footnote, .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 44, height: 30)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Add a Column")
        }
        .background(Theme.card)
        .overlay(alignment: .bottom) { Divider() }
    }

    /// One person’s row. `above`/`below`: shown together with the person in the next row up/down.
    private func row(_ c: ContactRow, above: Bool, below: Bool, _ cols: [(def: TableColumnDef, width: CGFloat)]) -> some View {
        let ticked = selecting && selection.contains(c.id)
        let ground = ticked ? Theme.selected : Theme.card
        return HStack(spacing: 0) {
            HStack(spacing: 0) {
                // While selecting, only the tick selects; the photo still opens (or switches) the card.
                if selecting {
                    Button {
                        if ticked { selection.remove(c.id) } else { selection.insert(c.id) }
                    } label: {
                        Image(systemName: ticked ? "checkmark.circle.fill" : "circle")
                            .font(.app(.title2))
                            .foregroundStyle(ticked ? Color.accentColor : Color.secondary)
                            .frame(width: checkWidth, height: rowHeight, alignment: .trailing)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .transition(.move(edge: .leading).combined(with: .opacity))
                    .accessibilityLabel("Select \(c.displayName)")
                    .accessibilityAddTraits(ticked ? .isSelected : [])
                }
                Button { open(c.id) } label: {
                    Avatar(url: c.photoUrl, initials: c.initials, size: avatarSize)
                        .overlay {
                            if c.isDraft {
                                Circle().strokeBorder(Theme.brand, style: StrokeStyle(lineWidth: 1.5, dash: [3, 2.5])).padding(-3)
                            }
                        }
                        .overlay { if current == c.id { Circle().strokeBorder(Color.accentColor, lineWidth: 2.5).padding(-4) } }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .gesture(HoldToSelect(enabled: !selecting) { startSelecting(c.id) })
                .accessibilityLabel("Open \(c.displayName)")
            }
            .frame(width: photoColumn, height: rowHeight)
            .background(ground)
            // The “+” sits on the join; both rows draw it, so it’s whole whichever row is on top.
            .overlay(alignment: .bottomTrailing) { if below { pairPlus.offset(y: PairPlus.size / 2) } }
            .overlay(alignment: .topTrailing) { if above { pairPlus.offset(y: -PairPlus.size / 2) } }
            .offset(x: scrollX)
            .zIndex(1)
            ForEach(Array(cols.enumerated()), id: \.element.def.id) { i, col in
                cell(c, col.def)
                    .frame(width: width(i, col.width), height: rowHeight, alignment: .leading)
                    .background(colDrag?.id == col.def.id ? Theme.selected : ground)
                    .offset(x: heldOffset(col.def.id, cols))
                    .zIndex(colDrag?.id == col.def.id ? 0.5 : 0)
            }
        }
        // Only the tick selects; the rest of the row works as usual while selecting.
        .overlay(alignment: .bottom) { if !below { Divider() } }
    }

    /// Centred under the photo, which sits in the photo column’s last `avatarSize + 20`.
    private var pairPlus: some View {
        PairPlus().frame(width: avatarSize + 20)
    }

    @ViewBuilder
    private func cell(_ c: ContactRow, _ def: TableColumnDef) -> some View {
        switch def.kind {
        case .name:
            Button { open(c.id) } label: {
                HStack(spacing: 8) {
                    Text(def.value(c)).fontWeight(.medium).italic(c.isDraft).lineLimit(textLines)
                    if c.isDraft { DraftTag() }
                    Spacer(minLength: 0)
                }
                .padding(.trailing, 10)
                .frame(maxHeight: .infinity)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
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
/// The table’s columns for this view, and your fields: show, hide and reorder columns; add a
/// field (it shows as a column straight away); tap one of your fields to rename, retype or delete it.
struct ColumnsSheet: View {
    struct Choice: Identifiable {
        let id: String
        let label: String
        var field: FieldDef?
    }

    let choices: [Choice]
    @State var shown: [ColumnPref]
    /// Who a new field is on to start with.
    var startList: ListRef?
    /// Whether a field shows as a column in this view.
    var onView: (FieldDef) -> Bool = { _ in true }
    let save: ([ColumnPref]) -> Void
    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var editing: FieldsView.FieldTarget?

    private func choice(_ id: String) -> Choice? { choices.first { $0.id == id } }
    private var hidden: [Choice] { choices.filter { c in !shown.contains { $0.id == c.id } } }
    /// A list’s own fields, while viewing somewhere else: edited here, not shown as columns.
    private var elsewhere: [FieldDef] { store.fields.filter { !onView($0) } }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button { editing = FieldsView.FieldTarget(field: nil) } label: { Label("New Field", systemImage: "plus") }
                } footer: {
                    Text("Your fields are kept only in Ligatures. They never sync to Google, your iPhone or your Mac.")
                }
                Section {
                    ForEach(shown, id: \.id) { c in
                        row(c.id, label: choice(c.id)?.label ?? c.id, field: choice(c.id)?.field)
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
                            HStack {
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
                                .buttonStyle(.borderless)
                                Spacer(minLength: 0)
                                if let f = c.field { editButton(f) }
                            }
                        }
                    }
                }
                if !elsewhere.isEmpty {
                    Section("Fields for Other Lists") {
                        ForEach(elsewhere) { f in row("f:\(f.id)", label: f.label, field: f) }
                    }
                }
            }
            .environment(\.editMode, .constant(.active))
            .navigationTitle("Columns")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.bold() } }
            .sheet(item: $editing) { t in
                FieldForm(field: t.field, startList: startList) { f in
                    // A new field shows as a column straight away, if it applies here.
                    guard onView(f), !shown.contains(where: { $0.id == "f:\(f.id)" }) else { return }
                    shown.append(ColumnPref(id: "f:\(f.id)"))
                    save(shown)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .storeAlert()
    }

    private func row(_ id: String, label: String, field: FieldDef?) -> some View {
        HStack {
            Text(label)
            Spacer(minLength: 0)
            if let field { editButton(field) }
        }
    }

    /// One of your fields: its type, and a tap to change it.
    private func editButton(_ f: FieldDef) -> some View {
        Button { editing = FieldsView.FieldTarget(field: f) } label: {
            HStack(spacing: 6) {
                Text(f.key != nil ? "Built in" : FieldType(rawValue: f.type)?.title ?? f.type)
                Image(systemName: "info.circle")
            }
            .font(.app(.subheadline))
            .foregroundStyle(.secondary)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel("Edit \(f.label)")
    }
}
