plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    // FIXED — matches the Kotlin package dir (com/forgeax/player). Do NOT change
    // per-game; only `applicationId` is replaced at export time.
    namespace = "com.forgeax.player"
    compileSdk = 34

    defaultConfig {
        // Replaced at export time by AndroidPackager (androidAppId).
        applicationId = "__FORGEAX_APPLICATION_ID__"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    androidResources {
        // aapt2's default ignore pattern contains the ".*" rule, which drops all
        // dot-prefixed files from the packaged APK. The web product may ship
        // GUID-referenced dotfiles under assets/public/game-assets/ (the exporter
        // does not rename those). Remove ".*" so they survive into the APK;
        // otherwise they 404 at runtime. (index.html-referenced dotfiles are
        // additionally renamed by the packager, so this is defense-in-depth.)
        ignoreAssetsPattern = "!.svn:!.git:!.ds_store:!*.scc:<dir>_*:!CVS:!thumbs.db:!picasa.ini:!*~"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    // WebViewAssetLoader — serves local assets over a secure https origin so
    // WebGPU / Secure-Context-gated APIs work without a local server.
    implementation("androidx.webkit:webkit:1.11.0")
}
