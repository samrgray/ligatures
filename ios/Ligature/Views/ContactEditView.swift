import PhotosUI
import SwiftUI

enum ContactEditMode {
    case new
    case edit(ContactDetail)
}

/// Edit what Google keeps for a contact (or create one). Your own fields are edited on the card.
struct ContactEditView: View {
    let mode: ContactEditMode
    /// For a new contact: the list you were viewing, which they join.
    var list: ListRef? = nil
    var onDeleted: () -> Void = {}

    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var given = ""
    @State private var family = ""
    @State private var organization = ""
    @State private var title = ""
    @State private var phones: [Labeled] = []
    @State private var emails: [Labeled] = []
    @State private var urls: [Labeled] = []
    @State private var addresses: [PostalAddress] = []
    @State private var notes = ""
    @State private var asDraft = false
    @State private var confirmMakeDraft = false

    @State private var pickerItem: PhotosPickerItem?
    /// A new photo or crop, saved with the contact: the cropped square, and what it was cropped from.
    @State private var newPhoto: (jpeg: Data, image: UIImage, original: UIImage, crop: PhotoCrop)?
    @State private var removePhoto = false
    @State private var cropping: CropJob?
    @State private var loadingOriginal = false

    @State private var saving = false
    @State private var error: String?
    @State private var confirmDelete = false
    @State private var loaded = false

    private static let phoneLabels = ["mobile", "home", "work", "main", "other"]
    private static let emailLabels = ["home", "work", "other"]
    private static let urlLabels = ["homepage", "work", "blog", "profile", "other"]
    private static let addressLabels = ["home", "work", "other"]

    private var original: ContactDetail? {
        if case let .edit(d) = mode { return d }
        return nil
    }

    var body: some View {
        NavigationStack {
            Form {
                photoSection
                if original == nil, let list, let name = store.listName(list.id, accountId: list.accountId) {
                    Section {
                        Label("Adds them to \(name)", systemImage: "list.bullet")
                            .font(.app(.subheadline))
                            .foregroundStyle(.secondary)
                    }
                }
                Section {
                    TextField("First name", text: $given).textContentType(.givenName)
                    TextField("Last name", text: $family).textContentType(.familyName)
                    TextField("Company", text: $organization).textContentType(.organizationName)
                    TextField("Job title", text: $title).textContentType(.jobTitle)
                }
                multiSection("phone", items: $phones, labels: Self.phoneLabels, keyboard: .phonePad, format: true)
                multiSection("email", items: $emails, labels: Self.emailLabels, keyboard: .emailAddress)
                addressSection
                multiSection("website", items: $urls, labels: Self.urlLabels, keyboard: .URL)
                Section("Notes") {
                    TextField("Notes", text: $notes, axis: .vertical).lineLimit(3...12)
                }
                if original == nil {
                    Section {
                        Toggle("Save as Draft", isOn: $asDraft)
                    } footer: {
                        Text("A draft stays only in Ligature, not in Google Contacts, until you add it to Google from its card.")
                    }
                }
                if let d = original, d.draft != true {
                    Section {
                        Button("Make Draft") { confirmMakeDraft = true }
                            .frame(maxWidth: .infinity)
                    } footer: {
                        Text("Takes them out of Google Contacts (and your iPhone and Mac), keeping everything in Ligature as a draft. Add them back to Google anytime.")
                    }
                }
                if let d = original {
                    Section {
                        Button("Archive Contact") {
                            saving = true
                            Task {
                                let done = await store.archive(.archive, ids: [d.id], etags: [d.id: d.etag ?? ""])
                                saving = false
                                if !done.isEmpty {
                                    dismiss()
                                    onDeleted()
                                }
                            }
                        }
                        .frame(maxWidth: .infinity)
                    } footer: {
                        Text("Takes them out of Google Contacts, keeping everything (fields, photo, lists) in Ligature. Restore them anytime from Archived.")
                    }
                    Section {
                        Button("Delete Contact", role: .destructive) { confirmDelete = true }
                            .frame(maxWidth: .infinity)
                    } footer: {
                        Text("Deletes the contact from Google Contacts, so it also leaves your iPhone and Mac. Google keeps it in Trash for 30 days.")
                    }
                }
            }
            .navigationTitle(original == nil ? "New Contact" : "Edit Contact")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if saving { ProgressView() } else { Button("Done") { Task { await save() } }.bold() }
                }
            }
            .disabled(saving)
            .alert("Couldn’t Save", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(error ?? "")
            }
            .confirmationDialog("Make this contact a draft?", isPresented: $confirmMakeDraft, titleVisibility: .visible) {
                Button("Make Draft", role: .destructive) {
                    guard let d = original else { return }
                    saving = true
                    Task {
                        do {
                            try await store.makeDraft(d.id, etag: d.etag)
                            dismiss()
                        } catch {
                            self.error = error.localizedDescription
                        }
                        saving = false
                    }
                }
            } message: {
                Text("They’re deleted from Google Contacts, your iPhone and your Mac. Everything stays in Ligature as a draft. Unsaved edits are discarded.")
            }
            .confirmationDialog("Delete this contact?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete Contact", role: .destructive) { Task { await delete() } }
            } message: {
                Text("It’s deleted from Google Contacts, your iPhone and your Mac.")
            }
            .onAppear(perform: load)
            .onChange(of: pickerItem) { _, item in
                guard let item else { return }
                Task {
                    if let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) {
                        cropping = CropJob(image: Photo.original(image))
                    } else {
                        error = "That image couldn’t be read."
                    }
                    pickerItem = nil
                }
            }
            .fullScreenCover(item: $cropping) { job in
                PhotoCropView(job: job) { crop in
                    if let jpeg = Photo.croppedJPEG(job.image, crop: crop), let square = UIImage(data: jpeg) {
                        newPhoto = (jpeg, square, job.image, crop)
                        removePhoto = false
                    }
                }
            }
        }
        .interactiveDismissDisabled(saving)
        .storeAlert()
    }

    // MARK: Photo

    private var photoSection: some View {
        let current = removePhoto ? "" : (original?.card.photoUrl ?? "")
        let hasPhoto = newPhoto != nil || !current.isEmpty
        return Section {
            VStack(spacing: 10) {
                Group {
                    if let newPhoto {
                        Image(uiImage: newPhoto.image).resizable().scaledToFill()
                            .frame(width: 96, height: 96).clipShape(Circle())
                    } else {
                        Avatar(url: current, initials: initials, size: 96)
                    }
                }
                HStack(spacing: 16) {
                    PhotosPicker(hasPhoto ? "Change Photo" : "Add Photo", selection: $pickerItem, matching: .images)
                    if hasPhoto {
                        if loadingOriginal {
                            ProgressView()
                        } else {
                            Button("Crop") { Task { await recrop() } }
                        }
                        Button("Remove", role: .destructive) {
                            newPhoto = nil
                            removePhoto = original?.card.photoUrl.isEmpty == false
                        }
                    }
                }
                .buttonStyle(.borderless)
                .font(.app(.subheadline))
            }
            .frame(maxWidth: .infinity)
            .listRowBackground(Color.clear)
        }
    }

    /// Change the crop: of the new photo, or of the contact’s current one (from its kept original).
    private func recrop() async {
        if let p = newPhoto {
            cropping = CropJob(image: p.original, crop: p.crop)
            return
        }
        guard let d = original else { return }
        loadingOriginal = true
        defer { loadingOriginal = false }
        do {
            let r = try await store.photoOriginal(d.id)
            cropping = CropJob(image: Photo.original(r.image), crop: r.crop)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private var initials: String {
        let s = (given.first.map(String.init) ?? "") + (family.first.map(String.init) ?? "")
        return s.isEmpty ? "?" : s.uppercased()
    }

    // MARK: Phones, emails, websites

    private func multiSection(_ noun: String, items: Binding<[Labeled]>, labels: [String], keyboard: UIKeyboardType, format: Bool = false) -> some View {
        Section {
            ForEach(items) { $item in
                HStack(spacing: 10) {
                    Menu {
                        ForEach(labels, id: \.self) { l in Button(l) { item.label = l } }
                    } label: {
                        HStack(spacing: 2) {
                            Text(item.label.isEmpty ? labels[0] : item.label)
                            Image(systemName: "chevron.up.chevron.down").font(.app(.caption2))
                        }
                        .frame(width: 92, alignment: .leading)
                    }
                    Divider()
                    TextField(noun.capitalized, text: $item.value)
                        .keyboardType(keyboard)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onChange(of: item.value) { _, v in
                            if format {
                                let f = PhoneFormat.typing(v)
                                if f != v { item.value = f }
                            }
                        }
                }
            }
            .onDelete { items.wrappedValue.remove(atOffsets: $0) }
            Button {
                items.wrappedValue.append(Labeled(value: "", label: labels[0]))
            } label: {
                Label("Add \(noun)", systemImage: "plus.circle.fill")
            }
        }
    }

    // MARK: Addresses

    private var addressSection: some View {
        Section {
            ForEach($addresses) { $a in
                HStack(alignment: .top, spacing: 10) {
                    Menu {
                        ForEach(Self.addressLabels, id: \.self) { l in Button(l) { a.label = l } }
                    } label: {
                        HStack(spacing: 2) {
                            Text(a.label.isEmpty ? "home" : a.label)
                            Image(systemName: "chevron.up.chevron.down").font(.app(.caption2))
                        }
                        .frame(width: 92, alignment: .leading)
                    }
                    .padding(.top, 2)
                    Divider()
                    VStack(spacing: 8) {
                        TextField("Street", text: $a.street, axis: .vertical)
                            .lineLimit(1...3)
                            .textContentType(.fullStreetAddress)
                        Divider()
                        HStack(spacing: 8) {
                            TextField("City", text: $a.city).textContentType(.addressCity)
                            Divider()
                            TextField("State", text: $a.region).textContentType(.addressState).frame(width: 52)
                        }
                        Divider()
                        HStack(spacing: 8) {
                            TextField("ZIP", text: $a.postalCode).textContentType(.postalCode).keyboardType(.numbersAndPunctuation)
                            Divider()
                            TextField("Country", text: $a.country).textContentType(.countryName)
                        }
                    }
                }
                .padding(.vertical, 4)
            }
            .onDelete { addresses.remove(atOffsets: $0) }
            Button {
                addresses.append(PostalAddress(label: "home"))
            } label: {
                Label("Add address", systemImage: "plus.circle.fill")
            }
        }
    }

    // MARK: Load and save

    private func load() {
        guard !loaded else { return }
        loaded = true
        guard let c = original?.card else {
            phones = [Labeled(value: "", label: "mobile")]
            emails = [Labeled(value: "", label: "home")]
            return
        }
        given = c.givenName
        family = c.familyName
        organization = c.organization
        title = c.title
        phones = c.phones
        emails = c.emails
        urls = c.urls
        addresses = c.addresses
        notes = c.notes
    }

    private func clean(_ list: [Labeled]) -> [[String: String]] {
        list.map { ["value": $0.value.trimmingCharacters(in: .whitespaces), "label": $0.label] }.filter { !($0["value"] ?? "").isEmpty }
    }

    /// Only what changed goes to Google, so nothing else on the contact is touched.
    private func edits() -> [String: Any] {
        let c = original?.card
        var e: [String: Any] = [:]
        func text(_ key: String, _ now: String, _ was: String?) {
            let v = now.trimmingCharacters(in: .whitespacesAndNewlines)
            if v != (was ?? "") { e[key] = v }
        }
        text("givenName", given, c?.givenName)
        text("familyName", family, c?.familyName)
        text("organization", organization, c?.organization)
        text("title", title, c?.title)
        text("notes", notes, c?.notes)
        for (key, now, was) in [("phones", phones, c?.phones), ("emails", emails, c?.emails), ("urls", urls, c?.urls)] {
            let n = clean(now)
            if n != clean(was ?? []) { e[key] = n }
        }
        let a = addresses.filter { !$0.isEmpty }.map(\.parts)
        if a != (c?.addresses ?? []).filter({ !$0.isEmpty }).map(\.parts) { e["addresses"] = a }
        return e
    }

    private func save() async {
        let edit = edits()
        saving = true
        defer { saving = false }
        do {
            switch mode {
            case .new:
                guard edit["givenName"] != nil || edit["familyName"] != nil || edit["organization"] != nil
                    || edit["phones"] != nil || edit["emails"] != nil else {
                    error = "Add a name, company, phone or email."
                    return
                }
                guard let accountId = list?.accountId ?? store.accounts.first?.id else { return }
                var edit = edit
                if let list { edit["groups"] = [list.id] }
                let d = try await store.create(accountId: accountId, edit: edit, draft: asDraft)
                if let p = newPhoto { try await store.setPhoto(d.id, etag: d.etag, jpeg: p.jpeg, original: p.original.jpegData(compressionQuality: 0.9), crop: p.crop) }
            case let .edit(d):
                var etag = d.etag
                if !edit.isEmpty { etag = try await store.saveEdit(d.id, etag: etag, edit: edit).etag }
                if let p = newPhoto {
                    try await store.setPhoto(d.id, etag: etag, jpeg: p.jpeg, original: p.original.jpegData(compressionQuality: 0.9), crop: p.crop)
                } else if removePhoto {
                    try await store.deletePhoto(d.id, etag: etag)
                }
            }
            dismiss()
        } catch let e as APIError where e.code == "conflict" {
            error = "This contact changed in Google since you opened it. It’s been reloaded; close this and make your edit again."
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func delete() async {
        guard let d = original else { return }
        saving = true
        defer { saving = false }
        do {
            try await store.deleteContact(d.id, etag: d.etag)
            dismiss()
            onDeleted()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
