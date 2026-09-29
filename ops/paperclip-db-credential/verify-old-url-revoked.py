#!/usr/bin/env python3
"""Gate agent dispatch on new DB access and rejection of the old URL.

Both URLs stay in private files and process memory; neither enters argv or logs.
Requires libpq, which is installed with the PostgreSQL client tools.
"""

import argparse
import ctypes
import ctypes.util
import os
import stat
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


def read_private_url(path: Path) -> str:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError("credential source must be a private regular file")
    url = path.read_text(encoding="utf-8").strip()
    parts = urlsplit(url)
    if (
        parts.scheme not in {"postgres", "postgresql"}
        or not parts.username
        or not parts.password
        or not parts.hostname
        or not parts.path
    ):
        raise ValueError("credential source must contain an explicit PostgreSQL endpoint and password")
    if {"host", "hostaddr", "port", "dbname", "service"} & parse_qs(parts.query).keys():
        raise ValueError("database endpoint must not be overridden in URL parameters")
    return url


def endpoint(url: str) -> tuple[str | None, int, str]:
    parts = urlsplit(url)
    return parts.hostname, parts.port or 5432, parts.path


def connects(libpq: ctypes.CDLL, url: str) -> bool:
    connection = libpq.PQconnectdb(url.encode("utf-8"))
    if not connection:
        raise RuntimeError("libpq could not create a connection handle")
    try:
        return libpq.PQstatus(connection) == 0  # CONNECTION_OK
    finally:
        libpq.PQfinish(connection)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--old-url-file", required=True, type=Path)
    parser.add_argument("--service-url-file", required=True, type=Path)
    args = parser.parse_args()
    try:
        old_url = read_private_url(args.old_url_file)
        service_url = read_private_url(args.service_url_file)
        if endpoint(old_url) != endpoint(service_url):
            raise ValueError("old and new URLs must target the same database endpoint")
        library = ctypes.util.find_library("pq")
        if not library:
            raise RuntimeError("libpq is unavailable")
        libpq = ctypes.CDLL(library)
        libpq.PQconnectdb.argtypes = [ctypes.c_char_p]
        libpq.PQconnectdb.restype = ctypes.c_void_p
        libpq.PQstatus.argtypes = [ctypes.c_void_p]
        libpq.PQstatus.restype = ctypes.c_int
        libpq.PQfinish.argtypes = [ctypes.c_void_p]
        os.environ["PGCONNECT_TIMEOUT"] = "5"
        if not connects(libpq, service_url):
            print("BLOCKED: new service DB credential cannot connect")
            return 1
        if connects(libpq, old_url):
            print("BLOCKED: old DB URL still authenticates")
            return 1
    except (OSError, RuntimeError, UnicodeError, ValueError) as error:
        # The exception may contain an input path; never emit its URL or libpq text.
        print(f"BLOCKED: pre-dispatch DB gate could not complete ({type(error).__name__})")
        return 1
    print("PASS: new service DB credential connects; old DB URL is rejected")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
