import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import struct
import sys
import tempfile
import zipfile


MAX_BYTES = 256 * 1024 * 1024
MAX_ARCHIVE_BYTES = MAX_BYTES + 8 * 1024 * 1024
MAX_FILES = 4097


def safe_path(name):
    parts = name.split("/")
    if (not name or len(name) > 512 or "\\" in name or ":" in name
            or any(ord(c) < 32 or ord(c) == 127 for c in name)
            or any(p in ("", ".", "..") for p in parts)):
        raise ValueError("Unsafe private archive path")
    return PurePosixPath(name)


def pack(source, destination):
    source, destination = Path(source), Path(destination)
    if source.is_symlink() or not source.is_dir():
        raise ValueError("Private archive source must be a directory")
    root = source.resolve()
    if destination.resolve().is_relative_to(root):
        raise ValueError("Private archive must be outside its source")
    files = []
    names_seen = set()
    total = 0
    visited = 0
    for directory, directories, names in os.walk(source, followlinks=False):
        visited += len(directories) + len(names)
        if visited > MAX_FILES:
            raise ValueError("Private archive exceeds entry allowance")
        for name in directories:
            entry = Path(directory) / name
            safe_path(entry.relative_to(source).as_posix())
            if entry.is_symlink():
                raise ValueError("Private archive cannot contain symlinks")
        for name in names:
            entry = Path(directory) / name
            relative = entry.relative_to(source).as_posix()
            safe_path(relative)
            if relative.casefold() in names_seen:
                raise ValueError("Private archive has colliding paths")
            names_seen.add(relative.casefold())
            metadata = entry.lstat()
            if not stat.S_ISREG(metadata.st_mode) or not entry.resolve().is_relative_to(root):
                raise ValueError("Private archive requires regular files")
            total += metadata.st_size
            if total > MAX_BYTES:
                raise ValueError("Private archive exceeds byte allowance")
            files.append((entry, relative, metadata))
    if not files:
        raise ValueError("Private archive is empty")
    output = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(output, "wb") as stream, zipfile.ZipFile(stream, "w", zipfile.ZIP_STORED, allowZip64=False) as archive:
            for entry, relative, before in sorted(files):
                with os.fdopen(os.open(entry, os.O_RDONLY | os.O_NOFOLLOW), "rb") as data:
                    observed = os.fstat(data.fileno())
                    if (observed.st_ino, observed.st_size, observed.st_mtime_ns) != (before.st_ino, before.st_size, before.st_mtime_ns):
                        raise ValueError("Private archive source changed")
                    info = zipfile.ZipInfo(relative)
                    info.external_attr = (stat.S_IFREG | 0o600) << 16
                    copied = 0
                    with archive.open(info, "w") as target:
                        while chunk := data.read(64 * 1024):
                            copied += len(chunk)
                            if copied > before.st_size:
                                raise ValueError("Private archive source grew")
                            target.write(chunk)
                    after = os.fstat(data.fileno())
                    if copied != before.st_size or (after.st_size, after.st_mtime_ns, after.st_ctime_ns) != (before.st_size, before.st_mtime_ns, before.st_ctime_ns):
                        raise ValueError("Private archive source changed")
        if destination.stat().st_size > MAX_ARCHIVE_BYTES:
            raise ValueError("Private archive exceeds transfer allowance")
    except BaseException:
        destination.unlink(missing_ok=True)
        raise
    return {"files": len(files), "sourceBytes": total, "archiveBytes": destination.stat().st_size}


def unpack(source, destination):
    source, destination = Path(source), Path(destination)
    if source.is_symlink() or not source.is_file() or source.stat().st_size > MAX_ARCHIVE_BYTES:
        raise ValueError("Invalid private archive file")
    if destination.exists() or destination.is_symlink():
        raise ValueError("Private archive destination already exists")
    with source.open("rb") as data:
        if source.stat().st_size < 22:
            raise ValueError("Private archive is truncated")
        data.seek(-22, os.SEEK_END)
        signature, disk, start_disk, disk_entries, entries, central_bytes, central_offset, comment_bytes = struct.unpack("<4s4H2LH", data.read(22))
        if (signature != b"PK\x05\x06" or disk or start_disk or comment_bytes
                or entries != disk_entries or not 0 < entries <= MAX_FILES
                or central_bytes > 8 * 1024 * 1024
                or central_offset + central_bytes != source.stat().st_size - 22):
            raise ValueError("Private archive directory exceeds its boundary")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".private-eval-", dir=destination.parent))
    try:
        with zipfile.ZipFile(source) as archive:
            entries = archive.infolist()
            if not entries or len(entries) != disk_entries or len(entries) > MAX_FILES:
                raise ValueError("Private archive exceeds entry allowance")
            paths = set()
            total = 0
            for entry in entries:
                relative = safe_path(entry.filename)
                mode = entry.external_attr >> 16
                if (entry.compress_type != zipfile.ZIP_STORED or entry.flag_bits & 1
                        or stat.S_IFMT(mode) not in (0, stat.S_IFREG)
                        or str(relative).casefold() in paths):
                    raise ValueError("Private archive has unsupported or duplicate entries")
                paths.add(str(relative).casefold())
                total += entry.file_size
                if total > MAX_BYTES:
                    raise ValueError("Private archive exceeds byte allowance")
            for entry in entries:
                target = temporary.joinpath(*safe_path(entry.filename).parts)
                target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                copied = 0
                with archive.open(entry) as data, os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as output:
                    while chunk := data.read(64 * 1024):
                        copied += len(chunk)
                        if copied > entry.file_size:
                            raise ValueError("Private archive entry exceeded its declared size")
                        output.write(chunk)
                if copied != entry.file_size:
                    raise ValueError("Private archive entry was truncated")
        os.rename(temporary, destination)
    except BaseException:
        shutil.rmtree(temporary)
        raise
    return {"files": len(entries), "sourceBytes": total}


if __name__ == "__main__":
    if len(sys.argv) != 4 or sys.argv[1] not in ("pack", "unpack"):
        raise SystemExit("Usage: private-history-archive.py pack|unpack SOURCE DESTINATION")
    print(json.dumps((pack if sys.argv[1] == "pack" else unpack)(sys.argv[2], sys.argv[3])))
