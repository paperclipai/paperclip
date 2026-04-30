cdef class UVStreamServer(UVSocketHandle):
    cdef:
        int backlog
        object ssl
        object ssl_handshake_timeout
        object ssl_shutdown_timeout
        object protocol_factory
        bint opened
        Server _server

    # All "inline" methods are final

    cdef inline _init(self, Loop loop, object protocol_factory,
                      Server server,
                      object backlog,
                      object ssl,
                      object ssl_handshake_timeout,
                      object ssl_shutdown_timeout)

    cdef inline _mark_as_open(self)

    cdef inline listen(self)
    cdef inline _on_listen(self)

    cdef UVStream _make_new_transport(self, object protocol, object waiter,
                                      object context)
