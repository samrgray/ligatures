import Foundation

/// Sample data for the demo build (launched with `-demo`), used for screenshots and for
/// trying the app without a server. Nothing here touches the network.
extension Store {
    func loadDemo() {
        let lists = [
            ContactList(id: "contactGroups/starred", name: "Favorites", system: true),
            ContactList(id: "contactGroups/book", name: "Book Club", system: false),
            ContactList(id: "contactGroups/family", name: "Family", system: true),
            ContactList(id: "contactGroups/neighbors", name: "Neighbors", system: false),
            ContactList(id: "contactGroups/work", name: "Work", system: false),
        ]
        accounts = [Account(id: "demo", provider: "google", providerName: "Google", label: "Google", canEmail: true, lastSyncedAt: Date().timeIntervalSince1970 * 1000, groups: lists)]
        fields = [
            FieldDef(id: "met", label: "How we met", type: "text"),
            FieldDef(id: "follow", label: "Follow up", type: "date"),
            FieldDef(id: "interests", label: "Interests", type: "text"),
            FieldDef(id: "hood", label: "Neighborhood", type: "text", key: "neighborhood"),
            FieldDef(id: "notes", label: "Private notes", type: "longtext"),
            FieldDef(id: "signal", label: "On Signal", type: "checkbox", key: "signal"),
            FieldDef(id: "signalUser", label: "Signal username", type: "text", key: "signal_username"),
            FieldDef(id: "gate", label: "Gate code", type: "text", accountId: "demo", listId: "contactGroups/neighbors", listName: "Neighbors"),
        ]
        let people: [(String, String, String, String, [String])] = [
            ("Zoe", "Abernathy", "", "", ["contactGroups/family"]),
            ("Jonah", "Albrecht", "Albrecht Design", "Founder", ["contactGroups/book"]),
            ("Rosa", "Alvarez", "", "", ["contactGroups/neighbors", "contactGroups/starred"]),
            ("Will", "Ashby", "Ashby Insurance", "Agent", []),
            ("Marco", "Bellini", "Trattoria Bellini", "Owner", ["contactGroups/book"]),
            ("Eli", "Brandt", "Brandt Legal", "Attorney", []),
            ("Imani", "Brooks", "Lincoln Elementary", "Teacher", ["contactGroups/neighbors"]),
            ("Ava", "Chen", "Northwind Studio", "Design Lead", ["contactGroups/work", "contactGroups/starred"]),
            ("Yusuf", "Demir", "Demir Imports", "", []),
            ("Aaron", "Diaz", "Diaz & Co.", "", ["contactGroups/work"]),
            ("Paul", "Dubois", "Atelier M", "Chef", []),
            ("Wren", "Ellis", "Fieldwork", "Producer", ["contactGroups/work"]),
            ("Isaac", "Feld", "Feld Physical Therapy", "", []),
            ("Noah", "Fischer", "Fischer Dental", "Dentist", []),
            ("Olivia", "Grant", "Grant Realty", "", ["contactGroups/neighbors"]),
            ("Nadia", "Haddad", "", "", ["contactGroups/book"]),
            ("Devon", "Hale", "Hale Builders", "", []),
            ("Quinn", "Harper", "Harper Coaching", "Coach", []),
            ("Zane", "Holloway", "Holloway Cycles", "", ["contactGroups/neighbors"]),
            ("Dana", "Kim", "", "", ["contactGroups/family"]),
            ("Lena", "Kowalski", "", "", ["contactGroups/family"]),
            ("Uma", "Krishnan", "Harbor Health", "", []),
            ("Sofia", "Lindqvist", "Nordic Supply", "", []),
            ("Theo", "Marsh", "Marsh Woodworks", "Carpenter", []),
        ]
        contacts = people.enumerated().map { i, p in
            let (first, last, org, title, groups) = p
            let email = "\(first.lowercased()).\(last.lowercased())@example.com"
            let phone = String(format: "(503) 555-01%02d", i + 10)
            var fields: [String: String] = [:]
            if i % 3 == 0 { fields["met"] = ["Design Week", "Neighbors", "College", "Book club"][i % 4] }
            if i % 4 == 1 { fields["signal"] = "1" }
            if i == 7 { fields["follow"] = "2026-11-02"; fields["interests"] = "Ceramics, trail running" }
            return ContactRow(
                id: "demo-\(i)", accountId: "demo", givenName: first, familyName: last, displayName: "\(first) \(last)",
                organization: org, title: title, email: email, phone: phone, photoUrl: Self.demoPhoto(first),
                search: "\(first) \(last) \(org) \(email) \(phone)".lowercased(), groups: groups, fields: fields, draft: i == 4 ? true : nil
            )
        }
        for c in contacts { details[c.id] = demoDetail(c) }
        // Around Portland, Oregon: most at a street address, a few only by neighborhood or city.
        mapPoints = contacts.enumerated().compactMap { i, c in
            if i % 7 == 6 { return nil }
            let lat = 45.52 + Double((i * 37) % 23) / 23 * 0.16 - 0.08
            let lng = -122.66 + Double((i * 53) % 29) / 29 * 0.2 - 0.1
            if i % 5 == 4 { return MapPoint(id: c.id, label: "home", precision: "neighborhood", lat: 45.4638, lng: -122.6530, text: "Sellwood, Portland, OR") }
            if i % 9 == 8 { return MapPoint(id: c.id, label: "home", precision: "city", lat: 45.5152, lng: -122.6784, text: "Portland, OR") }
            return MapPoint(id: c.id, label: i % 4 == 1 ? "work" : "home", precision: "address", lat: lat, lng: lng, text: "")
        }
        mapLoaded = true
        pins = [Pin(id: "demo-pin", label: "Washington Park", address: "Washington Park, Portland, OR", lat: 45.5100, lng: -122.7160)]
        // Zoe and Rosa show as one; Eli is Zoe’s son, shown on his own.
        relationships = [
            Relationship(id: "demo-r1", a: "demo-0", b: "demo-2", kind: "spouse", label: "", combined: true),
            Relationship(id: "demo-r2", a: "demo-0", b: "demo-5", kind: "parent", label: "", combined: false),
        ]
        if ProcessInfo.processInfo.arguments.contains("-nopins") { return }
        pinned = ["contactGroups/starred", "contactGroups/book", "contactGroups/neighbors", "contactGroups/work"].map { ListRef(accountId: "demo", id: $0) }
    }

    /// Photos for most people, bundled so the demo still makes no network calls (Unsplash, free to use).
    static func demoPhoto(_ first: String) -> String {
        Bundle.main.url(forResource: "demo-\(first.lowercased())", withExtension: "jpg")?.absoluteString ?? ""
    }

    func demoDetail(_ c: ContactRow) -> ContactDetail {
        var phones = [Labeled(value: c.phone, label: "mobile")]
        var emails = [Labeled(value: c.email, label: "home")]
        if !c.organization.isEmpty {
            phones.append(Labeled(value: "(971) 555-0188", label: "work"))
            emails.append(Labeled(value: "\(c.givenName.lowercased())@\(c.familyName.lowercased()).example.com", label: "work"))
        }
        let card = Card(
            givenName: c.givenName, familyName: c.familyName, displayName: c.displayName, organization: c.organization, title: c.title,
            phones: phones, emails: emails, urls: [],
            addresses: [PostalAddress(label: "home", street: "466 Quarry Bend Rd", city: "Portland", region: "OR", postalCode: "97214",
                                      value: "466 Quarry Bend Rd\nPortland, OR 97214")],
            relations: [], events: [], birthday: "September 19, 1986", notes: "Kids go to Lincoln.", photoUrl: c.photoUrl, groups: c.groups
        )
        return ContactDetail(id: c.id, etag: "demo", draft: c.draft, card: card, fields: c.fields, account: AccountRef(id: "demo", providerName: "Google"))
    }

    func demoEdit(_ id: String, _ edit: [String: Any]) -> ContactDetail {
        guard var d = details[id] else { return details.values.first! }
        if let v = edit["givenName"] as? String { d.card.givenName = v }
        if let v = edit["familyName"] as? String { d.card.familyName = v }
        if let v = edit["organization"] as? String { d.card.organization = v }
        if let v = edit["title"] as? String { d.card.title = v }
        if let v = edit["notes"] as? String { d.card.notes = v }
        if let list = edit["addresses"] as? [[String: String]] {
            d.card.addresses = list.map { p in
                let line2 = [[p["city"] ?? "", p["region"] ?? ""].filter { !$0.isEmpty }.joined(separator: ", "), p["postalCode"] ?? ""]
                    .filter { !$0.isEmpty }.joined(separator: " ")
                let value = [p["street"] ?? "", line2, p["country"] ?? ""].filter { !$0.isEmpty }.joined(separator: "\n")
                return PostalAddress(label: p["label"] ?? "home", street: p["street"] ?? "", city: p["city"] ?? "", region: p["region"] ?? "",
                                     postalCode: p["postalCode"] ?? "", country: p["country"] ?? "", value: value)
            }
        }
        d.card.displayName = [d.card.givenName, d.card.familyName].filter { !$0.isEmpty }.joined(separator: " ")
        details[id] = d
        if let i = contacts.firstIndex(where: { $0.id == id }) {
            contacts[i].givenName = d.card.givenName
            contacts[i].familyName = d.card.familyName
            contacts[i].displayName = d.card.displayName
            contacts[i].organization = d.card.organization
            contacts[i].title = d.card.title
        }
        return d
    }

    func demoCreate(_ edit: [String: Any]) -> ContactDetail {
        let first = edit["givenName"] as? String ?? ""
        let last = edit["familyName"] as? String ?? ""
        let row = ContactRow(
            id: "demo-new-\(contacts.count)", accountId: "demo", givenName: first, familyName: last,
            displayName: [first, last].filter { !$0.isEmpty }.joined(separator: " "), organization: edit["organization"] as? String ?? "",
            title: "", email: "", phone: "", photoUrl: "", search: "\(first) \(last)".lowercased(), groups: edit["groups"] as? [String] ?? [], fields: [:]
        )
        contacts.append(row)
        let d = demoDetail(row)
        details[row.id] = d
        return d
    }
}
