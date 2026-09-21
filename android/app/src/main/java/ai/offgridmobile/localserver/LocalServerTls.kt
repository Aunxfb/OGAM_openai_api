package ai.offgridmobile.localserver

import android.annotation.SuppressLint
import android.content.Context
import android.security.KeyPairGeneratorSpec
import android.util.Base64
import java.io.ByteArrayInputStream
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyStore
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Calendar
import java.util.GregorianCalendar
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.security.auth.x500.X500Principal

/**
 * TLS identity for the local server. Three modes, one port (mode-switched):
 *
 * - off: plain HTTP.
 * - byoc: PEM cert + PKCS8 PEM key from the given files, loaded into a
 *   memory KeyStore. Fail-closed on unreadable/mismatched material.
 * - self-signed: generate-once RSA-2048 (CN=localhost, 10y) in AndroidKeyStore
 *   via KeyPairGeneratorSpec — the framework mints the self-signed cert
 *   itself, so no bundled cert builder is needed. Stable across restarts so
 *   clients can pin the fingerprint shown in the UI.
 */
object LocalServerTls {

    const val SELF_SIGNED_ALIAS = "offgrid-local-server"

    fun sslContextFor(context: Context, config: LocalServerConfig): SSLContext? {
        if (!config.isTls()) return null
        val (chain, key) = when (config.tlsMode) {
            "byoc" -> loadByoc(config.certPath, config.keyPath)
            else -> loadOrGenerateSelfSigned(context)
        }
        val store = KeyStore.getInstance(KeyStore.getDefaultType())
        store.load(null, null)
        store.setKeyEntry("local-server", key, CharArray(0), chain)
        val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
        kmf.init(store, CharArray(0))
        val ssl = SSLContext.getInstance("TLS")
        ssl.init(kmf.keyManagers, null, SecureRandom())
        return ssl
    }

    /** SHA-256 fingerprint of the served cert, shown in the UI for trust. */
    fun fingerprintHex(cert: X509Certificate): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(cert.encoded)
        return digest.joinToString(":") { "%02X".format(it) }
    }

    /** The cert clients would pin under this config, or null when TLS is off. */
    fun certificateFor(context: Context, config: LocalServerConfig): X509Certificate? {
        if (!config.isTls()) return null
        return if (config.tlsMode == "byoc") {
            loadByoc(config.certPath, config.keyPath).first.first() as X509Certificate
        } else {
            selfSignedCertificate(context)
        }
    }

    /** Delete + regenerate the persisted self-signed identity (Regenerate UI). */
    fun regenerateSelfSigned(context: Context): X509Certificate {
        val androidKeyStore = KeyStore.getInstance("AndroidKeyStore")
        androidKeyStore.load(null)
        if (androidKeyStore.containsAlias(SELF_SIGNED_ALIAS)) {
            androidKeyStore.deleteEntry(SELF_SIGNED_ALIAS)
        }
        return loadOrGenerateSelfSigned(context).first.first() as X509Certificate
    }

    fun selfSignedCertificate(context: Context): X509Certificate {
        return loadOrGenerateSelfSigned(context).first.first() as X509Certificate
    }

    private fun loadByoc(certPath: String, keyPath: String): Pair<Array<java.security.cert.Certificate>, java.security.Key> {
        val certPem = readFileFailClosed(certPath, "cert")
        val keyPem = readFileFailClosed(keyPath, "key")
        val certs = CertificateFactory.getInstance("X.509")
            .generateCertificates(ByteArrayInputStream(pemBody(certPem).toByteArray()))
            .toTypedArray()
        if (certs.isEmpty()) throw IllegalArgumentException("Local server BYOC cert file holds no certificate")
        val keyBytes = Base64.decode(pemBody(keyPem).replace("\\s".toRegex(), ""), Base64.DEFAULT)
        val key = KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(keyBytes))
        return Pair(certs, key)
    }

    @SuppressLint("GetInstance")
    private fun loadOrGenerateSelfSigned(context: Context): Pair<Array<java.security.cert.Certificate>, java.security.Key> {
        val androidKeyStore = KeyStore.getInstance("AndroidKeyStore")
        androidKeyStore.load(null)
        if (!androidKeyStore.containsAlias(SELF_SIGNED_ALIAS)) {
            val start = GregorianCalendar()
            val end = GregorianCalendar()
            end.add(Calendar.YEAR, 10)
            @Suppress("DEPRECATION")
            val spec = KeyPairGeneratorSpec.Builder(context)
                .setAlias(SELF_SIGNED_ALIAS)
                .setSubject(X500Principal("CN=localhost"))
                .setSerialNumber(BigInteger(64, SecureRandom()))
                .setStartDate(start.time)
                .setEndDate(end.time)
                .setKeySize(2048)
                .build()
            val generator = KeyPairGenerator.getInstance("RSA", "AndroidKeyStore")
            generator.initialize(spec)
            generator.generateKeyPair()
        }
        val cert = androidKeyStore.getCertificate(SELF_SIGNED_ALIAS)
            ?: throw IllegalStateException("Local server self-signed cert missing after generation")
        val key = androidKeyStore.getKey(SELF_SIGNED_ALIAS, null)
            ?: throw IllegalStateException("Local server self-signed key missing after generation")
        return Pair(arrayOf(cert), key)
    }

    private fun readFileFailClosed(path: String, what: String): String {
        try {
            return java.io.File(path).readText()
        } catch (e: Exception) {
            throw IllegalArgumentException("Local server BYOC $what file unreadable: $path")
        }
    }

    private fun pemBody(pem: String): String {
        val lines = pem.lines().filter { !it.startsWith("-----") }
        return lines.joinToString("")
    }
}
