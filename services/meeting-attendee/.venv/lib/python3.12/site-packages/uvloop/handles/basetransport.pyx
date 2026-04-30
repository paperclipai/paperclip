cdef class UVBaseTransport(UVSocketHandle):

    def __cinit__(self):
        # Flow control
        self._high_water = FLOW_CONTROL_HIGH_WATER * 1024
        self._low_water = FLOW_CONTROL_HIGH_WATER // 4

        self._protocol = None
        self._protocol_connected = 0
        self._protocol_paused = 0
        self._protocol_data_received = None

        self._server = None
        self._waiter = None
        self._extra_info = None

        self._conn_lost = 0

        self._closing = 0

    cdef size_t _get_write_buffer_size(self):
        return 0

    cdef inline _schedule_call_connection_made(self):
        self._loop._call_soon_handle(
            new_MethodHandle(self._loop,
                             "UVTransport._call_connection_made",
                             <method_t>self._call_connection_made,
                             self.context,
                             self))

    cdef inline _schedule_call_connection_lost(self, exc):
        self._loop._call_soon_handle(
            new_MethodHandle1(self._loop,
                              "UVTransport._call_connection_lost",
                              <method1_t>self._call_connection_lost,
                              self.context,
                              self, exc))

    cdef _fatal_error(self, exc, throw, reason=None):
        # Overload UVHandle._fatal_error

        self._force_close(exc)

        if not isinstance(exc, OSError):

            if throw or self._loop is None:
                raise exc

            msg = f'Fatal error on transport {self.__class__.__name__}'
            if reason is not None:
                msg = f'{msg} ({reason})'

            self._loop.call_exception_handler({
                'message': msg,
                'exception': exc,
                'transport': self,
                'protocol': self._protocol,
            })

    cdef inline _maybe_pause_protocol(self):
        cdef:
            size_t size = self._get_write_buffer_size()

        if size <= self._high_water:
            return

        if not self._protocol_paused:
            self._protocol_paused = 1
            try:
                # _maybe_pause_protocol() is always triggered from user-calls,
                # so we must copy the context to avoid entering context twice
                run_in_context(
                    self.context.copy(), self._protocol.pause_writing,
                )
            except (KeyboardInterrupt, SystemExit):
                raise
            except BaseException as exc:
                self._loop.call_exception_handler({
                    'message': 'protocol.pause_writing() failed',
                    'exception': exc,
                    'transport': self,
                    'protocol': self._protocol,
                })

    cdef inline _maybe_resume_protocol(self):
        cdef:
            size_t size = self._get_write_buffer_size()

        if self._protocol_paused and size <= self._low_water:
            self._protocol_paused = 0
            try:
                # We're copying the context to avoid entering context twice,
                # even though it's not always necessary to copy - it's easier
                # to copy here than passing down a copied context.
                run_in_context(
                    self.context.copy(), self._protocol.resume_writing,
                )
            except (KeyboardInterrupt, SystemExit):
                raise
            except BaseException as exc:
                self._loop.call_exception_handler({
                    'message': 'protocol.resume_writing() failed',
                    'exception': exc,
                    'transport': self,
                    'protocol': self._protocol,
                })

    cdef _wakeup_waiter(self):
        if self._waiter is not None:
            if not self._waiter.cancelled():
                if not self._is_alive():
                    self._waiter.set_exception(
                        RuntimeError(
                            'closed Transport handle and unset waiter'))
                else:
                    self._waiter.set_result(True)
            self._waiter = None

    cdef _call_connection_made(self):
        if self._protocol is None:
            raise RuntimeError(
                'protocol is not set, cannot call connection_made()')

        # We use `_is_alive()` and not `_closing`, because we call
        # `transport._close()` in `loop.create_connection()` if an
        # exception happens during `await waiter`.
        if not self._is_alive():
            # A connection waiter can be cancelled between
            # 'await loop.create_connection()' and
            # `_schedule_call_connection_made` and
            # the actual `_call_connection_made`.
            self._wakeup_waiter()
            return

        # Set _protocol_connected to 1 before calling "connection_made":
        # if transport is aborted or closed, "connection_lost" will
        # still be scheduled.
        self._protocol_connected = 1

        try:
            self._protocol.connection_made(self)
        except BaseException:
            self._wakeup_waiter()
            raise

        if not self._is_alive():
            # This might happen when "transport.abort()" is called
            # from "Protocol.connection_made".
            self._wakeup_waiter()
            return

        self._start_reading()
        self._wakeup_waiter()

    cdef _call_connection_lost(self, exc):
        if self._waiter is not None:
            if not self._waiter.done():
                self._waiter.set_exception(exc)
            self._waiter = None

        if self._closed:
            # The handle is closed -- likely, _call_connection_lost
            # was already called before.
            return

        try:
            if self._protocol_connected:
                self._protocol.connection_lost(exc)
        finally:
            self._clear_protocol()

            self._close()

            server = self._server
            if server is not None:
                (<Server>server)._detach()
                self._server = None

    cdef inline _set_server(self, Server server):
        self._server = server
        (<Server>server)._attach()

    cdef inline _set_waiter(self, object waiter):
        if waiter is not None and not isfuture(waiter):
            raise TypeError(
                f'invalid waiter object {waiter!r}, expected asyncio.Future')

        self._waiter = waiter

    cdef _set_protocol(self, object protocol):
        self._protocol = protocol
        # Store a reference to the bound method directly
        try:
            self._protocol_data_received = protocol.data_received
        except AttributeError:
            pass

    cdef _clear_protocol(self):
        self._protocol = None
        self._protocol_data_received = None

    cdef inline _init_protocol(self):
        self._loop._track_transport(self)
        if self._protocol is None:
            raise RuntimeError('invalid _init_protocol call')
        self._schedule_call_connection_made()

    cdef inline _add_extra_info(self, str name, object obj):
        if self._extra_info is None:
            self._extra_info = {}
        self._extra_info[name] = obj

    cdef bint _is_reading(self):
        raise NotImplementedError

    cdef _start_reading(self):
        raise NotImplementedError

    cdef _stop_reading(self):
        raise NotImplementedError

    # === Public API ===

    property _paused:
        # Used by SSLProto.  Might be removed in the future.
        def __get__(self):
            return bool(not self._is_reading())

    def get_protocol(self):
        return self._protocol

    def set_protocol(self, protocol):
        self._set_protocol(protocol)
        if self._is_reading():
            self._stop_reading()
            self._start_reading()

    def _force_close(self, exc):
        # Used by SSLProto.  Might be removed in the future.
        if self._conn_lost or self._closed:
            return
        if not self._closing:
            self._closing = 1
            self._stop_reading()
        self._conn_lost += 1
        self._schedule_call_connection_lost(exc)

    def abort(self):
        self._force_close(None)

    def close(self):
        if self._closing or self._closed:
            return

        self._closing = 1
        self._stop_reading()

        if not self._get_write_buffer_size():
            # The write buffer is empty
            self._conn_lost += 1
            self._schedule_call_connection_lost(None)

    def is_closing(self):
        return self._closing

    def get_write_buffer_size(self):
        return self._get_write_buffer_size()

    def set_write_buffer_limits(self, high=None, low=None):
        self._ensure_alive()

        self._high_water, self._low_water = add_flowcontrol_defaults(
            high, low, FLOW_CONTROL_HIGH_WATER)

        self._maybe_pause_protocol()

    def get_write_buffer_limits(self):
        return (self._low_water, self._high_water)

    def get_extra_info(self, name, default=None):
        if self._extra_info is not None and name in self._extra_info:
            return self._extra_info[name]
        if name == 'socket':
            return self._get_socket()
        if name == 'sockname':
            return self._get_socket().getsockname()
        if name == 'peername':
            try:
                return self._get_socket().getpeername()
            except socket_error:
                return default
        return default
