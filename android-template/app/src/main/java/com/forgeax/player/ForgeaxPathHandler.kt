package com.forgeax.player

import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader

/**
 * Wraps [WebViewAssetLoader.AssetsPathHandler] to fix MIME types for engine
 * artefacts. The default handler guesses MIME from the filename and returns
 * null/application/octet-stream for `.wasm`, which makes
 * `WebAssembly.instantiateStreaming` fail. We force the correct types.
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
            else -> return res
        }
        return WebResourceResponse(mime, res.encoding, res.data)
    }
}
