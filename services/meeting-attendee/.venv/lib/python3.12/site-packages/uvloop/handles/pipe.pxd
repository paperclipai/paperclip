cdef class UnixServer(UVStreamServer):

    cdef bind(self, str path)

    @staticmethod
    cdef UnixServer new(Loop loop, object protocol_factory, Server server,
                        object backlog,
                        object ssl,
                        object ssl_handshake_timeout,
                        object ssl_shutdown_timeout)


cdef class UnixTransport(UVStream):

    @staticmethod
    cdef UnixTransport new(Loop loop, object protocol, Server server,
                           object waiter, object context)

    cdef connect(self, char* addr)


cdef class ReadUnixTransport(UVStream):

    @staticmethod
    cdef ReadUnixTransport new(Loop loop, object protocol, Server server,
                               object waiter)


cdef class WriteUnixTransport(UVStream):

    @staticmethod
    cdef WriteUnixTransport new(Loop loop, object protocol, Server server,
                                object waiter)
