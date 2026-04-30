from __future__ import annotations

import asyncio
import socket
import threading
from collections.abc import Callable
from selectors import EVENT_READ, EVENT_WRITE, DefaultSelector
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from _typeshed import FileDescriptorLike

_selector_lock = threading.Lock()
_selector: Selector | None = None


class Selector:
    def __init__(self) -> None:
        self._thread = threading.Thread(target=self.run, name="AnyIO socket selector")
        self._selector = DefaultSelector()
        self._send, self._receive = socket.socketpair()
        self._send.setblocking(False)
        self._receive.setblocking(False)
        # This somewhat reduces the amount of memory wasted queueing up data
        # for wakeups. With these settings, maximum number of 1-byte sends
        # before getting BlockingIOError:
        #   Linux 4.8: 6
        #   macOS (darwin 15.5): 1
        #   Windows 10: 525347
        # Windows you're weird. (And on Windows setting SNDBUF to 0 makes send
        # blocking, even on non-blocking sockets, so don't do that.)
        self._receive.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1)
        self._send.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 1)
        # On Windows this is a TCP socket so this might matter. On other
        # platforms this fails b/c AF_UNIX sockets aren't actually TCP.
        try:
            self._send.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass

        self._selector.register(self._receive, EVENT_READ)
        self._closed = False

    def start(self) -> None:
        self._thread.start()
        threading._register_atexit(self._stop)  # type: ignore[attr-defined]

    def _stop(self) -> None:
        global _selector
        self._closed = True
        self._notify_self()
        self._send.close()
        self._thread.join()
        self._selector.unregister(self._receive)
        self._receive.close()
        self._selector.close()
        _selector = None
        assert not self._selector.get_map(), (
            "selector still has registered file descriptors after shutdown"
        )

    def _notify_self(self) -> None:
        try:
            self._send.send(b"\x00")
        except BlockingIOError:
            pass

    def add_reader(self, fd: FileDescriptorLike, callback: Callable[[], Any]) -> None:
        loop = asyncio.get_running_loop()
        try:
            key = self._selector.get_key(fd)
        except KeyError:
            self._selector.register(fd, EVENT_READ, {EVENT_READ: (loop, callback)})
        else:
            if EVENT_READ in key.data:
                raise ValueError(
                    "this file descriptor is already registered for reading"
                )

            key.data[EVENT_READ] = loop, callback
            self._selector.modify(fd, key.events | EVENT_READ, key.data)

        self._notify_self()

    def add_writer(self, fd: FileDescriptorLike, callback: Callable[[], Any]) -> None:
        loop = asyncio.get_running_loop()
        try:
            key = self._selector.get_key(fd)
        except KeyError:
            self._selector.register(fd, EVENT_WRITE, {EVENT_WRITE: (loop, callback)})
        else:
            if EVENT_WRITE in key.data:
                raise ValueError(
                    "this file descriptor is already registered for writing"
                )

            key.data[EVENT_WRITE] = loop, callback
            self._selector.modify(fd, key.events | EVENT_WRITE, key.data)

        self._notify_self()

    def remove_reader(self, fd: FileDescriptorLike) -> bool:
        try:
            key = self._selector.get_key(fd)
        except KeyError:
            return False

        if new_events := key.events ^ EVENT_READ:
            del key.data[EVENT_READ]
            self._selector.modify(fd, new_events, key.data)
        else:
            self._selector.unregister(fd)

        return True

    def remove_writer(self, fd: FileDescriptorLike) -> bool:
        try:
            key = self._selector.get_key(fd)
        except KeyError:
            return False

        if new_events := key.events ^ EVENT_WRITE:
            del key.data[EVENT_WRITE]
            self._selector.modify(fd, new_events, key.data)
        else:
            self._selector.unregister(fd)

        return True

    def run(self) -> None:
        while not self._closed:
            for key, events in self._selector.select():
                if key.fileobj is self._receive:
                    try:
                        while self._receive.recv(4096):
                            pass
                    except BlockingIOError:
                        pass

                    continue

                if events & EVENT_READ:
                    loop, callback = key.data[EVENT_READ]
                    self.remove_reader(key.fd)
                    try:
                        loop.call_soon_threadsafe(callback)
                    except RuntimeError:
                        pass  # the loop was already closed

                if events & EVENT_WRITE:
                    loop, callback = key.data[EVENT_WRITE]
                    self.remove_writer(key.fd)
                    try:
                        loop.call_soon_threadsafe(callback)
                    except RuntimeError:
                        pass  # the loop was already closed


def get_selector() -> Selector:
    global _selector

    with _selector_lock:
        if _selector is None:
            _selector = Selector()
            _selector.start()

        return _selector
