@cython.no_gc_clear
cdef class UVPoll(UVHandle):
    cdef _init(self, Loop loop, int fd):
        cdef int err

        self._start_init(loop)

        self._handle = <uv.uv_handle_t*>PyMem_RawMalloc(sizeof(uv.uv_poll_t))
        if self._handle is NULL:
            self._abort_init()
            raise MemoryError()

        err = uv.uv_poll_init(self._loop.uvloop,
                              <uv.uv_poll_t *>self._handle, fd)
        if err < 0:
            self._abort_init()
            raise convert_error(err)

        self._finish_init()

        self.fd = fd
        self.reading_handle = None
        self.writing_handle = None

    @staticmethod
    cdef UVPoll new(Loop loop, int fd):
        cdef UVPoll handle
        handle = UVPoll.__new__(UVPoll)
        handle._init(loop, fd)
        return handle

    cdef int is_active(self) noexcept:
        return (self.reading_handle is not None or
                self.writing_handle is not None)

    cdef inline _poll_start(self, int flags):
        cdef int err

        self._ensure_alive()

        err = uv.uv_poll_start(
            <uv.uv_poll_t*>self._handle,
            flags,
            __on_uvpoll_event)

        if err < 0:
            exc = convert_error(err)
            self._fatal_error(exc, True)
            return

    cdef inline _poll_stop(self):
        cdef int err

        if not self._is_alive():
            return

        err = uv.uv_poll_stop(<uv.uv_poll_t*>self._handle)
        if err < 0:
            exc = convert_error(err)
            self._fatal_error(exc, True)
            return

        cdef:
            int backend_id
            system.epoll_event dummy_event

        if system.PLATFORM_IS_LINUX:
            # libuv doesn't remove the FD from epoll immediately
            # after uv_poll_stop or uv_poll_close, causing hard
            # to debug issue with dup-ed file descriptors causing
            # CPU burn in epoll/epoll_ctl:
            #    https://github.com/MagicStack/uvloop/issues/61
            #
            # It's safe though to manually call epoll_ctl here,
            # after calling uv_poll_stop.

            backend_id = uv.uv_backend_fd(self._loop.uvloop)
            if backend_id != -1:
                memset(&dummy_event, 0, sizeof(dummy_event))
                system.epoll_ctl(
                    backend_id,
                    system.EPOLL_CTL_DEL,
                    self.fd,
                    &dummy_event)  # ignore errors

    cdef is_reading(self):
        return self._is_alive() and self.reading_handle is not None

    cdef is_writing(self):
        return self._is_alive() and self.writing_handle is not None

    cdef start_reading(self, Handle callback):
        cdef:
            int mask = 0

        if self.reading_handle is None:
            # not reading right now, setup the handle

            mask = uv.UV_READABLE
            if self.writing_handle is not None:
                # are we writing right now?
                mask |= uv.UV_WRITABLE

            self._poll_start(mask)
        else:
            self.reading_handle._cancel()

        self.reading_handle = callback

    cdef start_writing(self, Handle callback):
        cdef:
            int mask = 0

        if self.writing_handle is None:
            # not writing right now, setup the handle

            mask = uv.UV_WRITABLE
            if self.reading_handle is not None:
                # are we reading right now?
                mask |= uv.UV_READABLE

            self._poll_start(mask)
        else:
            self.writing_handle._cancel()

        self.writing_handle = callback

    cdef stop_reading(self):
        if self.reading_handle is None:
            return False

        self.reading_handle._cancel()
        self.reading_handle = None

        if self.writing_handle is None:
            self.stop()
        else:
            self._poll_start(uv.UV_WRITABLE)

        return True

    cdef stop_writing(self):
        if self.writing_handle is None:
            return False

        self.writing_handle._cancel()
        self.writing_handle = None

        if self.reading_handle is None:
            self.stop()
        else:
            self._poll_start(uv.UV_READABLE)

        return True

    cdef stop(self):
        if self.reading_handle is not None:
            self.reading_handle._cancel()
            self.reading_handle = None

        if self.writing_handle is not None:
            self.writing_handle._cancel()
            self.writing_handle = None

        self._poll_stop()

    cdef _close(self):
        if self.is_active():
            self.stop()

        UVHandle._close(<UVHandle>self)

    cdef _fatal_error(self, exc, throw, reason=None):
        try:
            if self.reading_handle is not None:
                try:
                    self.reading_handle._run()
                except BaseException as ex:
                    self._loop._handle_exception(ex)
                self.reading_handle = None

            if self.writing_handle is not None:
                try:
                    self.writing_handle._run()
                except BaseException as ex:
                    self._loop._handle_exception(ex)
                self.writing_handle = None

        finally:
            self._close()


cdef void __on_uvpoll_event(
    uv.uv_poll_t* handle,
    int status,
    int events,
) noexcept with gil:

    if __ensure_handle_data(<uv.uv_handle_t*>handle, "UVPoll callback") == 0:
        return

    cdef:
        UVPoll poll = <UVPoll> handle.data

    if status < 0:
        exc = convert_error(status)
        poll._fatal_error(exc, False)
        return

    if ((events & (uv.UV_READABLE | uv.UV_DISCONNECT)) and
            poll.reading_handle is not None):

        try:
            if UVLOOP_DEBUG:
                poll._loop._poll_read_events_total += 1
            poll.reading_handle._run()
        except BaseException as ex:
            if UVLOOP_DEBUG:
                poll._loop._poll_read_cb_errors_total += 1
            poll._error(ex, False)
            # continue code execution

    if ((events & (uv.UV_WRITABLE | uv.UV_DISCONNECT)) and
            poll.writing_handle is not None):

        try:
            if UVLOOP_DEBUG:
                poll._loop._poll_write_events_total += 1
            poll.writing_handle._run()
        except BaseException as ex:
            if UVLOOP_DEBUG:
                poll._loop._poll_write_cb_errors_total += 1
            poll._error(ex, False)
