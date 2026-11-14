"""Execute a command whose process tree cannot read the eval harness.

Runner E2E starts the product from a repository checkout that also holds the
scenarios, fixtures and graders. This helper applies a Linux Landlock domain
that grants filesystem access everywhere except the given hidden paths, then
replaces itself with the command (same PID, argv and environment). Every
descendant inherits the domain, including an agent's shell commands.

Usage:
  agent-filesystem-sandbox.py [--required] [--unset NAME]... [--set NAME=VALUE]...
      --hide PATH [--hide PATH]... [--expose PATH]... -- COMMAND [ARG]...

An exposed path lies beneath a hidden directory and stays usable: a run sees its
own saved session while the directory holding every run's sessions stays hidden.

Without Landlock, --required exits 125 instead of running the command.
"""

import ctypes
import os
import stat
import struct
import sys

SYS_LANDLOCK_CREATE_RULESET = 444
SYS_LANDLOCK_ADD_RULE = 445
SYS_LANDLOCK_RESTRICT_SELF = 446
LANDLOCK_CREATE_RULESET_VERSION = 1
LANDLOCK_RULE_PATH_BENEATH = 1
PR_SET_NO_NEW_PRIVS = 38

FILE_RIGHTS = (1 << 0) | (1 << 1) | (1 << 2)  # execute, write, read
ABI_1_RIGHTS = (1 << 13) - 1
REFER = 1 << 13
TRUNCATE = 1 << 14
IOCTL_DEV = 1 << 15


class RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


def fail(message, code=125):
    sys.stderr.write("agent_filesystem_sandbox: %s\n" % message)
    sys.stderr.flush()
    os._exit(code)


def parse(argv):
    required = False
    hidden = []
    exposed = []
    unset = []
    assignments = []
    index = 0
    while index < len(argv):
        token = argv[index]
        if token == "--":
            command = argv[index + 1:]
            if not command:
                fail("missing command", 2)
            return required, hidden, exposed, unset, assignments, command
        if token == "--required":
            required = True
        elif token in ("--hide", "--expose", "--unset", "--set") and index + 1 < len(argv):
            index += 1
            value = argv[index]
            if token in ("--hide", "--expose"):
                if not os.path.isabs(value):
                    fail("%s path must be absolute: %s" % (token[2:], value), 2)
                (hidden if token == "--hide" else exposed).append(value)
            elif token == "--unset":
                unset.append(value)
            else:
                name, separator, assigned = value.partition("=")
                if not separator or not name:
                    fail("--set requires NAME=VALUE", 2)
                assignments.append((name, assigned))
        else:
            fail("unexpected argument: %s" % token, 2)
        index += 1
    fail("missing -- before the command", 2)


def within(candidate, root):
    return candidate == root or candidate.startswith(root.rstrip("/") + "/")


def landlock():
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long

    def syscall(*args):
        result = libc.syscall(*args)
        if result < 0:
            raise OSError(ctypes.get_errno(), os.strerror(ctypes.get_errno()))
        return result

    return libc, syscall


def restrict(hidden, exposed=()):
    libc, syscall = landlock()
    try:
        abi = syscall(
            ctypes.c_long(SYS_LANDLOCK_CREATE_RULESET),
            ctypes.c_void_p(None),
            ctypes.c_long(0),
            ctypes.c_long(LANDLOCK_CREATE_RULESET_VERSION),
        )
    except OSError as error:
        raise RuntimeError("Landlock is unavailable on this kernel (%s)" % error)
    handled = ABI_1_RIGHTS
    if abi >= 2:
        handled |= REFER
    if abi >= 3:
        handled |= TRUNCATE
    if abi >= 5:
        handled |= IOCTL_DEV
    attr = RulesetAttr(handled)
    ruleset = syscall(
        ctypes.c_long(SYS_LANDLOCK_CREATE_RULESET),
        ctypes.byref(attr),
        ctypes.c_long(ctypes.sizeof(attr)),
        ctypes.c_long(0),
    )

    def allow(path):
        try:
            descriptor = os.open(path, os.O_PATH | os.O_CLOEXEC)
        except OSError:
            return
        try:
            mode = os.fstat(descriptor).st_mode
            access = handled if stat.S_ISDIR(mode) else handled & (FILE_RIGHTS | TRUNCATE | IOCTL_DEV)
            # struct landlock_path_beneath_attr is packed: u64 allowed_access, s32 parent_fd.
            rule = ctypes.create_string_buffer(struct.pack("=Qi", access, descriptor), 12)
            syscall(
                ctypes.c_long(SYS_LANDLOCK_ADD_RULE),
                ctypes.c_long(ruleset),
                ctypes.c_long(LANDLOCK_RULE_PATH_BENEATH),
                rule,
                ctypes.c_long(0),
            )
        finally:
            os.close(descriptor)

    # Landlock only grants. Grant every entry except the hidden paths, walking
    # down only through their ancestors; ancestors themselves get no rule.
    def grant(directory):
        try:
            names = sorted(os.listdir(directory))
        except OSError:
            return
        for name in names:
            child = os.path.join(directory, name)
            if any(within(child, path) for path in hidden):
                continue
            try:
                is_link = os.path.islink(child)
                real = os.path.realpath(child)
            except OSError:
                continue
            if any(within(real, path) or within(path, real) for path in hidden):
                if not is_link and any(within(path, child) for path in hidden):
                    grant(child)
                # A link into, or onto an ancestor of, a hidden path stays ungranted.
                continue
            allow(child)

    grant("/")
    # Landlock does not check path traversal, so a rule on an exposed path
    # grants it even though the hidden directory above it has no rule.
    for path in exposed:
        allow(path)
    if libc.prctl(ctypes.c_int(PR_SET_NO_NEW_PRIVS), ctypes.c_ulong(1), ctypes.c_ulong(0), ctypes.c_ulong(0), ctypes.c_ulong(0)) != 0:
        raise RuntimeError("prctl(PR_SET_NO_NEW_PRIVS) failed")
    syscall(ctypes.c_long(SYS_LANDLOCK_RESTRICT_SELF), ctypes.c_long(ruleset), ctypes.c_long(0))
    os.close(ruleset)
    # Fail closed unless this process (which becomes the command) is denied.
    for path in hidden:
        try:
            if os.path.isdir(path):
                os.listdir(path)
            else:
                os.close(os.open(path, os.O_RDONLY | os.O_CLOEXEC))
        except PermissionError:
            continue
        except OSError:
            continue
        raise RuntimeError("sandbox ineffective: %s is still readable" % path)
    for path in exposed:
        try:
            if os.path.isdir(path):
                os.listdir(path)
            else:
                os.close(os.open(path, os.O_RDONLY | os.O_CLOEXEC))
        except OSError as error:
            raise RuntimeError("sandbox unusable: %s is not readable (%s)" % (path, error))
    return abi


def main():
    required, hidden_inputs, exposed_inputs, unset, assignments, command = parse(sys.argv[1:])
    hidden = []
    for path in hidden_inputs:
        # Keep paths that do not exist yet: their ancestors stay ungranted, so
        # a later mkdir there is unreachable too.
        real = os.path.realpath(path)
        if real == "/":
            fail("refusing to hide the filesystem root", 2)
        hidden.append(real)
    exposed = []
    for path in exposed_inputs:
        real = os.path.realpath(path)
        if not os.path.exists(real):
            fail("exposed path must exist before the sandbox starts: %s" % real, 2)
        if not any(within(real, root) and real != root for root in hidden):
            fail("exposed path must lie beneath a hidden directory: %s" % real, 2)
        if any(within(root, real) for root in hidden):
            fail("exposed path would reveal a hidden path: %s" % real, 2)
        exposed.append(real)
    for name in unset:
        os.environ.pop(name, None)
    for name, value in assignments:
        os.environ[name] = value
    if hidden:
        if not sys.platform.startswith("linux"):
            if required:
                fail("Landlock requires Linux")
        else:
            try:
                restrict(hidden, exposed)
            except (OSError, RuntimeError) as error:
                if required:
                    fail(str(error))
                sys.stderr.write("agent_filesystem_sandbox: continuing without isolation: %s\n" % error)
    try:
        if os.path.isabs(command[0]):
            os.execv(command[0], command)
        os.execvp(command[0], command)
    except OSError as error:
        fail("cannot execute %s: %s" % (command[0], error), 127)


if __name__ == "__main__":
    main()
