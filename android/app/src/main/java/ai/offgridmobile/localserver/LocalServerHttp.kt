package ai.offgridmobile.localserver

import android.content.Context
import android.util.Log
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.BindException
import java.net.InetAddress
import java.net.ServerSocket
import java.nio.charset.StandardCharsets
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.SSLServerSocket

/**
 * Minimal embedded HTTP/1.1 server for the v1 route set. No new network
 * dependencies: plain ServerSocket / SSLServerSocket with a bounded pool.
 * `Connection: close` throughout (single-model phone semantics — no
 * keep-alive bookkeeping).
 *
 * Transport split: auth, health, embeddings-501, and 404 are answered inline
 * on the socket thread. Inference routes (`needsJsDispatch`) are handed to
 * JS through the `emitRequest` event where the owning LocalServerService runs
 * generation; the socket thread blocks on the pending entry until JS answers
 * (`respondToRequest`) or streams (`sendChunk` / `finishStream`). Every wait
 * is bounded (fail-closed timeout) so no socket hangs forever.
 *
 * Fail-closed: EADDRINUSE and bad-cert failures throw with clear messages
 * before serving anything; malformed requests get 400, unknown routes 404.
 */
class LocalServerHttp(
    private val context: Context,
    private val config: LocalServerConfig,
    private val onError: (message: String) -> Unit = {},
    private val emitRequest: (requestId: String, method: String, path: String, headers: Map<String, String>, body: String) -> Unit = { _, _, _, _, _ -> },
) {
    private var serverSocket: ServerSocket? = null
    private val pool = Executors.newFixedThreadPool(8)
    private val running = AtomicBoolean(false)
    private val requestsServed = AtomicInteger(0)
    private val activeInference = AtomicInteger(0)
    private val pending = ConcurrentHashMap<String, PendingRequest>()

    @Volatile private var acceptLoop: Thread? = null

    fun start() {
        if (running.get()) return
        val address = InetAddress.getByName(config.bindAddress())
        val socket: ServerSocket = try {
            val ssl = LocalServerTls.sslContextFor(context, config)
            if (ssl != null) {
                val factory = ssl.serverSocketFactory
                (factory.createServerSocket(config.port, 50, address) as SSLServerSocket).apply {
                    needClientAuth = false
                }
            } else {
                ServerSocket(config.port, 50, address)
            }
        } catch (e: BindException) {
            throw IllegalStateException("Local server port ${config.port} is already in use")
        } catch (e: IllegalArgumentException) {
            throw e
        } catch (e: Exception) {
            throw IllegalStateException("Local server failed to start: ${e.message}")
        }
        serverSocket = socket
        running.set(true)
        acceptLoop = Thread({
            while (running.get()) {
                try {
                    val client = socket.accept()
                    pool.execute { handleConnection(client.getOutputStream(), client.getInputStream().bufferedReader()) { try { client.close() } catch (_: Exception) {} } }
                } catch (e: Exception) {
                    if (running.get()) onError("Local server accept failed: ${e.message}")
                }
            }
        }, "LocalServerAccept")
        acceptLoop?.isDaemon = true
        acceptLoop?.start()
        Log.i(TAG, "Serving on ${config.bindAddress()}:${config.port} tls=${config.tlsMode}")
    }

    fun stop() {
        running.set(false)
        try { serverSocket?.close() } catch (_: Exception) {}
        serverSocket = null
        pool.shutdownNow()
        pending.clear()
    }

    fun servedCount(): Int = requestsServed.get()

    fun baseUrls(): List<String> {
        val socket = serverSocket ?: return emptyList()
        val scheme = if (config.isTls()) "https" else "http"
        val port = socket.localPort
        val hosts = when (config.bindMode) {
            "all" -> listOf("127.0.0.1")
            "interface" -> listOf(config.interfaceIp)
            else -> listOf("127.0.0.1")
        }
        return hosts.map { "$scheme://$it:$port" }
    }

    // ── JS delegation (called on the RN bridge threads) ──

    /** Answer a pending request with one final response. Unknown ids are ignored. */
    fun respondToRequest(
        requestId: String,
        status: Int,
        body: String,
        contentType: String = "application/json",
        extraHeaders: Map<String, String> = emptyMap(),
    ) {
        pending[requestId]?.completeFinal(status, body, contentType, extraHeaders)
    }

    /** Append one SSE payload to a pending stream, opening it on first chunk. */
    fun sendChunk(requestId: String, sseData: String) {
        try {
            pending[requestId]?.writeChunk(sseData)
        } catch (e: Exception) {
            onError("Local server stream write failed: ${e.message}")
        }
    }

    /** End a pending stream (native appends `data: [DONE]`) and releases the socket thread. */
    fun finishStream(requestId: String) {
        try {
            pending[requestId]?.finishStream()
        } catch (e: Exception) {
            onError("Local server stream finish failed: ${e.message}")
        }
    }

    // ── Socket handling ──

    private fun handleConnection(out: OutputStream, reader: BufferedReader, done: () -> Unit) {
        try {
            val requestLine = reader.readLine() ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 3) {
                writeResponse(out, 400, """{"error":{"message":"bad request"}}""")
                return
            }
            val method = parts[0].uppercase()
            val path = parts[1]
            val headers = mutableMapOf<String, String>()
            while (true) {
                val line = reader.readLine() ?: break
                if (line.isEmpty()) break
                val idx = line.indexOf(':')
                if (idx > 0) headers[line.substring(0, idx).trim().lowercase()] = line.substring(idx + 1).trim()
            }
            val body = readBody(reader, headers["content-length"]?.toIntOrNull() ?: 0)
            if (!LocalServerRouter.admit(activeInference.get(), config.queueDepth) && LocalServerRouter.needsSlot(method, path)) {
                writeResponse(out, 503, LocalServerRouter.modelLoadingBody(), mapOf("Retry-After" to LocalServerRouter.RETRY_AFTER_SEC))
                return
            }
            val staticDecision = LocalServerRouter.route(method, path, headers, config.apiKey)
            if (LocalServerRouter.needsJsDispatch(method, path) && staticDecision.status != 401) {
                serveViaJs(out, method, path.substringBefore('?'), headers, body)
                return
            }
            writeResponse(out, staticDecision.status, staticDecision.body, staticDecision.extraHeaders, staticDecision.contentType)
            requestsServed.incrementAndGet()
        } catch (e: Exception) {
            try { writeResponse(out, 500, """{"error":{"message":"internal error"}}""") } catch (_: Exception) {}
        } finally {
            try { out.flush() } catch (_: Exception) {}
            done()
        }
    }

    private fun serveViaJs(
        out: OutputStream,
        method: String,
        path: String,
        headers: Map<String, String>,
        body: String,
    ) {
        val requestId = UUID.randomUUID().toString()
        val entry = PendingRequest(out)
        pending[requestId] = entry
        activeInference.incrementAndGet()
        try {
            emitRequest(requestId, method, path, headers, body)
            val answered = entry.awaitAnswer()
            if (!answered) {
                entry.completeTimedOut()
            }
            requestsServed.incrementAndGet()
        } catch (e: Exception) {
            onError("Local server delegation failed: ${e.message}")
        } finally {
            activeInference.decrementAndGet()
            pending.remove(requestId)
        }
    }

    private fun readBody(reader: BufferedReader, contentLength: Int): String {
        if (contentLength <= 0) return ""
        var remaining = contentLength.coerceAtMost(MAX_BODY_BYTES)
        val out = StringBuilder(minOf(contentLength, MAX_BODY_BYTES))
        val buf = CharArray(4096)
        while (remaining > 0) {
            val read = reader.read(buf, 0, minOf(buf.size, remaining))
            if (read < 0) break
            out.append(buf, 0, read)
            remaining -= read
        }
        return out.toString()
    }

    /**
     * One delegated request. The socket thread parks on [awaitAnswer] while JS
     * generates; bridge threads drive [completeFinal] / [writeChunk] /
     * [finishStream]. All socket writes hold the entry lock.
     */
    private class PendingRequest(private val out: OutputStream) {
        private val latch = CountDownLatch(1)
        @Volatile var settled = false
            private set
        private var streamOpen = false

        fun awaitAnswer(): Boolean =
            latch.await(REQUEST_TIMEOUT_MINUTES, TimeUnit.MINUTES)

        fun completeFinal(status: Int, body: String, contentType: String, extraHeaders: Map<String, String>) {
            synchronized(this) {
                if (settled) return
                settled = true
                writeResponse(out, status, body, extraHeaders, contentType)
                try { out.flush() } catch (_: Exception) {}
            }
            latch.countDown()
        }

        fun writeChunk(sseData: String) {
            synchronized(this) {
                if (settled) return
                if (!streamOpen) {
                    writeSseHead(out)
                    streamOpen = true
                }
                writeChunkFrame(out, sseData)
            }
        }

        fun finishStream() {
            synchronized(this) {
                if (settled) return
                settled = true
                if (!streamOpen) {
                    writeSseHead(out)
                    streamOpen = true
                }
                writeChunkFrame(out, LocalServerRouter.SSE_DONE)
                writeTerminator(out)
                try { out.flush() } catch (_: Exception) {}
            }
            latch.countDown()
        }

        /**
         * Bounded-wait expiry. A half-open stream is terminated, not
         * double-answered: writing a second response head onto a connection
         * that already received the SSE head would corrupt the framing.
         */
        fun completeTimedOut() {
            synchronized(this) {
                if (settled) return
                settled = true
                if (streamOpen) {
                    writeTerminator(out)
                } else {
                    writeResponse(
                        out, 503,
                        """{"error":{"message":"request timed out","type":"server_error","code":"timeout"}}""",
                        mapOf("Retry-After" to LocalServerRouter.RETRY_AFTER_SEC),
                    )
                }
                try { out.flush() } catch (_: Exception) {}
            }
            latch.countDown()
        }
    }

    companion object {
        private const val TAG = "LocalServer"
        private const val MAX_BODY_BYTES = 256 * 1024
        private const val REQUEST_TIMEOUT_MINUTES = 15L

        fun writeResponse(
            out: OutputStream,
            status: Int,
            body: String,
            extraHeaders: Map<String, String> = emptyMap(),
            contentType: String = "application/json",
        ) {
            val bytes = body.toByteArray(StandardCharsets.UTF_8)
            val head = StringBuilder()
            head.append("HTTP/1.1 $status ${reasonFor(status)}\r\n")
            head.append("Content-Type: $contentType\r\n")
            head.append("Content-Length: ${bytes.size}\r\n")
            head.append("Connection: close\r\n")
            for ((k, v) in extraHeaders) head.append("$k: $v\r\n")
            head.append("\r\n")
            out.write(head.toString().toByteArray(StandardCharsets.UTF_8))
            out.write(bytes)
        }

        /** Open an SSE stream: 200 head with chunked framing. */
        fun writeSseHead(out: OutputStream) {
            val head = "HTTP/1.1 200 OK\r\n" +
                "Content-Type: text/event-stream\r\n" +
                "Cache-Control: no-cache\r\n" +
                "Connection: close\r\n" +
                "Transfer-Encoding: chunked\r\n\r\n"
            out.write(head.toByteArray(StandardCharsets.UTF_8))
            out.flush()
        }

        /** One chunked frame carrying an already-framed SSE payload. */
        fun writeChunkFrame(out: OutputStream, payload: String) {
            val bytes = payload.toByteArray(StandardCharsets.UTF_8)
            out.write("${bytes.size.toString(16)}\r\n".toByteArray(StandardCharsets.US_ASCII))
            out.write(bytes)
            out.write("\r\n".toByteArray(StandardCharsets.US_ASCII))
            out.flush()
        }

        /** Zero-length frame terminating a chunked stream. */
        fun writeTerminator(out: OutputStream) {
            out.write("0\r\n\r\n".toByteArray(StandardCharsets.US_ASCII))
            out.flush()
        }

        private fun reasonFor(status: Int): String = when (status) {
            200 -> "OK"
            400 -> "Bad Request"
            401 -> "Unauthorized"
            404 -> "Not Found"
            500 -> "Internal Server Error"
            501 -> "Not Implemented"
            503 -> "Service Unavailable"
            else -> "Unknown"
        }
    }
}
