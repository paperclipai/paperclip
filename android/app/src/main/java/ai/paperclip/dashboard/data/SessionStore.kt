package ai.paperclip.dashboard.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Persists server URL, optional board API key, selected company and the auth cookies.
 * The board key and cookies are encrypted with an Android Keystore key that never leaves the device.
 */
class SessionStore(context: Context) {
    private val prefs = context.getSharedPreferences("paperclip", Context.MODE_PRIVATE)

    var baseUrl: String
        get() = prefs.getString("baseUrl", "") ?: ""
        set(v) = prefs.edit().putString("baseUrl", v.trim().trimEnd('/')).apply()

    var boardKey: String
        get() = prefs.getString("boardKey", null)?.let(::decrypt) ?: ""
        set(v) = prefs.edit().putString("boardKey", encrypt(v.trim())).apply()

    var companyId: String?
        get() = prefs.getString("companyId", null)
        set(v) = prefs.edit().putString("companyId", v).apply()

    // Lazy: the jar decrypts on load, which needs keystoreKey (declared below) to be set up.
    val cookieJar: CookieJar by lazy { PrefsCookieJar() }

    fun clearAuth() {
        (cookieJar as PrefsCookieJar).clear()
        prefs.edit().remove("boardKey").apply()
    }

    private val keystoreKey: SecretKey by lazy {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(KEY_ALIAS, null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build(),
            )
            generateKey()
        }
    }

    init {
        // One-time migration: re-save a board key stored by builds before encryption.
        prefs.getString("boardKey", null)?.takeIf { it.isNotEmpty() && !it.startsWith(PREFIX) }?.let { boardKey = it }
    }

    private fun encrypt(plain: String): String {
        if (plain.isEmpty()) return ""
        val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, keystoreKey) }
        val b64 = { b: ByteArray -> Base64.encodeToString(b, Base64.NO_WRAP) }
        return "$PREFIX${b64(cipher.iv)}:${b64(cipher.doFinal(plain.toByteArray()))}"
    }

    // Values written before encryption was added have no prefix and are read as-is,
    // then re-encrypted on the next write. Undecryptable values (key lost) read as empty.
    private fun decrypt(stored: String): String {
        if (!stored.startsWith(PREFIX)) return stored
        return runCatching {
            val (iv, data) = stored.removePrefix(PREFIX).split(':', limit = 2).map { Base64.decode(it, Base64.NO_WRAP) }
            val cipher = Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.DECRYPT_MODE, keystoreKey, GCMParameterSpec(128, iv)) }
            String(cipher.doFinal(data))
        }.getOrDefault("")
    }

    private inner class PrefsCookieJar : CookieJar {
        // Entries are "domain\tSet-Cookie string" so Cookie.parse can rebuild them.
        private val cookies: MutableList<Cookie> =
            (prefs.getStringSet("cookies", emptySet()) ?: emptySet()).mapNotNull { stored ->
                val entry = decrypt(stored)
                val (domain, raw) = entry.split('\t', limit = 2).takeIf { it.size == 2 } ?: return@mapNotNull null
                runCatching { Cookie.parse("http://$domain/".toHttpUrl(), raw) }.getOrNull()
            }.toMutableList()

        @Synchronized
        override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
            for (c in cookies) {
                this.cookies.removeAll { it.name == c.name && it.domain == c.domain && it.path == c.path }
                if (c.expiresAt > System.currentTimeMillis()) this.cookies.add(c)
            }
            persist()
        }

        @Synchronized
        override fun loadForRequest(url: HttpUrl): List<Cookie> {
            val now = System.currentTimeMillis()
            if (cookies.removeAll { it.expiresAt <= now }) persist()
            return cookies.filter { it.matches(url) }
        }

        @Synchronized
        fun clear() {
            cookies.clear()
            persist()
        }

        private fun persist() {
            prefs.edit().putStringSet("cookies", cookies.map { encrypt("${it.domain}\t$it") }.toSet()).apply()
        }
    }

    private companion object {
        const val KEY_ALIAS = "paperclip-session"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val PREFIX = "enc1:"
    }
}
