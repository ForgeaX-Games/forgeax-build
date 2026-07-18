import Foundation
import WebKit

/// Serves the bundled web game (`public/` folder reference) over the custom
/// `forgeax-app://` scheme with correct MIME types.
///
/// WKWebView's generic handling returns `application/octet-stream` for `.wasm`,
/// which makes `WebAssembly.instantiateStreaming` fail — the same class of bug
/// the Android `ForgeaxPathHandler` fixes. We force the right Content-Type for
/// engine artefacts (wasm / js / glb …) so streaming instantiation and module
/// loading work.
final class ForgeaxSchemeHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url,
              let fileURL = resolveBundleURL(for: url) else {
            urlSchemeTask.didFailWithError(NSError(domain: "forgeax", code: 404))
            return
        }

        guard let data = try? Data(contentsOf: fileURL) else {
            urlSchemeTask.didFailWithError(NSError(domain: "forgeax", code: 404,
                userInfo: [NSLocalizedDescriptionKey: "not found: \(url.absoluteString)"]))
            return
        }

        let mime = mimeType(for: fileURL.pathExtension.lowercased())
        // Headers mirror a static server: correct type + permissive CORS so the
        // engine's fetch()/module loads (same-origin custom scheme) never trip.
        let headers = [
            "Content-Type": mime,
            "Content-Length": String(data.count),
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache",
        ]
        let response = HTTPURLResponse(url: url, statusCode: 200,
                                       httpVersion: "HTTP/1.1", headerFields: headers)!
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // Synchronous file reads — nothing to cancel.
    }

    /// Map `forgeax-app://public/assets/foo.js` → `<bundle>/public/assets/foo.js`.
    /// Host ("public") + path segments form the bundle-relative path. An empty
    /// path defaults to index.html.
    private func resolveBundleURL(for url: URL) -> URL? {
        guard let base = Bundle.main.resourceURL else { return nil }
        let host = url.host ?? ""
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        // Drop leading slash, keep the rest; percent-decode segments.
        let rel = (host + path).removingPercentEncoding ?? (host + path)
        let candidate = base.appendingPathComponent(rel).standardizedFileURL
        // Contain traversal within the bundle resource dir.
        guard candidate.path.hasPrefix(base.standardizedFileURL.path) else { return nil }
        return candidate
    }

    private func mimeType(for ext: String) -> String {
        switch ext {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "wasm": return "application/wasm"
        case "json": return "application/json; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "svg": return "image/svg+xml"
        case "ico": return "image/x-icon"
        case "glb": return "model/gltf-binary"
        case "gltf": return "model/gltf+json"
        case "bin", "ktx2", "hdr": return "application/octet-stream"
        case "wav": return "audio/wav"
        case "mp3": return "audio/mpeg"
        case "ogg": return "audio/ogg"
        case "ttf": return "font/ttf"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        default: return "application/octet-stream"
        }
    }
}
