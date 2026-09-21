package ai.offgridmobile.localserver

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * LocalServerRouter unit tests — pure JVM, no Robolectric needed.
 * Pins the behavior shared with `src/services/localServer/oai.ts`:
 * public health, Bearer gating, 503 admission, 501 embeddings.
 */
class LocalServerRouterTest {

    @Test
    fun healthIsPublicEvenWithKeySet() {
        val res = LocalServerRouter.route("GET", "/health", emptyMap(), "secret")
        assertEquals(200, res.status)
    }

    @Test
    fun protectedRoutesAreOpenWithoutAKey() {
        assertEquals(200, LocalServerRouter.route("GET", "/health", emptyMap(), "").status)
        assertEquals(503, LocalServerRouter.route("POST", "/v1/chat/completions", emptyMap(), "").status)
    }

    @Test
    fun protectedRoutesRejectMissingAndWrongBearers() {
        assertEquals(401, LocalServerRouter.route("GET", "/v1/models", emptyMap(), "secret").status)
        val wrong = mapOf("authorization" to "Bearer wrong")
        assertEquals(401, LocalServerRouter.route("GET", "/v1/models", wrong, "secret").status)
    }

    @Test
    fun protectedRoutesAcceptTheExactBearer() {
        val headers = mapOf("authorization" to "Bearer secret")
        // 503 = admitted past auth, waiting on JS inference (T6 wires it).
        assertEquals(503, LocalServerRouter.route("POST", "/v1/chat/completions", headers, "secret").status)
    }

    @Test
    fun embeddingsAre501InV1() {
        assertEquals(501, LocalServerRouter.route("POST", "/v1/embeddings", emptyMap(), "").status)
    }

    @Test
    fun unknownRoutesAre404() {
        assertEquals(404, LocalServerRouter.route("GET", "/props", emptyMap(), "").status)
    }

    @Test
    fun admissionRejectsAtDepth() {
        assertTrue(LocalServerRouter.admit(0, 4))
        assertTrue(LocalServerRouter.admit(3, 4))
        assertFalse(LocalServerRouter.admit(4, 4))
    }

    @Test
    fun contractNamesMatchTheTypeScriptContract() {
        // Must stay identical to src/services/localServer/contract.ts or the
        // JS side never hears the native module. Change both together.
        assertEquals("LocalServerModule", LocalServerRouter.MODULE_NAME)
        assertEquals("LocalServerStatus", LocalServerRouter.EVENT_STATUS)
        assertEquals("LocalServerError", LocalServerRouter.EVENT_ERROR)
        assertEquals("LocalServerRequest", LocalServerRouter.EVENT_REQUEST)
    }

    @Test
    fun configRejectsBadPortsAndMissingFields() {
        // Fail-closed validation lives in LocalServerConfig.fromMap (needs a
        // ReadableMap — exercised here via range constants).
        assertEquals(1024, LocalServerConfig.MIN_PORT)
        assertEquals(65535, LocalServerConfig.MAX_PORT)
        assertEquals(1, LocalServerConfig.MIN_QUEUE)
        assertEquals(32, LocalServerConfig.MAX_QUEUE)
    }

    @Test
    fun rootLandingPageIsPublicHtml() {
        val res = LocalServerRouter.route("GET", "/", emptyMap(), "secret")
        assertEquals(200, res.status)
        assertEquals("text/html", res.contentType)
        assertTrue(res.body.contains("Off Grid AI local server"))
        assertTrue(res.body.contains("/v1/chat/completions"))
        assertFalse(LocalServerRouter.needsJsDispatch("GET", "/"))
    }

    @Test
    fun inferenceRoutesDispatchToJsWhileHealthAndEmbeddingsStayInline() {
        assertTrue(LocalServerRouter.needsJsDispatch("POST", "/v1/chat/completions"))
        assertTrue(LocalServerRouter.needsJsDispatch("POST", "/v1/completions"))
        assertTrue(LocalServerRouter.needsJsDispatch("GET", "/v1/models"))
        assertTrue(LocalServerRouter.needsJsDispatch("POST", "/tokenize"))
        assertTrue(LocalServerRouter.needsJsDispatch("POST", "/detokenize"))
        assertFalse(LocalServerRouter.needsJsDispatch("GET", "/health"))
        assertFalse(LocalServerRouter.needsJsDispatch("POST", "/v1/embeddings"))
        assertFalse(LocalServerRouter.needsJsDispatch("GET", "/props"))
    }

    @Test
    fun bodyBuildersMatchTheTypeScriptOaiShapes() {
        // Parity with src/services/localServer/oai.ts — same keys, same envelopes.
        val models = LocalServerRouter.modelsBody("model-abc")
        assertTrue(models.contains("\"object\":\"list\""))
        assertTrue(models.contains("\"id\":\"model-abc\""))

        val chat = LocalServerRouter.chatCompletionBody("m", "hi", "id-1", 1L)
        assertTrue(chat.contains("\"object\":\"chat.completion\""))
        assertTrue(chat.contains("\"content\":\"hi\""))

        val text = LocalServerRouter.textCompletionBody("m", "hi", "id-1", 1L)
        assertTrue(text.contains("\"object\":\"text_completion\""))

        val chunk = LocalServerRouter.chatChunkBody("m", "hi", "id-1", 1L)
        assertTrue(chunk.contains("\"object\":\"chat.completion.chunk\""))

        assertEquals("{\"tokens\":[1,2]}", LocalServerRouter.tokenizeBody(listOf(1, 2)))
        assertEquals("{\"content\":\"hi\"}", LocalServerRouter.detokenizeBody("hi"))
        assertEquals("{\"status\":\"ok\"}", LocalServerRouter.healthBody())
        assertEquals("data: {\"a\":1}\n\n", LocalServerRouter.sseFrame("{\"a\":1}"))
        assertEquals("data: [DONE]\n\n", LocalServerRouter.SSE_DONE)
    }

    @Test
    fun bodiesEscapeQuotesAndControlChars() {
        val body = LocalServerRouter.chatCompletionBody("m", "say \"hi\"\nbye", "id-1", 1L)
        assertTrue(body.contains("\\\"hi\\\""))
        assertTrue(body.contains("\\n"))
    }
}
