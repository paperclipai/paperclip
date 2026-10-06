#!/usr/bin/env python3
"""Check named carriers and all regular worktree files without printing secrets."""

import argparse
import json
import os
import re
import shlex
import stat
from pathlib import Path
from urllib.parse import unquote_to_bytes


URL_PREFIXES = (b"postgres://", b"postgresql://")
URL_WHITESPACE = b" \t\n\r\f\v"
PASSWORD_QUERY_KEY = b"password"
MAX_QUERY_KEY_BYTES = len(PASSWORD_QUERY_KEY) * 3  # Percent-encoded bytes.
MAX_CARRIER_LINE_BYTES = 64 * 1024
# Search the full length of an oversized line for these DB command/carrier
# markers. A fixed overlap catches a marker split across bounded reads.
OVERSIZED_DB_MARKERS = (
    b"psql",
    b"pgpassword",
    b"pgpassfile",
    b"pgservicefile",
    b"password",
    b"passfile",
)
MAX_OVERSIZED_MARKER_BYTES = max(map(len, OVERSIZED_DB_MARKERS))
SERVICE_FILE_NAMES = {".pg_service.conf", "pg_service.conf"}
PASSFILE_NAMES = {".pgpass", "pgpass", "pgpass.conf"}
ENV_DB_URL_KEYS = {b"DATABASE_URL", b"DATABASE_MIGRATION_URL"}
ENV_LIBPQ_KEYS = {b"PGPASSWORD", b"PGPASSFILE", b"PGSERVICEFILE", b"PGSYSCONFDIR"}
SHELL_IDENTIFIER = rb"[A-Za-z_][A-Za-z_0-9]*"
SHELL_ASSIGNMENT = re.compile(rb"^(" + SHELL_IDENTIFIER + rb")=(.*)$")
SAFE_PASSWORD_REFERENCE = re.compile(
    rb"(?:\$(?:" + SHELL_IDENTIFIER + rb"|\{" + SHELL_IDENTIFIER + rb"\})"
    rb'|"\$(?:' + SHELL_IDENTIFIER + rb"|\{" + SHELL_IDENTIFIER + rb'\})")'
)
PRIVATE_REFERENCE_NAME = re.compile(rb"^\$\{?(" + SHELL_IDENTIFIER + rb")\}?$")
# A connection string may begin with any libpq parameter, not just host/user.
# Keep this set aligned with libpq's documented keyword/value parameters.
LIBPQ_CONNINFO_KEYS = frozenset(
    b"""host hostaddr port dbname user password passfile require_auth
    channel_binding connect_timeout client_encoding options application_name
    fallback_application_name keepalives keepalives_idle keepalives_interval
    keepalives_count tcp_user_timeout replication gssencmode sslmode requiressl
    sslnegotiation sslcompression sslcert sslkey sslkeylogfile sslpassword
    sslcertmode sslrootcert sslcrl sslcrldir sslsni requirepeer
    ssl_min_protocol_version ssl_max_protocol_version min_protocol_version
    max_protocol_version krbsrvname gsslib gssdelegation scram_client_key
    scram_server_key service target_session_attrs load_balance_hosts
    oauth_issuer oauth_client_id oauth_client_secret oauth_scope""".split()
)
LIBPQ_CONNINFO_START = re.compile(
    rb"^[ \t]*(?:" + b"|".join(sorted(LIBPQ_CONNINFO_KEYS)) + rb")[ \t]*=",
    re.I,
)
LIBPQ_CONNINFO_KEY = re.compile(
    rb"(?:^|[ \t])(?:"
    + b"|".join(sorted(LIBPQ_CONNINFO_KEYS - {b"password"}))
    + rb")[ \t]*=",
    re.I,
)
LIBPQ_PASSWORD_KEY = re.compile(rb"(?:^|[ \t])password[ \t]*=[ \t]*\S", re.I)


def shell_words(line: bytes, *, include_separators: bool = False):
    """Yield shell words without treating a quoted fixture as executable code.

    The scanner rejects a password assignment wherever it is a whole word,
    including in groups, subshells, env arguments and quoted command strings.
    It does not need to enumerate the command words that can precede it.
    """
    start = None
    quote = None
    escaped = False
    for index, byte in enumerate(line):
        if start is None:
            if byte in b" \t\r\n;|&()<>":
                if include_separators and byte in b";|&()<>":
                    yield line[index : index + 1]
                continue
            if byte == ord("#"):
                break
            start = index
        if escaped:
            escaped = False
        elif byte == ord("\\") and quote != ord("'"):
            escaped = True
        elif quote is not None:
            if byte == quote:
                quote = None
        elif byte in (ord("'"), ord('"')):
            quote = byte
        elif byte in b" \t\r\n;|&()<>":
            yield line[start:index]
            start = None
            if include_separators and byte in b";|&()<>":
                yield line[index : index + 1]
    if start is not None:
        yield line[start:]


def shell_assignment(word: bytes) -> tuple[bytes, bytes] | None:
    # `env "PGPASSWORD=literal"` is executable; `content='PGPASSWORD=literal'`
    # assigns a different variable and is a harmless fixture definition.
    if len(word) >= 2 and word[0] in (ord("'"), ord('"')) and word[-1] == word[0]:
        word = word[1:-1]
    match = SHELL_ASSIGNMENT.match(word)
    return (match.group(1), match.group(2)) if match else None


def shell_commands(line: bytes):
    """Split shell commands without interpreting separators inside quotes."""
    words = []
    for word in shell_words(line, include_separators=True):
        if word in (b";", b"|", b"&", b"(", b")", b"<", b">"):
            if words:
                yield words
                words = []
        else:
            words.append(word)
    if words:
        yield words


def skip_wrapper_options(
    words: list[bytes], index: int, value_options: set[bytes]
) -> int:
    """Skip wrapper flags, including flags whose next word is an option value."""
    while index < len(words):
        option = unquote_shell_word(words[index])
        if option == b"--":
            return index + 1
        if not option.startswith(b"-") or option == b"-":
            break
        index += 1
        if option in value_options:
            index += 1
    return index


def split_env_string(word: bytes) -> tuple[list[bytes], bool]:
    """Split the ordinary env -S syntax; reject forms we cannot model safely."""
    value = unquote_shell_word(word)
    # GNU env also processes escapes and variable references in split strings.
    # Their meaning differs from shell quoting, so fail closed instead of
    # treating a possibly obfuscated DB command as harmless text.
    if b"\\" in value or b"$" in value or b"\0" in value:
        return [], True
    try:
        parts = shlex.split(value.decode("utf-8", "surrogateescape"))
    except ValueError:
        return [], True
    return [part.encode("utf-8", "surrogateescape") for part in parts], False


def executable_words(
    words: list[bytes],
) -> tuple[bytes, list[bytes], list[bytes], bool]:
    """Find the executable after shell control words, assignments and wrappers."""
    index = 0
    split_words = []
    while index < len(words):
        word = unquote_shell_word(words[index])
        if word in (
            b"if",
            b"then",
            b"elif",
            b"else",
            b"while",
            b"until",
            b"do",
            b"!",
            b"--",
        ):
            index += 1
        elif word == b"time":
            index += 1
            if index < len(words) and words[index] == b"-p":
                index += 1
        elif shell_assignment(word):
            index += 1
        elif word.rsplit(b"/", 1)[-1] == b"env":
            index += 1
            while index < len(words) and unquote_shell_word(words[index]).startswith(
                b"-"
            ):
                option = unquote_shell_word(words[index])
                index += 1
                if option == b"--":
                    break
                argument = None
                if option.startswith(b"--"):
                    if option in (b"--unset", b"--chdir", b"--split-string"):
                        if index >= len(words):
                            return b"", [], split_words, True
                        if option == b"--split-string":
                            argument = words[index]
                        index += 1
                    elif option.startswith(b"--split-string="):
                        argument = option[len(b"--split-string=") :]
                    elif option in (
                        b"--ignore-environment",
                        b"--null",
                        b"--debug",
                    ) or option.startswith((b"--unset=", b"--chdir=")):
                        pass
                    else:
                        return b"", [], split_words, True
                elif option == b"-":
                    # A lone dash is GNU env's shorthand for -i.
                    continue
                else:
                    # GNU env permits clusters such as -vS STRING and -iSSTRING.
                    # Options with values consume the rest of the cluster or
                    # the next shell word; S must be expanded before scanning.
                    for offset, flag in enumerate(option[1:], start=2):
                        if flag in b"iv0":
                            continue
                        if flag not in b"uCS":
                            return b"", [], split_words, True
                        attached = option[offset:]
                        if not attached:
                            if index >= len(words):
                                return b"", [], split_words, True
                            attached = words[index]
                            index += 1
                        if flag == ord("S"):
                            argument = attached
                        break
                if argument is not None:
                    parsed, unsafe = split_env_string(argument)
                    if unsafe:
                        return b"", [], split_words, True
                    split_words.extend(parsed)
                    words = [b"env", *parsed, *words[index:]]
                    index = 0
                    break
        elif word in (b"command", b"exec", b"builtin"):
            index += 1
            while index < len(words) and words[index].startswith(b"-"):
                option = words[index]
                index += 1
                if word == b"exec" and option == b"-a":
                    index += 1
        elif word.rsplit(b"/", 1)[-1] == b"timeout":
            index = skip_wrapper_options(
                words, index + 1, {b"-k", b"-s", b"--kill-after", b"--signal"}
            )
            index += 1  # DURATION precedes the executable.
        elif word.rsplit(b"/", 1)[-1] == b"sudo":
            index = skip_wrapper_options(
                words,
                index + 1,
                {
                    b"-C",
                    b"-D",
                    b"-g",
                    b"-h",
                    b"-p",
                    b"-R",
                    b"-r",
                    b"-T",
                    b"-t",
                    b"-U",
                    b"-u",
                    b"--chdir",
                    b"--chroot",
                    b"--close-from",
                    b"--command-timeout",
                    b"--group",
                    b"--host",
                    b"--other-user",
                    b"--prompt",
                    b"--role",
                    b"--type",
                    b"--user",
                },
            )
        elif word.rsplit(b"/", 1)[-1] == b"nohup":
            index += 1
            if index < len(words) and unquote_shell_word(words[index]) == b"--":
                index += 1
        else:
            return word.rsplit(b"/", 1)[-1], words[index + 1 :], split_words, False
    return b"", [], split_words, False


def unquote_shell_word(word: bytes) -> bytes:
    if len(word) >= 2 and word[0] == word[-1] == ord("'"):
        return word[1:-1]
    if len(word) >= 2 and word[0] == word[-1] == ord('"'):
        return re.sub(rb"\\([\\$`\"])", rb"\1", word[1:-1])
    return word


def libpq_conninfo_arguments(line: bytes):
    """Find executable psql database arguments, including shell -c commands.

    Assignment values and arguments of other programs stay opaque, so fixture
    definitions and `curl -d` do not become psql commands.
    """
    pending = [line]
    candidates = []
    split_words = []
    unsafe_split = False
    while pending:
        for command in shell_commands(pending.pop()):
            executable, arguments, expanded, unsafe = executable_words(command)
            split_words.extend(expanded)
            unsafe_split |= unsafe
            if executable in (b"sh", b"bash", b"dash", b"zsh", b"ksh"):
                for index, word in enumerate(arguments[:-1]):
                    if re.fullmatch(rb"-[A-Za-z]*c[A-Za-z]*", word):
                        pending.append(unquote_shell_word(arguments[index + 1]))
                        break
            if executable != b"psql":
                continue
            for index, word in enumerate(arguments):
                if word in (b"-d", b"--dbname") and index + 1 < len(arguments):
                    argument = arguments[index + 1]
                elif word.startswith(b"--dbname="):
                    argument = word[len(b"--dbname=") :]
                elif word.startswith(b"-d") and len(word) > 2:
                    argument = word[2:]
                else:
                    continue
                candidates.append(unquote_shell_word(argument))
    return candidates, split_words, unsafe_split


def shell_logical_lines(source):
    """Join shell backslash-newline continuations without retaining long lines.

    Shell removes an unescaped backslash and newline before parsing words, even
    when they split an identifier. Report overlong lines and DB markers found
    anywhere in them, so the caller does not trust only a bounded prefix.
    """
    logical = bytearray()
    joined = False
    oversized_prefix = None
    oversized_joined = False
    oversized_db_marker = False
    marker_overlap = b""
    while fragment := source.readline(MAX_CARRIER_LINE_BYTES + 1):
        has_newline = fragment.endswith(b"\n")
        complete = has_newline or len(fragment) <= MAX_CARRIER_LINE_BYTES
        backslashes = 0
        if has_newline:
            index = len(fragment) - 2
            while index >= 0 and fragment[index] == ord("\\"):
                backslashes += 1
                index -= 1
        continued = backslashes % 2 == 1
        if oversized_prefix is not None:
            marker_window = (marker_overlap + fragment).lower()
            oversized_db_marker |= any(
                marker in marker_window for marker in OVERSIZED_DB_MARKERS
            )
            marker_overlap = marker_window[-(MAX_OVERSIZED_MARKER_BYTES - 1) :]
            oversized_joined |= continued
            if complete and not continued:
                yield oversized_prefix, True, oversized_joined, oversized_db_marker
                oversized_prefix = None
                oversized_db_marker = False
                marker_overlap = b""
            continue
        payload = fragment[:-2] if continued else fragment
        available = MAX_CARRIER_LINE_BYTES - len(logical)
        if len(payload) > available:
            oversized_prefix = bytes(logical) + payload[:available]
            oversized_joined = joined or continued
            marker_window = (bytes(logical) + payload).lower()
            oversized_db_marker = any(
                marker in marker_window for marker in OVERSIZED_DB_MARKERS
            )
            marker_overlap = marker_window[-(MAX_OVERSIZED_MARKER_BYTES - 1) :]
            logical.clear()
            joined = False
            if complete and not continued:
                yield oversized_prefix, True, oversized_joined, oversized_db_marker
                oversized_prefix = None
                oversized_db_marker = False
                marker_overlap = b""
            continue
        logical.extend(payload)
        if continued:
            joined = True
        else:
            yield bytes(logical), False, joined, False
            logical.clear()
            joined = False
    if oversized_prefix is not None:
        yield oversized_prefix, True, oversized_joined, oversized_db_marker
    elif logical:
        yield bytes(logical), False, joined, False


def candidates(carriers: list[Path], worktree_roots: list[Path]):
    for carrier in carriers:
        yield carrier, True
    for root in worktree_roots:
        if root.is_symlink() or not root.is_dir():
            yield root, False
            continue
        walk_errors = []
        for directory, dirs, files in os.walk(
            root, followlinks=False, onerror=walk_errors.append
        ):
            # os.walk leaves symlinked directories in dirs without visiting them.
            # Report every one so an agent-readable copy cannot hide behind it.
            for name in dirs:
                if (Path(directory) / name).is_symlink():
                    yield Path(directory) / name, False
            for name in files:
                yield Path(directory) / name, False
        for error in walk_errors:
            yield Path(error.filename), False


def scan_credentials(path: Path, old_url: bytes) -> tuple[bool, bool, bool]:
    """Find old URLs, inline URLs and libpq passfile entries with bounded memory.

    Prefix and credential state continue across read boundaries, including for
    URLs with a username or password longer than a read chunk.
    """
    overlap = b""
    has_old_url = False
    has_inline_url = False
    has_passfile_entry = False
    passfile_fields = 0
    passfile_field_has_bytes = False
    passfile_line_valid = True
    passfile_escaped = False
    passfile_port_star = False
    prefix_lengths = [0, 0]
    credential_part = 0  # 0: none, 1: username, 2: password
    part_has_bytes = False
    query_part = 0  # 0: no URL, 1: before ?, 2: parameter name, 3: value
    query_key = bytearray()
    query_key_overlong = False
    nested_url_query = False
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            data = overlap + chunk
            has_old_url |= old_url in data
            overlap = data[-(len(old_url) - 1) :] if len(old_url) > 1 else b""
            if has_inline_url:
                continue
            for raw_byte in chunk:
                # A custom PGPASSFILE can have any name. Recognize its five
                # colon-separated fields in every scanned file, including
                # explicit --carrier paths, without retaining line contents.
                if not has_passfile_entry:
                    if raw_byte in (10, 13):
                        has_passfile_entry = (
                            passfile_line_valid
                            and passfile_fields == 4
                            and passfile_field_has_bytes
                            and not passfile_escaped
                        )
                        passfile_fields = 0
                        passfile_field_has_bytes = False
                        passfile_line_valid = True
                        passfile_escaped = False
                        passfile_port_star = False
                    elif passfile_line_valid:
                        if raw_byte == 0 or (
                            raw_byte == ord("#")
                            and passfile_fields == 0
                            and not passfile_field_has_bytes
                        ):
                            passfile_line_valid = False
                        elif passfile_escaped:
                            passfile_field_has_bytes = True
                            passfile_escaped = False
                        elif raw_byte == ord("\\"):
                            if passfile_fields == 1:
                                passfile_line_valid = False
                            else:
                                passfile_escaped = True
                        elif raw_byte == ord(":"):
                            if not passfile_field_has_bytes or passfile_fields == 4:
                                passfile_line_valid = False
                            else:
                                passfile_fields += 1
                                passfile_field_has_bytes = False
                        else:
                            if passfile_fields == 1:
                                if (
                                    raw_byte == ord("*")
                                    and not passfile_field_has_bytes
                                ):
                                    passfile_port_star = True
                                elif not (
                                    48 <= raw_byte <= 57 and not passfile_port_star
                                ):
                                    passfile_line_valid = False
                            passfile_field_has_bytes = True
                byte = raw_byte + 32 if 65 <= raw_byte <= 90 else raw_byte
                found_prefix = False
                for index, prefix in enumerate(URL_PREFIXES):
                    length = prefix_lengths[index]
                    if byte == prefix[length]:
                        length += 1
                        if length == len(prefix):
                            found_prefix = True
                            length = 0
                    else:
                        length = 1 if byte == ord("p") else 0
                    prefix_lengths[index] = length
                if found_prefix and query_part == 0:
                    query_part = 1
                elif found_prefix:
                    nested_url_query = True
                if byte in URL_WHITESPACE or byte in b"'\"<>`#":
                    query_part = 0
                    query_key.clear()
                    nested_url_query = False
                # A second URL can immediately follow a query value. A bare ?
                # inside a value is not a new PostgreSQL parameter, however.
                elif byte == ord("?") and (query_part == 1 or nested_url_query):
                    query_part = 2
                    query_key.clear()
                    query_key_overlong = False
                    nested_url_query = False
                elif query_part == 2:
                    if byte == ord("&"):
                        query_key.clear()
                        query_key_overlong = False
                        nested_url_query = False
                    elif byte == ord("="):
                        if (
                            not query_key_overlong
                            and unquote_to_bytes(bytes(query_key)) == PASSWORD_QUERY_KEY
                        ):
                            has_inline_url = True
                            break
                        query_part = 3
                    elif len(query_key) < MAX_QUERY_KEY_BYTES:
                        query_key.append(byte)
                    else:
                        query_key_overlong = True
                elif query_part == 3 and byte == ord("&"):
                    query_part = 2
                    query_key.clear()
                    query_key_overlong = False
                    nested_url_query = False
                # A second prefix may itself be part of a password.
                if found_prefix and credential_part == 0:
                    credential_part = 1
                    part_has_bytes = False
                    continue
                if credential_part == 1:
                    if byte == ord(":"):
                        credential_part = 2 if part_has_bytes else 0
                        part_has_bytes = False
                    elif byte in b"/@?#":
                        credential_part = 0
                    elif byte in URL_WHITESPACE or byte in b"'\"":
                        credential_part = 0
                    else:
                        part_has_bytes = True
                elif credential_part == 2:
                    if byte == ord("@"):
                        if part_has_bytes:
                            has_inline_url = True
                            break
                        credential_part = 0
                    elif byte in URL_WHITESPACE or byte in b"'\"":
                        credential_part = 0
                    else:
                        part_has_bytes = True
    has_passfile_entry |= (
        passfile_line_valid
        and passfile_fields == 4
        and passfile_field_has_bytes
        and not passfile_escaped
    )
    return has_old_url, has_inline_url, has_passfile_entry


def scan_libpq_carrier(path: Path) -> tuple[list[str], set[bytes], set[bytes]]:
    """Reject libpq password sources that contain no PostgreSQL URL.

    A service file may have any name via PGSERVICEFILE. Shell assignments and
    keyword/value conninfo may also have arbitrary names. Read bounded lines
    in every file; shell scripts and DB-bearing oversized lines fail closed.
    Values are not logged.
    """
    is_env = path.name.startswith(".env")
    is_service = path.name in SERVICE_FILE_NAMES
    is_passfile = path.name in PASSFILE_NAMES
    is_named_carrier = is_env or is_service or is_passfile
    reasons = set()
    in_service_section = False
    conninfo_has_key = False
    conninfo_has_password = False
    meaningful_lines = 0
    password_only_line = False
    assigned_variables = set()
    password_references = set()
    with path.open("rb") as source:
        shebang = source.readline(128).split(b"\n", 1)[0]
        source.seek(0)
        shell_names = {b"sh", b"bash", b"dash", b"zsh", b"ksh"}
        is_shell_script = path.suffix in {".sh", ".bash", ".zsh", ".ksh"} or (
            shebang.startswith(b"#!")
            and any(word.rsplit(b"/", 1)[-1] in shell_names for word in shebang.split())
        )
        for line, oversized, joined, db_marker in shell_logical_lines(source):
            if oversized:
                is_comment = line.lstrip().startswith(b"#")
                if (
                    is_named_carrier
                    or joined
                    or (not is_comment and (is_shell_script or db_marker))
                    or (
                        not is_comment
                        and (
                            in_service_section
                            or line.lstrip().startswith(b"[")
                            or b"PGPASSWORD=" in line
                            or b"PGPASS" in line
                            or LIBPQ_CONNINFO_START.match(line)
                        )
                    )
                ):
                    reasons.add("oversized-db-carrier-line")
                if is_named_carrier:
                    break
                continue
            if line.startswith(b"#!"):
                # In a shebang, env -S receives and splits the interpreter
                # arguments even though the shell treats the line as a comment.
                line = line[2:].lstrip()
            elif not line.strip() or line.lstrip().startswith(b"#"):
                continue
            if re.fullmatch(rb"\[[^\]\r\n]+\]", line.strip()):
                in_service_section = True
            if is_env:
                assignment = re.match(
                    rb"^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z_0-9]*)[ \t]*=",
                    line,
                )
                if assignment:
                    key = assignment.group(1)
                    if key in ENV_DB_URL_KEYS:
                        reasons.add("env-db-url")
                    if key == b"PGPASSWORD":
                        reasons.add("env-libpq-password")
                    if key in ENV_LIBPQ_KEYS - {b"PGPASSWORD"}:
                        reasons.add("env-libpq-credential-reference")
            if (is_service or in_service_section) and re.match(
                rb"^[ \t]*(?:password|passfile)[ \t]*=", line, re.I
            ):
                reasons.add("libpq-service-credential")
            conninfo_arguments, split_words, unsafe_split = libpq_conninfo_arguments(
                line
            )
            if unsafe_split:
                reasons.add("unparsed-env-split-string")
            # A whole assignment word can follow any shell construct, including
            # a group. The caller checks direct references against definitions
            # in every scanned file, not only the file holding PGPASSWORD.
            if b"=" in line:
                for word in (*shell_words(line), *split_words):
                    assignments = [shell_assignment(word)]
                    if (
                        assignments[0] is None
                        and len(word) >= 2
                        and word[0] in (ord("'"), ord('"'))
                        and word[-1] == word[0]
                    ):
                        # A standalone quoted argument can itself be a `sh -c`
                        # command. Inspect its words while leaving `content='…'`
                        # fixture definitions alone.
                        assignments.extend(
                            shell_assignment(inner) for inner in shell_words(word[1:-1])
                        )
                    for assignment in assignments:
                        if assignment is None:
                            continue
                        name, value = assignment
                        if name != b"PGPASSWORD":
                            assigned_variables.add(name)
                        elif value:
                            if SAFE_PASSWORD_REFERENCE.fullmatch(value):
                                reference = value.strip(b'"')
                                match = PRIVATE_REFERENCE_NAME.fullmatch(reference)
                                if match:
                                    password_references.add(match.group(1))
                            else:
                                reasons.add("env-libpq-password")
            if not is_service and not in_service_section:
                meaningful_lines += 1
                conninfo_lines = [line]
                conninfo_lines.extend(conninfo_arguments)
                matches = [
                    (
                        bool(LIBPQ_CONNINFO_KEY.search(candidate)),
                        bool(LIBPQ_PASSWORD_KEY.search(candidate)),
                        index > 0,
                    )
                    for index, candidate in enumerate(conninfo_lines)
                    if LIBPQ_CONNINFO_START.match(candidate)
                ]
                if matches:
                    has_key = any(match[0] for match in matches)
                    has_password = any(match[1] for match in matches)
                    conninfo_has_key |= has_key
                    conninfo_has_password |= has_password
                    password_only_line = has_password and not has_key
                    if conninfo_has_key and conninfo_has_password:
                        reasons.add("libpq-conninfo-password")
                    if any(match[1] and match[2] for match in matches):
                        # `psql -d 'password=...'` is a complete conninfo too.
                        reasons.add("libpq-conninfo-password")
                else:
                    conninfo_has_key = False
                    conninfo_has_password = False
            if is_passfile:
                reasons.add("libpq-passfile-entry")
    if meaningful_lines == 1 and password_only_line:
        reasons.add("libpq-conninfo-password")
    return sorted(reasons), assigned_variables, password_references


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--old-url-file", required=True, type=Path)
    parser.add_argument("--carrier", action="append", default=[], type=Path)
    parser.add_argument("--worktree-root", action="append", default=[], type=Path)
    args = parser.parse_args()
    old_url = args.old_url_file.read_bytes().strip()
    if not old_url:
        parser.error("old URL source is empty")
    paths = list(dict.fromkeys(candidates(args.carrier, args.worktree_root)))
    if not paths:
        parser.error("at least one carrier or worktree root is required")

    failures = 0
    checked = 0
    assigned_variables = set()
    scanned_files = []
    for root in args.worktree_root:
        if root.is_symlink() or not root.is_dir():
            print(f"INVALID_WORKTREE_ROOT {root}")
            failures += 1
    for path, _is_carrier in paths:
        if path in args.worktree_root:
            continue
        try:
            info = path.lstat()
        except FileNotFoundError:
            print(f"MISSING {path}")
            failures += 1
            continue
        if stat.S_ISLNK(info.st_mode):
            print(f"SYMLINK {path}")
            failures += 1
            continue
        if not stat.S_ISREG(info.st_mode):
            print(f"NONFILE {path}")
            failures += 1
            continue
        try:
            has_old_url, has_inline_url, has_passfile_entry = scan_credentials(
                path, old_url
            )
            is_instance_config = (
                path.name == "config.json" and path.parent.name == ".paperclip"
            )
            data = path.read_bytes() if is_instance_config else b""
            carrier_reasons, definitions, references = scan_libpq_carrier(path)
        except OSError:
            print(f"UNREADABLE {path}")
            failures += 1
            continue
        checked += 1
        assigned_variables.update(definitions)
        reasons = []
        if has_old_url:
            reasons.append("old-url-copy")
        if has_inline_url:
            reasons.append("inline-db-credential")
        if has_passfile_entry and "libpq-passfile-entry" not in carrier_reasons:
            reasons.append("libpq-passfile-entry")
        reasons.extend(carrier_reasons)
        if is_instance_config:
            try:
                config = json.loads(data)
                if config.get("database", {}).get("connectionString"):
                    reasons.append("config-connection-string")
            except (ValueError, TypeError, AttributeError):
                reasons.append("invalid-config-json")
        scanned_files.append((path, reasons, references))
    for path, reasons, references in scanned_files:
        if references & assigned_variables and "env-libpq-password" not in reasons:
            reasons.append("env-libpq-password")
        if reasons:
            print(f"FAIL {path} reasons={','.join(reasons)}")
            failures += 1
    print(f"Copy scan: checked={checked} failures={failures}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
