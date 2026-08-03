package com.forgeax.player

import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader

/**
 * Wraps [WebViewAssetLoader.AssetsPathHandler] to fix MIME types for engine
 * artefacts AND attach permissive CORS headers.
 *
 * Two independent problems this fixes:
 *  1. MIME: the default handler guesses MIME from the filename and returns
 *     null/application/octet-stream for `.wasm`, which makes
 *     `WebAssembly.instantiateStreaming` fail. We force the correct types.
 *  2. CORS on runtime `import()`: an ES module (and any `crossorigin` fetch) is
 *     fetched in CORS mode. A response returned from `shouldInterceptRequest`
 *     is treated by WebView as coming from an opaque origin unless it carries
 *     an `Access-Control-Allow-Origin` header — see Chromium's WebView CORS doc
 *     (android_webview/docs/cors-and-webview-api.md). The initial
 *     `<script type=module>` in index.html loads as a navigation subresource
 *     and slips through, but a JS-initiated runtime `import()` of a code-split
 *     chunk (e.g. the lazily-loaded physics / @dimforge rapier chunk) fails
 *     with `TypeError: Failed to fetch dynamically imported module` even though
 *     the file ships in the APK. Reflecting `Access-Control-Allow-Origin: *`
 *     on every response makes those module + fetch() requests resolve.
 */
class ForgeaxPathHandler(
    private val inner: WebViewAssetLoader.AssetsPathHandler
) : WebViewAssetLoader.PathHandler {
    override fun handle(path: String): WebResourceResponse? {
        // WebViewAssetLoader already stripped the "/public/" route prefix, but the
        // game ships under assets/public/ and AssetsPathHandler is rooted at assets/.
        // Re-add the segment so the real file is found (otherwise every request —
        // starting with index.html — misses and the WebView reports
        // net::ERR_INVALID_RESPONSE).
        val assetPath = "public/" + path.removePrefix("/")
        val res = inner.handle(assetPath) ?: return null
        val mime = when {
            path.endsWith(".wasm") -> "application/wasm"
            path.endsWith(".js") || path.endsWith(".mjs") -> "text/javascript"
            path.endsWith(".glb") -> "model/gltf-binary"
            path.endsWith(".gltf") -> "model/gltf+json"
            else -> res.mimeType
        }
        // `*` is the correct value for a virtual https origin processed as opaque
        // by the intercept path; the game uses no credentialed cross-origin
        // requests, so a wildcard is both sufficient and safe.
        val headers = mapOf("Access-Control-Allow-Origin" to "*")
        return WebResourceResponse(mime, res.encoding, 200, "OK", headers, res.data)
    }
}
