import AuthenticationServices
import SwiftUI

struct SignInView: View {
    @Environment(Store.self) private var store
    @Environment(\.webAuthenticationSession) private var webAuth
    @State private var busy = false
    @State private var error: String?
    @State private var showServer = false

    var body: some View {
        @Bindable var store = store
        VStack(spacing: 0) {
            Spacer()
            Image(systemName: "person.crop.circle")
                .font(.system(size: 44, weight: .regular))
                .foregroundStyle(.white)
                .frame(width: 84, height: 84)
                .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color.accentColor))
                .padding(.bottom, 20)
            Text("Ligatures")
                .font(.app(.largeTitle, .bold))
            Text("Your Google contacts, with notes of your own.")
                .font(.app(.body))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.top, 6)
            Spacer()

            if let error {
                Text(error)
                    .font(.app(.footnote))
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .padding(.bottom, 12)
            }

            Button {
                Task { await signIn() }
            } label: {
                HStack {
                    if busy { ProgressView().tint(.white) }
                    Text(busy ? "Signing In…" : "Sign In with Google")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(busy)

            HStack(spacing: 20) {
                Button("Try the Demo") { Task { await store.setDemo(true) } }
                Button(showServer ? "Hide Server" : "Server…") { showServer.toggle() }
            }
            .font(.app(.footnote))
            .padding(.top, 14)
            if showServer {
                VStack(alignment: .leading, spacing: 6) {
                    TextField("https://", text: $store.server)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .padding(10)
                        .background(RoundedRectangle(cornerRadius: 10).fill(Color(.secondarySystemBackground)))
                    Text("The Ligatures server to sign in to. Change it if you host your own.")
                        .font(.app(.caption))
                        .foregroundStyle(.secondary)
                }
                .padding(.top, 8)
            }
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 24)
    }

    private func signIn() async {
        let pkce = PKCE()
        guard let url = store.signInURL(pkce) else {
            error = "That server address isn’t valid."
            return
        }
        busy = true
        error = nil
        defer { busy = false }
        do {
            let callback = try await webAuth.authenticate(using: url, callbackURLScheme: "ligature", preferredBrowserSession: .ephemeral)
            try await store.completeSignIn(callback: callback, pkce: pkce)
        } catch let e as ASWebAuthenticationSessionError where e.code == .canceledLogin {
            return
        } catch {
            self.error = error.localizedDescription
        }
    }
}
