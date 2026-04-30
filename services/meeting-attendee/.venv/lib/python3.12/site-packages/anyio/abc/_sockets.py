from __future__ import annotations

import errno
import socket
from abc import abstractmethod
from collections.abc import Callable, Collection, Mapping
from contextlib import AsyncExitStack
from io import IOBase
from ipaddress import IPv4Address, IPv6Address
from socket import AddressFamily
from typing import Any, TypeAlias, TypeVar

from .._core._eventloop import get_async_backend
from .._core._typedattr import (
    TypedAttributeProvider,
    TypedAttributeSet,
    typed_attribute,
)
from ._streams import ByteStream, Listener, UnreliableObjectStream
from ._tasks import TaskGroup

IPAddressType: TypeAlias = str | IPv4Address | IPv6Address
IPSockAddrType: TypeAlias = tuple[str, int]
SockAddrType: TypeAlias = IPSockAddrType | str
UDPPacketType: TypeAlias = tuple[bytes, IPSockAddrType]
UNIXDatagramPacketType: TypeAlias = tuple[bytes, str]
T_Retval = TypeVar("T_Retval")


def _validate_socket(
    sock_or_fd: socket.socket | int,
    sock_type: socket.SocketKind,
    addr_family: socket.AddressFamily = socket.AF_UNSPEC,
    *,
    require_connected: bool = False,
    require_bound: bool = False,
) -> socket.socket:
    if isinstance(sock_or_fd, int):
        try:
            sock = socket.socket(fileno=sock_or_fd)
        except OSError as exc:
            if exc.errno == errno.ENOTSOCK:
                raise ValueError(
                    "the file descriptor does not refer to a socket"
                ) from exc
            elif require_connected:
                raise ValueError("the socket must be connected") from exc
            elif require_bound:
                raise ValueError("the socket must be bound to a local address") from exc
            else:
                raise
    elif isinstance(sock_or_fd, socket.socket):
        sock = sock_or_fd
    else:
        raise TypeError(
            f"expected an int or socket, got {type(sock_or_fd).__qualname__} instead"
        )

    try:
        if require_connected:
            try:
                sock.getpeername()
            except OSError as exc:
                raise ValueError("the socket must be connected") from exc

        if require_bound:
            try:
                if sock.family in (socket.AF_INET, socket.AF_INET6):
                    bound_addr = sock.getsockname()[1]
                else:
                    bound_addr = sock.getsockname()
            except OSError:
                bound_addr = None

            if not bound_addr:
                raise ValueError("the socket must be bound to a local address")

        if addr_family != socket.AF_UNSPEC and sock.family != addr_family:
            raise ValueError(
                f"address family mismatch: expected {addr_family.name}, got "
                f"{sock.family.name}"
            )

        if sock.type != sock_type:
            raise ValueError(
                f"socket type mismatch: expected {sock_type.name}, got {sock.type.name}"
            )
    except BaseException:
        # Avoid ResourceWarning from the locally constructed socket object
        if isinstance(sock_or_fd, int):
            sock.detach()

        raise

    sock.setblocking(False)
    return sock


class SocketAttribute(TypedAttributeSet):
    """
    .. attribute:: family
        :type: socket.AddressFamily

        the address family of the underlying socket

    .. attribute:: local_address
        :type: tuple[str, int] | str

        the local address the underlying socket is connected to

    .. attribute:: local_port
        :type: int

        for IP based sockets, the local port the underlying socket is bound to

    .. attribute:: raw_socket
        :type: socket.socket

        the underlying stdlib socket object

    .. attribute:: remote_address
        :type: tuple[str, int] | str

        the remote address the underlying socket is connected to

    .. attribute:: remote_port
        :type: int

        for IP based sockets, the remote port the underlying socket is connected to
    """

    family: AddressFamily = typed_attribute()
    local_address: SockAddrType = typed_attribute()
    local_port: int = typed_attribute()
    raw_socket: socket.socket = typed_attribute()
    remote_address: SockAddrType = typed_attribute()
    remote_port: int = typed_attribute()


class _SocketProvider(TypedAttributeProvider):
    @property
    def extra_attributes(self) -> Mapping[Any, Callable[[], Any]]:
        from .._core._sockets import convert_ipv6_sockaddr as convert

        attributes: dict[Any, Callable[[], Any]] = {
            SocketAttribute.family: lambda: self._raw_socket.family,
            SocketAttribute.local_address: lambda: convert(
                self._raw_socket.getsockname()
            ),
            SocketAttribute.raw_socket: lambda: self._raw_socket,
        }
        try:
            peername: tuple[str, int] | None = convert(self._raw_socket.getpeername())
        except OSError:
            peername = None

        # Provide the remote address for connected sockets
        if peername is not None:
            attributes[SocketAttribute.remote_address] = lambda: peername

        # Provide local and remote ports for IP based sockets
        if self._raw_socket.family in (AddressFamily.AF_INET, AddressFamily.AF_INET6):
            attributes[SocketAttribute.local_port] = lambda: (
                self._raw_socket.getsockname()[1]
            )
            if peername is not None:
                remote_port = peername[1]
                attributes[SocketAttribute.remote_port] = lambda: remote_port

        return attributes

    @property
    @abstractmethod
    def _raw_socket(self) -> socket.socket:
        pass


class SocketStream(ByteStream, _SocketProvider):
    """
    Transports bytes over a socket.

    Supports all relevant extra attributes from :class:`~SocketAttribute`.
    """

    @classmethod
    async def from_socket(cls, sock_or_fd: socket.socket | int) -> SocketStream:
        """
        Wrap an existing socket object or file descriptor as a socket stream.

        The newly created socket wrapper takes ownership of the socket being passed in.
        The existing socket must already be connected.

        :param sock_or_fd: a socket object or file descriptor
        :return: a socket stream

        """
        sock = _validate_socket(sock_or_fd, socket.SOCK_STREAM, require_connected=True)
        return await get_async_backend().wrap_stream_socket(sock)


class UNIXSocketStream(SocketStream):
    @classmethod
    async def from_socket(cls, sock_or_fd: socket.socket | int) -> UNIXSocketStream:
        """
        Wrap an existing socket object or file descriptor as a UNIX socket stream.

        The newly created socket wrapper takes ownership of the socket being passed in.
        The existing socket must already be connected.

        :param sock_or_fd: a socket object or file descriptor
        :return: a UNIX socket stream

        """
        sock = _validate_socket(
            sock_or_fd, socket.SOCK_STREAM, socket.AF_UNIX, require_connected=True
        )
        return await get_async_backend().wrap_unix_stream_socket(sock)

    @abstractmethod
    async def send_fds(self, message: bytes, fds: Collection[int | IOBase]) -> None:
        """
        Send file descriptors along with a message to the peer.

        :param message: a non-empty bytestring
        :param fds: a collection of files (either numeric file descriptors or open file
            or socket objects)
        """

    @abstractmethod
    async def receive_fds(self, msglen: int, maxfds: int) -> tuple[bytes, list[int]]:
        """
        Receive file descriptors along with a message from the peer.

        :param msglen: length of the message to expect from the peer
        :param maxfds: maximum number of file descriptors to expect from the peer
        :return: a tuple of (message, file descriptors)
        """


class SocketListener(Listener[SocketStream], _SocketProvider):
    """
    Listens to incoming socket connections.

    Supports all relevant extra attributes from :class:`~SocketAttribute`.
    """

    @classmethod
    async def from_socket(
        cls,
        sock_or_fd: socket.socket | int,
    ) -> SocketListener:
        """
        Wrap an existing socket object or file descriptor as a socket listener.

        The newly created listener takes ownership of the socket being passed in.

        :param sock_or_fd: a socket object or file descriptor
        :return: a socket listener

        """
        sock = _validate_socket(sock_or_fd, socket.SOCK_STREAM, require_bound=True)
        return await get_async_backend().wrap_listener_socket(sock)

    @abstractmethod
    async def accept(self) -> SocketStream:
        """Accept an incoming connection."""

    async def serve(
        self,
        handler: Callable[[SocketStream], Any],
        task_group: TaskGroup | None = None,
    ) -> None:
        from .. import create_task_group

        async with AsyncExitStack() as stack:
            if task_group is None:
                task_group = await stack.enter_async_context(create_task_group())

            while True:
                stream = await self.accept()
                task_group.start_soon(handler, stream)


class UDPSocket(UnreliableObjectStream[UDPPacketType], _SocketProvider):
    """
    Represents an unconnected UDP socket.

    Supports all relevant extra attributes from :class:`~SocketAttribute`.
    """

    @classmethod
    async def from_socket(cls, sock_or_fd: socket.socket | int) -> UDPSocket:
        """
        Wrap an existing socket object or file descriptor as a UDP socket.

        The newly created socket wrapper takes ownership of the socket being passed in.
        The existing socket must be bound to a local address.

        :param sock_or_fd: a socket object or file descriptor
        :return: a UDP socket

        """
        sock = _validate_socket(sock_or_fd, socket.SOCK_DGRAM, require_bound=True)
        return await get_async_backend().wrap_udp_socket(sock)

    async def sendto(self, data: bytes, host: str, port: int) -> None:
        """
        Alias for :meth:`~.UnreliableObjectSendStream.send` ((data, (host, port))).

        """
        return await self.send((data, (host, port)))


class ConnectedUDPSocket(UnreliableObjectStream[bytes], _SocketProvider):
    """
    Represents an connected UDP socket.

    Supports all relevant extra attributes from :class:`~SocketAttribute`.
    """

    @classmethod
    async def from_socket(cls, sock_or_fd: socket.socket | int) -> ConnectedUDPSocket:
        """
        Wrap an existing socket object or file descriptor as a connected UDP socket.

        The newly created socket wrapper takes ownership of the socket being passed in.
        The existing socket must already be connected.

        :param sock_or_fd: a socket object or file descriptor
        :return: a connected UDP socket

        """
        sock = _validate_socket(
            sock_or_fd,
            socket.SOCK_DGRAM,
            require_connected=True,
        )
        return await get_async_backend().wrap_connected_udp_socket(sock)


class UNIXDatagramSocket(
    UnreliableObjectStream[UNIXDatagramPacketType], _SocketProvider
):
    """
    Represents an unconnected Unix datagram socket.

    Supports all relevant extra attributes from :class:`~SocketAttribute`.
    """

    @classmethod
    async def from_socket(
        cls,
        sock_or_fd: socket.socket | int,
    ) -> UNIXDatagramSocket:
        """
        Wrap an existing socket object or file descriptor as a UNIX datagram
        socket.

        The newly created socket wrapper takes ownership of the socket being passed in.

        :param sock_or_fd: a socket object or file descriptor
        :return: a UNIX datagram socket

        """
        sock = _validate_socket(sock_or_fd, socket.SOCK_DGRAM, socket.AF_UNIX)
        return await get_async_backend().wrap_unix_datagram_socket(sock)

    async def sendto(self, data: bytes, path: str) -> None:
        """Alias for :meth:`~.UnreliableObjectSendStream.send` ((data, path))."""
        return await self.send((data, path))


class ConnectedUNIXDatagramSocket(UnreliableObjectStream[bytes], _SocketProvider):
    """
    Represents a connected Unix datagram socket.

    Supports all relevant extra attributes from :class:`~SocketAttribute`.
    """

    @classmethod
    async def from_socket(
        cls,
        sock_or_fd: socket.socket | int,
    ) -> ConnectedUNIXDatagramSocket:
        """
        Wrap an existing socket object or file descriptor as a connected UNIX datagram
        socket.

        The newly created socket wrapper takes ownership of the socket being passed in.
        The existing socket must already be connected.

        :param sock_or_fd: a socket object or file descriptor
        :return: a connected UNIX datagram socket

        """
        sock = _validate_socket(
            sock_or_fd, socket.SOCK_DGRAM, socket.AF_UNIX, require_connected=True
        )
        return await get_async_backend().wrap_connected_unix_datagram_socket(sock)
