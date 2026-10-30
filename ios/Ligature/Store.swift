import Foundation
import Observation
import SwiftUI

enum Phase { case loading, signedOut, ready }

/// Everything the app shows, plus every change it makes. Changes go to the server (and so to
/// Google) first; the local copy is updated from what comes back.
@MainActor
@Observable
final class Store {
    static let defaultServer = "https://ligature-50o.pages.dev"

    var phase: Phase = .loading
    var accounts: [Account] = []
    var fields: [FieldDef] = []
    var contacts: [ContactRow] = []
    var relationships: [Relationship] = []
    /// Archived contacts: out of Google, kept here to restore.
    var archived: [ContactRow] = []
    var mapPoints: [MapPoint] = []
    var mapFailed: Set<String> = []
    var mapPending = 0
    var mapLoaded = false
    var mapStalled = false
    var pins: [Pin] = []
    @ObservationIgnored private var lookingUp = false
    var details: [String: ContactDetail] = [:]
    /// Lists shown as tabs above the contacts, in order.
    var pinned: [ListRef] = []
    var listParents: [ListParent] = []
    var listStyles: [ListStyle] = []
    /// The table’s setup per view, shared with the web (prefs.views), and the older single setup.
    var viewPrefs: [String: ViewPrefs] = [:]
    var legacyView = ViewPrefs()
    /// Your order for all lists (pinned ones are ordered by `pinned`).
    var listOrder: [ListRef] = []
    var syncing = false
    /// Where places open: Apple or Google Maps. Kept on this iPhone too, so it’s known before the
    /// account loads.
    var mapsApp: MapsApp = MapsApp(rawValue: UserDefaults.standard.string(forKey: "mapsApp") ?? "") ?? .apple {
        didSet { UserDefaults.standard.set(mapsApp.rawValue, forKey: "mapsApp") }
    }
    var lastSynced: Date?

    var showAlert = false
    var alertTitle = ""
    var alertMessage = ""

    /// Demo mode: made-up contacts kept only on this iPhone, nothing sent to the server or Google.
    /// Turned on in Settings, or by launching with `-demo` (screenshots and UI tests).
    private(set) var demo = ProcessInfo.processInfo.arguments.contains("-demo") || UserDefaults.standard.bool(forKey: "demo")
    /// Screens the demo build opens straight into, for screenshots.
    let demoScreen: String? = {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-screen"), i + 1 < args.count else { return nil }
        return args[i + 1]
    }()

    @ObservationIgnored private var api: API
    @ObservationIgnored private var syncSoonTask: Task<Void, Never>?
    @ObservationIgnored private var syncAgain = false

    var server: String {
        didSet { UserDefaults.standard.set(server, forKey: "server") }
    }

    init() {
        let saved = UserDefaults.standard.string(forKey: "server") ?? Store.defaultServer
        server = saved
        api = API(baseURL: URL(string: saved) ?? URL(string: Store.defaultServer)!, token: Keychain.read("session"))
    }

    // MARK: - Start, sign in, sign out

    func boot() async {
        if demo {
            loadDemo()
            phase = demoScreen == "signin" ? .signedOut : .ready
            return
        }
        guard api.token != nil else {
            phase = .signedOut
            return
        }
        if loadCache() { phase = .ready }
        await refresh(sync: false)
        await checkIfStale(60)
    }

    /// Switch between the demo and your own contacts. Your contacts come back from the cache
    /// and the server, as at launch.
    func setDemo(_ on: Bool) async {
        guard on != demo else { return }
        UserDefaults.standard.set(on, forKey: "demo")
        syncSoonTask?.cancel()
        demo = on
        accounts = []
        fields = []
        contacts = []
        details = [:]
        relationships = []
        archived = []
        mapPoints = []
        mapFailed = []
        mapLoaded = false
        pins = []
        pinned = []
        listOrder = []
        listParents = []
        listStyles = []
        viewPrefs = [:]
        legacyView = ViewPrefs()
        lastSynced = nil
        phase = .loading
        await boot()
    }

    // MARK: - Staying current
    // Edits go to Google as you make them. After one, the app also checks Google for anything
    // changed elsewhere, so “Last synced” means “current as of”. It checks again when you come
    // back to the app after a minute away, and every five minutes while it’s open.

    /// One background check after a burst of edits.
    func syncSoon() {
        guard !demo else { return }
        syncSoonTask?.cancel()
        syncSoonTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard let self, !Task.isCancelled else { return }
            if self.syncing { self.syncAgain = true } else { await self.refresh(sync: true, quiet: true) }
        }
    }

    func checkIfStale(_ maxAge: TimeInterval) async {
        guard !demo, phase == .ready, !syncing, !accounts.isEmpty else { return }
        let last = accounts.compactMap(\.lastSyncedAt).max().map { Date(timeIntervalSince1970: $0 / 1000) }
        if last == nil || Date().timeIntervalSince(last!) > maxAge { await refresh(sync: true, quiet: true) }
    }

    /// The address the browser opens to sign in, with this attempt’s challenge.
    func signInURL(_ pkce: PKCE) -> URL? {
        guard let base = URL(string: server) else { return nil }
        var c = URLComponents(url: base.appendingPathComponent("api/auth/google/start"), resolvingAgainstBaseURL: false)
        c?.queryItems = [URLQueryItem(name: "app", value: "1"), URLQueryItem(name: "challenge", value: pkce.challenge)]
        return c?.url
    }

    /// Finish sign-in with what the browser handed back (ligature://auth?code=…).
    func completeSignIn(callback: URL, pkce: PKCE) async throws {
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        if let error = items.first(where: { $0.name == "error" })?.value {
            throw APIError(status: 0, message: error, code: nil, contact: nil)
        }
        guard let code = items.first(where: { $0.name == "code" })?.value else {
            throw APIError(status: 0, message: "Sign-in didn’t finish. Try again.", code: nil, contact: nil)
        }
        api = API(baseURL: URL(string: server) ?? URL(string: Store.defaultServer)!, token: nil)
        struct TokenResponse: Decodable { let token: String }
        let r: TokenResponse = try await api.post("/auth/app/token", ["code": code, "verifier": pkce.verifier])
        Keychain.write("session", r.token)
        api.token = r.token
        phase = .loading
        await refresh(sync: true)
    }

    func signOut() async {
        if !demo { let _: Empty? = try? await api.post("/auth/logout", [:]) }
        Keychain.delete("session")
        api.token = nil
        accounts = []
        fields = []
        pinned = []
        listOrder = []
        contacts = []
        details = [:]
        clearCache()
        phase = .signedOut
    }

    // MARK: - Loading

    /// Reload the session and contacts; with `sync`, pull changes from Google first.
    /// `quiet`: a background check, so being offline isn’t worth an alert.
    func refresh(sync: Bool, quiet: Bool = false) async {
        if demo { return }
        defer {
            if sync, syncAgain {
                syncAgain = false
                syncSoon()
            }
        }
        do {
            if sync {
                syncing = true
                defer { syncing = false }
                struct SyncResponse: Decodable {
                    struct Result: Decodable { let error: String?; let code: String? }
                    let results: [Result]
                }
                let r: SyncResponse = try await api.post("/sync", [:])
                if demo { return }
                if let failed = r.results.first(where: { $0.error != nil }) {
                    if failed.code == "reauth" {
                        alert("Sign in again", "Google access expired. Sign out and back in to keep syncing.")
                    } else {
                        alert("Couldn’t sync", failed.error ?? "Sync failed.")
                    }
                }
            }
            let s: SessionResponse = try await api.get("/session")
            if demo { return }
            guard s.user != nil else { return expired() }
            accounts = s.accounts ?? []
            fields = s.fields ?? []
            pinned = s.user?.prefs?.pinnedLists ?? []
            listOrder = s.user?.prefs?.listOrder ?? []
            listParents = s.user?.prefs?.listParents ?? []
            if let m = s.user?.prefs?.mapsApp.flatMap(MapsApp.init(rawValue:)) { mapsApp = m }
            listStyles = s.user?.prefs?.listStyles ?? []
            viewPrefs = s.user?.prefs?.views ?? [:]
            legacyView = ViewPrefs(columns: s.user?.prefs?.columns, sort: s.user?.prefs?.sort, nameSort: s.user?.prefs?.nameSort)
            let c: ContactsResponse = try await api.get("/contacts")
            if demo { return }
            contacts = c.contacts
            relationships = c.relationships ?? []
            if let a: ContactsResponse = try? await api.get("/archive"), !demo { archived = a.contacts }
            lastSynced = accounts.compactMap(\.lastSyncedAt).max().map { Date(timeIntervalSince1970: $0 / 1000) }
            phase = .ready
            saveCache()
        } catch {
            if demo { return }
            if quiet, let e = error as? APIError, e.code == "offline" || e.status >= 500 { return }
            handle(error)
            if phase == .loading { phase = contacts.isEmpty ? .signedOut : .ready }
        }
    }

    func loadDetail(_ id: String) async {
        if demo { return }
        do {
            let d: ContactDetail = try await api.get("/contacts/\(id)")
            details[id] = d
        } catch {
            handle(error)
        }
    }

    // MARK: - Editing contacts (Google)

    /// Save edits to Google. `edit` holds only what changed. Returns the saved contact.
    @discardableResult
    func saveEdit(_ id: String, etag: String?, edit: [String: Any]) async throws -> ContactDetail {
        if demo { return demoEdit(id, edit) }
        do {
            let d: ContactDetail = try await api.patch("/contacts/\(id)", ["etag": etag ?? "", "edit": edit])
            apply(d)
            syncSoon()
            return d
        } catch let e as APIError where e.code == "conflict" {
            if let fresh = e.contact { apply(fresh) }
            throw e
        }
    }

    func create(accountId: String, edit: [String: Any], draft: Bool = false) async throws -> ContactDetail {
        if demo { return demoCreate(edit) }
        let d: ContactDetail = try await api.post("/contacts", ["accountId": accountId, "edit": edit, "draft": draft])
        apply(d)
        await refreshContacts()
        syncSoon()
        return d
    }

    /// Save one view’s table setup (sort, say), keeping every other view’s as the web left it.
    func saveViewPrefs(_ key: String, _ prefs: ViewPrefs) async {
        viewPrefs[key] = prefs
        if demo { return }
        do {
            let data = try JSONEncoder().encode(viewPrefs)
            let obj = try JSONSerialization.jsonObject(with: data)
            let _: Empty = try await api.patch("/prefs", ["set": ["views": obj]])
        } catch {
            handle(error)
        }
    }

    /// Turn a real contact into a draft: kept in Ligature, deleted from Google.
    func makeDraft(_ id: String, etag: String?) async throws {
        if demo {
            if let i = contacts.firstIndex(where: { $0.id == id }) { contacts[i].draft = true }
            details[id]?.draft = true
            return
        }
        let d: ContactDetail = try await api.post("/contacts/\(id)/demote", ["etag": etag ?? ""])
        apply(d)
        await refreshContacts()
    }

    /// Make a draft real: create it in Google, with its photo and lists.
    func promote(_ id: String) async throws {
        if demo {
            if let i = contacts.firstIndex(where: { $0.id == id }) { contacts[i].draft = nil }
            details[id]?.draft = nil
            return
        }
        let d: ContactDetail = try await api.post("/contacts/\(id)/promote", [String: String]())
        apply(d)
        await refreshContacts()
        syncSoon()
    }

    /// Set the photo. With the uncropped original and the crop, Ligature keeps those (never
    /// Google) so the crop can be changed later.
    func setPhoto(_ id: String, etag: String?, jpeg: Data, original: Data? = nil, crop: PhotoCrop? = nil) async throws {
        if demo { return }
        var body: [String: Any] = ["etag": etag ?? "", "image": jpeg.base64EncodedString()]
        if let original, let crop {
            body["original"] = original.base64EncodedString()
            body["crop"] = ["x": crop.x, "y": crop.y, "w": crop.w, "h": crop.h]
        }
        let d: ContactDetail = try await api.put("/contacts/\(id)/photo", body)
        apply(d)
        syncSoon()
    }

    /// What to crop a contact’s photo from: the original kept when it was last cropped (and
    /// that crop), or else the photo itself, as large as Google has it.
    func photoOriginal(_ id: String) async throws -> (image: UIImage, crop: PhotoCrop?) {
        if demo {
            // Demo photos are bundled with the app.
            guard let url = details[id]?.card.photoUrl, let image = await Photo.load(url, px: 1600) else {
                throw APIError(status: 0, message: "That photo couldn’t be read.", code: nil, contact: nil)
            }
            return (image, nil)
        }
        let r: PhotoOriginal = try await api.get("/contacts/\(id)/photo/original")
        guard let comma = r.image.firstIndex(of: ","),
              let data = Data(base64Encoded: String(r.image[r.image.index(after: comma)...])),
              let image = UIImage(data: data) else {
            throw APIError(status: 0, message: "That photo couldn’t be read.", code: nil, contact: nil)
        }
        return (image, r.crop)
    }

    func deletePhoto(_ id: String, etag: String?) async throws {
        if demo { return }
        let e = (etag ?? "").addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ""
        let d: ContactDetail = try await api.delete("/contacts/\(id)/photo?etag=\(e)")
        apply(d)
        syncSoon()
    }

    /// Delete in Google (Google keeps it in Trash for 30 days).
    func deleteContact(_ id: String, etag: String?) async throws {
        if !demo {
            let r: DeleteResult = try await api.post("/contacts/delete", ["ids": [id], "etags": [id: etag ?? ""]])
            if r.changed.contains(id) {
                await loadDetail(id)
                throw APIError(status: 409, message: "This contact changed in Google since you opened it, so it wasn’t deleted. It’s been reloaded; try again.", code: "conflict", contact: nil)
            }
        }
        contacts.removeAll { $0.id == id }
        details[id] = nil
        saveCache()
        syncSoon()
    }

    // MARK: - Your fields (only in Ligature)

    func saveField(_ id: String, fieldId: String, value: String) async {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if let i = contacts.firstIndex(where: { $0.id == id }) {
            if trimmed.isEmpty { contacts[i].fields[fieldId] = nil } else { contacts[i].fields[fieldId] = value }
        }
        if demo { return }
        do {
            let d: ContactDetail = try await api.put("/contacts/\(id)/fields", ["values": [fieldId: value]])
            apply(d)
        } catch {
            handle(error)
        }
    }

    // MARK: - Messaging

    /// Names, every phone and email, and your fields, for filling in a message.
    func people(_ ids: [String]) async throws -> [Person] {
        if demo {
            return ids.compactMap { id in
                guard let d = details[id], let r = contacts.first(where: { $0.id == id }) else { return nil }
                let c = d.card
                return Person(id: id, accountId: r.accountId, givenName: c.givenName, familyName: c.familyName, displayName: c.displayName,
                              organization: c.organization, title: c.title, phones: c.phones, emails: c.emails, fields: r.fields)
            }
        }
        var out: [Person] = []
        for i in stride(from: 0, to: ids.count, by: 2000) {
            let r: PeopleResponse = try await api.post("/contacts/lookup", ["ids": Array(ids[i..<min(i + 2000, ids.count)])])
            out += r.contacts
        }
        let order = Dictionary(uniqueKeysWithValues: ids.enumerated().map { ($1, $0) })
        return out.sorted { (order[$0.id] ?? 0) < (order[$1.id] ?? 0) }
    }

    /// One email through the account’s Gmail: one person, or everyone on one message.
    func sendEmail(accountId: String, group: Bool, bcc: Bool, recipients: [(id: String, email: String, name: String)], subject: String, body: String) async throws {
        if demo {
            try await Task.sleep(nanoseconds: 300_000_000)
            return
        }
        let _: Empty = try await api.post("/messages/email", [
            "accountId": accountId,
            "mode": group ? "group" : "individual",
            "groupTo": bcc ? "bcc" : "to",
            "recipients": recipients.map { ["contactId": $0.id, "email": $0.email, "name": $0.name] },
            "subject": subject,
            "body": body,
        ])
    }

    /// Google’s consent page for letting Ligature send email from this account.
    func gmailConsentURL(accountId: String) async throws -> URL {
        struct R: Decodable { let url: String }
        let r: R = try await api.post("/auth/app/gmail", ["accountId": accountId])
        guard let url = URL(string: r.url) else { throw APIError(status: 0, message: "Bad link from the server.", code: nil, contact: nil) }
        return url
    }

    /// After connecting Gmail: reload the accounts so the app knows it can send.
    func reloadSession() async {
        if demo {
            for i in accounts.indices { accounts[i].canEmail = true }
            return
        }
        if let s: SessionResponse = try? await api.get("/session"), s.user != nil {
            accounts = s.accounts ?? accounts
            fields = s.fields ?? fields
            saveCache()
        }
    }

    // MARK: - Pinned lists

    /// Pinned lists that still exist, in order.
    var pinnedLists: [ListEntry] {
        pinned.compactMap { ref in
            rawLists(ref.accountId).first { $0.id == ref.id }.map { ListEntry(ref: ref, list: $0) }
        }
    }

    /// Every list in every account: pinned first, then your order, then new ones as Google sorts them.
    var orderedLists: [ListEntry] {
        let all = accounts.flatMap { a in a.groups.map { ListEntry(ref: ListRef(accountId: a.id, id: $0.id), list: $0) } }
        func rank(_ r: ListRef) -> (Int, Int) {
            (pinned.firstIndex(of: r) ?? Int.max, listOrder.firstIndex(of: r) ?? Int.max)
        }
        return all.enumerated().sorted { a, b in
            let ra = rank(a.element.ref), rb = rank(b.element.ref)
            return ra != rb ? ra < rb : a.offset < b.offset
        }.map { $0.element }
    }

    /// The other lists, as a tree: each list followed by the lists inside it.
    var unpinnedLists: [ListEntry] {
        tree(orderedLists.filter { !pinned.contains($0.ref) }).map(\.entry)
    }

    // MARK: - Nested lists

    /// A list’s parent, if it still exists (and the nesting doesn’t loop).
    func parentOf(_ r: ListRef) -> String? {
        let groups = rawLists(r.accountId)
        func up(_ id: String) -> String? {
            guard let p = listParents.first(where: { $0.accountId == r.accountId && $0.id == id })?.parentId,
                  p != id, groups.contains(where: { $0.id == p }) else { return nil }
            return p
        }
        guard let first = up(r.id) else { return nil }
        var seen: Set<String> = [r.id]
        var p: String? = first
        while let x = p {
            if seen.contains(x) { return nil }
            seen.insert(x)
            p = up(x)
        }
        return first
    }

    /// Every list inside this one, all the way down.
    func descendants(of r: ListRef) -> [String] {
        var out: [String] = []
        func walk(_ id: String) {
            for g in rawLists(r.accountId) where g.id != r.id && !out.contains(g.id) && parentOf(ListRef(accountId: r.accountId, id: g.id)) == id {
                out.append(g.id)
                walk(g.id)
            }
        }
        walk(r.id)
        return out
    }

    func depth(of r: ListRef) -> Int {
        var d = 0
        var p = parentOf(r)
        while let x = p, d < 8 { d += 1; p = parentOf(ListRef(accountId: r.accountId, id: x)) }
        return d
    }

    /// Lists in order, each followed by its sublists. A list whose parent isn’t among them is top level.
    func tree(_ entries: [ListEntry]) -> [(entry: ListEntry, depth: Int)] {
        var out: [(ListEntry, Int)] = []
        func visit(_ parent: ListRef?, _ depth: Int) {
            for e in entries {
                let p = parentOf(e.ref)
                let isRoot = p == nil || !entries.contains { $0.ref == ListRef(accountId: e.ref.accountId, id: p!) }
                let matches = parent == nil ? isRoot : (!isRoot && e.ref.accountId == parent!.accountId && p == parent!.id)
                guard matches, !out.contains(where: { $0.0.ref == e.ref }) else { continue }
                out.append((e, depth))
                visit(e.ref, depth + 1)
            }
        }
        visit(nil, 0)
        return out.map { (entry: $0.0, depth: $0.1) }
    }

    /// Puts a list inside another, or back at the top level with nil.
    func nest(_ r: ListRef, inside parentId: String?) async {
        if let p = parentId, p == r.id || descendants(of: r).contains(p) { return }
        listParents.removeAll { $0.accountId == r.accountId && $0.id == r.id }
        if let p = parentId { listParents.append(ListParent(accountId: r.accountId, id: r.id, parentId: p)) }
        saveCache()
        if demo { return }
        do {
            let enc = listParents.map { ["accountId": $0.accountId, "id": $0.id, "parentId": $0.parentId] }
            let _: Empty = try await api.patch("/prefs", ["set": ["listParents": enc]])
        } catch {
            handle(error)
        }
    }

    // MARK: - List colors and emoji

    func style(_ r: ListRef) -> ListStyle {
        listStyles.first { $0.accountId == r.accountId && $0.id == r.id } ?? ListStyle(accountId: r.accountId, id: r.id)
    }

    func setStyle(_ r: ListRef, color: String?, emoji: String?) async {
        listStyles.removeAll { $0.accountId == r.accountId && $0.id == r.id }
        if color != nil || emoji != nil { listStyles.append(ListStyle(accountId: r.accountId, id: r.id, color: color, emoji: emoji)) }
        saveCache()
        if demo { return }
        do {
            let enc: [[String: String]] = listStyles.map { s in
                var d = ["accountId": s.accountId, "id": s.id]
                if let c = s.color { d["color"] = c }
                if let e = s.emoji { d["emoji"] = e }
                return d
            }
            let _: Empty = try await api.patch("/prefs", ["set": ["listStyles": enc]])
        } catch {
            handle(error)
        }
    }

    /// Which app opens places (directions on the full map). Shared with the web.
    func setMapsApp(_ app: MapsApp) async {
        mapsApp = app
        if demo { return }
        do {
            let _: Empty = try await api.patch("/prefs", ["set": ["mapsApp": app.rawValue]])
        } catch {
            handle(error)
        }
    }

    /// Reorder pinned lists (drag in Manage Lists).
    func movePinned(from: IndexSet, to: Int) async {
        var refs = pinnedLists.map { $0.ref }
        refs.move(fromOffsets: from, toOffset: to)
        pinned = refs
        await saveOrder()
    }

    /// Reorder the other lists (drag in Manage Lists).
    func moveUnpinned(from: IndexSet, to: Int) async {
        var refs = unpinnedLists.map { $0.ref }
        refs.move(fromOffsets: from, toOffset: to)
        listOrder = pinnedLists.map { $0.ref } + refs
        await saveOrder()
    }

    /// Drop a pinned tab before another tab (or first, onto All).
    func moveTab(_ ref: ListRef, before target: ListRef?) async {
        guard pinned.contains(ref), ref != target else { return }
        var refs = pinnedLists.map { $0.ref }
        refs.removeAll { $0 == ref }
        let i = target.flatMap { refs.firstIndex(of: $0) } ?? 0
        refs.insert(ref, at: i)
        pinned = refs
        await saveOrder()
    }

    /// After dragging tabs: `pinned` is already in the new order.
    func savePinnedOrder() async { await saveOrder() }

    private func saveOrder() async {
        saveCache()
        if demo { return }
        do {
            let enc = { (r: [ListRef]) in r.map { ["accountId": $0.accountId, "id": $0.id] } }
            let _: Empty = try await api.patch("/prefs", ["set": ["pinnedLists": enc(pinned), "listOrder": enc(listOrder)]])
        } catch {
            handle(error)
        }
    }

    func isPinned(_ list: ContactList, accountId: String) -> Bool {
        pinned.contains(ListRef(accountId: accountId, id: list.id))
    }

    func setPinned(_ list: ContactList, accountId: String, _ on: Bool) async {
        let ref = ListRef(accountId: accountId, id: list.id)
        if on, !pinned.contains(ref) { pinned.append(ref) }
        if !on { pinned.removeAll { $0 == ref } }
        saveCache()
        if demo { return }
        do {
            let _: Empty = try await api.patch("/prefs", ["set": ["pinnedLists": pinned.map { ["accountId": $0.accountId, "id": $0.id] }]])
        } catch {
            handle(error)
        }
    }

    // MARK: - Lists

    /// One account’s lists in your order.
    func lists(for accountId: String) -> [ContactList] {
        orderedLists.filter { $0.ref.accountId == accountId }.map { $0.list }
    }

    private func rawLists(_ accountId: String) -> [ContactList] {
        accounts.first { $0.id == accountId }?.groups ?? []
    }

    func listName(_ id: String, accountId: String) -> String? {
        lists(for: accountId).first { $0.id == id }?.name
    }

    /// Add these contacts to a list, or take them out.
    func setMembership(_ ids: [String], list: ContactList, accountId: String, add: Bool) async {
        if demo {
            for id in ids {
                guard let i = contacts.firstIndex(where: { $0.id == id }) else { continue }
                if add, !contacts[i].groups.contains(list.id) { contacts[i].groups.append(list.id) }
                if !add { contacts[i].groups.removeAll { $0 == list.id } }
                details[id]?.card.groups = contacts[i].groups
            }
            return
        }
        do {
            let r: ListResult = try await api.post("/lists", [
                "action": "members", "accountId": accountId, "groupId": list.id, (add ? "add" : "remove"): ids,
            ])
            applyLists(r, accountId: accountId)
        } catch {
            handle(error)
        }
    }

    @discardableResult
    func createList(_ name: String, accountId: String) async -> ContactList? {
        if demo {
            let g = ContactList(id: "contactGroups/demo\(Int.random(in: 1000...9999))", name: name, system: false)
            if let i = accounts.firstIndex(where: { $0.id == accountId }) { accounts[i].groups.append(g) }
            return g
        }
        do {
            let r: ListResult = try await api.post("/lists", ["action": "create", "accountId": accountId, "name": name])
            applyLists(r, accountId: accountId)
            return r.group
        } catch {
            handle(error)
            return nil
        }
    }

    func renameList(_ list: ContactList, to name: String, accountId: String) async {
        if demo { return }
        do {
            let r: ListResult = try await api.post("/lists", ["action": "rename", "accountId": accountId, "groupId": list.id, "name": name])
            applyLists(r, accountId: accountId)
        } catch {
            handle(error)
        }
    }

    func deleteList(_ list: ContactList, accountId: String) async {
        if demo { return }
        do {
            let r: ListResult = try await api.post("/lists", ["action": "delete", "accountId": accountId, "groupId": list.id])
            listStyles.removeAll { $0.accountId == accountId && $0.id == list.id } // the server forgets it too
            applyLists(r, accountId: accountId)
        } catch {
            handle(error)
        }
    }

    // MARK: - Archive

    /// A contact, live or archived.
    func row(_ id: String) -> ContactRow? {
        contacts.first { $0.id == id } ?? archived.first { $0.id == id }
    }

    enum ArchiveAction: String { case archive, restore, forget }

    /// Archive, restore or delete-for-good. Returns the IDs that were done.
    @discardableResult
    func archive(_ action: ArchiveAction, ids: [String], etags: [String: String] = [:]) async -> [String] {
        guard !ids.isEmpty else { return [] }
        if demo {
            switch action {
            case .archive:
                archived += contacts.filter { ids.contains($0.id) }
                contacts.removeAll { ids.contains($0.id) }
                for id in ids {
                    let groups = details[id]?.card.groups ?? []
                    details[id]?.archived = .init(at: Date().timeIntervalSince1970 * 1000, groups: groups)
                }
            case .restore:
                contacts += archived.filter { ids.contains($0.id) }
                archived.removeAll { ids.contains($0.id) }
                for id in ids { details[id]?.archived = nil }
            case .forget:
                archived.removeAll { ids.contains($0.id) }
            }
            return ids
        }
        struct R: Decodable {
            struct Skip: Decodable { let id: String; let reason: String }
            let done: [String]
            let skipped: [Skip]
        }
        do {
            let r: R = try await api.post("/archive", ["action": action.rawValue, "ids": ids, "etags": etags])
            for id in r.done { details[id] = nil }
            await refresh(sync: false, quiet: true)
            if action == .archive || action == .restore { syncSoon() }
            if !r.skipped.isEmpty {
                let changed = r.skipped.contains { $0.reason == "changed" }
                alert(action == .archive ? "Not Archived" : "Not Restored",
                      changed ? "\(r.skipped.count == 1 ? "This contact" : "Some contacts") changed in Google since your last sync. Pull to sync, then try again."
                              : r.skipped[0].reason)
            }
            return r.done
        } catch {
            handle(error)
            return []
        }
    }

    // MARK: - Relationships (kept only in Ligature)

    /// People shown together, by contact ID.
    var together: [String: [ContactRow]] { Together.groups(contacts, relationships) }

    func relationships(of id: String) -> [Relationship] {
        let ids = Set(contacts.map(\.id))
        return relationships.filter { ($0.a == id || $0.b == id) && ids.contains($0.other(than: id)) }
    }

    /// Add or replace the relationship between two people. Returns false if it didn’t save.
    func saveRelationship(me: String, other: String, role: RelationRole, label: String, together: Bool, replacing old: Relationship?) async -> Bool {
        let (a, b) = role.otherIsA == true ? (other, me) : (me, other)
        let kind = role.kind
        let text = kind == "other" ? label.trimmingCharacters(in: .whitespaces) : ""
        func samePair(_ r: Relationship) -> Bool { (r.a == a && r.b == b) || (r.a == b && r.b == a) }
        do {
            let saved: Relationship
            if demo {
                saved = Relationship(id: old?.id ?? UUID().uuidString, a: a, b: b, kind: kind, label: text, combined: together)
            } else {
                struct R: Decodable { let relationship: Relationship }
                let r: R = try await api.post("/relationships", ["a": a, "b": b, "kind": kind, "label": text, "combined": together])
                saved = r.relationship
            }
            relationships.removeAll { $0.id == saved.id || samePair($0) }
            relationships.append(saved)
            saveCache()
            return true
        } catch {
            handle(error)
            return false
        }
    }

    func removeRelationship(_ r: Relationship) async {
        if !demo {
            do {
                let _: Empty = try await api.delete("/relationships/\(r.id)")
            } catch let e as APIError where e.status == 404 {
                // Already gone.
            } catch {
                return handle(error)
            }
        }
        relationships.removeAll { $0.id == r.id }
        saveCache()
    }

    // MARK: - Map

    /// Fetch where everyone is, then look up the rest a few at a time while `keepGoing` holds.
    func loadMap(keepGoing: @escaping () -> Bool) async {
        if demo { mapLoaded = true; return }
        do {
            let r: MapResponse = try await api.get("/map")
            takeMap(r)
        } catch {
            if let e = error as? APIError, e.code == "offline" { return }
            return handle(error)
        }
        guard !lookingUp else { return }
        lookingUp = true
        defer { lookingUp = false }
        mapStalled = false
        while mapPending > 0, keepGoing() {
            do {
                let r: MapResponse = try await api.post("/map/geocode", [:])
                takeMap(r)
                if r.stalled == true { mapStalled = true; break }
                if r.busy == true { try? await Task.sleep(for: .seconds(3)) }
            } catch {
                break
            }
        }
    }

    func loadPins() async {
        if demo { return }
        struct R: Decodable { let pins: [Pin] }
        if let r: R = try? await api.get("/pins") { pins = r.pins }
    }

    func searchPlaces(_ q: String) async throws -> [Place] {
        if demo {
            return [Place(name: q, address: "\(q), Portland, OR", lat: 45.52, lng: -122.68)]
        }
        struct R: Decodable { let places: [Place] }
        let enc = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? q
        let r: R = try await api.get("/places?q=\(enc)")
        return r.places
    }

    func addPin(_ place: Place, label: String) async -> Bool {
        do {
            let pin: Pin
            if demo {
                pin = Pin(id: UUID().uuidString, label: label, address: place.address, lat: place.lat, lng: place.lng)
            } else {
                struct R: Decodable { let pin: Pin }
                let r: R = try await api.post("/pins", ["label": label, "lat": place.lat, "lng": place.lng, "address": place.address])
                pin = r.pin
            }
            pins.append(pin)
            return true
        } catch {
            handle(error)
            return false
        }
    }

    func renamePin(_ pin: Pin, to label: String) async {
        guard let i = pins.firstIndex(where: { $0.id == pin.id }) else { return }
        let old = pins[i].label
        pins[i].label = label
        if demo { return }
        do {
            struct R: Decodable { let pin: Pin }
            let _: R = try await api.patch("/pins/\(pin.id)", ["label": label])
        } catch {
            if let j = pins.firstIndex(where: { $0.id == pin.id }) { pins[j].label = old }
            handle(error)
        }
    }

    func removePin(_ pin: Pin) async {
        if !demo {
            do {
                let _: Empty = try await api.delete("/pins/\(pin.id)")
            } catch {
                return handle(error)
            }
        }
        pins.removeAll { $0.id == pin.id }
    }

    private func takeMap(_ r: MapResponse) {
        mapPoints = r.points
        mapFailed = Set((r.failed ?? []).map(\.id))
        mapPending = r.pending
        mapLoaded = true
    }

    // MARK: - Helpers

    private func refreshContacts() async {
        if let c: ContactsResponse = try? await api.get("/contacts") {
            contacts = c.contacts
            relationships = c.relationships ?? relationships
            saveCache()
        }
    }

    /// Fold a fresh copy of one contact into the list and the detail cache.
    private func apply(_ d: ContactDetail) {
        details[d.id] = d
        if let i = contacts.firstIndex(where: { $0.id == d.id }) {
            var r = contacts[i]
            r.givenName = d.card.givenName
            r.familyName = d.card.familyName
            r.displayName = d.card.displayName
            r.organization = d.card.organization
            r.title = d.card.title
            r.email = d.card.emails.first?.value ?? ""
            r.phone = (d.card.phones.first { $0.label.range(of: "mobile|cell|iphone", options: [.regularExpression, .caseInsensitive]) != nil } ?? d.card.phones.first)?.value ?? ""
            r.photoUrl = d.card.photoUrl
            r.groups = d.card.groups
            r.fields = d.fields
            r.draft = d.draft
            if let search = d.search { r.search = search }
            contacts[i] = r
        }
        saveCache()
    }

    private func applyLists(_ r: ListResult, accountId: String) {
        syncSoon()
        if let i = accounts.firstIndex(where: { $0.id == accountId }) { accounts[i].groups = r.groups }
        for c in r.contacts {
            if let i = contacts.firstIndex(where: { $0.id == c.id }) { contacts[i].groups = c.groups }
            if details[c.id] != nil {
                details[c.id]?.card.groups = c.groups
                details[c.id]?.etag = c.etag
            }
        }
        saveCache()
    }

    func handle(_ error: Error) {
        if let e = error as? APIError, e.code == "signed_out" || e.status == 401 { return expired() }
        alert("Something went wrong", error.localizedDescription)
    }

    func alert(_ title: String, _ message: String) {
        alertTitle = title
        alertMessage = message
        showAlert = true
    }

    private func expired() {
        Keychain.delete("session")
        api.token = nil
        clearCache()
        phase = .signedOut
    }

    // MARK: - Cache, so the app opens instantly and works offline for reading

    private struct Cache: Codable {
        var accounts: [Account]
        var fields: [FieldDef]
        var contacts: [ContactRow]
        var details: [String: ContactDetail]
        var pinned: [ListRef]?
        var listOrder: [ListRef]?
        var listParents: [ListParent]?
        var listStyles: [ListStyle]?
        var relationships: [Relationship]?
        var archived: [ContactRow]?
    }

    private var cacheURL: URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("cache.json")
    }

    private func saveCache() {
        guard !demo else { return }
        let cache = Cache(accounts: accounts, fields: fields, contacts: contacts, details: details, pinned: pinned, listOrder: listOrder, listParents: listParents, listStyles: listStyles, relationships: relationships, archived: archived)
        if let data = try? JSONEncoder().encode(cache) {
            try? data.write(to: cacheURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }

    private func loadCache() -> Bool {
        guard let data = try? Data(contentsOf: cacheURL), let c = try? JSONDecoder().decode(Cache.self, from: data) else { return false }
        accounts = c.accounts
        fields = c.fields
        contacts = c.contacts
        details = c.details
        pinned = c.pinned ?? []
        listOrder = c.listOrder ?? []
        listParents = c.listParents ?? []
        listStyles = c.listStyles ?? []
        relationships = c.relationships ?? []
        archived = c.archived ?? []
        return !contacts.isEmpty
    }

    private func clearCache() {
        try? FileManager.default.removeItem(at: cacheURL)
    }
}
