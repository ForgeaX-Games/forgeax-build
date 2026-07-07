import UIKit
import WebKit

/// Custom scheme the local game is served under. A registered scheme handler
/// (see ForgeaxSchemeHandler) lets us serve the bundled web product with the
/// correct MIME types — mirroring the Android WebViewAssetLoader approach at
/// https://appassets.androidplatform.net/public/.
let kForgeaxScheme = "forgeax-app"
let kForgeaxIndexURL = "\(kForgeaxScheme)://public/index.html"

/// Full-screen WKWebView host for the exported ForgeaX game. The whole game is
/// a WebGPU/WebGL web app served from the app bundle's `public/` folder.
class ViewController: UIViewController {
    private var webView: WKWebView!

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(ForgeaxSchemeHandler(), forURLScheme: kForgeaxScheme)

        // Games often start audio/animation; don't require a user gesture.
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        let prefs = WKPreferences()
        prefs.javaScriptCanOpenWindowsAutomatically = false
        config.preferences = prefs

        let pagePrefs = WKWebpagePreferences()
        pagePrefs.allowsContentJavaScript = true
        config.defaultWebpagePreferences = pagePrefs

        webView = WKWebView(frame: .zero, configuration: config)
        webView.isOpaque = true
        webView.backgroundColor = .black
        webView.scrollView.backgroundColor = .black
        // A game canvas fills the viewport; no page scrolling / rubber-banding.
        webView.scrollView.bounces = false
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = false
        view = webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        if let url = URL(string: kForgeaxIndexURL) {
            webView.load(URLRequest(url: url))
        }
    }

    // Immersive full-screen: no status bar, draw into the safe-area/notch.
    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var preferredScreenEdgesDeferringSystemGestures: UIRectEdge { .all }
}
