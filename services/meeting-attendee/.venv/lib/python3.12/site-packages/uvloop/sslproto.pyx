cdef _create_transport_context(server_side, server_hostname):
    if server_side:
        raise ValueError('Server side SSL needs a valid SSLContext')

    # Client side may pass ssl=True to use a default
    # context; in that case the sslcontext passed is None.
    # The default is secure for client connections.
    # Python 3.4+: use up-to-date strong settings.
    sslcontext = ssl_create_default_context()
    if not server_hostname:
        sslcontext.check_hostname = False
    return sslcontext


cdef class _SSLProtocolTransport:

    # TODO:
    # _sendfile_compatible = constants._SendfileMode.FALLBACK

    def __cinit__(self, Loop loop, ssl_protocol, context):
        self._loop = loop
        # SSLProtocol instance
        self._ssl_protocol = ssl_protocol
        self._closed = False
        if context is None:
            context = Context_CopyCurrent()
        self.context = context

    def get_extra_info(self, name, default=None):
        """Get optional transport information."""
        return self._ssl_protocol._get_extra_info(name, default)

    def set_protocol(self, protocol):
        self._ssl_protocol._set_app_protocol(protocol)

    def get_protocol(self):
        return self._ssl_protocol._app_protocol

    def is_closing(self):
        return self._closed

    def close(self):
        """Close the transport.

        Buffered data will be flushed asynchronously.  No more data
        will be received.  After all buffered data is flushed, the
        protocol's connection_lost() method will (eventually) called
        with None as its argument.
        """
        self._closed = True
        self._ssl_protocol._start_shutdown(self.context.copy())

    def __dealloc__(self):
        if not self._closed:
            self._closed = True
            warnings_warn(
                "unclosed transport <uvloop.loop._SSLProtocolTransport "
                "object>", ResourceWarning)

    def is_reading(self):
        return not self._ssl_protocol._app_reading_paused

    def pause_reading(self):
        """Pause the receiving end.

        No data will be passed to the protocol's data_received()
        method until resume_reading() is called.
        """
        self._ssl_protocol._pause_reading()

    def resume_reading(self):
        """Resume the receiving end.

        Data received will once again be passed to the protocol's
        data_received() method.
        """
        self._ssl_protocol._resume_reading(self.context.copy())

    def set_write_buffer_limits(self, high=None, low=None):
        """Set the high- and low-water limits for write flow control.

        These two values control when to call the protocol's
        pause_writing() and resume_writing() methods.  If specified,
        the low-water limit must be less than or equal to the
        high-water limit.  Neither value can be negative.

        The defaults are implementation-specific.  If only the
        high-water limit is given, the low-water limit defaults to an
        implementation-specific value less than or equal to the
        high-water limit.  Setting high to zero forces low to zero as
        well, and causes pause_writing() to be called whenever the
        buffer becomes non-empty.  Setting low to zero causes
        resume_writing() to be called only once the buffer is empty.
        Use of zero for either limit is generally sub-optimal as it
        reduces opportunities for doing I/O and computation
        concurrently.
        """
        self._ssl_protocol._set_write_buffer_limits(high, low)
        self._ssl_protocol._control_app_writing(self.context.copy())

    def get_write_buffer_limits(self):
        return (self._ssl_protocol._outgoing_low_water,
                self._ssl_protocol._outgoing_high_water)

    def get_write_buffer_size(self):
        """Return the current size of the write buffers."""
        return self._ssl_protocol._get_write_buffer_size()

    def set_read_buffer_limits(self, high=None, low=None):
        """Set the high- and low-water limits for read flow control.

        These two values control when to call the upstream transport's
        pause_reading() and resume_reading() methods.  If specified,
        the low-water limit must be less than or equal to the
        high-water limit.  Neither value can be negative.

        The defaults are implementation-specific.  If only the
        high-water limit is given, the low-water limit defaults to an
        implementation-specific value less than or equal to the
        high-water limit.  Setting high to zero forces low to zero as
        well, and causes pause_reading() to be called whenever the
        buffer becomes non-empty.  Setting low to zero causes
        resume_reading() to be called only once the buffer is empty.
        Use of zero for either limit is generally sub-optimal as it
        reduces opportunities for doing I/O and computation
        concurrently.
        """
        self._ssl_protocol._set_read_buffer_limits(high, low)
        self._ssl_protocol._control_ssl_reading()

    def get_read_buffer_limits(self):
        return (self._ssl_protocol._incoming_low_water,
                self._ssl_protocol._incoming_high_water)

    def get_read_buffer_size(self):
        """Return the current size of the read buffer."""
        return self._ssl_protocol._get_read_buffer_size()

    @property
    def _protocol_paused(self):
        # Required for sendfile fallback pause_writing/resume_writing logic
        return self._ssl_protocol._app_writing_paused

    def write(self, data):
        """Write some data bytes to the transport.

        This does not block; it buffers the data and arranges for it
        to be sent out asynchronously.
        """
        if not isinstance(data, (bytes, bytearray, memoryview)):
            raise TypeError(f"data: expecting a bytes-like instance, "
                            f"got {type(data).__name__}")
        if not data:
            return
        self._ssl_protocol._write_appdata((data,), self.context.copy())

    def writelines(self, list_of_data):
        """Write a list (or any iterable) of data bytes to the transport.

        The default implementation concatenates the arguments and
        calls write() on the result.
        """
        self._ssl_protocol._write_appdata(list_of_data, self.context.copy())

    def write_eof(self):
        """Close the write end after flushing buffered data.

        This raises :exc:`NotImplementedError` right now.
        """
        raise NotImplementedError

    def can_write_eof(self):
        """Return True if this transport supports write_eof(), False if not."""
        return False

    def abort(self):
        """Close the transport immediately.

        Buffered data will be lost.  No more data will be received.
        The protocol's connection_lost() method will (eventually) be
        called with None as its argument.
        """
        self._force_close(None)

    def _force_close(self, exc):
        self._closed = True
        self._ssl_protocol._abort(exc)

    def _test__append_write_backlog(self, data):
        # for test only
        self._ssl_protocol._write_backlog.append(data)
        self._ssl_protocol._write_buffer_size += len(data)


cdef class SSLProtocol:
    """SSL protocol.

    Implementation of SSL on top of a socket using incoming and outgoing
    buffers which are ssl.MemoryBIO objects.
    """

    def __cinit__(self, *args, **kwargs):
        self._ssl_buffer_len = SSL_READ_MAX_SIZE
        self._ssl_buffer = <char*>PyMem_RawMalloc(self._ssl_buffer_len)
        if not self._ssl_buffer:
            raise MemoryError()
        self._ssl_buffer_view = PyMemoryView_FromMemory(
            self._ssl_buffer, self._ssl_buffer_len, PyBUF_WRITE)

    def __dealloc__(self):
        self._ssl_buffer_view = None
        PyMem_RawFree(self._ssl_buffer)
        self._ssl_buffer = NULL
        self._ssl_buffer_len = 0

    def __init__(self, loop, app_protocol, sslcontext, waiter,
                 server_side=False, server_hostname=None,
                 call_connection_made=True,
                 ssl_handshake_timeout=None,
                 ssl_shutdown_timeout=None):
        if ssl_handshake_timeout is None:
            ssl_handshake_timeout = SSL_HANDSHAKE_TIMEOUT
        elif ssl_handshake_timeout <= 0:
            raise ValueError(
                f"ssl_handshake_timeout should be a positive number, "
                f"got {ssl_handshake_timeout}")
        if ssl_shutdown_timeout is None:
            ssl_shutdown_timeout = SSL_SHUTDOWN_TIMEOUT
        elif ssl_shutdown_timeout <= 0:
            raise ValueError(
                f"ssl_shutdown_timeout should be a positive number, "
                f"got {ssl_shutdown_timeout}")

        if not sslcontext:
            sslcontext = _create_transport_context(
                server_side, server_hostname)

        self._server_side = server_side
        if server_hostname and not server_side:
            self._server_hostname = server_hostname
        else:
            self._server_hostname = None
        self._sslcontext = sslcontext
        # SSL-specific extra info. More info are set when the handshake
        # completes.
        self._extra = dict(sslcontext=sslcontext)

        # App data write buffering
        self._write_backlog = col_deque()
        self._write_buffer_size = 0

        self._waiter = waiter
        self._loop = loop
        self._set_app_protocol(app_protocol)
        self._app_transport = None
        self._app_transport_created = False
        # transport, ex: SelectorSocketTransport
        self._transport = None
        self._ssl_handshake_timeout = ssl_handshake_timeout
        self._ssl_shutdown_timeout = ssl_shutdown_timeout
        # SSL and state machine
        self._sslobj = None
        self._incoming = ssl_MemoryBIO()
        self._incoming_write = self._incoming.write
        self._outgoing = ssl_MemoryBIO()
        self._outgoing_read = self._outgoing.read
        self._state = UNWRAPPED
        self._conn_lost = 0  # Set when connection_lost called
        if call_connection_made:
            self._app_state = STATE_INIT
        else:
            self._app_state = STATE_CON_MADE

        # Flow Control

        self._ssl_writing_paused = False

        self._app_reading_paused = False

        self._ssl_reading_paused = False
        self._incoming_high_water = 0
        self._incoming_low_water = 0
        self._set_read_buffer_limits()

        self._app_writing_paused = False
        self._outgoing_high_water = 0
        self._outgoing_low_water = 0
        self._set_write_buffer_limits()

    cdef _set_app_protocol(self, app_protocol):
        self._app_protocol = app_protocol
        if (hasattr(app_protocol, 'get_buffer') and
                not isinstance(app_protocol, aio_Protocol)):
            self._app_protocol_get_buffer = app_protocol.get_buffer
            self._app_protocol_buffer_updated = app_protocol.buffer_updated
            self._app_protocol_is_buffer = True
        else:
            self._app_protocol_is_buffer = False

    cdef _wakeup_waiter(self, exc=None):
        if self._waiter is None:
            return
        if not self._waiter.cancelled():
            if exc is not None:
                self._waiter.set_exception(exc)
            else:
                self._waiter.set_result(None)
        self._waiter = None

    def _get_app_transport(self, context=None):
        if self._app_transport is None:
            if self._app_transport_created:
                raise RuntimeError('Creating _SSLProtocolTransport twice')
            self._app_transport = _SSLProtocolTransport(self._loop, self,
                                                        context)
            self._app_transport_created = True
        return self._app_transport

    def connection_made(self, transport):
        """Called when the low-level connection is made.

        Start the SSL handshake.
        """
        self._transport = transport
        self._start_handshake()

    def connection_lost(self, exc):
        """Called when the low-level connection is lost or closed.

        The argument is an exception object or None (the latter
        meaning a regular EOF is received or the connection was
        aborted or closed).
        """
        self._write_backlog.clear()
        self._outgoing_read()
        self._conn_lost += 1

        # Just mark the app transport as closed so that its __dealloc__
        # doesn't complain.
        if self._app_transport is not None:
            self._app_transport._closed = True

        if self._state != DO_HANDSHAKE:
            if self._app_state == STATE_CON_MADE or \
                    self._app_state == STATE_EOF:
                self._app_state = STATE_CON_LOST
                self._loop.call_soon(self._app_protocol.connection_lost, exc)
        self._set_state(UNWRAPPED)
        self._transport = None
        self._app_transport = None
        self._app_protocol = None
        self._wakeup_waiter(exc)

        if self._shutdown_timeout_handle:
            self._shutdown_timeout_handle.cancel()
            self._shutdown_timeout_handle = None
        if self._handshake_timeout_handle:
            self._handshake_timeout_handle.cancel()
            self._handshake_timeout_handle = None

    def get_buffer(self, n):
        cdef size_t want = n
        if want > SSL_READ_MAX_SIZE:
            want = SSL_READ_MAX_SIZE
        if self._ssl_buffer_len < want:
            self._ssl_buffer = <char*>PyMem_RawRealloc(self._ssl_buffer, want)
            if not self._ssl_buffer:
                raise MemoryError()
            self._ssl_buffer_len = want
            self._ssl_buffer_view = PyMemoryView_FromMemory(
                self._ssl_buffer, want, PyBUF_WRITE)
        return self._ssl_buffer_view

    def buffer_updated(self, nbytes):
        self._incoming_write(PyMemoryView_FromMemory(
            self._ssl_buffer, nbytes, PyBUF_WRITE))

        if self._state == DO_HANDSHAKE:
            self._do_handshake()

        elif self._state == WRAPPED:
            self._do_read()

        elif self._state == FLUSHING:
            self._do_flush()

        elif self._state == SHUTDOWN:
            self._do_shutdown()

    def eof_received(self):
        """Called when the other end of the low-level stream
        is half-closed.

        If this returns a false value (including None), the transport
        will close itself.  If it returns a true value, closing the
        transport is up to the protocol.
        """
        try:
            if self._loop.get_debug():
                aio_logger.debug("%r received EOF", self)

            if self._state == DO_HANDSHAKE:
                self._on_handshake_complete(ConnectionResetError)

            elif self._state == WRAPPED or self._state == FLUSHING:
                # We treat a low-level EOF as a critical situation similar to a
                # broken connection - just send whatever is in the buffer and
                # close. No application level eof_received() is called -
                # because we don't want the user to think that this is a
                # graceful shutdown triggered by SSL "close_notify".
                self._set_state(SHUTDOWN)
                self._on_shutdown_complete(None)

            elif self._state == SHUTDOWN:
                self._on_shutdown_complete(None)

        except Exception:
            self._transport.close()
            raise

    cdef _get_extra_info(self, name, default=None):
        if name == 'uvloop.sslproto':
            return self
        elif name in self._extra:
            return self._extra[name]
        elif self._transport is not None:
            return self._transport.get_extra_info(name, default)
        else:
            return default

    cdef _set_state(self, SSLProtocolState new_state):
        cdef bint allowed = False

        if new_state == UNWRAPPED:
            allowed = True

        elif self._state == UNWRAPPED and new_state == DO_HANDSHAKE:
            allowed = True

        elif self._state == DO_HANDSHAKE and new_state == WRAPPED:
            allowed = True

        elif self._state == WRAPPED and new_state == FLUSHING:
            allowed = True

        elif self._state == WRAPPED and new_state == SHUTDOWN:
            allowed = True

        elif self._state == FLUSHING and new_state == SHUTDOWN:
            allowed = True

        if allowed:
            self._state = new_state

        else:
            raise RuntimeError(
                'cannot switch state from {} to {}'.format(
                    self._state, new_state))

    # Handshake flow

    cdef _start_handshake(self):
        if self._loop.get_debug():
            aio_logger.debug("%r starts SSL handshake", self)
            self._handshake_start_time = self._loop.time()
        else:
            self._handshake_start_time = None

        self._set_state(DO_HANDSHAKE)

        # start handshake timeout count down
        self._handshake_timeout_handle = \
            self._loop.call_later(self._ssl_handshake_timeout,
                                  lambda: self._check_handshake_timeout())

        try:
            self._sslobj = self._sslcontext.wrap_bio(
                self._incoming, self._outgoing,
                server_side=self._server_side,
                server_hostname=self._server_hostname)
            self._sslobj_read = self._sslobj.read
            self._sslobj_write = self._sslobj.write
        except Exception as ex:
            self._on_handshake_complete(ex)
        else:
            self._do_handshake()

    cdef _check_handshake_timeout(self):
        if self._state == DO_HANDSHAKE:
            msg = (
                f"SSL handshake is taking longer than "
                f"{self._ssl_handshake_timeout} seconds: "
                f"aborting the connection"
            )
            self._fatal_error(ConnectionAbortedError(msg))

    cdef _do_handshake(self):
        try:
            self._sslobj.do_handshake()
        except ssl_SSLAgainErrors as exc:
            self._process_outgoing()
        except ssl_SSLError as exc:
            self._on_handshake_complete(exc)
        else:
            self._on_handshake_complete(None)

    cdef _on_handshake_complete(self, handshake_exc):
        if self._handshake_timeout_handle is not None:
            self._handshake_timeout_handle.cancel()
            self._handshake_timeout_handle = None

        sslobj = self._sslobj
        try:
            if handshake_exc is None:
                self._set_state(WRAPPED)
            else:
                raise handshake_exc

            peercert = sslobj.getpeercert()
        except Exception as exc:
            self._set_state(UNWRAPPED)
            if isinstance(exc, ssl_CertificateError):
                msg = 'SSL handshake failed on verifying the certificate'
            else:
                msg = 'SSL handshake failed'
            self._fatal_error(exc, msg)
            self._wakeup_waiter(exc)
            return

        if self._loop.get_debug():
            dt = self._loop.time() - self._handshake_start_time
            aio_logger.debug("%r: SSL handshake took %.1f ms", self, dt * 1e3)

        # Add extra info that becomes available after handshake.
        self._extra.update(peercert=peercert,
                           cipher=sslobj.cipher(),
                           compression=sslobj.compression(),
                           ssl_object=sslobj)
        if self._app_state == STATE_INIT:
            self._app_state = STATE_CON_MADE
            self._app_protocol.connection_made(self._get_app_transport())
        self._wakeup_waiter()

        # We should wakeup user code before sending the first data below. In
        # case of `start_tls()`, the user can only get the SSLTransport in the
        # wakeup callback, because `connection_made()` is not called again.
        # We should schedule the first data later than the wakeup callback so
        # that the user get a chance to e.g. check ALPN with the transport
        # before having to handle the first data.
        self._loop._call_soon_handle(
            new_MethodHandle(self._loop,
                             "SSLProtocol._do_read",
                             <method_t> self._do_read,
                             None,  # current context is good
                             self))

    # Shutdown flow

    cdef _start_shutdown(self, object context=None):
        if self._state in (FLUSHING, SHUTDOWN, UNWRAPPED):
            return
        # we don't need the context for _abort or the timeout, because
        # TCP transport._force_close() should be able to call
        # connection_lost() in the right context
        if self._app_transport is not None:
            self._app_transport._closed = True
        if self._state == DO_HANDSHAKE:
            self._abort(None)
        else:
            self._set_state(FLUSHING)
            self._shutdown_timeout_handle = \
                self._loop.call_later(self._ssl_shutdown_timeout,
                                      lambda: self._check_shutdown_timeout())
            self._do_flush(context)

    cdef _check_shutdown_timeout(self):
        if self._state in (FLUSHING, SHUTDOWN):
            self._transport._force_close(
                aio_TimeoutError('SSL shutdown timed out'))

    cdef _do_read_into_void(self, object context):
        """Consume and discard incoming application data.

        If close_notify is received for the first time, call eof_received.
        """
        cdef:
            bint close_notify = False
        try:
            while True:
                if not self._sslobj_read(SSL_READ_MAX_SIZE):
                    close_notify = True
                    break
        except ssl_SSLAgainErrors as exc:
            pass
        except ssl_SSLZeroReturnError:
            close_notify = True
        if close_notify:
            self._call_eof_received(context)

    cdef _do_flush(self, object context=None):
        """Flush the write backlog, discarding new data received.

        We don't send close_notify in FLUSHING because we still want to send
        the remaining data over SSL, even if we received a close_notify. Also,
        no application-level resume_writing() or pause_writing() will be called
        in FLUSHING, as we could fully manage the flow control internally.
        """
        try:
            self._do_read_into_void(context)
            self._do_write()
            self._process_outgoing()
            self._control_ssl_reading()
        except Exception as ex:
            self._on_shutdown_complete(ex)
        else:
            if not self._get_write_buffer_size():
                self._set_state(SHUTDOWN)
                self._do_shutdown(context)

    cdef _do_shutdown(self, object context=None):
        """Send close_notify and wait for the same from the peer."""
        try:
            # we must skip all application data (if any) before unwrap
            self._do_read_into_void(context)
            try:
                self._sslobj.unwrap()
            except ssl_SSLAgainErrors as exc:
                self._process_outgoing()
            else:
                self._process_outgoing()
                if not self._get_write_buffer_size():
                    self._on_shutdown_complete(None)
        except Exception as ex:
            self._on_shutdown_complete(ex)

    cdef _on_shutdown_complete(self, shutdown_exc):
        if self._shutdown_timeout_handle is not None:
            self._shutdown_timeout_handle.cancel()
            self._shutdown_timeout_handle = None

        # we don't need the context here because TCP transport.close() should
        # be able to call connection_made() in the right context
        if shutdown_exc:
            self._fatal_error(shutdown_exc, 'Error occurred during shutdown')
        else:
            self._transport.close()

    cdef _abort(self, exc):
        self._set_state(UNWRAPPED)
        if self._transport is not None:
            self._transport._force_close(exc)

    # Outgoing flow

    cdef _write_appdata(self, list_of_data, object context):
        if self._state in (FLUSHING, SHUTDOWN, UNWRAPPED):
            if self._conn_lost >= LOG_THRESHOLD_FOR_CONNLOST_WRITES:
                aio_logger.warning('SSL connection is closed')
            self._conn_lost += 1
            return

        for data in list_of_data:
            self._write_backlog.append(data)
            self._write_buffer_size += len(data)

        try:
            if self._state == WRAPPED:
                self._do_write()
                self._process_outgoing()
                self._control_app_writing(context)

        except Exception as ex:
            self._fatal_error(ex, 'Fatal error on SSL protocol')

    cdef _do_write(self):
        """Do SSL write, consumes write backlog and fills outgoing BIO."""
        cdef size_t data_len, count
        try:
            while self._write_backlog:
                data = self._write_backlog[0]
                count = self._sslobj_write(data)
                data_len = len(data)
                if count < data_len:
                    if not PyMemoryView_Check(data):
                        data = PyMemoryView_FromObject(data)
                    self._write_backlog[0] = data[count:]
                    self._write_buffer_size -= count
                else:
                    del self._write_backlog[0]
                    self._write_buffer_size -= data_len
        except ssl_SSLAgainErrors as exc:
            pass

    cdef _process_outgoing(self):
        """Send bytes from the outgoing BIO."""
        if not self._ssl_writing_paused:
            data = self._outgoing_read()
            if len(data):
                self._transport.write(data)

    # Incoming flow

    cdef _do_read(self):
        if self._state != WRAPPED:
            return
        try:
            if not self._app_reading_paused:
                if self._app_protocol_is_buffer:
                    self._do_read__buffered()
                else:
                    self._do_read__copied()
                if self._write_backlog:
                    self._do_write()
                self._process_outgoing()
                self._control_app_writing()
            self._control_ssl_reading()
        except Exception as ex:
            self._fatal_error(ex, 'Fatal error on SSL protocol')

    cdef _do_read__buffered(self):
        cdef:
            Py_buffer pybuf
            bint pybuf_inited = False
            size_t wants, offset = 0
            int count = 1
            object buf

        buf = self._app_protocol_get_buffer(self._get_read_buffer_size())
        wants = len(buf)

        try:
            count = self._sslobj_read(wants, buf)

            if count > 0:
                offset = count
                if offset < wants:
                    PyObject_GetBuffer(buf, &pybuf, PyBUF_WRITABLE)
                    pybuf_inited = True
                while offset < wants:
                    buf = PyMemoryView_FromMemory(
                        (<char*>pybuf.buf) + offset,
                        wants - offset,
                        PyBUF_WRITE)
                    count = self._sslobj_read(wants - offset, buf)
                    if count > 0:
                        offset += count
                    else:
                        break
                else:
                    self._loop._call_soon_handle(
                        new_MethodHandle(self._loop,
                                         "SSLProtocol._do_read",
                                         <method_t>self._do_read,
                                         None,  # current context is good
                                         self))
        except ssl_SSLAgainErrors as exc:
            pass
        finally:
            if pybuf_inited:
                PyBuffer_Release(&pybuf)
        if offset > 0:
            self._app_protocol_buffer_updated(offset)
        if not count:
            # close_notify
            self._call_eof_received()
            self._start_shutdown()

    cdef _do_read__copied(self):
        cdef:
            list data
            bytes first, chunk = b'1'
            bint zero = True, one = False

        try:
            while True:
                chunk = self._sslobj_read(SSL_READ_MAX_SIZE)
                if not chunk:
                    break
                if zero:
                    zero = False
                    one = True
                    first = chunk
                elif one:
                    one = False
                    data = [first, chunk]
                else:
                    data.append(chunk)
        except ssl_SSLAgainErrors as exc:
            pass
        if one:
            self._app_protocol.data_received(first)
        elif not zero:
            self._app_protocol.data_received(b''.join(data))
        if not chunk:
            # close_notify
            self._call_eof_received()
            self._start_shutdown()

    cdef _call_eof_received(self, object context=None):
        if self._app_state == STATE_CON_MADE:
            self._app_state = STATE_EOF
            try:
                if context is None:
                    # If the caller didn't provide a context, we assume the
                    # caller is already in the right context, which is usually
                    # inside the upstream callbacks like buffer_updated()
                    keep_open = self._app_protocol.eof_received()
                else:
                    keep_open = run_in_context(
                        context, self._app_protocol.eof_received,
                    )
            except (KeyboardInterrupt, SystemExit):
                raise
            except BaseException as ex:
                self._fatal_error(ex, 'Error calling eof_received()')
            else:
                if keep_open:
                    aio_logger.warning('returning true from eof_received() '
                                       'has no effect when using ssl')

    # Flow control for writes from APP socket

    cdef _control_app_writing(self, object context=None):
        cdef size_t size = self._get_write_buffer_size()
        if size >= self._outgoing_high_water and not self._app_writing_paused:
            self._app_writing_paused = True
            try:
                if context is None:
                    # If the caller didn't provide a context, we assume the
                    # caller is already in the right context, which is usually
                    # inside the upstream callbacks like buffer_updated()
                    self._app_protocol.pause_writing()
                else:
                    run_in_context(context, self._app_protocol.pause_writing)
            except (KeyboardInterrupt, SystemExit):
                raise
            except BaseException as exc:
                self._loop.call_exception_handler({
                    'message': 'protocol.pause_writing() failed',
                    'exception': exc,
                    'transport': self._app_transport,
                    'protocol': self,
                })
        elif size <= self._outgoing_low_water and self._app_writing_paused:
            self._app_writing_paused = False
            try:
                if context is None:
                    # If the caller didn't provide a context, we assume the
                    # caller is already in the right context, which is usually
                    # inside the upstream callbacks like resume_writing()
                    self._app_protocol.resume_writing()
                else:
                    run_in_context(context, self._app_protocol.resume_writing)
            except (KeyboardInterrupt, SystemExit):
                raise
            except BaseException as exc:
                self._loop.call_exception_handler({
                    'message': 'protocol.resume_writing() failed',
                    'exception': exc,
                    'transport': self._app_transport,
                    'protocol': self,
                })

    cdef size_t _get_write_buffer_size(self):
        return self._outgoing.pending + self._write_buffer_size

    cdef _set_write_buffer_limits(self, high=None, low=None):
        high, low = add_flowcontrol_defaults(
            high, low, FLOW_CONTROL_HIGH_WATER_SSL_WRITE)
        self._outgoing_high_water = high
        self._outgoing_low_water = low

    # Flow control for reads to APP socket

    cdef _pause_reading(self):
        self._app_reading_paused = True

    cdef _resume_reading(self, object context):
        if self._app_reading_paused:
            self._app_reading_paused = False
            if self._state == WRAPPED:
                self._loop._call_soon_handle(
                    new_MethodHandle(self._loop,
                                     "SSLProtocol._do_read",
                                     <method_t>self._do_read,
                                     context,
                                     self))

    # Flow control for reads from SSL socket

    cdef _control_ssl_reading(self):
        cdef size_t size = self._get_read_buffer_size()
        if size >= self._incoming_high_water and not self._ssl_reading_paused:
            self._ssl_reading_paused = True
            self._transport.pause_reading()
        elif size <= self._incoming_low_water and self._ssl_reading_paused:
            self._ssl_reading_paused = False
            self._transport.resume_reading()

    cdef _set_read_buffer_limits(self, high=None, low=None):
        high, low = add_flowcontrol_defaults(
            high, low, FLOW_CONTROL_HIGH_WATER_SSL_READ)
        self._incoming_high_water = high
        self._incoming_low_water = low

    cdef size_t _get_read_buffer_size(self):
        return self._incoming.pending

    # Flow control for writes to SSL socket

    def pause_writing(self):
        """Called when the low-level transport's buffer goes over
        the high-water mark.
        """
        assert not self._ssl_writing_paused
        self._ssl_writing_paused = True

    def resume_writing(self):
        """Called when the low-level transport's buffer drains below
        the low-water mark.
        """
        assert self._ssl_writing_paused
        self._ssl_writing_paused = False

        if self._state == WRAPPED:
            self._process_outgoing()
            self._control_app_writing()

        elif self._state == FLUSHING:
            self._do_flush()

        elif self._state == SHUTDOWN:
            self._do_shutdown()

    cdef _fatal_error(self, exc, message='Fatal error on transport'):
        if self._app_transport:
            self._app_transport._force_close(exc)
        elif self._transport:
            self._transport._force_close(exc)

        if isinstance(exc, OSError):
            if self._loop.get_debug():
                aio_logger.debug("%r: %s", self, message, exc_info=True)
        elif not isinstance(exc, aio_CancelledError):
            self._loop.call_exception_handler({
                'message': message,
                'exception': exc,
                'transport': self._transport,
                'protocol': self,
            })
