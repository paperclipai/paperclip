cdef enum:
    __PREALLOCED_BUFS = 4


@cython.no_gc_clear
@cython.freelist(DEFAULT_FREELIST_SIZE)
cdef class _StreamWriteContext:
    # used to hold additional write request information for uv_write

    cdef:
        uv.uv_write_t   req

        list            buffers

        uv.uv_buf_t     uv_bufs_sml[__PREALLOCED_BUFS]
        Py_buffer       py_bufs_sml[__PREALLOCED_BUFS]
        bint            py_bufs_sml_inuse

        uv.uv_buf_t*    uv_bufs
        Py_buffer*      py_bufs
        size_t          py_bufs_len

        uv.uv_buf_t*    uv_bufs_start
        size_t          uv_bufs_len

        UVStream        stream

        bint            closed

    cdef free_bufs(self):
        cdef size_t i

        if self.uv_bufs is not NULL:
            PyMem_RawFree(self.uv_bufs)
            self.uv_bufs = NULL
            if UVLOOP_DEBUG:
                if self.py_bufs_sml_inuse:
                    raise RuntimeError(
                        '_StreamWriteContext.close: uv_bufs != NULL and '
                        'py_bufs_sml_inuse is True')

        if self.py_bufs is not NULL:
            for i from 0 <= i < self.py_bufs_len:
                PyBuffer_Release(&self.py_bufs[i])
            PyMem_RawFree(self.py_bufs)
            self.py_bufs = NULL
            if UVLOOP_DEBUG:
                if self.py_bufs_sml_inuse:
                    raise RuntimeError(
                        '_StreamWriteContext.close: py_bufs != NULL and '
                        'py_bufs_sml_inuse is True')

        if self.py_bufs_sml_inuse:
            for i from 0 <= i < self.py_bufs_len:
                PyBuffer_Release(&self.py_bufs_sml[i])
            self.py_bufs_sml_inuse = 0

        self.py_bufs_len = 0
        self.buffers = None

    cdef close(self):
        if self.closed:
            return
        self.closed = 1
        self.free_bufs()
        Py_DECREF(self)

    cdef advance_uv_buf(self, size_t sent):
        # Advance the pointer to first uv_buf and the
        # pointer to first byte in that buffer.
        #
        # We do this after a "uv_try_write" call, which
        # sometimes sends only a portion of data.
        # We then call "advance_uv_buf" on the write
        # context, and reuse it in a "uv_write" call.

        cdef:
            uv.uv_buf_t* buf
            size_t idx

        for idx from 0 <= idx < self.uv_bufs_len:
            buf = &self.uv_bufs_start[idx]
            if buf.len > sent:
                buf.len -= sent
                buf.base = buf.base + sent
                self.uv_bufs_start = buf
                self.uv_bufs_len -= idx
                return
            else:
                sent -= self.uv_bufs_start[idx].len

            if UVLOOP_DEBUG:
                if sent < 0:
                    raise RuntimeError('fatal: sent < 0 in advance_uv_buf')

        raise RuntimeError('fatal: Could not advance _StreamWriteContext')

    @staticmethod
    cdef _StreamWriteContext new(UVStream stream, list buffers):
        cdef:
            _StreamWriteContext ctx
            int uv_bufs_idx = 0
            size_t py_bufs_len = 0
            int i

            Py_buffer* p_pybufs
            uv.uv_buf_t* p_uvbufs

        ctx = _StreamWriteContext.__new__(_StreamWriteContext)
        ctx.stream = None
        ctx.closed = 1
        ctx.py_bufs_len = 0
        ctx.py_bufs_sml_inuse = 0
        ctx.uv_bufs = NULL
        ctx.py_bufs = NULL
        ctx.buffers = buffers
        ctx.stream = stream

        if len(buffers) <= __PREALLOCED_BUFS:
            # We've got a small number of buffers to write, don't
            # need to use malloc.
            ctx.py_bufs_sml_inuse = 1
            p_pybufs = <Py_buffer*>&ctx.py_bufs_sml
            p_uvbufs = <uv.uv_buf_t*>&ctx.uv_bufs_sml

        else:
            for buf in buffers:
                if UVLOOP_DEBUG:
                    if not isinstance(buf, (bytes, bytearray, memoryview)):
                        raise RuntimeError(
                            'invalid data in writebuf: an instance of '
                            'bytes, bytearray or memoryview was expected, '
                            'got {}'.format(type(buf)))

                if not PyBytes_CheckExact(buf):
                    py_bufs_len += 1

            if py_bufs_len > 0:
                ctx.py_bufs = <Py_buffer*>PyMem_RawMalloc(
                    py_bufs_len * sizeof(Py_buffer))
                if ctx.py_bufs is NULL:
                    raise MemoryError()

            ctx.uv_bufs = <uv.uv_buf_t*>PyMem_RawMalloc(
                len(buffers) * sizeof(uv.uv_buf_t))
            if ctx.uv_bufs is NULL:
                raise MemoryError()

            p_pybufs = ctx.py_bufs
            p_uvbufs = ctx.uv_bufs

        py_bufs_len = 0
        for buf in buffers:
            if PyBytes_CheckExact(buf):
                # We can only use this hack for bytes since it's
                # immutable.  For everything else it is only safe to
                # use buffer protocol.
                p_uvbufs[uv_bufs_idx].base = PyBytes_AS_STRING(buf)
                p_uvbufs[uv_bufs_idx].len = Py_SIZE(buf)

            else:
                try:
                    PyObject_GetBuffer(
                        buf, &p_pybufs[py_bufs_len], PyBUF_SIMPLE)
                except Exception:
                    # This shouldn't ever happen, as `UVStream._buffer_write`
                    # casts non-bytes objects to `memoryviews`.
                    ctx.py_bufs_len = py_bufs_len
                    ctx.free_bufs()
                    raise

                p_uvbufs[uv_bufs_idx].base = <char*>p_pybufs[py_bufs_len].buf
                p_uvbufs[uv_bufs_idx].len = p_pybufs[py_bufs_len].len

                py_bufs_len += 1

            uv_bufs_idx += 1

        ctx.uv_bufs_start = p_uvbufs
        ctx.uv_bufs_len = uv_bufs_idx

        ctx.py_bufs_len = py_bufs_len
        ctx.req.data = <void*> ctx

        if UVLOOP_DEBUG:
            stream._loop._debug_stream_write_ctx_total += 1
            stream._loop._debug_stream_write_ctx_cnt += 1

        # Do incref after everything else is done.
        # Under no circumstances we want `ctx` to be GCed while
        # libuv is still working with `ctx.uv_bufs`.
        Py_INCREF(ctx)
        ctx.closed = 0
        return ctx

    def __dealloc__(self):
        if not self.closed:
            # Because we do an INCREF in _StreamWriteContext.new,
            # __dealloc__ shouldn't ever happen with `self.closed == 1`
            raise RuntimeError(
                'open _StreamWriteContext is being deallocated')

        if UVLOOP_DEBUG:
            if self.stream is not None:
                self.stream._loop._debug_stream_write_ctx_cnt -= 1
                self.stream = None


@cython.no_gc_clear
cdef class UVStream(UVBaseTransport):

    def __cinit__(self):
        self.__shutting_down = 0
        self.__reading = 0
        self.__read_error_close = 0
        self.__buffered = 0
        self._eof = 0
        self._buffer = []
        self._buffer_size = 0

        self._protocol_get_buffer = None
        self._protocol_buffer_updated = None

        self._read_pybuf_acquired = False

    cdef _set_protocol(self, object protocol):
        if protocol is None:
            raise TypeError('protocol is required')

        UVBaseTransport._set_protocol(self, protocol)

        if (hasattr(protocol, 'get_buffer') and
                not isinstance(protocol, aio_Protocol)):
            try:
                self._protocol_get_buffer = protocol.get_buffer
                self._protocol_buffer_updated = protocol.buffer_updated
                self.__buffered = 1
            except AttributeError:
                pass
        else:
            self.__buffered = 0

    cdef _clear_protocol(self):
        UVBaseTransport._clear_protocol(self)
        self._protocol_get_buffer = None
        self._protocol_buffer_updated = None
        self.__buffered = 0

    cdef inline _shutdown(self):
        cdef int err

        if self.__shutting_down:
            return
        self.__shutting_down = 1

        self._ensure_alive()

        self._shutdown_req.data = <void*> self
        err = uv.uv_shutdown(&self._shutdown_req,
                             <uv.uv_stream_t*> self._handle,
                             __uv_stream_on_shutdown)
        if err < 0:
            exc = convert_error(err)
            self._fatal_error(exc, True)
            return

    cdef inline _accept(self, UVStream server):
        cdef int err
        self._ensure_alive()

        err = uv.uv_accept(<uv.uv_stream_t*>server._handle,
                           <uv.uv_stream_t*>self._handle)
        if err < 0:
            exc = convert_error(err)
            self._fatal_error(exc, True)
            return

        self._on_accept()

    cdef inline _close_on_read_error(self):
        self.__read_error_close = 1

    cdef bint _is_reading(self):
        return self.__reading

    cdef _start_reading(self):
        cdef int err

        if self._closing:
            return

        self._ensure_alive()

        if self.__reading:
            return

        if self.__buffered:
            err = uv.uv_read_start(<uv.uv_stream_t*>self._handle,
                                   __uv_stream_buffered_alloc,
                                   __uv_stream_buffered_on_read)
        else:
            err = uv.uv_read_start(<uv.uv_stream_t*>self._handle,
                                   __loop_alloc_buffer,
                                   __uv_stream_on_read)
        if err < 0:
            exc = convert_error(err)
            self._fatal_error(exc, True)
            return
        else:
            # UVStream must live until the read callback is called
            self.__reading_started()

    cdef inline __reading_started(self):
        if self.__reading:
            return
        self.__reading = 1
        Py_INCREF(self)

    cdef inline __reading_stopped(self):
        if not self.__reading:
            return
        self.__reading = 0
        Py_DECREF(self)

    cdef _stop_reading(self):
        cdef int err

        if not self.__reading:
            return

        self._ensure_alive()

        # From libuv docs:
        #    This function is idempotent and may be safely
        #    called on a stopped stream.
        err = uv.uv_read_stop(<uv.uv_stream_t*>self._handle)
        if err < 0:
            exc = convert_error(err)
            self._fatal_error(exc, True)
            return
        else:
            self.__reading_stopped()

    cdef inline _try_write(self, object data):
        cdef:
            ssize_t written
            bint used_buf = 0
            Py_buffer py_buf
            void* buf
            size_t blen
            int saved_errno
            int fd

        if (<uv.uv_stream_t*>self._handle).write_queue_size != 0:
            raise RuntimeError(
                'UVStream._try_write called with data in uv buffers')

        if PyBytes_CheckExact(data):
            # We can only use this hack for bytes since it's
            # immutable.  For everything else it is only safe to
            # use buffer protocol.
            buf = <void*>PyBytes_AS_STRING(data)
            blen = Py_SIZE(data)
        else:
            PyObject_GetBuffer(data, &py_buf, PyBUF_SIMPLE)
            used_buf = 1
            buf = py_buf.buf
            blen = py_buf.len

        if blen == 0:
            # Empty data, do nothing.
            return 0

        fd = self._fileno()
        # Use `unistd.h/write` directly, it's faster than
        # uv_try_write -- less layers of code.  The error
        # checking logic is copied from libuv.
        written = system.write(fd, buf, blen)
        while written == -1 and (
                errno.errno == errno.EINTR or
                (system.PLATFORM_IS_APPLE and
                    errno.errno == errno.EPROTOTYPE)):
            # From libuv code (unix/stream.c):
            #   Due to a possible kernel bug at least in OS X 10.10 "Yosemite",
            #   EPROTOTYPE can be returned while trying to write to a socket
            #   that is shutting down. If we retry the write, we should get
            #   the expected EPIPE instead.
            written = system.write(fd, buf, blen)
        saved_errno = errno.errno

        if used_buf:
            PyBuffer_Release(&py_buf)

        if written < 0:
            if saved_errno == errno.EAGAIN or \
                    saved_errno == system.EWOULDBLOCK:
                return -1
            else:
                exc = convert_error(-saved_errno)
                self._fatal_error(exc, True)
                return

        if UVLOOP_DEBUG:
            self._loop._debug_stream_write_tries += 1

        if <size_t>written == blen:
            return 0

        return written

    cdef inline _buffer_write(self, object data):
        cdef int dlen

        if not PyBytes_CheckExact(data):
            data = memoryview(data).cast('b')

        dlen = len(data)
        if not dlen:
            return

        self._buffer_size += dlen
        self._buffer.append(data)

    cdef inline _initiate_write(self):
        if (not self._protocol_paused and
                (<uv.uv_stream_t*>self._handle).write_queue_size == 0 and
                self._buffer_size > self._high_water):
            # Fast-path.  If:
            #   - the protocol isn't yet paused,
            #   - there is no data in libuv buffers for this stream,
            #   - the protocol will be paused if we continue to buffer data
            #
            # Then:
            #   - Try to write all buffered data right now.
            all_sent = self._exec_write()
            if UVLOOP_DEBUG:
                if self._buffer_size != 0 or self._buffer != []:
                    raise RuntimeError(
                        '_buffer_size is not 0 after a successful _exec_write')

            # There is no need to call `_queue_write` anymore,
            # as `uv_write` should be called already.

            if not all_sent:
                # If not all of the data was sent successfully,
                # we might need to pause the protocol.
                self._maybe_pause_protocol()

        elif self._buffer_size > 0:
            self._maybe_pause_protocol()
            self._loop._queue_write(self)

    cdef inline _exec_write(self):
        cdef:
            int err
            int buf_len
            _StreamWriteContext ctx = None

        if self._closed:
            # If the handle is closed, just return, it's too
            # late to do anything.
            return

        buf_len = len(self._buffer)
        if not buf_len:
            return

        if (<uv.uv_stream_t*>self._handle).write_queue_size == 0:
            # libuv internal write buffers for this stream are empty.
            if buf_len == 1:
                # If we only have one piece of data to send, let's
                # use our fast implementation of try_write.
                data = self._buffer[0]
                sent = self._try_write(data)

                if sent is None:
                    # A `self._fatal_error` was called.
                    # It might not raise an exception under some
                    # conditions.
                    self._buffer_size = 0
                    self._buffer.clear()
                    if not self._closing:
                        # This should never happen.
                        raise RuntimeError(
                            'stream is open after UVStream._try_write '
                            'returned None')
                    return

                if sent == 0:
                    # All data was successfully written.
                    self._buffer_size = 0
                    self._buffer.clear()
                    # on_write will call "maybe_resume_protocol".
                    self._on_write()
                    return True

                if sent > 0:
                    if UVLOOP_DEBUG:
                        if sent == len(data):
                            raise RuntimeError(
                                '_try_write sent all data and returned '
                                'non-zero')

                    if PyBytes_CheckExact(data):
                        # Cast bytes to memoryview to avoid copying
                        # data that wasn't sent.
                        data = memoryview(data)
                    data = data[sent:]

                    self._buffer_size -= sent
                    self._buffer[0] = data

                # At this point it's either data was sent partially,
                # or an EAGAIN has happened.

            else:
                ctx = _StreamWriteContext.new(self, self._buffer)

                err = uv.uv_try_write(<uv.uv_stream_t*>self._handle,
                                      ctx.uv_bufs_start,
                                      ctx.uv_bufs_len)

                if err > 0:
                    # Some data was successfully sent.

                    if <size_t>err == self._buffer_size:
                        # Everything was sent.
                        ctx.close()
                        self._buffer.clear()
                        self._buffer_size = 0
                        # on_write will call "maybe_resume_protocol".
                        self._on_write()
                        return True

                    try:
                        # Advance pointers to uv_bufs in `ctx`,
                        # we will reuse it soon for a uv_write
                        # call.
                        ctx.advance_uv_buf(<ssize_t>err)
                    except Exception as ex:  # This should never happen.
                        # Let's try to close the `ctx` anyways.
                        ctx.close()
                        self._fatal_error(ex, True)
                        self._buffer.clear()
                        self._buffer_size = 0
                        return

                elif err != uv.UV_EAGAIN:
                    ctx.close()
                    exc = convert_error(err)
                    self._fatal_error(exc, True)
                    self._buffer.clear()
                    self._buffer_size = 0
                    return

                # fall through

        if ctx is None:
            ctx = _StreamWriteContext.new(self, self._buffer)

        err = uv.uv_write(&ctx.req,
                          <uv.uv_stream_t*>self._handle,
                          ctx.uv_bufs_start,
                          ctx.uv_bufs_len,
                          __uv_stream_on_write)

        self._buffer_size = 0
        # Can't use `_buffer.clear()` here: `ctx` holds a reference to
        # the `_buffer`.
        self._buffer = []

        if err < 0:
            # close write context
            ctx.close()

            exc = convert_error(err)
            self._fatal_error(exc, True)
            return

        self._maybe_resume_protocol()

    cdef size_t _get_write_buffer_size(self):
        if self._handle is NULL:
            return 0
        return ((<uv.uv_stream_t*>self._handle).write_queue_size +
                self._buffer_size)

    cdef _close(self):
        try:
            if self._read_pybuf_acquired:
                # Should never happen. libuv always calls uv_alloc/uv_read
                # in pairs.
                self._loop.call_exception_handler({
                    'transport': self,
                    'message': 'XXX: an allocated buffer in transport._close()'
                })
                self._read_pybuf_acquired = 0
                PyBuffer_Release(&self._read_pybuf)

            self._stop_reading()
        finally:
            UVSocketHandle._close(<UVHandle>self)

    cdef inline _on_accept(self):
        # Ultimately called by __uv_stream_on_listen.
        self._init_protocol()

    cdef inline _on_eof(self):
        # Any exception raised here will be caught in
        # __uv_stream_on_read.

        try:
            meth = self._protocol.eof_received
        except AttributeError:
            keep_open = False
        else:
            keep_open = run_in_context(self.context, meth)

        if keep_open:
            # We're keeping the connection open so the
            # protocol can write more, but we still can't
            # receive more, so remove the reader callback.
            self._stop_reading()
        else:
            self.close()

    cdef inline _on_write(self):
        self._maybe_resume_protocol()
        if not self._get_write_buffer_size():
            if self._closing:
                self._schedule_call_connection_lost(None)
            elif self._eof:
                self._shutdown()

    cdef inline _init(self, Loop loop, object protocol, Server server,
                      object waiter, object context):
        self.context = context
        self._set_protocol(protocol)
        self._start_init(loop)

        if server is not None:
            self._set_server(server)

        if waiter is not None:
            self._set_waiter(waiter)

    cdef inline _on_connect(self, object exc):
        # Called from __tcp_connect_callback (tcp.pyx) and
        # __pipe_connect_callback (pipe.pyx).
        if exc is None:
            self._init_protocol()
        else:
            if self._waiter is None:
                self._fatal_error(exc, False, "connect failed")
            elif self._waiter.cancelled():
                # Connect call was cancelled; just close the transport
                # silently.
                self._close()
            elif self._waiter.done():
                self._fatal_error(exc, False, "connect failed")
            else:
                self._waiter.set_exception(exc)
                self._close()

    # === Public API ===

    def __repr__(self):
        return '<{} closed={} reading={} {:#x}>'.format(
            self.__class__.__name__,
            self._closed,
            self.__reading,
            id(self))

    def write(self, object buf):
        self._ensure_alive()

        if self._eof:
            raise RuntimeError('Cannot call write() after write_eof()')
        if not buf:
            return
        if self._conn_lost:
            self._conn_lost += 1
            return
        self._buffer_write(buf)
        self._initiate_write()

    def writelines(self, bufs):
        self._ensure_alive()

        if self._eof:
            raise RuntimeError('Cannot call writelines() after write_eof()')
        if self._conn_lost:
            self._conn_lost += 1
            return
        for buf in bufs:
            self._buffer_write(buf)
        self._initiate_write()

    def write_eof(self):
        self._ensure_alive()

        if self._eof:
            return

        self._eof = 1
        if not self._get_write_buffer_size():
            self._shutdown()

    def can_write_eof(self):
        return True

    def is_reading(self):
        return self._is_reading()

    def pause_reading(self):
        if self._closing or not self._is_reading():
            return
        self._stop_reading()

    def resume_reading(self):
        if self._is_reading() or self._closing:
            return
        self._start_reading()


cdef void __uv_stream_on_shutdown(uv.uv_shutdown_t* req,
                                  int status) noexcept with gil:

    # callback for uv_shutdown

    if req.data is NULL:
        aio_logger.error(
            'UVStream.shutdown callback called with NULL req.data, status=%r',
            status)
        return

    cdef UVStream stream = <UVStream> req.data

    if status < 0 and status != uv.UV_ECANCELED:
        # From libuv source code:
        #     The ECANCELED error code is a lie, the shutdown(2) syscall is a
        #     fait accompli at this point. Maybe we should revisit this in
        #     v0.11.  A possible reason for leaving it unchanged is that it
        #     informs the callee that the handle has been destroyed.

        if UVLOOP_DEBUG:
            stream._loop._debug_stream_shutdown_errors_total += 1

        exc = convert_error(status)
        stream._fatal_error(
            exc, False, "error status in uv_stream_t.shutdown callback")
        return


cdef inline bint __uv_stream_on_read_common(
    UVStream sc,
    Loop loop,
    ssize_t nread,
):
    if sc._closed:
        # The stream was closed, there is no reason to
        # do any work now.
        sc.__reading_stopped()  # Just in case.
        return True

    if nread == uv.UV_EOF:
        # From libuv docs:
        #     The callee is responsible for stopping closing the stream
        #     when an error happens by calling uv_read_stop() or uv_close().
        #     Trying to read from the stream again is undefined.
        try:
            if UVLOOP_DEBUG:
                loop._debug_stream_read_eof_total += 1

            sc._stop_reading()
            sc._on_eof()
        except BaseException as ex:
            if UVLOOP_DEBUG:
                loop._debug_stream_read_eof_cb_errors_total += 1

            sc._fatal_error(ex, False)
        finally:
            return True

    if nread == 0:
        # From libuv docs:
        #     nread might be 0, which does not indicate an error or EOF.
        #     This is equivalent to EAGAIN or EWOULDBLOCK under read(2).
        return True

    if nread < 0:
        # From libuv docs:
        #     The callee is responsible for stopping closing the stream
        #     when an error happens by calling uv_read_stop() or uv_close().
        #     Trying to read from the stream again is undefined.
        #
        # Therefore, we're closing the stream.  Since "UVHandle._close()"
        # doesn't raise exceptions unless uvloop is built with DEBUG=1,
        # we don't need try...finally here.

        if UVLOOP_DEBUG:
            loop._debug_stream_read_errors_total += 1

        if sc.__read_error_close:
            # Used for getting notified when a pipe is closed.
            # See WriteUnixTransport for the explanation.
            sc._on_eof()
            return True

        exc = convert_error(nread)
        sc._fatal_error(
            exc, False, "error status in uv_stream_t.read callback")
        return True

    return False


cdef inline void __uv_stream_on_read_impl(
    uv.uv_stream_t* stream,
    ssize_t nread,
    const uv.uv_buf_t* buf,
):
    cdef:
        UVStream sc = <UVStream>stream.data
        Loop loop = sc._loop

    # It's OK to free the buffer early, since nothing will
    # be able to touch it until this method is done.
    __loop_free_buffer(loop)

    if __uv_stream_on_read_common(sc, loop, nread):
        return

    try:
        if UVLOOP_DEBUG:
            loop._debug_stream_read_cb_total += 1

        run_in_context1(
            sc.context,
            sc._protocol_data_received,
            loop._recv_buffer[:nread],
        )
    except BaseException as exc:
        if UVLOOP_DEBUG:
            loop._debug_stream_read_cb_errors_total += 1

        sc._fatal_error(exc, False)


cdef inline void __uv_stream_on_write_impl(
    uv.uv_write_t* req,
    int status,
):
    cdef:
        _StreamWriteContext ctx = <_StreamWriteContext> req.data
        UVStream stream = <UVStream>ctx.stream

    ctx.close()

    if stream._closed:
        # The stream was closed, there is nothing to do.
        # Even if there is an error, like EPIPE, there
        # is no reason to report it.
        return

    if status < 0:
        if UVLOOP_DEBUG:
            stream._loop._debug_stream_write_errors_total += 1

        exc = convert_error(status)
        stream._fatal_error(
            exc, False, "error status in uv_stream_t.write callback")
        return

    try:
        stream._on_write()
    except BaseException as exc:
        if UVLOOP_DEBUG:
            stream._loop._debug_stream_write_cb_errors_total += 1

        stream._fatal_error(exc, False)


cdef void __uv_stream_on_read(
    uv.uv_stream_t* stream,
    ssize_t nread,
    const uv.uv_buf_t* buf,
) noexcept with gil:

    if __ensure_handle_data(<uv.uv_handle_t*>stream,
                            "UVStream read callback") == 0:
        return

    # Don't need try-finally, __uv_stream_on_read_impl is void
    __uv_stream_on_read_impl(stream, nread, buf)


cdef void __uv_stream_on_write(
    uv.uv_write_t* req,
    int status,
) noexcept with gil:

    if UVLOOP_DEBUG:
        if req.data is NULL:
            aio_logger.error(
                'UVStream.write callback called with NULL req.data, status=%r',
                status)
            return

    # Don't need try-finally, __uv_stream_on_write_impl is void
    __uv_stream_on_write_impl(req, status)


cdef void __uv_stream_buffered_alloc(
    uv.uv_handle_t* stream,
    size_t suggested_size,
    uv.uv_buf_t* uvbuf,
) noexcept with gil:

    if __ensure_handle_data(<uv.uv_handle_t*>stream,
                            "UVStream alloc buffer callback") == 0:
        return

    cdef:
        UVStream sc = <UVStream>stream.data
        Loop loop = sc._loop
        Py_buffer* pybuf = &sc._read_pybuf
        int got_buf = 0

    if sc._read_pybuf_acquired:
        uvbuf.len = 0
        uvbuf.base = NULL
        return

    sc._read_pybuf_acquired = 0
    try:
        buf = run_in_context1(
            sc.context,
            sc._protocol_get_buffer,
            suggested_size,
        )
        PyObject_GetBuffer(buf, pybuf, PyBUF_WRITABLE)
        got_buf = 1
    except BaseException as exc:
        # Can't call 'sc._fatal_error' or 'sc._close', libuv will SF.
        # We'll do it later in __uv_stream_buffered_on_read when we
        # receive UV_ENOBUFS.
        uvbuf.len = 0
        uvbuf.base = NULL
        return

    if not pybuf.len:
        uvbuf.len = 0
        uvbuf.base = NULL
        if got_buf:
            PyBuffer_Release(pybuf)
        return

    sc._read_pybuf_acquired = 1
    uvbuf.base = <char*>pybuf.buf
    uvbuf.len = pybuf.len


cdef void __uv_stream_buffered_on_read(
    uv.uv_stream_t* stream,
    ssize_t nread,
    const uv.uv_buf_t* buf,
) noexcept with gil:

    if __ensure_handle_data(<uv.uv_handle_t*>stream,
                            "UVStream buffered read callback") == 0:
        return

    cdef:
        UVStream sc = <UVStream>stream.data
        Loop loop = sc._loop
        Py_buffer* pybuf = &sc._read_pybuf

    if nread == uv.UV_ENOBUFS:
        sc._fatal_error(
            RuntimeError(
                'unhandled error (or an empty buffer) in get_buffer()'),
            False)
        return

    try:
        if nread > 0 and not sc._read_pybuf_acquired:
            # From libuv docs:
            #     nread is > 0 if there is data available or < 0 on error. When
            #     we’ve reached EOF, nread will be set to UV_EOF. When
            #     nread < 0, the buf parameter might not point to a valid
            #     buffer; in that case buf.len and buf.base are both set to 0.
            raise RuntimeError(
                f'no python buffer is allocated in on_read; nread={nread}')

        if nread == 0:
            # From libuv docs:
            #     nread might be 0, which does not indicate an error or EOF.
            #     This is equivalent to EAGAIN or EWOULDBLOCK under read(2).
            return

        if __uv_stream_on_read_common(sc, loop, nread):
            return

        if UVLOOP_DEBUG:
            loop._debug_stream_read_cb_total += 1

        run_in_context1(sc.context, sc._protocol_buffer_updated, nread)
    except BaseException as exc:
        if UVLOOP_DEBUG:
            loop._debug_stream_read_cb_errors_total += 1

        sc._fatal_error(exc, False)
    finally:
        sc._read_pybuf_acquired = 0
        PyBuffer_Release(pybuf)
