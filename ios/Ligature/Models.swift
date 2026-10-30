import Foundation

// Shapes of what the Ligature server sends. Unknown keys are ignored, so the server can
// grow without breaking older builds of the app.

struct SessionResponse: Decodable {
    let configured: Bool?
    let user: SessionUser?
    let accounts: [Account]?
    let fields: [FieldDef]?
}

struct SessionUser: Codable, Hashable {
    let id: String
    let name: String?
    let prefs: Prefs?
}

/// Settings saved to the account. Only the parts the app uses; the web keeps others here too.
struct Prefs: Codable, Hashable {
    var pinnedLists: [ListRef]?
    var listOrder: [ListRef]?
    var listParents: [ListParent]?
    var listStyles: [ListStyle]?
    /// The table’s setup for each view (All Contacts, each list…), shared with the web.
    var views: [String: ViewPrefs]?
    /// The setup from before views were separate: where a view you haven’t changed starts.
    var columns: [ColumnPref]?
    var sort: SortPref?
    var nameSort: String?
    /// Where places open: "apple" or "google".
    var mapsApp: String?
    /// The font for all text (one of AppFont.families).
    var font: String?
}

struct ViewPrefs: Codable, Hashable {
    var columns: [ColumnPref]?
    var sort: SortPref?
    var nameSort: String?
    var withSub: Bool?
    var hideDrafts: Bool?
}

struct ColumnPref: Codable, Hashable {
    let id: String
    var w: Double?
}

struct SortPref: Codable, Hashable {
    var id: String
    var dir: String
}

/// The first address, in parts, so the table can put the neighborhood before the city.
struct AddressParts: Codable, Hashable {
    let street: String
    let city: String
    let rest: String
    let country: String
    let hood: Bool
}

/** A list nested inside another (only in Ligature; Google’s labels stay flat). */
struct ListParent: Codable, Hashable {
    let accountId: String
    let id: String
    let parentId: String
}

/// A list’s color and emoji (only in Ligature; Google labels have neither).
struct ListStyle: Codable, Hashable {
    let accountId: String
    let id: String
    var color: String?
    var emoji: String?
}

/// A list in a particular account.
struct ListRef: Codable, Hashable {
    let accountId: String
    let id: String
}

struct ListEntry: Identifiable, Hashable {
    let ref: ListRef
    let list: ContactList
    var id: ListRef { ref }
}

struct Account: Codable, Identifiable, Hashable {
    let id: String
    let provider: String
    let providerName: String
    let label: String?
    var canEmail: Bool?
    let lastSyncedAt: Double?
    var groups: [ContactList]
}

/// A list (Google calls them labels or contact groups).
struct ContactList: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    let system: Bool
}

struct FieldDef: Codable, Identifiable, Hashable {
    let id: String
    let label: String
    let type: String // text, longtext, date, url, checkbox
    /// Built-in fields: "neighborhood", "signal", "signal_username".
    var key: String?
    /// A list’s own field: only on people in that list. listName outlives the list.
    var accountId: String? = nil
    var listId: String? = nil
    var listName: String? = nil

    /// Whether this field belongs on a contact with these lists.
    func applies(accountId: String?, groups: [String]) -> Bool {
        guard let listId else { return true }
        return self.accountId == accountId && groups.contains(listId)
    }
}

/// One of a contact’s addresses, placed on the map.
struct MapPoint: Codable, Hashable {
    let id: String
    let label: String
    /// address, neighborhood, city, postal or region
    let precision: String
    let lat: Double
    let lng: Double
    let text: String

    var type: String { label.isEmpty ? "other" : label }
}

/// A place you pinned on the map.
struct Pin: Codable, Identifiable, Hashable {
    let id: String
    var label: String
    let address: String
    let lat: Double
    let lng: Double
}

/// A search result to pin.
struct Place: Codable, Identifiable, Hashable {
    var id: String { "\(lat),\(lng),\(address)" }
    let name: String
    let address: String
    let lat: Double
    let lng: Double
}

struct MapResponse: Decodable {
    struct Failed: Decodable, Hashable { let id: String }
    let points: [MapPoint]
    let failed: [Failed]?
    let pending: Int
    let stalled: Bool?
    let busy: Bool?
}

/// One row per contact: enough for the list, search and quick actions.
struct ContactRow: Codable, Identifiable, Hashable {
    let id: String
    let accountId: String
    var givenName: String
    var familyName: String
    var displayName: String
    var organization: String
    var title: String
    var email: String
    var phone: String
    var photoUrl: String
    var search: String
    var groups: [String]
    var fields: [String: String]
    /// Only in Ligature, not (yet) in Google.
    var draft: Bool? = nil
    var isDraft: Bool { draft == true }
    // For the table.
    var address: String? = nil
    var addressParts: AddressParts? = nil
    var birthday: String? = nil
    var birthdayKey: String? = nil
    var notes: String? = nil
}

/// Everything a message template can use about one person.
struct Person: Codable, Identifiable, Hashable {
    let id: String
    let accountId: String
    let givenName: String
    let familyName: String
    let displayName: String
    let organization: String
    let title: String
    let phones: [Labeled]
    let emails: [Labeled]
    let fields: [String: String]
}

struct PeopleResponse: Decodable {
    let contacts: [Person]
}

struct ContactsResponse: Decodable {
    let contacts: [ContactRow]
    let relationships: [Relationship]?
}

struct Labeled: Codable, Hashable, Identifiable {
    var id = UUID()
    var value: String
    var label: String

    enum CodingKeys: String, CodingKey { case value, label }

    init(value: String, label: String) {
        self.value = value
        self.label = label
    }
}

/// A postal address: the formatted text in `value`, plus its parts for editing.
struct PostalAddress: Codable, Hashable, Identifiable {
    var id = UUID()
    var value = ""
    var label: String
    var street = ""
    var city = ""
    var region = ""
    var postalCode = ""
    var country = ""

    enum CodingKeys: String, CodingKey { case value, label, street, city, region, postalCode, country }

    init(label: String, street: String = "", city: String = "", region: String = "", postalCode: String = "", country: String = "", value: String = "") {
        self.label = label
        self.street = street
        self.city = city
        self.region = region
        self.postalCode = postalCode
        self.country = country
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        value = try c.decodeIfPresent(String.self, forKey: .value) ?? ""
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
        // Older servers sent only the text; edit it as the street.
        street = try c.decodeIfPresent(String.self, forKey: .street) ?? value
        city = try c.decodeIfPresent(String.self, forKey: .city) ?? ""
        region = try c.decodeIfPresent(String.self, forKey: .region) ?? ""
        postalCode = try c.decodeIfPresent(String.self, forKey: .postalCode) ?? ""
        country = try c.decodeIfPresent(String.self, forKey: .country) ?? ""
    }

    /// What goes to the server: the parts, trimmed.
    var parts: [String: String] {
        let t = { (s: String) in s.trimmingCharacters(in: .whitespacesAndNewlines) }
        return ["label": label, "street": t(street), "city": t(city), "region": t(region), "postalCode": t(postalCode), "country": t(country)]
    }

    var isEmpty: Bool { parts.filter { $0.key != "label" }.allSatisfy { $0.value.isEmpty } }
}

/// The full contact as the provider has it.
struct Card: Codable, Hashable {
    var givenName: String
    var familyName: String
    var displayName: String
    var organization: String
    var title: String
    var phones: [Labeled]
    var emails: [Labeled]
    var urls: [Labeled]
    var addresses: [PostalAddress]
    var relations: [Labeled]
    var events: [Labeled]
    var birthday: String
    var notes: String
    var photoUrl: String
    var groups: [String]
}

struct AccountRef: Codable, Hashable {
    let id: String
    let providerName: String
}

struct ContactDetail: Codable, Hashable {
    struct Archived: Codable, Hashable {
        let at: Double
        let groups: [String]
    }
    let id: String
    var etag: String?
    /// Set when the contact is archived: out of Google, kept in Ligature.
    var archived: Archived?
    /// Only in Ligature, not (yet) in Google.
    var draft: Bool? = nil
    var card: Card
    var fields: [String: String]
    /// Everything search looks through, so an edit is findable straight away.
    var search: String? = nil
    let account: AccountRef
}

struct ListResult: Decodable {
    struct Changed: Decodable {
        let id: String
        let etag: String?
        let groups: [String]
    }
    let group: ContactList?
    let groups: [ContactList]
    let contacts: [Changed]
    let skipped: Int?
}

struct DeleteResult: Decodable {
    let deleted: [String]
    let changed: [String]
    let missing: [String]
}

extension ContactRow {
    /// What the list sorts and groups by.
    func sortKey(byFirst: Bool) -> String {
        let first = givenName.trimmingCharacters(in: .whitespaces)
        let last = familyName.trimmingCharacters(in: .whitespaces)
        let parts = byFirst ? [first, last] : [last, first]
        let key = parts.filter { !$0.isEmpty }.joined(separator: " ")
        return (key.isEmpty ? displayName : key).lowercased()
    }

    var initials: String {
        let a = givenName.first.map(String.init) ?? ""
        let b = familyName.first.map(String.init) ?? ""
        let both = (a + b).uppercased()
        if !both.isEmpty { return both }
        return displayName.first.map { String($0).uppercased() } ?? "?"
    }

    var subtitle: String {
        [title, organization].filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

extension Card {
    var initials: String {
        let a = givenName.first.map(String.init) ?? ""
        let b = familyName.first.map(String.init) ?? ""
        let both = (a + b).uppercased()
        if !both.isEmpty { return both }
        return displayName.first.map { String($0).uppercased() } ?? "?"
    }
}

/// Where a cropped photo sits in its original, as fractions of the original’s width and height.
struct PhotoCrop: Codable, Hashable {
    var x: Double
    var y: Double
    var w: Double
    var h: Double
}

/// What a photo is cropped from: the kept original and its crop, or the photo itself (no crop yet).
struct PhotoOriginal: Decodable {
    let image: String
    let crop: PhotoCrop?
}
