###############################################################################
# Server process to keep track of unlinked resources, like folders and
# semaphores and clean them.
#
# author: Thomas Moreau
#
# Adapted from multiprocessing/resource_tracker.py
#  * add some VERBOSE logging,
#  * add support to track folders,
#  * add Windows support,
#  * refcounting scheme to avoid unlinking resources still in use.
#
# On Unix we run a server process which keeps track of unlinked
# resources. The server ignores SIGINT and SIGTERM and reads from a
# pipe. The resource_tracker implements a reference counting scheme: each time
# a Python process anticipates the shared usage of a resource by another
# process, it signals the resource_tracker of this shared usage, and in return,
# the resource_tracker increments the resource's reference count by 1.
# Similarly, when access to a resource is closed by a Python process, the
# process notifies the resource_tracker by asking it to decrement the
# resource's reference count by 1.  When the reference count drops to 0, the
# resource_tracker attempts to clean up the underlying resource.

# Finally, every other process connected to the resource tracker has a copy of
# the writable end of the pipe used to communicate with it, so the resource
# tracker gets EOF when all other processes have exited. Then the
# resource_tracker process unlinks any remaining leaked resources (with
# reference count above 0)

# For semaphores, this is important because the system only supports a limited
# number of named semaphores, and they will not be automatically removed till
# the next reboot.  Without this resource tracker process, "killall python"
# would probably leave unlinked semaphores.

# Note that this behavior differs from CPython's resource_tracker, which only
# implements list of shared resources, and not a proper refcounting scheme.
# Also, CPython's resource tracker will only attempt to cleanup those shared
# resources once all processes connected to the resource tracker have exited.


import os
import shutil
import sys
import signal
import warnings
from multiprocessing import util
from multiprocessing.resource_tracker import (
    ResourceTracker as _ResourceTracker,
)

from . import spawn

if sys.platform == "win32":
    import _winapi
    import msvcrt
    from multiprocessing.reduction import duplicate


__all__ = ["ensure_running", "register", "unregister"]

_HAVE_SIGMASK = hasattr(signal, "pthread_sigmask")
_IGNORED_SIGNALS = (signal.SIGINT, signal.SIGTERM)


def cleanup_noop(name):
    raise RuntimeError("noop should never be registered or cleaned up")


_CLEANUP_FUNCS = {
    "noop": cleanup_noop,
    "folder": shutil.rmtree,
    "file": os.unlink,
}

if os.name == "posix":
    import _multiprocessing

    # Use sem_unlink() to clean up named semaphores.
    #
    # sem_unlink() may be missing if the Python build process detected the
    # absence of POSIX named semaphores. In that case, no named semaphores were
    # ever opened, so no cleanup would be necessary.
    if hasattr(_multiprocessing, "sem_unlink"):
        _CLEANUP_FUNCS.update(
            {
                "semlock": _multiprocessing.sem_unlink,
            }
        )


VERBOSE = False


class ResourceTracker(_ResourceTracker):
    """Resource tracker with refcounting scheme.

    This class is an extension of the multiprocessing ResourceTracker class
    which implements a reference counting scheme to avoid unlinking shared
    resources still in use in other processes.

    This feature is notably used by `joblib.Parallel` to share temporary
    folders and memory mapped files between the main process and the worker
    processes.

    The actual implementation of the refcounting scheme is in the main
    function, which is run in a dedicated process.
    """

    def maybe_unlink(self, name, rtype):
        """Decrement the refcount of a resource, and delete it if it hits 0"""
        self._send("MAYBE_UNLINK", name, rtype)

    def ensure_running(self):
        """Make sure that resource tracker process is running.

        This can be run from any process.  Usually a child process will use
        the resource created by its parent.

        This function is necessary for backward compatibility with python
        versions before 3.13.7.
        """
        return self._ensure_running_and_write()

    def _teardown_dead_process(self):
        # Override this function for compatibility with windows and
        # for python version before 3.13.7

        # At this point, the resource_tracker process has been killed
        # or crashed.
        os.close(self._fd)

        # Let's remove the process entry from the process table on POSIX system
        # to avoid zombie processes.
        if os.name == "posix":
            try:
                # _pid can be None if this process is a child from another
                # python process, which has started the resource_tracker.
                if self._pid is not None:
                    os.waitpid(self._pid, 0)
            except OSError:
                # The resource_tracker has already been terminated.
                pass
        self._fd = None
        self._pid = None

        warnings.warn(
            "resource_tracker: process died unexpectedly, relaunching. "
            "Some folders/semaphores might leak."
        )

    def _launch(self):
        # This is the overridden part of the resource tracker, which launches
        # loky's version, which is compatible with windows and allow to track
        # folders with external ref counting.

        fds_to_pass = []
        try:
            fds_to_pass.append(sys.stderr.fileno())
        except Exception:
            pass

        # Create a pipe for posix and windows
        r, w = os.pipe()
        if sys.platform == "win32":
            _r = duplicate(msvcrt.get_osfhandle(r), inheritable=True)
            os.close(r)
            r = _r

        cmd = f"from {main.__module__} import main; main({r}, {VERBOSE})"
        try:
            fds_to_pass.append(r)
            # process will out live us, so no need to wait on pid
            exe = spawn.get_executable()
            args = [exe, *util._args_from_interpreter_flags(), "-c", cmd]
            util.debug(f"launching resource tracker: {args}")
            # bpo-33613: Register a signal mask that will block the
            # signals.  This signal mask will be inherited by the child
            # that is going to be spawned and will protect the child from a
            # race condition that can make the child die before it
            # registers signal handlers for SIGINT and SIGTERM. The mask is
            # unregistered after spawning the child.
            try:
                if _HAVE_SIGMASK:
                    signal.pthread_sigmask(signal.SIG_BLOCK, _IGNORED_SIGNALS)
                pid = spawnv_passfds(exe, args, fds_to_pass)
            finally:
                if _HAVE_SIGMASK:
                    signal.pthread_sigmask(
                        signal.SIG_UNBLOCK, _IGNORED_SIGNALS
                    )
        except BaseException:
            os.close(w)
            raise
        else:
            self._fd = w
            self._pid = pid
        finally:
            if sys.platform == "win32":
                _winapi.CloseHandle(r)
            else:
                os.close(r)

    def _ensure_running_and_write(self, msg=None):
        """Make sure that resource tracker process is running.

        This can be run from any process.  Usually a child process will use
        the resource created by its parent.


        This function is added for compatibility with python version before 3.13.7.
        """
        with self._lock:
            if (
                self._fd is not None
            ):  # resource tracker was launched before, is it still running?
                if msg is None:
                    to_send = b"PROBE:0:noop\n"
                else:
                    to_send = msg
                try:
                    self._write(to_send)
                except OSError:
                    self._teardown_dead_process()
                    self._launch()

                msg = None  # message was sent in probe
            else:
                self._launch()

        if msg is not None:
            self._write(msg)

    def _write(self, msg):
        nbytes = os.write(self._fd, msg)
        assert nbytes == len(msg), f"{nbytes=} != {len(msg)=}"

    def __del__(self):
        # ignore error due to trying to clean up child process which has already been
        # shutdown on windows. See https://github.com/joblib/loky/pull/450
        # This is only required if __del__ is defined
        if not hasattr(_ResourceTracker, "__del__"):
            return
        try:
            super().__del__()
        except ChildProcessError:
            pass


_resource_tracker = ResourceTracker()
ensure_running = _resource_tracker.ensure_running
register = _resource_tracker.register
maybe_unlink = _resource_tracker.maybe_unlink
unregister = _resource_tracker.unregister
getfd = _resource_tracker.getfd


def main(fd, verbose=0):
    """Run resource tracker."""
    if verbose:
        util.log_to_stderr(level=util.DEBUG)

    # protect the process from ^C and "killall python" etc
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    signal.signal(signal.SIGTERM, signal.SIG_IGN)

    if _HAVE_SIGMASK:
        signal.pthread_sigmask(signal.SIG_UNBLOCK, _IGNORED_SIGNALS)

    for f in (sys.stdin, sys.stdout):
        try:
            f.close()
        except Exception:
            pass

    if verbose:
        util.debug("Main resource tracker is running")

    registry = {rtype: {} for rtype in _CLEANUP_FUNCS.keys()}

    try:
        if sys.platform == "win32":
            fd = msvcrt.open_osfhandle(fd, os.O_RDONLY)
        # keep track of registered/unregistered resources
        with open(fd, "rb") as f:
            for line in f:
                try:
                    splitted = line.strip().decode("ascii").split(":")
                    # name can potentially contain separator symbols (for
                    # instance folders on Windows)
                    cmd, name, rtype = (
                        splitted[0],
                        ":".join(splitted[1:-1]),
                        splitted[-1],
                    )

                    if rtype not in _CLEANUP_FUNCS:
                        raise ValueError(
                            f"Cannot register {name} for automatic cleanup: "
                            f"unknown resource type ({rtype}). Resource type "
                            "should be one of the following: "
                            f"{list(_CLEANUP_FUNCS.keys())}"
                        )

                    if cmd == "PROBE":
                        pass
                    elif cmd == "REGISTER":
                        if name not in registry[rtype]:
                            registry[rtype][name] = 1
                        else:
                            registry[rtype][name] += 1

                        if verbose:
                            util.debug(
                                "[ResourceTracker] incremented refcount of "
                                f"{rtype} {name} "
                                f"(current {registry[rtype][name]})"
                            )
                    elif cmd == "UNREGISTER":
                        del registry[rtype][name]
                        if verbose:
                            util.debug(
                                f"[ResourceTracker] unregister {name} {rtype}: "
                                f"registry({len(registry)})"
                            )
                    elif cmd == "MAYBE_UNLINK":
                        registry[rtype][name] -= 1
                        if verbose:
                            util.debug(
                                "[ResourceTracker] decremented refcount of "
                                f"{rtype} {name} "
                                f"(current {registry[rtype][name]})"
                            )

                        if registry[rtype][name] == 0:
                            del registry[rtype][name]
                            try:
                                if verbose:
                                    util.debug(
                                        f"[ResourceTracker] unlink {name}"
                                    )
                                _CLEANUP_FUNCS[rtype](name)
                            except Exception as e:
                                warnings.warn(
                                    f"resource_tracker: {name}: {e!r}"
                                )

                    else:
                        raise RuntimeError(f"unrecognized command {cmd!r}")
                except BaseException:
                    try:
                        sys.excepthook(*sys.exc_info())
                    except BaseException:
                        pass
    finally:
        # all processes have terminated; cleanup any remaining resources
        def _unlink_resources(rtype_registry, rtype):
            if rtype_registry:
                try:
                    warnings.warn(
                        "resource_tracker: There appear to be "
                        f"{len(rtype_registry)} leaked {rtype} objects to "
                        "clean up at shutdown"
                    )
                except Exception:
                    pass
            for name in rtype_registry:
                # For some reason the process which created and registered this
                # resource has failed to unregister it. Presumably it has
                # died.  We therefore clean it up.
                try:
                    _CLEANUP_FUNCS[rtype](name)
                    if verbose:
                        util.debug(f"[ResourceTracker] unlink {name}")
                except Exception as e:
                    warnings.warn(f"resource_tracker: {name}: {e!r}")

        for rtype, rtype_registry in registry.items():
            if rtype == "folder":
                continue
            else:
                _unlink_resources(rtype_registry, rtype)

        # The default cleanup routine for folders deletes everything inside
        # those folders recursively, which can include other resources tracked
        # by the resource tracker). To limit the risk of the resource tracker
        # attempting to delete twice a resource (once as part of a tracked
        # folder, and once as a resource), we delete the folders after all
        # other resource types.
        if "folder" in registry:
            _unlink_resources(registry["folder"], "folder")

    if verbose:
        util.debug("resource tracker shut down")


def spawnv_passfds(path, args, passfds):
    if sys.platform != "win32":
        args = [arg.encode("utf-8") for arg in args]
        path = path.encode("utf-8")
        return util.spawnv_passfds(path, args, passfds)
    else:
        passfds = sorted(passfds)
        cmd = " ".join(f'"{x}"' for x in args)
        try:
            _, ht, pid, _ = _winapi.CreateProcess(
                path, cmd, None, None, True, 0, None, None, None
            )
            _winapi.CloseHandle(ht)
        except BaseException:
            pass
        return pid
