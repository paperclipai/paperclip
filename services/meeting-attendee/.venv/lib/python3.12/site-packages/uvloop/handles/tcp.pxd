cdef class TCPServer(UVStreamServer):
    cdef bind(self, system.sockaddr* addr, unsigned int flags=*)

    @staticmethod
    cdef TCPServer new(Loop loop, object protocol_factory, Server server,
                       unsigned int flags,
                       object backlog,
                       object ssl,
                       object ssl_handshake_timeout,
                       object ssl_shutdown_timeout)


cdef class TCPTransport(UVStream):
    cdef:
        bint __peername_set
        bint __sockname_set
        system.sockaddr_storage __peername
        system.sockaddr_storage __sockname

    cdef bind(self, system.sockaddr* addr, unsigned int flags=*)
    cdef connect(self, system.sockaddr* addr)
    cdef _set_nodelay(self)

    @staticmethod
    cdef TCPTransport new(Loop loop, object protocol, Server server,
                          object waiter, object context)
