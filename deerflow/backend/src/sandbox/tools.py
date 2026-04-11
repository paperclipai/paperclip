import re

from langchain.tools import ToolRuntime, tool
from langgraph.typing import ContextT

from src.agents.thread_state import ThreadDataState, ThreadState
from src.config.paths import VIRTUAL_PATH_PREFIX
from src.sandbox.exceptions import (
    SandboxError,
    SandboxNotFoundError,
    SandboxRuntimeError,
)
from src.sandbox.search import GrepMatch
from src.sandbox.sandbox import Sandbox
from src.sandbox.sandbox_provider import get_sandbox_provider


def replace_virtual_path(path: str, thread_data: ThreadDataState | None) -> str:
    """Replace virtual /mnt/user-data paths with actual thread data paths.

    Mapping:
        /mnt/user-data/workspace/* -> thread_data['workspace_path']/*
        /mnt/user-data/uploads/* -> thread_data['uploads_path']/*
        /mnt/user-data/outputs/* -> thread_data['outputs_path']/*

    Args:
        path: The path that may contain virtual path prefix.
        thread_data: The thread data containing actual paths.

    Returns:
        The path with virtual prefix replaced by actual path.
    """
    if not path.startswith(VIRTUAL_PATH_PREFIX):
        return path

    if thread_data is None:
        return path

    # Map virtual subdirectories to thread_data keys
    path_mapping = {
        "workspace": thread_data.get("workspace_path"),
        "uploads": thread_data.get("uploads_path"),
        "outputs": thread_data.get("outputs_path"),
    }

    # Extract the subdirectory after /mnt/user-data/
    relative_path = path[len(VIRTUAL_PATH_PREFIX) :].lstrip("/")
    if not relative_path:
        return path

    # Find which subdirectory this path belongs to
    parts = relative_path.split("/", 1)
    subdir = parts[0]
    rest = parts[1] if len(parts) > 1 else ""

    actual_base = path_mapping.get(subdir)
    if actual_base is None:
        return path

    if rest:
        return f"{actual_base}/{rest}"
    return actual_base


def replace_virtual_paths_in_command(command: str, thread_data: ThreadDataState | None) -> str:
    """Replace all virtual /mnt/user-data paths in a command string.

    Args:
        command: The command string that may contain virtual paths.
        thread_data: The thread data containing actual paths.

    Returns:
        The command with all virtual paths replaced.
    """
    if VIRTUAL_PATH_PREFIX not in command:
        return command

    if thread_data is None:
        return command

    # Pattern to match /mnt/user-data followed by path characters
    pattern = re.compile(rf"{re.escape(VIRTUAL_PATH_PREFIX)}(/[^\s\"';&|<>()]*)?")

    def replace_match(match: re.Match) -> str:
        full_path = match.group(0)
        return replace_virtual_path(full_path, thread_data)

    return pattern.sub(replace_match, command)


def get_thread_data(runtime: ToolRuntime[ContextT, ThreadState] | None) -> ThreadDataState | None:
    """Extract thread_data from runtime state."""
    if runtime is None:
        return None
    if runtime.state is None:
        return None
    return runtime.state.get("thread_data")


def is_local_sandbox(runtime: ToolRuntime[ContextT, ThreadState] | None) -> bool:
    """Check if the current sandbox is a local sandbox.

    Path replacement is only needed for local sandbox since aio sandbox
    already has /mnt/user-data mounted in the container.
    """
    if runtime is None:
        return False
    if runtime.state is None:
        return False
    sandbox_state = runtime.state.get("sandbox")
    if sandbox_state is None:
        return False
    return sandbox_state.get("sandbox_id") == "local"


def sandbox_from_runtime(runtime: ToolRuntime[ContextT, ThreadState] | None = None) -> Sandbox:
    """Extract sandbox instance from tool runtime.

    DEPRECATED: Use ensure_sandbox_initialized() for lazy initialization support.
    This function assumes sandbox is already initialized and will raise error if not.

    Raises:
        SandboxRuntimeError: If runtime is not available or sandbox state is missing.
        SandboxNotFoundError: If sandbox with the given ID cannot be found.
    """
    if runtime is None:
        raise SandboxRuntimeError("Tool runtime not available")
    if runtime.state is None:
        raise SandboxRuntimeError("Tool runtime state not available")
    sandbox_state = runtime.state.get("sandbox")
    if sandbox_state is None:
        raise SandboxRuntimeError("Sandbox state not initialized in runtime")
    sandbox_id = sandbox_state.get("sandbox_id")
    if sandbox_id is None:
        raise SandboxRuntimeError("Sandbox ID not found in state")
    sandbox = get_sandbox_provider().get(sandbox_id)
    if sandbox is None:
        raise SandboxNotFoundError(f"Sandbox with ID '{sandbox_id}' not found", sandbox_id=sandbox_id)

    runtime.context["sandbox_id"] = sandbox_id  # Ensure sandbox_id is in context for downstream use
    return sandbox


def ensure_sandbox_initialized(runtime: ToolRuntime[ContextT, ThreadState] | None = None) -> Sandbox:
    """Ensure sandbox is initialized, acquiring lazily if needed.

    On first call, acquires a sandbox from the provider and stores it in runtime state.
    Subsequent calls return the existing sandbox.

    Thread-safety is guaranteed by the provider's internal locking mechanism.

    Args:
        runtime: Tool runtime containing state and context.

    Returns:
        Initialized sandbox instance.

    Raises:
        SandboxRuntimeError: If runtime is not available or thread_id is missing.
        SandboxNotFoundError: If sandbox acquisition fails.
    """
    if runtime is None:
        raise SandboxRuntimeError("Tool runtime not available")

    if runtime.state is None:
        raise SandboxRuntimeError("Tool runtime state not available")

    # Check if sandbox already exists in state
    sandbox_state = runtime.state.get("sandbox")
    if sandbox_state is not None:
        sandbox_id = sandbox_state.get("sandbox_id")
        if sandbox_id is not None:
            sandbox = get_sandbox_provider().get(sandbox_id)
            if sandbox is not None:
                runtime.context["sandbox_id"] = sandbox_id  # Ensure sandbox_id is in context for releasing in after_agent
                return sandbox
            # Sandbox was released, fall through to acquire new one

    # Lazy acquisition: get thread_id and acquire sandbox
    thread_id = runtime.context.get("thread_id")
    if thread_id is None:
        raise SandboxRuntimeError("Thread ID not available in runtime context")

    provider = get_sandbox_provider()
    sandbox_id = provider.acquire(thread_id)

    # Update runtime state - this persists across tool calls
    runtime.state["sandbox"] = {"sandbox_id": sandbox_id}

    # Retrieve and return the sandbox
    sandbox = provider.get(sandbox_id)
    if sandbox is None:
        raise SandboxNotFoundError("Sandbox not found after acquisition", sandbox_id=sandbox_id)

    runtime.context["sandbox_id"] = sandbox_id  # Ensure sandbox_id is in context for releasing in after_agent
    return sandbox


def ensure_thread_directories_exist(runtime: ToolRuntime[ContextT, ThreadState] | None) -> None:
    """Ensure thread data directories (workspace, uploads, outputs) exist.

    This function is called lazily when any sandbox tool is first used.
    For local sandbox, it creates the directories on the filesystem.
    For other sandboxes (like aio), directories are already mounted in the container.

    Args:
        runtime: Tool runtime containing state and context.
    """
    if runtime is None:
        return

    # Only create directories for local sandbox
    if not is_local_sandbox(runtime):
        return

    thread_data = get_thread_data(runtime)
    if thread_data is None:
        return

    # Check if directories have already been created
    if runtime.state.get("thread_directories_created"):
        return

    # Create the three directories
    import os

    for key in ["workspace_path", "uploads_path", "outputs_path"]:
        path = thread_data.get(key)
        if path:
            os.makedirs(path, exist_ok=True)

    # Mark as created to avoid redundant operations
    runtime.state["thread_directories_created"] = True


def _truncate_bash_output(output: str, max_chars: int) -> str:
    """Middle-truncate bash output, preserving head and tail (50/50 split).

    bash output may have errors at either end (stderr/stdout ordering is
    non-deterministic), so both ends are preserved equally.

    The returned string (including the truncation marker) is guaranteed to be
    no longer than max_chars characters. Pass max_chars=0 to disable truncation
    and return the full output unchanged.
    """
    if max_chars == 0:
        return output
    if len(output) <= max_chars:
        return output
    total_len = len(output)
    # Compute the exact worst-case marker length: skipped chars is at most
    # total_len, so this is a tight upper bound.
    marker_max_len = len(f"\n... [middle truncated: {total_len} chars skipped] ...\n")
    kept = max(0, max_chars - marker_max_len)
    if kept == 0:
        return output[:max_chars]
    head_len = kept // 2
    tail_len = kept - head_len
    skipped = total_len - kept
    marker = f"\n... [middle truncated: {skipped} chars skipped] ...\n"
    return f"{output[:head_len]}{marker}{output[-tail_len:] if tail_len > 0 else ''}"


def _truncate_read_file_output(output: str, max_chars: int) -> str:
    """Head-truncate read_file output, preserving the beginning of the file.

    Source code and documents are read top-to-bottom; the head contains the
    most context (imports, class definitions, function signatures).

    The returned string (including the truncation marker) is guaranteed to be
    no longer than max_chars characters. Pass max_chars=0 to disable truncation
    and return the full output unchanged.
    """
    if max_chars == 0:
        return output
    if len(output) <= max_chars:
        return output
    total = len(output)
    # Compute the exact worst-case marker length: both numeric fields are at
    # their maximum (total chars), so this is a tight upper bound.
    marker_max_len = len(f"\n... [truncated: showing first {total} of {total} chars. Use start_line/end_line to read a specific range] ...")
    kept = max(0, max_chars - marker_max_len)
    if kept == 0:
        return output[:max_chars]
    marker = f"\n... [truncated: showing first {kept} of {total} chars. Use start_line/end_line to read a specific range] ..."
    return f"{output[:kept]}{marker}"


def _truncate_ls_output(output: str, max_chars: int) -> str:
    """Head-truncate ls output, preserving the beginning of the listing.

    Directory listings are read top-to-bottom; the head shows the most
    relevant structure.

    The returned string (including the truncation marker) is guaranteed to be
    no longer than max_chars characters. Pass max_chars=0 to disable truncation
    and return the full output unchanged.
    """
    if max_chars == 0:
        return output
    if len(output) <= max_chars:
        return output
    total = len(output)
    marker_max_len = len(f"\n... [truncated: showing first {total} of {total} chars. Use a more specific path to see fewer results] ...")
    kept = max(0, max_chars - marker_max_len)
    if kept == 0:
        return output[:max_chars]
    marker = f"\n... [truncated: showing first {kept} of {total} chars. Use a more specific path to see fewer results] ..."
    return f"{output[:kept]}{marker}"


def _get_sandbox_max_chars(field: str, default: int) -> int:
    """Resolve a max_chars value from sandbox config, falling back to a default."""
    try:
        from src.config.app_config import get_app_config

        sandbox_cfg = get_app_config().sandbox
        return getattr(sandbox_cfg, field, default) if sandbox_cfg else default
    except Exception:
        return default


@tool("bash", parse_docstring=True)
def bash_tool(runtime: ToolRuntime[ContextT, ThreadState], description: str, command: str) -> str:
    """Execute a bash command in a Linux environment.


    - Use `python` to run Python code.
    - Use `pip install` to install Python packages.

    Args:
        description: Explain why you are running this command in short words. ALWAYS PROVIDE THIS PARAMETER FIRST.
        command: The bash command to execute. Always use absolute paths for files and directories.
    """
    try:
        sandbox = ensure_sandbox_initialized(runtime)
        ensure_thread_directories_exist(runtime)
        if is_local_sandbox(runtime):
            thread_data = get_thread_data(runtime)
            command = replace_virtual_paths_in_command(command, thread_data)
        output = sandbox.execute_command(command)
        max_chars = _get_sandbox_max_chars("bash_output_max_chars", 20000)
        return _truncate_bash_output(output, max_chars)
    except SandboxError as e:
        return f"Error: {e}"
    except Exception as e:
        return f"Error: Unexpected error executing command: {type(e).__name__}: {e}"


@tool("ls", parse_docstring=True)
def ls_tool(runtime: ToolRuntime[ContextT, ThreadState], description: str, path: str) -> str:
    """List the contents of a directory up to 2 levels deep in tree format.

    Args:
        description: Explain why you are listing this directory in short words. ALWAYS PROVIDE THIS PARAMETER FIRST.
        path: The **absolute** path to the directory to list.
    """
    try:
        sandbox = ensure_sandbox_initialized(runtime)
        ensure_thread_directories_exist(runtime)
        if is_local_sandbox(runtime):
            thread_data = get_thread_data(runtime)
            path = replace_virtual_path(path, thread_data)
        children = sandbox.list_dir(path)
        if not children:
            return "(empty)"
        output = "\n".join(children)
        max_chars = _get_sandbox_max_chars("ls_output_max_chars", 20000)
        return _truncate_ls_output(output, max_chars)
    except SandboxError as e:
        return f"Error: {e}"
    except FileNotFoundError:
        return f"Error: Directory not found: {path}"
    except PermissionError:
        return f"Error: Permission denied: {path}"
    except Exception as e:
        return f"Error: Unexpected error listing directory: {type(e).__name__}: {e}"


@tool("read_file", parse_docstring=True)
def read_file_tool(
    runtime: ToolRuntime[ContextT, ThreadState],
    description: str,
    path: str,
    start_line: int | None = None,
    end_line: int | None = None,
) -> str:
    """Read the contents of a text file. Use this to examine source code, configuration files, logs, or any text-based file.

    Args:
        description: Explain why you are reading this file in short words. ALWAYS PROVIDE THIS PARAMETER FIRST.
        path: The **absolute** path to the file to read.
        start_line: Optional starting line number (1-indexed, inclusive). Use with end_line to read a specific range.
        end_line: Optional ending line number (1-indexed, inclusive). Use with start_line to read a specific range.
    """
    try:
        sandbox = ensure_sandbox_initialized(runtime)
        ensure_thread_directories_exist(runtime)
        if is_local_sandbox(runtime):
            thread_data = get_thread_data(runtime)
            path = replace_virtual_path(path, thread_data)
        content = sandbox.read_file(path)
        if not content:
            return "(empty)"
        if start_line is not None and end_line is not None:
            content = "\n".join(content.splitlines()[start_line - 1 : end_line])
        max_chars = _get_sandbox_max_chars("read_file_output_max_chars", 50000)
        return _truncate_read_file_output(content, max_chars)
    except SandboxError as e:
        return f"Error: {e}"
    except FileNotFoundError:
        return f"Error: File not found: {path}"
    except PermissionError:
        return f"Error: Permission denied reading file: {path}"
    except IsADirectoryError:
        return f"Error: Path is a directory, not a file: {path}"
    except Exception as e:
        return f"Error: Unexpected error reading file: {type(e).__name__}: {e}"


@tool("write_file", parse_docstring=True)
def write_file_tool(
    runtime: ToolRuntime[ContextT, ThreadState],
    description: str,
    path: str,
    content: str,
    append: bool = False,
) -> str:
    """Write text content to a file.

    Args:
        description: Explain why you are writing to this file in short words. ALWAYS PROVIDE THIS PARAMETER FIRST.
        path: The **absolute** path to the file to write to. ALWAYS PROVIDE THIS PARAMETER SECOND.
        content: The content to write to the file. ALWAYS PROVIDE THIS PARAMETER THIRD.
    """
    try:
        sandbox = ensure_sandbox_initialized(runtime)
        ensure_thread_directories_exist(runtime)
        if is_local_sandbox(runtime):
            thread_data = get_thread_data(runtime)
            path = replace_virtual_path(path, thread_data)
        sandbox.write_file(path, content, append)
        return "OK"
    except SandboxError as e:
        return f"Error: {e}"
    except PermissionError:
        return f"Error: Permission denied writing to file: {path}"
    except IsADirectoryError:
        return f"Error: Path is a directory, not a file: {path}"
    except OSError as e:
        return f"Error: Failed to write file '{path}': {e}"
    except Exception as e:
        return f"Error: Unexpected error writing file: {type(e).__name__}: {e}"


@tool("str_replace", parse_docstring=True)
def str_replace_tool(
    runtime: ToolRuntime[ContextT, ThreadState],
    description: str,
    path: str,
    old_str: str,
    new_str: str,
    replace_all: bool = False,
) -> str:
    """Replace a substring in a file with another substring.
    If `replace_all` is False (default), the substring to replace must appear **exactly once** in the file.

    Args:
        description: Explain why you are replacing the substring in short words. ALWAYS PROVIDE THIS PARAMETER FIRST.
        path: The **absolute** path to the file to replace the substring in. ALWAYS PROVIDE THIS PARAMETER SECOND.
        old_str: The substring to replace. ALWAYS PROVIDE THIS PARAMETER THIRD.
        new_str: The new substring. ALWAYS PROVIDE THIS PARAMETER FOURTH.
        replace_all: Whether to replace all occurrences of the substring. If False, only the first occurrence will be replaced. Default is False.
    """
    try:
        sandbox = ensure_sandbox_initialized(runtime)
        ensure_thread_directories_exist(runtime)
        if is_local_sandbox(runtime):
            thread_data = get_thread_data(runtime)
            path = replace_virtual_path(path, thread_data)
        content = sandbox.read_file(path)
        if not content:
            return "OK"
        if old_str not in content:
            return f"Error: String to replace not found in file: {path}"
        if replace_all:
            content = content.replace(old_str, new_str)
        else:
            content = content.replace(old_str, new_str, 1)
        sandbox.write_file(path, content)
        return "OK"
    except SandboxError as e:
        return f"Error: {e}"
    except FileNotFoundError:
        return f"Error: File not found: {path}"
    except PermissionError:
        return f"Error: Permission denied accessing file: {path}"
    except Exception as e:
        return f"Error: Unexpected error replacing string: {type(e).__name__}: {e}"


# ---------------------------------------------------------------------------
# glob / grep tools and helpers
# ---------------------------------------------------------------------------

_DEFAULT_GLOB_MAX_RESULTS = 200
_MAX_GLOB_MAX_RESULTS = 1000
_DEFAULT_GREP_MAX_RESULTS = 100
_MAX_GREP_MAX_RESULTS = 500


def _clamp_max_results(value: int, *, default: int, upper_bound: int) -> int:
    if value <= 0:
        return default
    return min(value, upper_bound)


def _format_glob_results(root_path: str, matches: list[str], truncated: bool) -> str:
    if not matches:
        return f"No files matched under {root_path}"

    lines = [f"Found {len(matches)} paths under {root_path}"]
    if truncated:
        lines[0] += f" (showing first {len(matches)})"
    lines.extend(f"{index}. {path}" for index, path in enumerate(matches, start=1))
    if truncated:
        lines.append("Results truncated. Narrow the path or pattern to see fewer matches.")
    return "\n".join(lines)


def _format_grep_results(root_path: str, matches: list[GrepMatch], truncated: bool) -> str:
    if not matches:
        return f"No matches found under {root_path}"

    lines = [f"Found {len(matches)} matches under {root_path}"]
    if truncated:
        lines[0] += f" (showing first {len(matches)})"
    lines.extend(f"{match.path}:{match.line_number}: {match.line}" for match in matches)
    if truncated:
        lines.append("Results truncated. Narrow the path or add a glob filter.")
    return "\n".join(lines)


@tool("glob", parse_docstring=True)
def glob_tool(
    runtime: ToolRuntime[ContextT, ThreadState],
    description: str,
    pattern: str,
    path: str,
    include_dirs: bool = False,
    max_results: int = _DEFAULT_GLOB_MAX_RESULTS,
) -> str:
    """Find files or directories that match a glob pattern under a root directory.

    Args:
        description: Explain why you are searching for these paths in short words. ALWAYS PROVIDE THIS PARAMETER FIRST.
        pattern: The glob pattern to match relative to the root path, for example `**/*.py`.
        path: The **absolute** root directory to search under.
        include_dirs: Whether matching directories should also be returned. Default is False.
        max_results: Maximum number of paths to return. Default is 200.
    """
    try:
        sandbox = ensure_sandbox_initialized(runtime)
        ensure_thread_directories_exist(runtime)
        requested_path = path
        effective_max_results = _clamp_max_results(
            max_results,
            default=_DEFAULT_GLOB_MAX_RESULTS,
            upper_bound=_MAX_GLOB_MAX_RESULTS,
        )
        if is_local_sandbox(runtime):
            thread_data = get_thread_data(runtime)
            path = replace_virtual_path(path, thread_data)
        matches, truncated = sandbox.glob(path, pattern, include_dirs=include_dirs, max_results=effective_max_results)
        return _format_glob_results(requested_path, matches, truncated)
    except SandboxError as e:
        return f"Error: {e}"
    except FileNotFoundError:
        return f"Error: Directory not found: {requested_path}"
    except NotADirectoryError:
        return f"Error: Path is not a directory: {requested_path}"
    except PermissionError:
        return f"Error: Permission denied: {requested_path}"
    except Exception as e:
        return f"Error: Unexpected error searching paths: {type(e).__name__}: {e}"


@tool("grep", parse_docstring=True)
def grep_tool(
    runtime: ToolRuntime[ContextT, ThreadState],
    description: str,
    pattern: str,
    path: str,
    glob: str | None = None,
    literal: bool = False,
    case_sensitive: bool = False,
    max_results: int = _DEFAULT_GREP_MAX_RESULTS,
) -> str:
    """Search for matching lines inside text files under a root directory.

    Args:
        description: Explain why you are searching file contents in short words. ALWAYS PROVIDE THIS PARAMETER FIRST.
        pattern: The string or regex pattern to search for.
        path: The **absolute** root directory to search under.
        glob: Optional glob filter for candidate files, for example `**/*.py`.
        literal: Whether to treat `pattern` as a plain string. Default is False.
        case_sensitive: Whether matching is case-sensitive. Default is False.
        max_results: Maximum number of matching lines to return. Default is 100.
    """
    try:
        sandbox = ensure_sandbox_initialized(runtime)
        ensure_thread_directories_exist(runtime)
        requested_path = path
        effective_max_results = _clamp_max_results(
            max_results,
            default=_DEFAULT_GREP_MAX_RESULTS,
            upper_bound=_MAX_GREP_MAX_RESULTS,
        )
        if is_local_sandbox(runtime):
            thread_data = get_thread_data(runtime)
            path = replace_virtual_path(path, thread_data)
        matches, truncated = sandbox.grep(
            path,
            pattern,
            glob=glob,
            literal=literal,
            case_sensitive=case_sensitive,
            max_results=effective_max_results,
        )
        return _format_grep_results(requested_path, matches, truncated)
    except SandboxError as e:
        return f"Error: {e}"
    except FileNotFoundError:
        return f"Error: Directory not found: {requested_path}"
    except NotADirectoryError:
        return f"Error: Path is not a directory: {requested_path}"
    except re.error as e:
        return f"Error: Invalid regex pattern: {e}"
    except PermissionError:
        return f"Error: Permission denied: {requested_path}"
    except Exception as e:
        return f"Error: Unexpected error searching file contents: {type(e).__name__}: {e}"
