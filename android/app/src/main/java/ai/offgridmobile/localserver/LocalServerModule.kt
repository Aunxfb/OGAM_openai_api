package ai.offgridmobile.localserver

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import ai.offgridmobile.SafePromise
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * React bridge for the on-device llama-server. Method names, event names, and
 * payload shapes are EXACTLY the TS contract in
 * `src/services/localServer/contract.ts` — the iOS module mirrors them
 * (same names, same payloads, same persistence/cleanup/error semantics).
 *
 * - start(config) → status map; rejects fail-closed (bad config, EADDRINUSE,
 *   bad cert) with a clear message, never a half-open socket.
 * - stop() → tears down socket + foreground service + wakelock.
 * - getStatus() → current status map.
 * - Events: LocalServerStatus (status map) + LocalServerError ({message}) +
 *   LocalServerRequest ({requestId, method, path, headers, body}) — JS answers
 *   each request via respondToRequest (single JSON) or the sendChunk /
 *   finishStream pair (SSE); the socket thread waits bounded (15 min).
 * - getCertificateFingerprint() → served-cert fingerprint for the trust UI.
 * - regenerateCertificate() → rotate the persisted self-signed identity.
 */
class LocalServerModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var server: LocalServerHttp? = null
    private var lastError: String? = null
    private var lastConfig: LocalServerConfig? = null

    override fun getName(): String = LocalServerRouter.MODULE_NAME

    override fun onCatalystInstanceDestroy() {
        scope.launch { tearDown() }
        scope.cancel()
        super.onCatalystInstanceDestroy()
    }

    @ReactMethod
    fun start(configMap: ReadableMap, promise: Promise) {
        val safe = SafePromise(promise, TAG)
        scope.launch {
            try {
                if (server != null) {
                    safe.resolve(statusMap())
                    return@launch
                }
                val config = LocalServerConfig.fromMap(configMap)
                val http = LocalServerHttp(
                    reactApplicationContext,
                    config,
                    onError = { message ->
                        lastError = message
                        sendError(message)
                    },
                    emitRequest = { requestId, method, path, headers, body ->
                        sendRequest(requestId, method, path, headers, body)
                    },
                )
                http.start()
                server = http
                lastConfig = config
                lastError = null
                LocalServerForegroundService.start(reactApplicationContext)
                val status = statusMap()
                sendStatus(status)
                safe.resolve(status)
            } catch (e: Exception) {
                lastError = e.message
                sendError(e.message ?: "Failed to start local server")
                safe.reject("LOCAL_SERVER_ERROR", e.message ?: "Failed to start local server")
            }
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        val safe = SafePromise(promise, TAG)
        scope.launch {
            tearDown()
            safe.resolve(null)
        }
    }

    @ReactMethod
    fun getStatus(promise: Promise) {
        SafePromise(promise, TAG).resolve(statusMap())
    }

    /**
     * True when the app was opened from the server notification (tap opens
     * the Local Server screen — consumed once by the T7 screen on mount).
     */
    @ReactMethod
    fun consumePendingOpenRequest(promise: Promise) {
        val pending = pendingOpenRequest
        pendingOpenRequest = false
        SafePromise(promise, TAG).resolve(pending)
    }

    /** Answer one delegated request with a final response (unknown ids ignored). */
    @ReactMethod
    fun respondToRequest(
        requestId: String,
        status: Double,
        body: String,
        contentType: String?,
        extraHeaders: ReadableMap?,
        promise: Promise,
    ) {
        val safe = SafePromise(promise, TAG)
        scope.launch {
            try {
                val headers = mutableMapOf<String, String>()
                extraHeaders?.entryIterator?.forEach { entry ->
                    (entry.value as? String)?.let { headers[entry.key] = it }
                }
                server?.respondToRequest(requestId, status.toInt(), body, contentType ?: "application/json", headers)
                safe.resolve(null)
            } catch (e: Exception) {
                safe.reject("LOCAL_SERVER_ERROR", e.message ?: "Failed to answer request")
            }
        }
    }

    /** Append one SSE payload to a delegated stream. */
    @ReactMethod
    fun sendChunk(requestId: String, sseData: String, promise: Promise) {
        try {
            server?.sendChunk(requestId, sseData)
            SafePromise(promise, TAG).resolve(null)
        } catch (e: Exception) {
            SafePromise(promise, TAG).reject("LOCAL_SERVER_ERROR", e.message ?: "Failed to send chunk")
        }
    }

    /** End a delegated SSE stream (native appends `data: [DONE]`). */
    @ReactMethod
    fun finishStream(requestId: String, promise: Promise) {
        try {
            server?.finishStream(requestId)
            SafePromise(promise, TAG).resolve(null)
        } catch (e: Exception) {
            SafePromise(promise, TAG).reject("LOCAL_SERVER_ERROR", e.message ?: "Failed to finish stream")
        }
    }

    /** Served-cert SHA-256 fingerprint for the trust UI; null when TLS is off. */
    @ReactMethod
    fun getCertificateFingerprint(promise: Promise) {
        val safe = SafePromise(promise, TAG)
        scope.launch {
            try {
                val config = lastConfig
                val cert = if (config != null) LocalServerTls.certificateFor(reactApplicationContext, config) else null
                if (cert != null) safe.resolve(LocalServerTls.fingerprintHex(cert)) else safe.resolve(null)
            } catch (_: Exception) {
                safe.resolve(null)
            }
        }
    }

    /** Rotate the persisted self-signed identity; resolves the new fingerprint. */
    @ReactMethod
    fun regenerateCertificate(promise: Promise) {
        val safe = SafePromise(promise, TAG)
        scope.launch {
            try {
                val cert = LocalServerTls.regenerateSelfSigned(reactApplicationContext)
                safe.resolve(LocalServerTls.fingerprintHex(cert))
            } catch (e: Exception) {
                safe.reject("LOCAL_SERVER_ERROR", e.message ?: "Failed to regenerate certificate")
            }
        }
    }

    private fun tearDown() {
        try { server?.stop() } catch (_: Exception) {}
        server = null
        lastConfig = null
        try { LocalServerForegroundService.stop(reactApplicationContext) } catch (_: Exception) {}
    }

    private fun statusMap(): com.facebook.react.bridge.WritableMap {
        val http = server
        val caps = Arguments.createMap()
        caps.putBoolean("backgroundServe", true)
        caps.putBoolean("wakeLock", true)
        return Arguments.createMap().apply {
            putBoolean("running", http != null)
            putArray("urls", Arguments.fromList(http?.baseUrls() ?: emptyList<String>()))
            putInt("requestsServed", http?.servedCount() ?: 0)
            if (lastError != null) putString("lastError", lastError) else putNull("lastError")
            putMap("capabilities", caps)
        }
    }

    private fun sendStatus(status: com.facebook.react.bridge.WritableMap) {
        try {
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(LocalServerRouter.EVENT_STATUS, status)
        } catch (_: Exception) {}
    }

    private fun sendError(message: String) {
        try {
            val payload = Arguments.createMap().apply { putString("message", message) }
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(LocalServerRouter.EVENT_ERROR, payload)
        } catch (_: Exception) {}
    }

    private fun sendRequest(
        requestId: String,
        method: String,
        path: String,
        headers: Map<String, String>,
        body: String,
    ) {
        try {
            val headersMap = Arguments.createMap()
            for ((k, v) in headers) headersMap.putString(k, v)
            val payload = Arguments.createMap().apply {
                putString("requestId", requestId)
                putString("method", method)
                putString("path", path)
                putMap("headers", headersMap)
                putString("body", body)
            }
            reactApplicationContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(LocalServerRouter.EVENT_REQUEST, payload)
        } catch (e: Exception) {
            server?.respondToRequest(requestId, 500, """{"error":{"message":"internal error"}}""")
        }
    }

    companion object {
        private const val TAG = "LocalServer"
        @Volatile var pendingOpenRequest: Boolean = false
    }
}
