from __future__ import annotations

import os
import uuid
import shutil
from abc import abstractmethod
from typing import TYPE_CHECKING, Any, List, cast
from pathlib import Path
from typing_extensions import override, assert_never

from anyio import Path as AsyncPath
from anyio.to_thread import run_sync

from anthropic.types.beta import (
    BetaMemoryTool20250818ViewCommand,
    BetaMemoryTool20250818CreateCommand,
    BetaMemoryTool20250818DeleteCommand,
    BetaMemoryTool20250818InsertCommand,
    BetaMemoryTool20250818RenameCommand,
    BetaMemoryTool20250818StrReplaceCommand,
)

from ..._models import construct_type_unchecked
from ...types.beta import (
    BetaMemoryTool20250818Param,
    BetaMemoryTool20250818Command,
    BetaCacheControlEphemeralParam,
    BetaMemoryTool20250818ViewCommand,
    BetaMemoryTool20250818CreateCommand,
    BetaMemoryTool20250818DeleteCommand,
    BetaMemoryTool20250818InsertCommand,
    BetaMemoryTool20250818RenameCommand,
    BetaMemoryTool20250818StrReplaceCommand,
)
from ._beta_functions import (
    ToolError,
    BetaBuiltinFunctionTool,
    BetaFunctionToolResultType,
    BetaAsyncBuiltinFunctionTool,
)

MAX_LINES = 999999
LINE_NUMBER_WIDTH = len(str(MAX_LINES))

# Owner read/write only. Avoids 0o666 which, in environments with a permissive
# umask (e.g. Docker where umask is often 0o000), would make memory files
# world-readable or even world-writable.
_FILE_CREATE_MODE = 0o600
# The default mkdir mode is 0o777, but we want to be more restrictive for memory
# directories to avoid them being world-accessible in environments with permissive umasks
# (eg Docker)
_DIR_CREATE_MODE = 0o700


class BetaAbstractMemoryTool(BetaBuiltinFunctionTool):
    """Abstract base class for memory tool implementations.

    This class provides the interface for implementing a custom memory backend for Claude.

    Subclass this to create your own memory storage solution (e.g., database, cloud storage, encrypted files, etc.).

    Example usage:

    ```py
    class MyMemoryTool(BetaAbstractMemoryTool):
        def view(self, command: BetaMemoryTool20250818ViewCommand) -> BetaFunctionToolResultType:
            ...
            return "view result"

        def create(self, command: BetaMemoryTool20250818CreateCommand) -> BetaFunctionToolResultType:
            ...
            return "created successfully"

        # ... implement other abstract methods


    client = Anthropic()
    memory_tool = MyMemoryTool()
    message = client.beta.messages.run_tools(
        model="claude-sonnet-4-5",
        messages=[{"role": "user", "content": "Remember that I like coffee"}],
        tools=[memory_tool],
    ).until_done()
    ```
    """

    def __init__(self, *, cache_control: BetaCacheControlEphemeralParam | None = None) -> None:
        super().__init__()
        self._cache_control = cache_control

    @override
    def to_dict(self) -> BetaMemoryTool20250818Param:
        param: BetaMemoryTool20250818Param = {"type": "memory_20250818", "name": "memory"}

        if self._cache_control is not None:
            param["cache_control"] = self._cache_control

        return param

    @override
    def call(self, input: object) -> BetaFunctionToolResultType:
        command = cast(
            BetaMemoryTool20250818Command,
            construct_type_unchecked(value=input, type_=cast(Any, BetaMemoryTool20250818Command)),
        )
        return self.execute(command)

    def execute(self, command: BetaMemoryTool20250818Command) -> BetaFunctionToolResultType:
        """Execute a memory command and return the result.

        This method dispatches to the appropriate handler method based on the
        command type (view, create, str_replace, insert, delete, rename).

        You typically don't need to override this method.
        """
        if command.command == "view":
            return self.view(command)
        elif command.command == "create":
            return self.create(command)
        elif command.command == "str_replace":
            return self.str_replace(command)
        elif command.command == "insert":
            return self.insert(command)
        elif command.command == "delete":
            return self.delete(command)
        elif command.command == "rename":
            return self.rename(command)
        elif TYPE_CHECKING:  # type: ignore[unreachable]
            assert_never(command)
        else:
            raise NotImplementedError(f"Unknown command: {command.command}")

    @abstractmethod
    def view(self, command: BetaMemoryTool20250818ViewCommand) -> BetaFunctionToolResultType:
        """View the contents of a memory path."""
        pass

    @abstractmethod
    def create(self, command: BetaMemoryTool20250818CreateCommand) -> BetaFunctionToolResultType:
        """Create a new memory file with the specified content."""
        pass

    @abstractmethod
    def str_replace(self, command: BetaMemoryTool20250818StrReplaceCommand) -> BetaFunctionToolResultType:
        """Replace text in a memory file."""
        pass

    @abstractmethod
    def insert(self, command: BetaMemoryTool20250818InsertCommand) -> BetaFunctionToolResultType:
        """Insert text at a specific line number in a memory file."""
        pass

    @abstractmethod
    def delete(self, command: BetaMemoryTool20250818DeleteCommand) -> BetaFunctionToolResultType:
        """Delete a memory file or directory."""
        pass

    @abstractmethod
    def rename(self, command: BetaMemoryTool20250818RenameCommand) -> BetaFunctionToolResultType:
        """Rename or move a memory file or directory."""
        pass

    def clear_all_memory(self) -> BetaFunctionToolResultType:
        """Clear all memory data."""
        raise NotImplementedError("clear_all_memory not implemented")


class BetaAsyncAbstractMemoryTool(BetaAsyncBuiltinFunctionTool):
    """Abstract base class for memory tool implementations.

    This class provides the interface for implementing a custom memory backend for Claude.

    Subclass this to create your own memory storage solution (e.g., database, cloud storage, encrypted files, etc.).

    Example usage:

    ```py
    class MyMemoryTool(BetaAbstractMemoryTool):
        def view(self, command: BetaMemoryTool20250818ViewCommand) -> BetaFunctionToolResultType:
            ...
            return "view result"

        def create(self, command: BetaMemoryTool20250818CreateCommand) -> BetaFunctionToolResultType:
            ...
            return "created successfully"

        # ... implement other abstract methods


    client = Anthropic()
    memory_tool = MyMemoryTool()
    message = client.beta.messages.run_tools(
        model="claude-sonnet-4-5",
        messages=[{"role": "user", "content": "Remember that I like coffee"}],
        tools=[memory_tool],
    ).until_done()
    ```
    """

    def __init__(self, *, cache_control: BetaCacheControlEphemeralParam | None = None) -> None:
        super().__init__()
        self._cache_control = cache_control

    @override
    def to_dict(self) -> BetaMemoryTool20250818Param:
        param: BetaMemoryTool20250818Param = {"type": "memory_20250818", "name": "memory"}

        if self._cache_control is not None:
            param["cache_control"] = self._cache_control

        return param

    @override
    async def call(self, input: object) -> BetaFunctionToolResultType:
        command = cast(
            BetaMemoryTool20250818Command,
            construct_type_unchecked(value=input, type_=cast(Any, BetaMemoryTool20250818Command)),
        )
        return await self.execute(command)

    async def execute(self, command: BetaMemoryTool20250818Command) -> BetaFunctionToolResultType:
        """Execute a memory command and return the result.

        This method dispatches to the appropriate handler method based on the
        command type (view, create, str_replace, insert, delete, rename).

        You typically don't need to override this method.
        """
        if command.command == "view":
            return await self.view(command)
        elif command.command == "create":
            return await self.create(command)
        elif command.command == "str_replace":
            return await self.str_replace(command)
        elif command.command == "insert":
            return await self.insert(command)
        elif command.command == "delete":
            return await self.delete(command)
        elif command.command == "rename":
            return await self.rename(command)
        elif TYPE_CHECKING:  # type: ignore[unreachable]
            assert_never(command)
        else:
            raise NotImplementedError(f"Unknown command: {command.command}")

    @abstractmethod
    async def view(self, command: BetaMemoryTool20250818ViewCommand) -> BetaFunctionToolResultType:
        """View the contents of a memory path."""
        pass

    @abstractmethod
    async def create(self, command: BetaMemoryTool20250818CreateCommand) -> BetaFunctionToolResultType:
        """Create a new memory file with the specified content."""
        pass

    @abstractmethod
    async def str_replace(self, command: BetaMemoryTool20250818StrReplaceCommand) -> BetaFunctionToolResultType:
        """Replace text in a memory file."""
        pass

    @abstractmethod
    async def insert(self, command: BetaMemoryTool20250818InsertCommand) -> BetaFunctionToolResultType:
        """Insert text at a specific line number in a memory file."""
        pass

    @abstractmethod
    async def delete(self, command: BetaMemoryTool20250818DeleteCommand) -> BetaFunctionToolResultType:
        """Delete a memory file or directory."""
        pass

    @abstractmethod
    async def rename(self, command: BetaMemoryTool20250818RenameCommand) -> BetaFunctionToolResultType:
        """Rename or move a memory file or directory."""
        pass

    async def clear_all_memory(self) -> BetaFunctionToolResultType:
        """Clear all memory data."""
        raise NotImplementedError("clear_all_memory not implemented")


def _atomic_write_file(target_path: Path, content: str) -> None:
    dir_path = target_path.parent
    temp_path = dir_path / f".tmp-{os.getpid()}-{uuid.uuid4()}"
    data = content.encode("utf-8")

    try:
        fd = os.open(temp_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, _FILE_CREATE_MODE)
        try:
            offset = 0
            while offset < len(data):
                written = os.write(fd, data[offset:])
                if written == 0:
                    raise OSError("os.write returned 0")
                offset += written

            os.fsync(fd)
        finally:
            os.close(fd)

        os.replace(temp_path, target_path)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def _validate_no_symlink_escape(target_path: Path, memory_root: Path) -> None:
    resolved_root = memory_root.resolve()

    current = target_path
    while True:
        try:
            resolved = current.resolve()
            if resolved != resolved_root and not str(resolved).startswith(str(resolved_root) + os.sep):
                raise ToolError("Path would escape /memories directory via symlink")
            return
        except (FileNotFoundError, OSError):
            parent = current.parent
            if parent == current or current == memory_root:
                return
            current = parent


def _read_file_content(full_path: Path, memory_path: str) -> str:
    try:
        return full_path.read_text(encoding="utf-8")
    except FileNotFoundError as err:
        raise ToolError(
            f"The file {memory_path} no longer exists (may have been deleted or renamed concurrently)."
        ) from err


def _format_file_size(bytes_size: int) -> str:
    if bytes_size == 0:
        return "0B"
    k = 1024
    sizes = ["B", "K", "M", "G"]
    i = int(bytes_size.bit_length() - 1) // 10
    i = min(i, len(sizes) - 1)
    size = bytes_size / (k**i)

    if size == int(size):
        return f"{int(size)}{sizes[i]}"
    else:
        return f"{size:.1f}{sizes[i]}"


class BetaLocalFilesystemMemoryTool(BetaAbstractMemoryTool):
    """File-based memory storage implementation for Claude conversations"""

    def __init__(self, base_path: str = "./memory"):
        super().__init__()
        self.base_path = Path(base_path)
        self.memory_root = self.base_path / "memories"
        self.memory_root.mkdir(parents=True, exist_ok=True, mode=_DIR_CREATE_MODE)

    def _validate_path(self, path: str) -> Path:
        """Validate and resolve memory paths"""
        if not path.startswith("/memories"):
            raise ToolError(f"Path must start with /memories, got: {path}")

        relative_path = path[len("/memories") :].lstrip("/")
        full_path = self.memory_root / relative_path if relative_path else self.memory_root

        resolved_path = full_path.resolve()
        resolved_root = self.memory_root.resolve()
        if resolved_path != resolved_root and not str(resolved_path).startswith(str(resolved_root) + os.sep):
            raise ToolError(f"Path {path} would escape /memories directory")

        _validate_no_symlink_escape(resolved_path, self.memory_root)

        return resolved_path

    @override
    def view(self, command: BetaMemoryTool20250818ViewCommand) -> str:
        full_path = self._validate_path(command.path)

        if not full_path.exists():
            raise ToolError(f"The path {command.path} does not exist. Please provide a valid path.")

        if full_path.is_dir():
            items: List[tuple[str, str]] = []

            def collect_items(dir_path: Path, relative_path: str, depth: int) -> None:
                if depth > 2:
                    return

                try:
                    dir_contents = sorted(dir_path.iterdir(), key=lambda x: x.name)
                except Exception:
                    return

                for item in dir_contents:
                    if item.name.startswith("."):
                        continue
                    item_relative_path = f"{relative_path}/{item.name}" if relative_path else item.name
                    try:
                        stat = item.stat()
                    except Exception:
                        continue

                    if item.is_dir():
                        items.append((_format_file_size(stat.st_size), f"{item_relative_path}/"))
                        if depth < 2:
                            collect_items(item, item_relative_path, depth + 1)
                    elif item.is_file():
                        items.append((_format_file_size(stat.st_size), item_relative_path))

            collect_items(full_path, "", 1)

            header = f"Here're the files and directories up to 2 levels deep in {command.path}, excluding hidden items:"
            dir_stat = full_path.stat()
            dir_size = _format_file_size(dir_stat.st_size)
            lines = [f"{dir_size}\t{command.path}"]
            lines.extend([f"{size}\t{command.path}/{path}" for size, path in items])

            return f"{header}\n" + "\n".join(lines)

        elif full_path.is_file():
            content = _read_file_content(full_path, command.path)
            lines = content.split("\n")

            if len(lines) > MAX_LINES:
                raise ToolError(f"File {command.path} exceeds maximum line limit of 999,999 lines.")

            display_lines = lines
            start_num = 1

            if command.view_range and len(command.view_range) == 2:
                start_line = max(1, command.view_range[0]) - 1
                end_line = len(lines) if command.view_range[1] == -1 else command.view_range[1]
                display_lines = lines[start_line:end_line]
                start_num = start_line + 1

            numbered_lines = [
                f"{str(i + start_num).rjust(LINE_NUMBER_WIDTH)}\t{line}" for i, line in enumerate(display_lines)
            ]

            return f"Here's the content of {command.path} with line numbers:\n" + "\n".join(numbered_lines)
        else:
            raise ToolError(f"Unsupported file type for {command.path}")

    @override
    def create(self, command: BetaMemoryTool20250818CreateCommand) -> str:
        full_path = self._validate_path(command.path)

        full_path.parent.mkdir(parents=True, exist_ok=True, mode=_DIR_CREATE_MODE)

        try:
            fd = os.open(full_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, _FILE_CREATE_MODE)
            try:
                os.write(fd, command.file_text.encode("utf-8"))
                os.fsync(fd)
            finally:
                os.close(fd)
        except FileExistsError as err:
            raise ToolError(f"File {command.path} already exists") from err

        return f"File created successfully at: {command.path}"

    @override
    def str_replace(self, command: BetaMemoryTool20250818StrReplaceCommand) -> str:
        full_path = self._validate_path(command.path)

        if not full_path.exists():
            raise ToolError(f"The path {command.path} does not exist. Please provide a valid path.")

        if not full_path.is_file():
            raise ToolError(f"The path {command.path} is not a file.")

        content = _read_file_content(full_path, command.path)

        count = content.count(command.old_str)
        if count == 0:
            raise ToolError(
                f"No replacement was performed, old_str `{command.old_str}` did not appear verbatim in {command.path}."
            )
        elif count > 1:
            matching_lines: List[int] = []
            start = 0
            while True:
                pos = content.find(command.old_str, start)
                if pos == -1:
                    break
                matching_lines.append(content[:pos].count("\n") + 1)
                start = pos + 1
            raise ToolError(
                f"No replacement was performed. Multiple occurrences of old_str `{command.old_str}` in lines: {', '.join(map(str, matching_lines))}. Please ensure it is unique"
            )

        pos = content.find(command.old_str)
        changed_line_index = content[:pos].count("\n")
        new_content = content.replace(command.old_str, command.new_str)
        _atomic_write_file(full_path, new_content)

        new_lines = new_content.split("\n")
        context_start = max(0, changed_line_index - 2)
        context_end = min(len(new_lines), changed_line_index + 3)
        snippet = [
            f"{str(line_num).rjust(LINE_NUMBER_WIDTH)}\t{new_lines[line_num - 1]}"
            for line_num in range(context_start + 1, context_end + 1)
        ]

        return (
            f"The memory file has been edited. Here is the snippet showing the change (with line numbers):\n"
            + "\n".join(snippet)
        )

    @override
    def insert(self, command: BetaMemoryTool20250818InsertCommand) -> str:
        full_path = self._validate_path(command.path)

        if not full_path.exists():
            raise ToolError(f"The path {command.path} does not exist. Please provide a valid path.")

        if not full_path.is_file():
            raise ToolError(f"The path {command.path} is not a file.")

        content = _read_file_content(full_path, command.path)
        lines = content.splitlines()

        if command.insert_line < 0 or command.insert_line > len(lines):
            raise ToolError(
                f"Invalid `insert_line` parameter: {command.insert_line}. "
                f"It should be within the range [0, {len(lines)}]."
            )

        lines.insert(command.insert_line, command.insert_text.rstrip("\n"))
        new_content = "\n".join(lines)
        if not new_content.endswith("\n"):
            new_content += "\n"
        _atomic_write_file(full_path, content=new_content)
        return f"The file {command.path} has been edited."

    @override
    def delete(self, command: BetaMemoryTool20250818DeleteCommand) -> str:
        full_path = self._validate_path(command.path)

        if command.path == "/memories":
            raise ToolError("Cannot delete the /memories directory itself")

        try:
            if full_path.is_file():
                full_path.unlink()
            elif full_path.is_dir():
                shutil.rmtree(full_path)
            else:
                raise ToolError(f"The path {command.path} does not exist")
        except FileNotFoundError as err:
            raise ToolError(f"The path {command.path} does not exist") from err

        return f"Successfully deleted {command.path}"

    @override
    def rename(self, command: BetaMemoryTool20250818RenameCommand) -> str:
        old_full_path = self._validate_path(command.old_path)
        new_full_path = self._validate_path(command.new_path)

        if new_full_path.exists():
            raise ToolError(f"The destination {command.new_path} already exists")

        new_full_path.parent.mkdir(parents=True, exist_ok=True, mode=_DIR_CREATE_MODE)

        try:
            old_full_path.rename(new_full_path)
        except FileNotFoundError as err:
            raise ToolError(f"The path {command.old_path} does not exist") from err

        return f"Successfully renamed {command.old_path} to {command.new_path}"

    @override
    def clear_all_memory(self) -> str:
        """Override the base implementation to provide file system clearing."""
        if self.memory_root.exists():
            shutil.rmtree(self.memory_root)
        self.memory_root.mkdir(parents=True, exist_ok=True, mode=_DIR_CREATE_MODE)
        return "All memory cleared"


async def _async_atomic_write_file(target_path: AsyncPath, content: str) -> None:
    temp_path = target_path.parent / f".tmp-{os.getpid()}-{uuid.uuid4()}"
    sync_target_path = Path(str(target_path))
    sync_temp_path = Path(str(temp_path))
    data = content.encode("utf-8")

    try:

        def write_replace_and_sync() -> None:
            fd = os.open(sync_temp_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, _FILE_CREATE_MODE)
            try:
                offset = 0
                while offset < len(data):
                    written = os.write(fd, data[offset:])
                    if written == 0:
                        raise OSError("os.write returned 0")
                    offset += written

                os.fsync(fd)
            finally:
                os.close(fd)

            os.replace(sync_temp_path, sync_target_path)

        await run_sync(write_replace_and_sync)

    except Exception:
        await temp_path.unlink(missing_ok=True)
        raise


async def _async_validate_no_symlink_escape(target_path: AsyncPath, memory_root: AsyncPath) -> None:
    sync_target = Path(str(target_path))
    sync_root = Path(str(memory_root))
    await run_sync(_validate_no_symlink_escape, sync_target, sync_root)


async def _async_read_file_content(full_path: AsyncPath, memory_path: str) -> str:
    try:
        return await full_path.read_text(encoding="utf-8")
    except FileNotFoundError as err:
        raise ToolError(
            f"The file {memory_path} no longer exists (may have been deleted or renamed concurrently)."
        ) from err


class BetaAsyncLocalFilesystemMemoryTool(BetaAsyncAbstractMemoryTool):
    """Async file-based memory storage implementation for Claude conversations"""

    def __init__(self, base_path: str = "./memory"):
        super().__init__()
        self.base_path = AsyncPath(base_path)
        self.memory_root = self.base_path / "memories"
        # Note: Directory creation is deferred to async methods since __init__ can't be async

    async def _ensure_memory_root(self) -> None:
        """Ensure the memory root directory exists"""
        await self.memory_root.mkdir(parents=True, exist_ok=True, mode=_DIR_CREATE_MODE)

    async def _validate_path(self, path: str) -> AsyncPath:
        """Validate and resolve memory paths"""
        if not path.startswith("/memories"):
            raise ToolError(f"Path must start with /memories, got: {path}")

        relative_path = path[len("/memories") :].lstrip("/")
        full_path = self.memory_root / relative_path if relative_path else self.memory_root

        sync_memory_root = Path(str(self.memory_root))
        sync_full_path = Path(str(full_path))

        resolved_path = sync_full_path.resolve()
        resolved_root = sync_memory_root.resolve()
        if resolved_path != resolved_root and not str(resolved_path).startswith(str(resolved_root) + os.sep):
            raise ToolError(f"Path {path} would escape /memories directory")

        await _async_validate_no_symlink_escape(full_path, self.memory_root)

        return AsyncPath(resolved_path)

    @override
    async def view(self, command: BetaMemoryTool20250818ViewCommand) -> str:
        await self._ensure_memory_root()
        full_path = await self._validate_path(command.path)

        if not await full_path.exists():
            raise ToolError(f"The path {command.path} does not exist. Please provide a valid path.")

        if await full_path.is_dir():
            items: List[tuple[str, str]] = []

            async def collect_items(dir_path: AsyncPath, relative_path: str, depth: int) -> None:
                if depth > 2:
                    return

                try:
                    dir_items = [item async for item in dir_path.iterdir()]
                    dir_contents = sorted(dir_items, key=lambda x: x.name)
                except Exception:
                    return

                for item in dir_contents:
                    if item.name.startswith("."):
                        continue
                    item_relative_path = f"{relative_path}/{item.name}" if relative_path else item.name
                    try:
                        sync_item = Path(str(item))
                        stat = await run_sync(sync_item.stat)
                    except Exception:
                        continue

                    if await item.is_dir():
                        items.append((_format_file_size(stat.st_size), f"{item_relative_path}/"))
                        if depth < 2:
                            await collect_items(item, item_relative_path, depth + 1)
                    elif await item.is_file():
                        items.append((_format_file_size(stat.st_size), item_relative_path))

            await collect_items(full_path, "", 1)

            header = f"Here're the files and directories up to 2 levels deep in {command.path}, excluding hidden items:"
            sync_full_path = Path(str(full_path))
            dir_stat = await run_sync(sync_full_path.stat)
            dir_size = _format_file_size(dir_stat.st_size)
            lines = [f"{dir_size}\t{command.path}"]
            lines.extend([f"{size}\t{command.path}/{path}" for size, path in items])

            return f"{header}\n" + "\n".join(lines)

        elif await full_path.is_file():
            content = await _async_read_file_content(full_path, command.path)
            lines = content.split("\n")

            if len(lines) > MAX_LINES:
                raise ToolError(f"File {command.path} exceeds maximum line limit of 999,999 lines.")

            display_lines = lines
            start_num = 1

            if command.view_range and len(command.view_range) == 2:
                start_line = max(1, command.view_range[0]) - 1
                end_line = len(lines) if command.view_range[1] == -1 else command.view_range[1]
                display_lines = lines[start_line:end_line]
                start_num = start_line + 1

            numbered_lines = [
                f"{str(i + start_num).rjust(LINE_NUMBER_WIDTH)}\t{line}" for i, line in enumerate(display_lines)
            ]

            return f"Here's the content of {command.path} with line numbers:\n" + "\n".join(numbered_lines)
        else:
            raise ToolError(f"Unsupported file type for {command.path}")

    @override
    async def create(self, command: BetaMemoryTool20250818CreateCommand) -> str:
        await self._ensure_memory_root()
        full_path = await self._validate_path(command.path)

        await full_path.parent.mkdir(parents=True, exist_ok=True, mode=_DIR_CREATE_MODE)

        try:
            sync_full_path = Path(str(full_path))

            def create_exclusive() -> None:
                fd = os.open(sync_full_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, _FILE_CREATE_MODE)
                try:
                    os.write(fd, command.file_text.encode("utf-8"))
                    os.fsync(fd)
                finally:
                    os.close(fd)

            await run_sync(create_exclusive)
        except FileExistsError as err:
            raise ToolError(f"File {command.path} already exists") from err

        return f"File created successfully at: {command.path}"

    @override
    async def str_replace(self, command: BetaMemoryTool20250818StrReplaceCommand) -> str:
        await self._ensure_memory_root()
        full_path = await self._validate_path(command.path)

        if not await full_path.exists():
            raise ToolError(f"The path {command.path} does not exist. Please provide a valid path.")

        if not await full_path.is_file():
            raise ToolError(f"The path {command.path} is not a file.")

        content = await _async_read_file_content(full_path, command.path)

        count = content.count(command.old_str)
        if count == 0:
            raise ToolError(
                f"No replacement was performed, old_str `{command.old_str}` did not appear verbatim in {command.path}."
            )
        elif count > 1:
            matching_lines: List[int] = []
            start = 0
            while True:
                pos = content.find(command.old_str, start)
                if pos == -1:
                    break
                matching_lines.append(content[:pos].count("\n") + 1)
                start = pos + 1
            raise ToolError(
                f"No replacement was performed. Multiple occurrences of old_str `{command.old_str}` in lines: {', '.join(map(str, matching_lines))}. Please ensure it is unique"
            )

        pos = content.find(command.old_str)
        changed_line_index = content[:pos].count("\n")
        new_content = content.replace(command.old_str, command.new_str)
        await _async_atomic_write_file(full_path, new_content)

        new_lines = new_content.split("\n")
        context_start = max(0, changed_line_index - 2)
        context_end = min(len(new_lines), changed_line_index + 3)
        snippet = [
            f"{str(line_num).rjust(LINE_NUMBER_WIDTH)}\t{new_lines[line_num - 1]}"
            for line_num in range(context_start + 1, context_end + 1)
        ]

        return (
            f"The memory file has been edited. Here is the snippet showing the change (with line numbers):\n"
            + "\n".join(snippet)
        )

    @override
    async def insert(self, command: BetaMemoryTool20250818InsertCommand) -> str:
        await self._ensure_memory_root()
        full_path = await self._validate_path(command.path)

        if not await full_path.exists():
            raise ToolError(f"The path {command.path} does not exist. Please provide a valid path.")

        if not await full_path.is_file():
            raise ToolError(f"The path {command.path} is not a file.")

        content = await _async_read_file_content(full_path, command.path)
        lines = content.splitlines()

        if command.insert_line < 0 or command.insert_line > len(lines):
            raise ToolError(
                f"Invalid `insert_line` parameter: {command.insert_line}. "
                f"It should be within the range [0, {len(lines)}]."
            )

        lines.insert(command.insert_line, command.insert_text.rstrip("\n"))
        new_content = "\n".join(lines)
        if not new_content.endswith("\n"):
            new_content += "\n"
        await _async_atomic_write_file(full_path, content=new_content)
        return f"The file {command.path} has been edited."

    @override
    async def delete(self, command: BetaMemoryTool20250818DeleteCommand) -> str:
        await self._ensure_memory_root()
        full_path = await self._validate_path(command.path)

        if command.path == "/memories":
            raise ToolError("Cannot delete the /memories directory itself")

        try:
            if await full_path.is_file():
                await full_path.unlink()
            elif await full_path.is_dir():
                await run_sync(shutil.rmtree, str(full_path))
            else:
                raise ToolError(f"The path {command.path} does not exist")
        except FileNotFoundError as err:
            raise ToolError(f"The path {command.path} does not exist") from err

        return f"Successfully deleted {command.path}"

    @override
    async def rename(self, command: BetaMemoryTool20250818RenameCommand) -> str:
        await self._ensure_memory_root()
        old_full_path = await self._validate_path(command.old_path)
        new_full_path = await self._validate_path(command.new_path)

        if await new_full_path.exists():
            raise ToolError(f"The destination {command.new_path} already exists")

        await new_full_path.parent.mkdir(parents=True, exist_ok=True, mode=_DIR_CREATE_MODE)

        try:
            await old_full_path.rename(new_full_path)
        except FileNotFoundError as err:
            raise ToolError(f"The path {command.old_path} does not exist") from err

        return f"Successfully renamed {command.old_path} to {command.new_path}"

    @override
    async def clear_all_memory(self) -> str:
        """Override the base implementation to provide file system clearing."""
        if await self.memory_root.exists():
            await run_sync(shutil.rmtree, str(self.memory_root))
        await self.memory_root.mkdir(parents=True, exist_ok=True, mode=_DIR_CREATE_MODE)
        return "All memory cleared"
