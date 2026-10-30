import Foundation

struct APIError: LocalizedError {
    let status: Int
    let message: String
    let code: String?
    /// On a 409 conflict the server sends the contact as it is now.
    let contact: ContactDetail?

    var errorDescription: String? { message }
}

/// Talks to the Ligature server (the same API the web app uses), authenticated with the
/// session token from sign-in.
final class API {
    var baseURL: URL
    var token: String?

    init(baseURL: URL, token: String?) {
        self.baseURL = baseURL
        self.token = token
    }

    private let decoder = JSONDecoder()

    func get<T: Decodable>(_ path: String) async throws -> T {
        try await send("GET", path, body: nil)
    }

    func post<T: Decodable>(_ path: String, _ body: [String: Any]) async throws -> T {
        try await send("POST", path, body: body)
    }

    func put<T: Decodable>(_ path: String, _ body: [String: Any]) async throws -> T {
        try await send("PUT", path, body: body)
    }

    func patch<T: Decodable>(_ path: String, _ body: [String: Any]) async throws -> T {
        try await send("PATCH", path, body: body)
    }

    func delete<T: Decodable>(_ path: String) async throws -> T {
        try await send("DELETE", path, body: nil)
    }

    private func send<T: Decodable>(_ method: String, _ path: String, body: [String: Any]?) async throws -> T {
        guard let url = URL(string: "/api" + path, relativeTo: baseURL) else {
            throw APIError(status: 0, message: "Bad server address.", code: nil, contact: nil)
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 60
        req.setValue("application/json", forHTTPHeaderField: "accept")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "authorization") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "content-type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: req)
        } catch {
            throw APIError(status: 0, message: "Couldn’t reach Ligatures. Check your connection.", code: "offline", contact: nil)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let b = try? decoder.decode(ErrorBody.self, from: data)
            throw APIError(status: status, message: b?.error ?? "Something went wrong (\(status)).", code: b?.code, contact: b?.contact)
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError(status: status, message: "The server sent something this version of the app doesn’t understand.", code: "decode", contact: nil)
        }
    }
}

/// What the server sends with an error.
private struct ErrorBody: Decodable {
    let error: String?
    let code: String?
    let contact: ContactDetail?
}

/// For calls whose answer we don’t need.
struct Empty: Decodable {}
