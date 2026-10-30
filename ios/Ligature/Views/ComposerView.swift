import AuthenticationServices
import MessageUI
import SwiftUI

/// Message a group of people: write once (with fields like {{First name}}), check who gets
/// what, then send. Email goes out through Gmail by itself; texts open in Messages one person
/// (or one group) at a time; WhatsApp and Signal open their apps.
struct ComposerView: View {
    let ids: [String]
    var onFinished: () -> Void = {}

    @Environment(Store.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @Environment(\.webAuthenticationSession) private var webAuth

    private enum Step { case compose, review, send, done }
    private enum Focus { case subject, body }
    private enum Outcome: Equatable { case sent, skipped, failed(String) }

    private struct Item {
        let people: [Person]
        let addresses: [String]
        let subject: String
        let body: String
        var title: String { people.count == 1 ? (people[0].displayName.isEmpty ? addresses[0] : people[0].displayName) : "\(people.count) people" }
    }

    private struct TextJob: Identifiable {
        let id = UUID()
        let recipients: [String]
        let body: String
    }

    @State private var step: Step = .compose
    @State private var people: [Person] = []
    @State private var loading = true
    @State private var channel: Channel = .text
    @State private var group = false
    @State private var bcc = true
    @State private var accountId = ""
    @State private var subject = ""
    @State private var message = ""
    @FocusState private var focus: Focus?
    @State private var lastFocus: Focus = .body
    @State private var skipped: Set<String> = []
    @State private var picks: [String: String] = [:]

    @State private var items: [Item] = []
    @State private var results: [Int: Outcome] = [:]
    @State private var index = 0
    @State private var sending = false
    @State private var stopping = false
    @State private var opened = false
    @State private var textJob: TextJob?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView()
                } else {
                    switch step {
                    case .compose: composeStep
                    case .review: reviewStep
                    case .send: sendStep
                    case .done: doneStep
                    }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
        }
        .interactiveDismissDisabled(step == .send)
        .task { await load() }
        .sheet(item: $textJob) { job in
            MessageComposer(recipients: job.recipients, body: job.body) { result in
                textJob = nil
                textFinished(result)
            }
            .ignoresSafeArea()
        }
        .alert("Couldn’t Send", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(error ?? "")
        }
        .storeAlert()
    }

    // MARK: - Who, and at which address

    private func options(_ p: Person) -> [Labeled] { channel.needsEmail ? p.emails : p.phones }

    private func pickKey(_ p: Person) -> String { "\(channel.needsEmail ? "e" : "p"):\(p.id)" }

    private func address(_ p: Person) -> String {
        let opts = options(p)
        if let picked = picks[pickKey(p)], opts.contains(where: { $0.value == picked }) { return picked }
        return channel.needsEmail ? Address.defaultEmail(opts) : Address.defaultPhone(opts)
    }

    private var reachable: [Person] { people.filter { !address($0).isEmpty } }
    private var unreachable: [Person] { people.filter { address($0).isEmpty } }
    private var included: [Person] { reachable.filter { !skipped.contains($0.id) } }

    private var problems: [String] {
        let texts = channel == .email ? [subject, message] : [message]
        var out: [String] = []
        let unknown = Template.unknown(texts, fields: store.fields)
        if !unknown.isEmpty { out.append("No field called \(unknown.map { "“\($0)”" }.joined(separator: ", ")). Use Insert Field to pick one.") }
        if group && texts.contains(where: { !Template.tags(in: $0).isEmpty }) {
            out.append("Fields like {{First name}} only work when sending individually.")
        }
        return out
    }

    private var canReview: Bool {
        !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (channel != .email || !subject.trimmingCharacters(in: .whitespaces).isEmpty)
            && problems.isEmpty && !reachable.isEmpty
    }

    private var sender: Account? { store.accounts.first { $0.id == accountId } ?? store.accounts.first }

    // MARK: - Compose

    private var composeStep: some View {
        Form {
            Section("To") {
                Text(people.count == 1 ? (people[0].displayName) : "\(people.count) people")
                    .font(.app(.headline))
                if people.count > 1 {
                    Text(people.prefix(8).map { $0.displayName.isEmpty ? "No name" : $0.displayName }.joined(separator: ", ") + (people.count > 8 ? ", and \(people.count - 8) more" : ""))
                        .font(.app(.footnote))
                        .foregroundStyle(.secondary)
                }
            }
            Section {
                Picker("Send by", selection: $channel) {
                    ForEach(Channel.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                if channel.canGroup {
                    Picker("How", selection: $group) {
                        Text("Individually").tag(false)
                        Text("As a group").tag(true)
                    }
                    .pickerStyle(.segmented)
                }
                if channel == .email && group {
                    Picker("Recipients", selection: $bcc) {
                        Text("BCC (private)").tag(true)
                        Text("To (everyone sees)").tag(false)
                    }
                }
                if channel == .email && store.accounts.count > 1 {
                    Picker("From", selection: $accountId) {
                        ForEach(store.accounts) { Text($0.label ?? $0.providerName).tag($0.id) }
                    }
                }
            } footer: {
                Text(howNote)
            }
            Section {
                if channel == .email {
                    TextField("Subject", text: $subject)
                        .focused($focus, equals: .subject)
                }
                TextField("Message", text: $message, axis: .vertical)
                    .lineLimit(6...18)
                    .focused($focus, equals: .body)
                Menu {
                    ForEach(Template.builtins + store.fields.map(\.label), id: \.self) { label in
                        Button(label) { insert(label) }
                    }
                } label: {
                    Label("Insert Field", systemImage: "curlybraces")
                }
                .disabled(group)
            } footer: {
                if problems.isEmpty {
                    Text(group ? "Everyone gets the same message." : "Add a fallback for blanks: {{First name|there}}")
                } else {
                    Text(problems.joined(separator: " ")).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("New Message")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            ToolbarItem(placement: .confirmationAction) {
                Button("Review") { step = .review }.disabled(!canReview)
            }
        }
        .onChange(of: channel) { _, c in if !c.canGroup { group = false } }
        .onChange(of: focus) { _, f in if let f { lastFocus = f } }
    }

    private var howNote: String {
        switch (channel, group) {
        case (.text, false): return "Each person gets their own text, with their name and fields filled in. Messages opens for each one; tap Send."
        case (.text, true): return "One group conversation in Messages."
        case (.email, false): return "Each person gets their own email from your Gmail, sent by Ligature."
        case (.email, true): return "One email to everyone, from your Gmail."
        case (.whatsapp, _): return "WhatsApp opens for each person with the message filled in; tap Send there."
        case (.signal, _): return "Signal can’t take a message from another app: Ligature copies it, opens the chat, and you paste."
        }
    }

    private func insert(_ label: String) {
        let tag = "{{\(label)}}"
        if lastFocus == .subject && channel == .email {
            subject += (subject.isEmpty || subject.hasSuffix(" ") ? "" : " ") + tag
        } else {
            message += (message.isEmpty || message.hasSuffix(" ") || message.hasSuffix("\n") ? "" : " ") + tag
        }
    }

    // MARK: - Review

    private var reviewStep: some View {
        List {
            Section {
                ForEach(reachable) { p in reviewRow(p) }
            } header: {
                HStack {
                    Text("\(included.count) of \(reachable.count) \(reachable.count == 1 ? "person" : "people")")
                    Spacer()
                    Button(included.count < reachable.count ? "Include All" : "Untick All") {
                        skipped = included.count < reachable.count ? [] : Set(reachable.map(\.id))
                    }
                    .font(.app(.footnote))
                    .textCase(nil)
                }
            } footer: {
                if !unreachable.isEmpty {
                    Text("Left out \(unreachable.count) with no \(channel.needsEmail ? "email address" : "phone number"): \(unreachable.prefix(6).map(\.displayName).joined(separator: ", "))\(unreachable.count > 6 ? ", and \(unreachable.count - 6) more" : "").")
                }
            }
            if group {
                Section("Message") {
                    if channel == .email { Text(subject).bold() }
                    Text(message)
                }
            }
        }
        .navigationTitle("Review")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Edit") { step = .compose } }
        }
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: 8) {
                if channel == .email, sender?.canEmail != true {
                    Text("Ligature needs your permission to send email from your Gmail. Google asks once; Ligature can send but can’t read your mail.")
                        .font(.app(.footnote))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button { Task { await connectGmail() } } label: { Text("Connect Gmail").frame(maxWidth: .infinity) }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                } else {
                    Button { startSending() } label: { Text(sendLabel).frame(maxWidth: .infinity) }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .disabled(included.isEmpty || (channel == .email && group && included.count > 100))
                    if channel == .email && group && included.count > 100 {
                        Text("Gmail takes at most 100 people on one email.").font(.app(.footnote)).foregroundStyle(.red)
                    }
                }
            }
            .padding()
            .background(.bar)
        }
    }

    private var sendLabel: String {
        let n = included.count
        switch channel {
        case .email: return group ? "Send to \(n) \(n == 1 ? "Person" : "People")" : "Send \(n) \(n == 1 ? "Email" : "Emails")"
        default: return group ? "Continue" : "Start (\(n))"
        }
    }

    @ViewBuilder
    private func reviewRow(_ p: Person) -> some View {
        let on = !skipped.contains(p.id)
        let opts = options(p)
        HStack(alignment: .top, spacing: 12) {
            Button {
                if on { skipped.insert(p.id) } else { skipped.remove(p.id) }
            } label: {
                Image(systemName: on ? "checkmark.circle.fill" : "circle")
                    .font(.app(.title3))
                    .foregroundStyle(on ? Color.accentColor : Color(.tertiaryLabel))
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(on ? "Included" : "Left out")
            VStack(alignment: .leading, spacing: 3) {
                Text(p.displayName.isEmpty ? address(p) : p.displayName).foregroundStyle(on ? Color.primary : Color.secondary)
                if opts.count > 1 {
                    Menu {
                        ForEach(opts) { o in
                            Button { picks[pickKey(p)] = o.value } label: {
                                Text(o.value)
                                if !o.label.isEmpty { Text(o.label) }
                            }
                        }
                    } label: {
                        HStack(spacing: 2) {
                            Text(address(p))
                            Image(systemName: "chevron.up.chevron.down").font(.app(.caption2))
                        }
                        .font(.app(.subheadline))
                    }
                } else {
                    Text(address(p)).font(.app(.subheadline)).foregroundStyle(.secondary)
                }
                if !group {
                    let s = channel == .email ? Template.render(subject, for: p, fields: store.fields) : nil
                    let b = Template.render(message, for: p, fields: store.fields)
                    let blanks = Array(Set((s?.blanks ?? []) + b.blanks))
                    if let s { Text(s.text).font(.app(.footnote, .semibold)).lineLimit(1) }
                    Text(b.text).font(.app(.footnote)).foregroundStyle(.secondary).lineLimit(4)
                    if !blanks.isEmpty {
                        Text("Blank: \(blanks.joined(separator: ", "))").font(.app(.caption)).foregroundStyle(.orange)
                    }
                }
            }
            .opacity(on ? 1 : 0.6)
        }
        .padding(.vertical, 2)
    }

    // MARK: - Sending

    private func buildItems() -> [Item] {
        let ppl = included
        if group {
            return [Item(people: ppl, addresses: ppl.map(address), subject: subject, body: message)]
        }
        return ppl.map { p in
            Item(people: [p], addresses: [address(p)],
                 subject: Template.render(subject, for: p, fields: store.fields).text,
                 body: Template.render(message, for: p, fields: store.fields).text)
        }
    }

    private func startSending() {
        items = buildItems()
        results = [:]
        index = 0
        opened = false
        step = .send
        if channel == .email {
            Task { await sendEmails() }
        } else if channel == .text && MFMessageComposeViewController.canSendText() {
            openCurrent()
        }
    }

    private func sendEmails() async {
        guard let account = sender else { return }
        sending = true
        stopping = false
        defer { sending = false }
        for i in items.indices where results[i] != .sent {
            if stopping { break }
            index = i
            let it = items[i]
            do {
                try await store.sendEmail(
                    accountId: account.id, group: group, bcc: bcc,
                    recipients: zip(it.people, it.addresses).map { (id: $0.id, email: $1, name: $0.displayName) },
                    subject: it.subject, body: it.body
                )
                results[i] = .sent
            } catch let e as APIError {
                results[i] = .failed(e.message)
                if e.code == "gmail_scope" {
                    await store.reloadSession()
                    error = "Ligature lost permission to send from this Gmail. Go back, connect Gmail, and send the rest."
                    break
                }
                if e.code == "rate_limited" || e.code == "offline" || e.code == "signed_out" || e.status >= 500 { break }
            } catch {
                results[i] = .failed(error.localizedDescription)
            }
        }
        if items.indices.allSatisfy({ results[$0] == .sent }) { step = .done }
    }

    /// Open the current text, WhatsApp or Signal message.
    private func openCurrent() {
        guard index < items.count else { return }
        let it = items[index]
        opened = true
        switch channel {
        case .text:
            if MFMessageComposeViewController.canSendText() {
                textJob = TextJob(recipients: it.addresses.map(Address.e164), body: it.body)
            } else if let u = Address.sms(it.addresses, body: it.body) {
                openURL(u)
            }
        case .whatsapp:
            if let u = Address.whatsapp(it.addresses[0], body: it.body) { openURL(u) }
        case .signal:
            copyToClipboard(it.body)
            if let u = Address.signal(it.addresses[0]) { openURL(u) }
        case .email:
            break
        }
    }

    private func textFinished(_ result: MessageComposeResult) {
        switch result {
        case .sent:
            mark(.sent)
            // Straight on to the next person, so it’s just Send, Send, Send.
            if index < items.count {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { if step == .send && textJob == nil { openCurrent() } }
            }
        case .failed:
            error = "Messages couldn’t send that one."
            opened = false
        default:
            opened = false // cancelled: stay here so you can try again or skip
        }
    }

    private func mark(_ outcome: Outcome) {
        results[index] = outcome
        index += 1
        opened = false
        if index >= items.count { step = .done }
    }

    private var sendStep: some View {
        VStack(spacing: 0) {
            if channel == .email {
                emailProgress
            } else if index < items.count {
                queueCard(items[index])
            }
        }
        .navigationTitle(channel == .email ? "Sending" : "\(min(index + 1, items.count)) of \(items.count)")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                if channel == .email && sending {
                    Button("Stop") { stopping = true }
                } else {
                    Button("Finish") { step = .done }
                }
            }
        }
    }

    private var emailProgress: some View {
        let sent = results.values.filter { $0 == .sent }.count
        let failed = items.indices.compactMap { i -> (Item, String)? in
            if case let .failed(msg) = results[i] { return (items[i], msg) }
            return nil
        }
        return List {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    ProgressView(value: Double(sent), total: Double(max(items.count, 1)))
                    Text(sending ? "Sending \(min(index + 1, items.count)) of \(items.count)…" : "Sent \(sent) of \(items.count).")
                        .font(.app(.subheadline))
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 6)
            }
            if !failed.isEmpty {
                Section("Didn’t send") {
                    ForEach(Array(failed.enumerated()), id: \.offset) { _, f in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(f.0.title)
                            Text(f.1).font(.app(.footnote)).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            if !sending && sent < items.count {
                Section {
                    if sender?.canEmail == true {
                        Button("Send the Rest") { Task { await sendEmails() } }
                    } else {
                        Button("Connect Gmail") { Task { await connectGmail() } }
                    }
                }
            }
        }
    }

    private func queueCard(_ it: Item) -> some View {
        VStack(spacing: 16) {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(it.title).font(.app(.title2, .semibold))
                    Text(it.addresses.joined(separator: ", ")).font(.app(.subheadline)).foregroundStyle(.secondary)
                    Text(it.body)
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color(.secondarySystemBackground)))
                        .textSelection(.enabled)
                }
                .padding()
            }
            VStack(spacing: 10) {
                Button { openCurrent() } label: { Text(openLabel).frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                HStack(spacing: 10) {
                    Button { mark(.skipped) } label: { Text(group ? "Didn’t Send" : "Skip").frame(maxWidth: .infinity) }
                        .buttonStyle(.bordered)
                    // Messages tells Ligature when a text is sent; other apps don’t, so you say.
                    if channel != .text || !MFMessageComposeViewController.canSendText() {
                        Button { mark(.sent) } label: { Text(index == items.count - 1 || group ? "Sent" : "Sent · Next").frame(maxWidth: .infinity) }
                            .buttonStyle(.bordered)
                            .disabled(!opened)
                    }
                }
                .controlSize(.large)
            }
            .padding([.horizontal, .bottom])
        }
    }

    private var openLabel: String {
        switch channel {
        case .text: return opened ? "Open Messages Again" : "Open Messages"
        case .whatsapp: return opened ? "Open WhatsApp Again" : "Open WhatsApp"
        case .signal: return "Copy and Open Signal"
        case .email: return ""
        }
    }

    // MARK: - Done

    private var doneStep: some View {
        let sentItems = items.indices.filter { results[$0] == .sent }
        let people = sentItems.reduce(0) { $0 + items[$1].people.count }
        let failed = results.values.filter { if case .failed = $0 { return true } else { return false } }.count
        let skippedCount = items.count - sentItems.count - failed
        return VStack(spacing: 10) {
            Spacer()
            Image(systemName: people > 0 ? "checkmark.circle.fill" : "minus.circle")
                .font(.system(size: 48))
                .foregroundStyle(people > 0 ? Color.green : Color.secondary)
            Text(people > 0 ? "Messaged \(people) \(people == 1 ? "person" : "people") by \(channel.label.lowercased())." : "Nothing was sent.")
                .font(.app(.title3, .semibold))
                .multilineTextAlignment(.center)
            if failed > 0 { Text("\(failed) didn’t send.").foregroundStyle(.secondary) }
            if skippedCount > 0 { Text("\(skippedCount) skipped.").foregroundStyle(.secondary) }
            Spacer()
            Button { onFinished(); dismiss() } label: { Text("Done").frame(maxWidth: .infinity) }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
        }
        .padding()
        .navigationTitle("Done")
        .navigationBarBackButtonHidden()
    }

    // MARK: - Loading and Gmail

    private func load() async {
        guard loading else { return }
        accountId = store.accounts.first?.id ?? ""
        do {
            people = try await store.people(ids)
        } catch {
            store.handle(error)
        }
        loading = false
        if store.demo {
            message = "Hi {{First name|there}}, we’re having people over Saturday at 6. Hope you can come!"
            if store.demoScreen == "review" { step = .review }
        }
    }

    private func connectGmail() async {
        guard let account = sender else { return }
        do {
            let url = try await store.gmailConsentURL(accountId: account.id)
            let callback = try await webAuth.authenticate(using: url, callbackURLScheme: "ligature", preferredBrowserSession: .ephemeral)
            let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
            if let e = items.first(where: { $0.name == "error" })?.value { error = e }
            await store.reloadSession()
        } catch let e as ASWebAuthenticationSessionError where e.code == .canceledLogin {
            return
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Apple’s Messages sheet, filled in. Ligature hears back whether it was sent.
struct MessageComposer: UIViewControllerRepresentable {
    let recipients: [String]
    let body: String
    let onFinish: (MessageComposeResult) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

    func makeUIViewController(context: Context) -> MFMessageComposeViewController {
        let vc = MFMessageComposeViewController()
        vc.recipients = recipients
        vc.body = body
        vc.messageComposeDelegate = context.coordinator
        return vc
    }

    func updateUIViewController(_ vc: MFMessageComposeViewController, context: Context) {}

    final class Coordinator: NSObject, MFMessageComposeViewControllerDelegate {
        let onFinish: (MessageComposeResult) -> Void
        init(onFinish: @escaping (MessageComposeResult) -> Void) { self.onFinish = onFinish }

        func messageComposeViewController(_ controller: MFMessageComposeViewController, didFinishWith result: MessageComposeResult) {
            onFinish(result)
        }
    }
}
