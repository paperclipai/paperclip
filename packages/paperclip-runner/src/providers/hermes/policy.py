"""Managed tool policy, evaluated at the native execution middleware boundary."""
from pathlib import Path

READ_TOOLS = frozenset({"read_file", "search_files", "web_search", "web_extract", "skills_list", "skill_view", "session_search", "session_read", "clarify", "todo_list"})
DISABLED_TOOLS = frozenset({"cronjob", "send_message", "gateway", "schedule", "kanban_create", "kanban_update"})
REPORTING_TOOLS = frozenset({"mcp__paperclip__paperclip_finish", "mcp__paperclip__paperclip_block"})
PATH_KEYS = frozenset({"path", "file_path", "file", "directory", "cwd", "workdir", "target_path", "source_path", "destination_path"})


def inside(path, root):
    return path == root or root in path.parents


def authorize_tool(name, args, *, policy, cwd, assigned_skills=()):
    if name in DISABLED_TOOLS:
        raise PermissionError("Use Paperclip routines and assigned integrations for proactive work")
    if policy["permissionMode"] == "deny-all":
        raise PermissionError("Paperclip permission mode denies native tools")
    read = (name in READ_TOOLS or name in REPORTING_TOOLS
            or name in policy.get("paperclipReadTools", [])
            or (name == "memory" and args.get("action") in {"read", "view"}))
    if policy["readOnly"] and not read and name not in policy.get("paperclipReadOnlyTools", []):
        # Arbitrary commands, code execution and delegation can write, even when
        # their natural-language description claims they only inspect state.
        raise PermissionError("Paperclip planning mode permits only native reads and authorized Paperclip workflow tools")
    protected = [Path(p).resolve() for p in policy.get("protectedPaths", [])]
    assigned = [Path(p).resolve() for p in assigned_skills]

    def check(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if key in PATH_KEYS and isinstance(item, str):
                    path = Path(item).expanduser()
                    path = (Path(cwd) / path).resolve() if not path.is_absolute() else path.resolve()
                    if any(inside(path, root) or (not read and inside(root, path)) for root in protected) or (not read and any(inside(path, root) or inside(root, path) for root in assigned)):
                        raise PermissionError("Paperclip protects this runtime or assigned-skill path")
                    if policy["readOnly"]:
                        roots = [Path(cwd).resolve(), *[Path(p).resolve() for p in policy.get("readRoots", [])], *assigned]
                        if not any(inside(path, root) for root in roots):
                            raise PermissionError("This path is outside Paperclip's planning read roots")
                else:
                    check(item)
        elif isinstance(value, list):
            for item in value:
                check(item)
    check(args)
    return read
