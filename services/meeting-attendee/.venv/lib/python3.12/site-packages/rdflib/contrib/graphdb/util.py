from __future__ import annotations

import typing as t
import urllib.parse


def sanitize_filename(filename: str) -> str | None:
    filename = filename.strip().strip("\"'")
    if not filename:
        return None
    filename = filename.replace("\\", "/").split("/")[-1]
    if not filename or filename in {".", ".."}:
        return None
    return filename


def extract_filename_from_content_disposition(header: str) -> str | None:
    """Extract filename from Content-Disposition header.

    Supports both ``filename=`` and RFC 5987 ``filename*=``; prefers ``filename*=``
    when present. Returned filenames are sanitized to prevent path traversal.
    """
    if not header:
        return None

    filename_star: str | None = None
    filename_plain: str | None = None

    for part in header.split(";"):
        part = part.strip()
        lower = part.lower()
        if lower.startswith("filename*="):
            value = part[len("filename*=") :].strip()
            value = value.strip().strip("\"'")
            try:
                charset, rest = value.split("'", 1)
                _language, encoded = rest.split("'", 1)
            except ValueError:
                charset = "utf-8"
                encoded = value
            try:
                raw = urllib.parse.unquote_to_bytes(encoded)
                decoded = raw.decode(charset, errors="replace")
            except LookupError:
                raw = urllib.parse.unquote_to_bytes(encoded)
                decoded = raw.decode("utf-8", errors="replace")
            filename_star = sanitize_filename(decoded)
        elif lower.startswith("filename="):
            value = part[len("filename=") :].strip()
            filename_plain = sanitize_filename(value)

    return filename_star or filename_plain


def infer_filename_from_fileobj(file_obj: t.Any, fallback: str) -> str:
    """Infer a safe filename from a file-like object's ``.name`` attribute."""
    name = getattr(file_obj, "name", None)
    if isinstance(name, str) and name:
        inferred = sanitize_filename(name)
        if inferred:
            return inferred
    return fallback
