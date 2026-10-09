package ua.genichka.wayback

/** Ті самі шари, що й у app.js (LAYERS). Ключ плитки рахується так само, як tileKey() у вебі. */
object Layers {
    class Layer(
        val key: String,
        val name: String,
        val url: String,
        val subs: String,
        val maxZoom: Int,
        val attr: String,
    )

    val all: List<Layer> = listOf(
        Layer("topo", "Топо", "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", "abc", 17,
            "© OpenStreetMap, SRTM | © OpenTopoMap"),
        Layer("osm", "Схема", "https://tile.openstreetmap.org/{z}/{x}/{y}.png", "", 19,
            "© OpenStreetMap"),
        Layer("sat", "Супутник",
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", "", 18,
            "© Esri, Maxar, Earthstar Geographics"),
        Layer("dark", "Темна",
            "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", "", 16,
            "© Esri, HERE, Garmin, © OpenStreetMap"),
    )

    fun get(key: String?): Layer = all.firstOrNull { it.key == key } ?: all[0]

    fun next(key: String?): Layer {
        val i = all.indexOfFirst { it.key == key }
        return all[(i + 1).mod(all.size)]
    }

    fun url(l: Layer, z: Int, x: Int, y: Int): String {
        val s = if (l.subs.isEmpty()) "a" else l.subs[(x + y).mod(l.subs.length)].toString()
        return l.url.replace("{s}", s).replace("{z}", z.toString())
            .replace("{x}", x.toString()).replace("{y}", y.toString())
    }

    private val TILE_HOSTS = Regex("(^|\\.)(tile\\.openstreetmap\\.org|tile\\.opentopomap\\.org|arcgisonline\\.com)$")
    fun isTileHost(host: String?): Boolean = host != null && TILE_HOSTS.containsMatchIn(host)

    private val SUBDOMAIN = Regex("^https://[a-d]\\.")
    fun tileKey(url: String): String = url.replace(SUBDOMAIN, "https://").substringBefore('?')
}
