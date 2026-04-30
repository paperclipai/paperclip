cdef __tcp_init_uv_handle(UVStream handle, Loop loop, unsigned int flags):
    cdef int err

    handle._handle = <uv.uv_handle_t*>PyMem_RawMalloc(sizeof(uv.uv_tcp_t))
    if handle._handle is NULL:
        handle._abort_init()
        raise MemoryError()

    err = uv.uv_tcp_init_ex(handle._loop.uvloop,
                            <uv.uv_tcp_t*>handle._handle,
                            flags)
    if err < 0:
        handle._abort_init()
        raise convert_error(err)

    handle._finish_init()


cdef __tcp_bind(UVStream handle, system.sockaddr* addr, unsigned int flags):
    cdef int err
    err = uv.uv_tcp_bind(<uv.uv_tcp_t *>handle._handle,
                         addr, flags)
    if err < 0:
        exc = convert_error(err)
        raise exc


cdef __tcp_open(UVStream handle, int sockfd):
    cdef int err
    err = uv.uv_tcp_open(<uv.uv_tcp_t *>handle._handle,
                         <uv.uv_os_sock_t>sockfd)
    if err < 0:
        exc = convert_error(err)
        raise exc


cdef __tcp_get_socket(UVSocketHandle handle):
    cdef:
        int buf_len = sizeof(system.sockaddr_storage)
        int fileno
        int err
        system.sockaddr_storage buf

    fileno = handle._fileno()

    err = uv.uv_tcp_getsockname(<uv.uv_tcp_t*>handle._handle,
                                <system.sockaddr*>&buf,
                                &buf_len)
    if err < 0:
        raise convert_error(err)

    return PseudoSocket(buf.ss_family, uv.SOCK_STREAM, 0, fileno)


@cython.no_gc_clear
cdef class TCPServer(UVStreamServer):

    @staticmethod
    cdef TCPServer new(Loop loop, object protocol_factory, Server server,
                       unsigned int flags,
                       object backlog,
                       object ssl,
                       object ssl_handshake_timeout,
                       object ssl_shutdown_timeout):

        cdef TCPServer handle
        handle = TCPServer.__new__(TCPServer)
        handle._init(loop, protocol_factory, server, backlog,
                     ssl, ssl_handshake_timeout, ssl_shutdown_timeout)
        __tcp_init_uv_handle(<UVStream>handle, loop, flags)
        return handle

    cdef _new_socket(self):
        return __tcp_get_socket(<UVSocketHandle>self)

    cdef _open(self, int sockfd):
        self._ensure_alive()
        try:
            __tcp_open(<UVStream>self, sockfd)
        except Exception as exc:
            self._fatal_error(exc, True)
        else:
            self._mark_as_open()

    cdef bind(self, system.sockaddr* addr, unsigned int flags=0):
        self._ensure_alive()
        try:
            __tcp_bind(<UVStream>self, addr, flags)
        except Exception as exc:
            self._fatal_error(exc, True)
        else:
            self._mark_as_open()

    cdef UVStream _make_new_transport(self, object protocol, object waiter,
                                      object context):
        cdef TCPTransport tr
        tr = TCPTransport.new(self._loop, protocol, self._server, waiter,
                              context)
        return <UVStream>tr


@cython.no_gc_clear
cdef class TCPTransport(UVStream):

    @staticmethod
    cdef TCPTransport new(Loop loop, object protocol, Server server,
                          object waiter, object context):

        cdef TCPTransport handle
        handle = TCPTransport.__new__(TCPTransport)
        handle._init(loop, protocol, server, waiter, context)
        __tcp_init_uv_handle(<UVStream>handle, loop, uv.AF_UNSPEC)
        handle.__peername_set = 0
        handle.__sockname_set = 0
        handle._set_nodelay()
        return handle

    cdef _set_nodelay(self):
        cdef int err
        self._ensure_alive()
        err = uv.uv_tcp_nodelay(<uv.uv_tcp_t*>self._handle, 1)
        if err < 0:
            raise convert_error(err)

    cdef _call_connection_made(self):
        # asyncio saves peername & sockname when transports are instantiated,
        # so that they're accessible even after the transport is closed.
        # We are doing the same thing here, except that we create Python
        # objects lazily, on request in get_extra_info()

        cdef:
            int err
            int buf_len

        buf_len = sizeof(system.sockaddr_storage)
        err = uv.uv_tcp_getsockname(<uv.uv_tcp_t*>self._handle,
                                    <system.sockaddr*>&self.__sockname,
                                    &buf_len)
        if err >= 0:
            # Ignore errors, this is an optional thing.
            # If something serious is going on, the transport
            # will crash later (in roughly the same way how
            # an asyncio transport would.)
            self.__sockname_set = 1

        buf_len = sizeof(system.sockaddr_storage)
        err = uv.uv_tcp_getpeername(<uv.uv_tcp_t*>self._handle,
                                    <system.sockaddr*>&self.__peername,
                                    &buf_len)
        if err >= 0:
            # Same as few lines above -- we don't really care
            # about error case here.
            self.__peername_set = 1

        UVBaseTransport._call_connection_made(self)

    def get_extra_info(self, name, default=None):
        if name == 'sockname':
            if self.__sockname_set:
                return __convert_sockaddr_to_pyaddr(
                    <system.sockaddr*>&self.__sockname)
        elif name == 'peername':
            if self.__peername_set:
                return __convert_sockaddr_to_pyaddr(
                    <system.sockaddr*>&self.__peername)
        return super().get_extra_info(name, default)

    cdef _new_socket(self):
        return __tcp_get_socket(<UVSocketHandle>self)

    cdef bind(self, system.sockaddr* addr, unsigned int flags=0):
        self._ensure_alive()
        __tcp_bind(<UVStream>self, addr, flags)

    cdef _open(self, int sockfd):
        self._ensure_alive()
        __tcp_open(<UVStream>self, sockfd)

    cdef connect(self, system.sockaddr* addr):
        cdef _TCPConnectRequest req
        req = _TCPConnectRequest(self._loop, self)
        req.connect(addr)


cdef class _TCPConnectRequest(UVRequest):
    cdef:
        TCPTransport transport
        uv.uv_connect_t _req_data

    def __cinit__(self, loop, transport):
        self.request = <uv.uv_req_t*>&self._req_data
        self.request.data = <void*>self
        self.transport = transport

    cdef connect(self, system.sockaddr* addr):
        cdef int err
        err = uv.uv_tcp_connect(<uv.uv_connect_t*>self.request,
                                <uv.uv_tcp_t*>self.transport._handle,
                                addr,
                                __tcp_connect_callback)
        if err < 0:
            exc = convert_error(err)
            self.on_done()
            raise exc


cdef void __tcp_connect_callback(
    uv.uv_connect_t* req,
    int status,
) noexcept with gil:
    cdef:
        _TCPConnectRequest wrapper
        TCPTransport transport

    wrapper = <_TCPConnectRequest> req.data
    transport = wrapper.transport

    if status < 0:
        exc = convert_error(status)
    else:
        exc = None

    try:
        transport._on_connect(exc)
    except BaseException as ex:
        wrapper.transport._fatal_error(ex, False)
    finally:
        wrapper.on_done()
