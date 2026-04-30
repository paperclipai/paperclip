@cython.no_gc_clear
@cython.freelist(DEFAULT_FREELIST_SIZE)
cdef class _UDPSendContext:
    # used to hold additional write request information for uv_write

    cdef:
        uv.uv_udp_send_t   req

        uv.uv_buf_t     uv_buf
        Py_buffer       py_buf

        UDPTransport    udp

        bint            closed

    cdef close(self):
        if self.closed:
            return

        self.closed = 1
        PyBuffer_Release(&self.py_buf)  # void
        self.req.data = NULL
        self.uv_buf.base = NULL
        Py_DECREF(self)
        self.udp = None

    @staticmethod
    cdef _UDPSendContext new(UDPTransport udp, object data):
        cdef _UDPSendContext ctx
        ctx = _UDPSendContext.__new__(_UDPSendContext)
        ctx.udp = None
        ctx.closed = 1

        ctx.req.data = <void*> ctx
        Py_INCREF(ctx)

        PyObject_GetBuffer(data, &ctx.py_buf, PyBUF_SIMPLE)
        ctx.uv_buf.base = <char*>ctx.py_buf.buf
        ctx.uv_buf.len = ctx.py_buf.len
        ctx.udp = udp

        ctx.closed = 0
        return ctx

    def __dealloc__(self):
        if UVLOOP_DEBUG:
            if not self.closed:
                raise RuntimeError(
                    'open _UDPSendContext is being deallocated')
        self.udp = None


@cython.no_gc_clear
cdef class UDPTransport(UVBaseTransport):
    def __cinit__(self):
        self._family = uv.AF_UNSPEC
        self.__receiving = 0
        self._address = None
        self.context = Context_CopyCurrent()

    cdef _init(self, Loop loop, unsigned int family):
        cdef int err

        self._start_init(loop)

        self._handle = <uv.uv_handle_t*>PyMem_RawMalloc(sizeof(uv.uv_udp_t))
        if self._handle is NULL:
            self._abort_init()
            raise MemoryError()

        err = uv.uv_udp_init_ex(loop.uvloop,
                                <uv.uv_udp_t*>self._handle,
                                family)
        if err < 0:
            self._abort_init()
            raise convert_error(err)

        if family in (uv.AF_INET, uv.AF_INET6):
            self._family = family

        self._finish_init()

    cdef _set_address(self, system.addrinfo *addr):
        self._address = __convert_sockaddr_to_pyaddr(addr.ai_addr)

    cdef _connect(self, system.sockaddr* addr, size_t addr_len):
        cdef int err
        err = uv.uv_udp_connect(<uv.uv_udp_t*>self._handle, addr)
        if err < 0:
            exc = convert_error(err)
            raise exc

    cdef open(self, int family, int sockfd):
        if family in (uv.AF_INET, uv.AF_INET6, uv.AF_UNIX):
            self._family = family
        else:
            raise ValueError(
                'cannot open a UDP handle, invalid family {}'.format(family))

        cdef int err
        err = uv.uv_udp_open(<uv.uv_udp_t*>self._handle,
                             <uv.uv_os_sock_t>sockfd)

        if err < 0:
            exc = convert_error(err)
            raise exc

    cdef _bind(self, system.sockaddr* addr):
        cdef:
            int err
            int flags = 0

        self._ensure_alive()

        err = uv.uv_udp_bind(<uv.uv_udp_t*>self._handle, addr, flags)
        if err < 0:
            exc = convert_error(err)
            raise exc

    cdef _set_broadcast(self, bint on):
        cdef int err

        self._ensure_alive()

        err = uv.uv_udp_set_broadcast(<uv.uv_udp_t*>self._handle, on)
        if err < 0:
            exc = convert_error(err)
            raise exc

    cdef size_t _get_write_buffer_size(self):
        if self._handle is NULL:
            return 0
        return (<uv.uv_udp_t*>self._handle).send_queue_size

    cdef bint _is_reading(self):
        return self.__receiving

    cdef _start_reading(self):
        cdef int err

        if self.__receiving:
            return

        self._ensure_alive()

        err = uv.uv_udp_recv_start(<uv.uv_udp_t*>self._handle,
                                   __loop_alloc_buffer,
                                   __uv_udp_on_receive)

        if err < 0:
            exc = convert_error(err)
            self._fatal_error(exc, True)
            return
        else:
            # UDPTransport must live until the read callback is called
            self.__receiving_started()

    cdef _stop_reading(self):
        cdef int err

        if not self.__receiving:
            return

        self._ensure_alive()

        err = uv.uv_udp_recv_stop(<uv.uv_udp_t*>self._handle)
        if err < 0:
            exc = convert_error(err)
            self._fatal_error(exc, True)
            return
        else:
            self.__receiving_stopped()

    cdef inline __receiving_started(self):
        if self.__receiving:
            return
        self.__receiving = 1
        Py_INCREF(self)

    cdef inline __receiving_stopped(self):
        if not self.__receiving:
            return
        self.__receiving = 0
        Py_DECREF(self)

    cdef _new_socket(self):
        if self._family not in (uv.AF_INET, uv.AF_INET6, uv.AF_UNIX):
            raise RuntimeError(
                'UDPTransport.family is undefined; '
                'cannot create python socket')

        fileno = self._fileno()
        return PseudoSocket(self._family, uv.SOCK_DGRAM, 0, fileno)

    cdef _send(self, object data, object addr):
        cdef:
            _UDPSendContext ctx
            system.sockaddr_storage saddr_st
            system.sockaddr *saddr
            Py_buffer       try_pybuf
            uv.uv_buf_t     try_uvbuf

        self._ensure_alive()

        if self._family not in (uv.AF_INET, uv.AF_INET6, uv.AF_UNIX):
            raise RuntimeError('UDPTransport.family is undefined; cannot send')

        if addr is None:
            saddr = NULL
        else:
            try:
                __convert_pyaddr_to_sockaddr(self._family, addr,
                                             <system.sockaddr*>&saddr_st)
            except (ValueError, TypeError):
                raise
            except Exception:
                raise ValueError(
                    f'{addr!r}: socket family mismatch or '
                    f'a DNS lookup is required')
            saddr = <system.sockaddr*>(&saddr_st)

        if self._get_write_buffer_size() == 0:
            PyObject_GetBuffer(data, &try_pybuf, PyBUF_SIMPLE)
            try_uvbuf.base = <char*>try_pybuf.buf
            try_uvbuf.len = try_pybuf.len
            err = uv.uv_udp_try_send(<uv.uv_udp_t*>self._handle,
                                     &try_uvbuf,
                                     1,
                                     saddr)
            PyBuffer_Release(&try_pybuf)
        else:
            err = uv.UV_EAGAIN

        if err == uv.UV_EAGAIN:
            ctx = _UDPSendContext.new(self, data)
            err = uv.uv_udp_send(&ctx.req,
                                 <uv.uv_udp_t*>self._handle,
                                 &ctx.uv_buf,
                                 1,
                                 saddr,
                                 __uv_udp_on_send)

            if err < 0:
                ctx.close()

                exc = convert_error(err)
                if isinstance(exc, OSError):
                    run_in_context1(self.context.copy(), self._protocol.error_received, exc)
                else:
                    self._fatal_error(exc, True)
            else:
                self._maybe_pause_protocol()

        else:
            self._on_sent(convert_error(err) if err < 0 else None, self.context.copy())

    cdef _on_receive(self, bytes data, object exc, object addr):
        if exc is None:
            run_in_context2(
                self.context, self._protocol.datagram_received, data, addr,
            )
        else:
            run_in_context1(self.context, self._protocol.error_received, exc)

    cdef _on_sent(self, object exc, object context=None):
        if exc is not None:
            if isinstance(exc, OSError):
                if context is None:
                    context = self.context
                run_in_context1(context, self._protocol.error_received, exc)
            else:
                self._fatal_error(
                    exc, False, 'Fatal write error on datagram transport')

        self._maybe_resume_protocol()
        if not self._get_write_buffer_size():
            if self._closing:
                self._schedule_call_connection_lost(None)

    # === Public API ===

    def sendto(self, data, addr=None):
        if not data:
            # Replicating asyncio logic here.
            return

        if self._address:
            if addr not in (None, self._address):
                # Replicating asyncio logic here.
                raise ValueError(
                    'Invalid address: must be None or %s' % (self._address,))

            # Instead of setting addr to self._address below like what asyncio
            # does, we depend on previous uv_udp_connect() to set the address
            addr = None

        if self._conn_lost:
            # Replicating asyncio logic here.
            if self._conn_lost >= LOG_THRESHOLD_FOR_CONNLOST_WRITES:
                aio_logger.warning('socket.send() raised exception.')
            self._conn_lost += 1
            return

        self._send(data, addr)


cdef void __uv_udp_on_receive(
    uv.uv_udp_t* handle,
    ssize_t nread,
    const uv.uv_buf_t* buf,
    const system.sockaddr* addr,
    unsigned flags
) noexcept with gil:

    if __ensure_handle_data(<uv.uv_handle_t*>handle,
                            "UDPTransport receive callback") == 0:
        return

    cdef:
        UDPTransport udp = <UDPTransport>handle.data
        Loop loop = udp._loop
        bytes data
        object pyaddr

    # It's OK to free the buffer early, since nothing will
    # be able to touch it until this method is done.
    __loop_free_buffer(loop)

    if udp._closed:
        # The handle was closed, there is no reason to
        # do any work now.
        udp.__receiving_stopped()  # Just in case.
        return

    if addr is NULL and nread == 0:
        # From libuv docs:
        #      addr: struct sockaddr* containing the address
        #      of the sender. Can be NULL. Valid for the duration
        #      of the callback only.
        #      [...]
        #      The receive callback will be called with
        #      nread == 0 and addr == NULL when there is
        #      nothing to read, and with nread == 0 and
        #      addr != NULL when an empty UDP packet is
        #      received.
        return

    if addr is NULL:
        pyaddr = None
    elif addr.sa_family == uv.AF_UNSPEC:
        # https://github.com/MagicStack/uvloop/issues/304
        if system.PLATFORM_IS_LINUX:
            pyaddr = None
        else:
            pyaddr = ''
    else:
        try:
            pyaddr = __convert_sockaddr_to_pyaddr(addr)
        except BaseException as exc:
            udp._error(exc, False)
            return

    if nread < 0:
        exc = convert_error(nread)
        udp._on_receive(None, exc, pyaddr)
        return

    if nread == 0:
        data = b''
    else:
        data = loop._recv_buffer[:nread]

    try:
        udp._on_receive(data, None, pyaddr)
    except BaseException as exc:
        udp._error(exc, False)


cdef void __uv_udp_on_send(
    uv.uv_udp_send_t* req,
    int status,
) noexcept with gil:

    if req.data is NULL:
        # Shouldn't happen as:
        #    - _UDPSendContext does an extra INCREF in its 'init()'
        #    - _UDPSendContext holds a ref to the relevant UDPTransport
        aio_logger.error(
            'UVStream.write callback called with NULL req.data, status=%r',
            status)
        return

    cdef:
        _UDPSendContext ctx = <_UDPSendContext> req.data
        UDPTransport udp = <UDPTransport>ctx.udp

    ctx.close()

    if status < 0:
        exc = convert_error(status)
        print(exc)
    else:
        exc = None

    try:
        udp._on_sent(exc)
    except BaseException as exc:
        udp._error(exc, False)
