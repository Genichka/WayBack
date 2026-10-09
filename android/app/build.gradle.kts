plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/* Веб-частина WayBack лежить у корені репозиторію, на рівень вище за android/.
   Її файли копіюються в APK під час збірки, тож телефон і машина працюють
   без інтернету з першого запуску. */
val webRoot: File = rootProject.projectDir.parentFile
val appVersion: String = Regex("APP_VERSION\\s*=\\s*'([^']+)'")
    .find(File(webRoot, "app.js").readText())?.groupValues?.get(1) ?: "1.0.0"
// кожна збірка на GitHub отримує більший номер — Android дозволяє ставити її поверх старої
val buildNo: Int = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 1

val genDir: File = layout.buildDirectory.get().asFile.resolve("generated/wayback")
val webFiles = listOf(
    "index.html", "style.css", "app.js", "leaflet.js", "leaflet.css", "qr.js",
    "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png",
)

val copyWeb by tasks.registering(Copy::class) {
    from(webRoot) { include(webFiles) }
    into(genDir.resolve("assets/www"))
}
val copyIcon by tasks.registering(Copy::class) {
    from(webRoot) {
        include("icon-512.png")
        rename { "ic_launcher.png" }
    }
    into(genDir.resolve("res/mipmap-xxxhdpi"))
}

android {
    namespace = "ua.genichka.wayback"
    compileSdk = 34

    defaultConfig {
        applicationId = "ua.genichka.wayback"
        minSdk = 29
        targetSdk = 34
        versionCode = 1000 + buildNo
        versionName = "$appVersion ($buildNo)"
    }

    signingConfigs {
        create("wayback") {
            storeFile = file("wayback.keystore")
            storeType = "pkcs12"
            storePassword = "wayback"
            keyAlias = "wayback"
            keyPassword = "wayback"
        }
    }

    buildTypes {
        getByName("debug") {
            signingConfig = signingConfigs.getByName("wayback")
        }
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("wayback")
        }
    }

    sourceSets["main"].assets.srcDir(genDir.resolve("assets"))
    sourceSets["main"].res.srcDir(genDir.resolve("res"))

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

tasks.named("preBuild") { dependsOn(copyWeb, copyIcon) }

dependencies {
    implementation("androidx.car.app:app:1.4.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.core:core-ktx:1.13.1")
}
