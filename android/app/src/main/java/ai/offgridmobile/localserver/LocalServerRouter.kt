package ai.offgridmobile.localserver

/**
 * Pure v1 route + auth + admission logic. Zero Android dependencies so it is
 * unit-testable on the JVM. The rule set mirrors
 * `src/services/localServer/oai.ts` (same paths, same public-health rule,
 * same 503 + Retry-After admission); the two cannot share code across
 * languages, so the parity test pins the shared constants AND the JSON body
 * shapes below (models/chat/completion/tokenize/detokenize/SSE framing).
 *
 * Transport split: auth, health, embeddings-501, and 404 are answered inline
 * by the socket thread via `route()`. Everything in `needsJsDispatch()` is
 * handed to JS (`LocalServerRequest` event) where LocalServerService owns
 * inference; `route()` still answers 503 for those as the fail-closed
 * default if the JS bridge is ever unreachable.
 */
object LocalServerRouter {

    const val EVENT_STATUS = "LocalServerStatus"
    const val EVENT_ERROR = "LocalServerError"
    const val EVENT_REQUEST = "LocalServerRequest"
    const val MODULE_NAME = "LocalServerModule"

    /** SSE terminator, exactly per llama-server OAI routes. Must match oai.ts. */
    const val SSE_DONE = "data: [DONE]\n\n"
    const val RETRY_AFTER_SEC = "5"

    /** Paths that never require the Bearer key (mirrors llama-server). */
    private val PUBLIC_PATHS = setOf("/health")

    /** Inference routes served 503 until T6 wires JS delegation. */
    private val INFERENCE_PATHS = setOf(
        "/v1/chat/completions",
        "/v1/completions",
        "/v1/models",
    )

    /**
     * True when the request must be dispatched to JS for inference instead of
     * being answered inline. Mirrors the dispatch in
     * `LocalServerService.handleNativeRequest`.
     */
    fun needsJsDispatch(method: String, rawPath: String): Boolean {
        val path = rawPath.substringBefore('?')
        if (method == "GET" && path == "/health") return false
        if (path == "/v1/embeddings") return false
        if (method == "POST" && (path == "/v1/chat/completions" || path == "/v1/completions")) return true
        if (method == "GET" && path == "/v1/models") return true
        if (method == "POST" && (path == "/tokenize" || path == "/detokenize")) return true
        return false
    }

    /** True when the route consumes an inference slot (admission-gated). */
    fun needsSlot(method: String, rawPath: String): Boolean {
        val path = rawPath.substringBefore('?')
        return method == "POST" && (
            path == "/v1/chat/completions" || path == "/v1/completions" ||
                path == "/tokenize" || path == "/detokenize"
            )
    }

    data class Decision(
        val status: Int,
        val body: String,
        val contentType: String = "application/json",
        val extraHeaders: Map<String, String> = emptyMap(),
    )

    fun route(method: String, rawPath: String, headers: Map<String, String>, apiKey: String): Decision {
        val path = rawPath.substringBefore('?')
        if (!isAuthorized(path, headers["authorization"], apiKey)) {
            return Decision(401, """{"error":{"message":"unauthorized","type":"auth_error"}}""")
        }
        if (method == "GET" && path == "/health") {
            return Decision(200, """{"status":"ok"}""")
        }
        if (path == "/v1/embeddings") {
            // T0 decision: real embeddings are v2; v1 answers 501.
            return Decision(501, """{"error":{"message":"embeddings are not available in v1","type":"not_implemented"}}""")
        }
        if (path == "/tokenize" || path == "/detokenize") {
            return Decision(503, modelLoadingBody(), extraHeaders = mapOf("Retry-After" to "5"))
        }
        if (method == "GET" && path == "/v1/models") {
            return Decision(503, modelLoadingBody(), extraHeaders = mapOf("Retry-After" to "5"))
        }
        if (method == "POST" && INFERENCE_PATHS.contains(path)) {
            return Decision(503, modelLoadingBody(), extraHeaders = mapOf("Retry-After" to "5"))
        }
        return Decision(404, """{"error":{"message":"not found","type":"not_found"}}""")
    }

    /** Bearer gate. Health is public; no configured key means open. */
    fun isAuthorized(path: String, authHeader: String?, apiKey: String): Boolean {
        if (PUBLIC_PATHS.contains(path)) return true
        if (apiKey.isEmpty()) return true
        val token = (authHeader ?: "").replace(Regex("^Bearer\\s+", RegexOption.IGNORE_CASE), "").trim()
        if (token.isEmpty()) return false
        return constantTimeEquals(token, apiKey)
    }

    /** FIFO admission: true = admitted; false answers 503 + Retry-After. */
    fun admit(activeCount: Int, queueDepth: Int): Boolean = activeCount < queueDepth

    fun modelLoadingBody(): String =
        """{"error":{"message":"model loading","type":"server_error","code":"model_loading"}}"""

    // ── v1 JSON body builders (parity with oai.ts — same shapes, same keys) ──

    fun healthBody(): String = """{"status":"ok"}"""

    fun modelsBody(modelId: String): String =
        """{"object":"list","data":[{"id":"${jsonEscape(modelId)}","object":"model","created":0,"owned_by":"offgrid"}]}"""

    fun chatCompletionBody(model: String, text: String, id: String, createdSec: Long): String =
        """{"id":"${jsonEscape(id)}","object":"chat.completion","created":$createdSec,"model":"${jsonEscape(model)}","choices":[{"index":0,"message":{"role":"assistant","content":"${jsonEscape(text)}"},"finish_reason":"stop"}]}"""

    fun textCompletionBody(model: String, text: String, id: String, createdSec: Long): String =
        """{"id":"${jsonEscape(id)}","object":"text_completion","created":$createdSec,"model":"${jsonEscape(model)}","choices":[{"index":0,"text":"${jsonEscape(text)}","finish_reason":"stop"}]}"""

    fun chatChunkBody(model: String, delta: String, id: String, createdSec: Long): String =
        """{"id":"${jsonEscape(id)}","object":"chat.completion.chunk","created":$createdSec,"model":"${jsonEscape(model)}","choices":[{"index":0,"delta":{"content":"${jsonEscape(delta)}"},"finish_reason":null}]}"""

    fun tokenizeBody(tokenIds: List<Int>): String =
        """{"tokens":[${tokenIds.joinToString(",")}]}"""

    fun detokenizeBody(text: String): String =
        """{"content":"${jsonEscape(text)}"}"""

    /** One SSE frame, exactly `data: {json}` + blank line per llama-server. */
    fun sseFrame(jsonPayload: String): String = "data: $jsonPayload\n\n"

    /** Minimal JSON string escaper for interpolated bodies (ids, texts, deltas). */
    fun jsonEscape(s: String): String {
        val out = StringBuilder(s.length + 8)
        for (c in s) {
            when (c) {
                '"' -> out.append("\\\"")
                '\\' -> out.append("\\\\")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                else -> if (c.code < 0x20) out.append("\\u%04x".format(c.code)) else out.append(c)
            }
        }
        return out.toString()
    }

    private fun constantTimeEquals(a: String, b: String): Boolean {        if (a.length != b.length) return false
        var diff = 0
        for (i in a.indices) diff = diff or (a[i].code xor b[i].code)
        return diff == 0
    }
}
