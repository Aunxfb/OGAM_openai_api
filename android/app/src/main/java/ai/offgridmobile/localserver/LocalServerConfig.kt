package ai.offgridmobile.localserver

import com.facebook.react.bridge.ReadableMap

/**
 * Validated local-server config. Fail-closed: any invalid value throws
 * IllegalArgumentException with a clear message and the socket never opens.
 * Mirrors the ranges in `src/services/localServer/types.ts` (the TS side
 * validates first; this re-validates at the boundary — defense in depth).
 */
data class LocalServerConfig(
    val port: Int,
    val bindMode: String,
    val interfaceIp: String,
    val tlsMode: String,
    val certPath: String,
    val keyPath: String,
    val apiKey: String,
    val queueDepth: Int,
) {
    companion object {
        const val MIN_PORT = 1024
        const val MAX_PORT = 65535
        const val MIN_QUEUE = 1
        const val MAX_QUEUE = 32

        fun fromMap(map: ReadableMap): LocalServerConfig {
            val port = if (map.hasKey("port")) map.getInt("port") else 8080
            if (port < MIN_PORT || port > MAX_PORT) {
                throw IllegalArgumentException("Local server port must be $MIN_PORT-$MAX_PORT (got $port)")
            }
            val bindMode = if (map.hasKey("bindMode")) map.getString("bindMode") ?: "loopback" else "loopback"
            if (bindMode != "loopback" && bindMode != "interface" && bindMode != "all") {
                throw IllegalArgumentException("Local server bindMode must be loopback, interface, or all")
            }
            val interfaceIp = if (map.hasKey("interfaceIp")) map.getString("interfaceIp") ?: "" else ""
            if (bindMode == "interface" && interfaceIp.isBlank()) {
                throw IllegalArgumentException("Local server bind mode \"interface\" requires an interface IP")
            }
            val tlsMode = if (map.hasKey("tlsMode")) map.getString("tlsMode") ?: "off" else "off"
            if (tlsMode != "off" && tlsMode != "byoc" && tlsMode != "self-signed") {
                throw IllegalArgumentException("Local server tlsMode must be off, byoc, or self-signed")
            }
            val certPath = if (map.hasKey("certPath")) map.getString("certPath") ?: "" else ""
            val keyPath = if (map.hasKey("keyPath")) map.getString("keyPath") ?: "" else ""
            if (tlsMode == "byoc" && (certPath.isBlank() || keyPath.isBlank())) {
                throw IllegalArgumentException("Local server TLS \"byoc\" mode requires both a cert and a key file")
            }
            val queueDepth = if (map.hasKey("queueDepth")) map.getInt("queueDepth") else 4
            if (queueDepth < MIN_QUEUE || queueDepth > MAX_QUEUE) {
                throw IllegalArgumentException("Local server queue depth must be $MIN_QUEUE-$MAX_QUEUE (got $queueDepth)")
            }
            val apiKey = if (map.hasKey("apiKey")) map.getString("apiKey") ?: "" else ""
            return LocalServerConfig(port, bindMode, interfaceIp, tlsMode, certPath, keyPath, apiKey, queueDepth)
        }
    }

    /** Bind address for the listening socket. */
    fun bindAddress(): String = when (bindMode) {
        "all" -> "0.0.0.0"
        "interface" -> interfaceIp
        else -> "127.0.0.1"
    }

    fun isTls(): Boolean = tlsMode != "off"
}
