"""Chrome and Brave cookie extraction for macOS.

Extracts cookies from Chromium-based browser SQLite databases using only
stdlib modules and the system openssl CLI (ships with macOS). Zero pip
dependencies.

Chromium on macOS uses v10 encryption (AES-128-CBC with Keychain-stored key).
Chrome and Brave share the same algorithm; only the DB path and Keychain
service name differ.
This is NOT affected by Windows App-Bound Encryption (v20).
"""

import hashlib
import logging
import shutil
import sqlite3
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Cookie DB locations on macOS
CHROME_COOKIES_DB = Path.home() / "Library" / "Application Support" / "Google" / "Chrome" / "Default" / "Cookies"
BRAVE_BASE_DIR = Path.home() / "Library" / "Application Support" / "BraveSoftware" / "Brave-Browser"

# Chromium v10 encryption constants (shared by Chrome and Brave)
CHROME_SALT = b"saltysalt"
CHROME_PBKDF2_ITERATIONS = 1003
CHROME_KEY_LENGTH = 16
# IV is 16 space characters (0x20)
CHROME_IV_HEX = "20" * 16


def _get_chromium_encryption_key(service_name: str) -> Optional[bytes]:
    """Retrieve the encryption passphrase for a Chromium-based browser from macOS Keychain.

    Calls `security find-generic-password` which may trigger a system dialog
    on first access.

    Returns the raw passphrase bytes, or None on failure.
    """
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-w", "-s", service_name],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            logger.info("%s Keychain access denied or browser not installed: %s", service_name, result.stderr.strip())
            return None
        passphrase = result.stdout.strip()
        if not passphrase:
            logger.info("%s Keychain returned empty passphrase", service_name)
            return None
        return passphrase.encode("utf-8")
    except FileNotFoundError:
        logger.info("'security' command not found — not on macOS?")
        return None
    except subprocess.TimeoutExpired:
        logger.info("%s Keychain access timed out", service_name)
        return None
    except Exception as e:
        logger.info("Failed to get %s encryption key: %s", service_name, e)
        return None


def _get_chrome_encryption_key() -> Optional[bytes]:
    return _get_chromium_encryption_key("Chrome Safe Storage")


def _derive_aes_key(passphrase: bytes) -> bytes:
    """Derive 16-byte AES key from Chrome's Keychain passphrase via PBKDF2."""
    return hashlib.pbkdf2_hmac(
        "sha1",
        passphrase,
        CHROME_SALT,
        CHROME_PBKDF2_ITERATIONS,
        dklen=CHROME_KEY_LENGTH,
    )


def _decrypt_v10_value(encrypted_value: bytes, aes_key: bytes, db_version: int) -> Optional[str]:
    """Decrypt a Chrome v10-encrypted cookie value.

    Uses system openssl CLI for AES-128-CBC decryption (zero pip deps).
    For Chrome 130+ (db_version >= 24), strips 32-byte SHA-256 prefix after decryption.

    Returns decrypted string or None on failure.
    """
    # Strip the 'v10' prefix
    ciphertext = encrypted_value[3:]
    if not ciphertext:
        return None

    hex_key = aes_key.hex()

    try:
        result = subprocess.run(
            [
                "openssl", "enc", "-aes-128-cbc", "-d",
                "-K", hex_key,
                "-iv", CHROME_IV_HEX,
                "-nopad",
            ],
            input=ciphertext,
            capture_output=True,
            timeout=5,
        )
        if result.returncode != 0:
            logger.debug("openssl decryption failed: %s", result.stderr.decode(errors="replace").strip())
            return None

        decrypted = result.stdout
        if not decrypted:
            return None

        # Remove PKCS7 padding
        decrypted = _remove_pkcs7_padding(decrypted)
        if decrypted is None:
            return None

        # Chrome 130+ (db version >= 24): strip 32-byte SHA-256 prefix
        if db_version >= 24 and len(decrypted) > 32:
            decrypted = decrypted[32:]

        return decrypted.decode("utf-8", errors="replace")

    except FileNotFoundError:
        logger.info("openssl not found — cannot decrypt Chrome cookies")
        return None
    except subprocess.TimeoutExpired:
        logger.info("openssl decryption timed out")
        return None
    except Exception as e:
        logger.debug("Chrome cookie decryption error: %s", e)
        return None


def _remove_pkcs7_padding(data: bytes) -> Optional[bytes]:
    """Remove PKCS7 padding from decrypted data.

    The last byte indicates the number of padding bytes added.
    All padding bytes must have the same value.

    Returns unpadded data or None if padding is invalid.
    """
    if not data:
        return None
    pad_len = data[-1]
    if pad_len < 1 or pad_len > 16:
        return None
    # Verify all padding bytes match
    if data[-pad_len:] != bytes([pad_len]) * pad_len:
        return None
    return data[:-pad_len]


def _get_db_version(cursor: sqlite3.Cursor) -> int:
    """Get Chrome cookie database version from the meta table.

    Returns 0 if meta table doesn't exist or version can't be read.
    """
    try:
        cursor.execute("SELECT value FROM meta WHERE key = 'version'")
        row = cursor.fetchone()
        if row:
            return int(row[0])
    except Exception:
        pass
    return 0


def _extract_chromium_cookies_macos(
    db_path: Path,
    keychain_service: str,
    domain: str,
    cookie_names: list[str],
) -> Optional[dict[str, str]]:
    """Extract cookies from any Chromium-based browser on macOS.

    Copies the locked Cookies database to a temp file, reads specified cookies,
    and decrypts v10-encrypted values using the Keychain-stored key.

    Args:
        db_path: Path to the browser's Cookies SQLite file.
        keychain_service: macOS Keychain service name (e.g. "Chrome Safe Storage").
        domain: Cookie domain to match (e.g., ".twitter.com", ".x.com").
        cookie_names: List of cookie names to extract.

    Returns:
        Dict mapping cookie name to decrypted value, or None on failure.
        Only includes cookies that were successfully found and decrypted.
    """
    if not db_path.exists():
        logger.info("%s cookies database not found at %s", keychain_service, db_path)
        return None

    passphrase = _get_chromium_encryption_key(keychain_service)
    aes_key = _derive_aes_key(passphrase) if passphrase else None

    # Copy DB to temp file (browser locks the original while running)
    tmp_fd = None
    tmp_path = None
    try:
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=".sqlite")
        shutil.copy2(str(db_path), tmp_path)
    except Exception as e:
        logger.info("Failed to copy %s cookies database: %s", keychain_service, e)
        if tmp_path:
            try:
                Path(tmp_path).unlink(missing_ok=True)
            except Exception:
                pass
        return None
    finally:
        if tmp_fd is not None:
            import os
            os.close(tmp_fd)

    try:
        conn = sqlite3.connect(tmp_path)
        cursor = conn.cursor()

        db_version = _get_db_version(cursor)
        logger.debug("%s cookie DB version: %d", keychain_service, db_version)

        placeholders = ",".join("?" for _ in cookie_names)
        query = (
            f"SELECT name, value, encrypted_value FROM cookies "
            f"WHERE host_key LIKE ? AND name IN ({placeholders})"
        )
        params = [f"%{domain}"] + list(cookie_names)
        cursor.execute(query, params)

        results: dict[str, str] = {}
        for name, value, encrypted_value in cursor.fetchall():
            if value:
                results[name] = value
                continue

            if encrypted_value and encrypted_value[:3] == b"v10":
                if aes_key is None:
                    logger.debug("Skipping encrypted cookie %s — no Keychain access", name)
                    continue
                decrypted = _decrypt_v10_value(encrypted_value, aes_key, db_version)
                if decrypted:
                    results[name] = decrypted
                else:
                    logger.debug("Failed to decrypt cookie %s", name)
            elif encrypted_value:
                logger.debug("Unknown encryption for cookie %s (prefix: %r)", name, encrypted_value[:3])

        conn.close()

        if not results:
            logger.info("No matching cookies found in %s for domain %s", keychain_service, domain)
            return None

        return results

    except sqlite3.Error as e:
        logger.info("Failed to read %s cookies database: %s", keychain_service, e)
        return None
    except Exception as e:
        logger.info("Unexpected error reading %s cookies: %s", keychain_service, e)
        return None
    finally:
        try:
            Path(tmp_path).unlink(missing_ok=True)
        except Exception:
            pass


def extract_chrome_cookies_macos(domain: str, cookie_names: list[str]) -> Optional[dict[str, str]]:
    """Extract cookies from Chrome on macOS."""
    return _extract_chromium_cookies_macos(
        CHROME_COOKIES_DB, "Chrome Safe Storage", domain, cookie_names
    )


def _find_brave_cookies_db() -> Optional[Path]:
    """Find Brave's Cookies database on macOS.

    Tries the Default profile first, then scans numbered Profile directories
    by most-recently-modified. Brave creates extra profiles as "Profile 1",
    "Profile 2", etc. alongside Default; the most recently used one is the
    likeliest to hold current cookies. Lexicographic sort would visit
    "Profile 10" before "Profile 2", which can return the wrong profile.
    """
    default = BRAVE_BASE_DIR / "Default" / "Cookies"
    if default.exists():
        return default

    try:
        candidates = [
            child for child in BRAVE_BASE_DIR.iterdir()
            if child.is_dir() and child.name.startswith("Profile ")
        ]
        for child in sorted(candidates, key=lambda p: p.stat().st_mtime, reverse=True):
            candidate = child / "Cookies"
            if candidate.exists():
                return candidate
    except OSError:
        pass

    return None


def extract_brave_cookies_macos(domain: str, cookie_names: list[str]) -> Optional[dict[str, str]]:
    """Extract cookies from Brave on macOS.

    Brave uses the same v10 AES-128-CBC encryption as Chrome; only the DB
    path and Keychain service name differ.
    """
    db_path = _find_brave_cookies_db()
    if db_path is None:
        logger.info("Brave cookies database not found under %s", BRAVE_BASE_DIR)
        return None
    return _extract_chromium_cookies_macos(db_path, "Brave Safe Storage", domain, cookie_names)
