@cython.no_gc_clear
cdef class UVTimer(UVHandle):
    cdef _init(self, Loop loop, method_t callback, object ctx,
               uint64_t timeout):

        cdef int err

        self._start_init(loop)

        self._handle = <uv.uv_handle_t*> PyMem_RawMalloc(sizeof(uv.uv_timer_t))
        if self._handle is NULL:
            self._abort_init()
            raise MemoryError()

        err = uv.uv_timer_init(self._loop.uvloop, <uv.uv_timer_t*>self._handle)
        if err < 0:
            self._abort_init()
            raise convert_error(err)

        self._finish_init()

        self.callback = callback
        self.ctx = ctx
        self.running = 0
        self.timeout = timeout
        self.start_t = 0

    cdef stop(self):
        cdef int err

        if not self._is_alive():
            self.running = 0
            return

        if self.running == 1:
            err = uv.uv_timer_stop(<uv.uv_timer_t*>self._handle)
            self.running = 0
            if err < 0:
                exc = convert_error(err)
                self._fatal_error(exc, True)
                return

    cdef start(self):
        cdef int err

        self._ensure_alive()

        if self.running == 0:
            # Update libuv internal time.
            uv.uv_update_time(self._loop.uvloop)  # void
            self.start_t = uv.uv_now(self._loop.uvloop)

            err = uv.uv_timer_start(<uv.uv_timer_t*>self._handle,
                                    __uvtimer_callback,
                                    self.timeout, 0)
            if err < 0:
                exc = convert_error(err)
                self._fatal_error(exc, True)
                return
            self.running = 1

    cdef get_when(self):
        return self.start_t + self.timeout

    @staticmethod
    cdef UVTimer new(Loop loop, method_t callback, object ctx,
                     uint64_t timeout):

        cdef UVTimer handle
        handle = UVTimer.__new__(UVTimer)
        handle._init(loop, callback, ctx, timeout)
        return handle


cdef void __uvtimer_callback(
    uv.uv_timer_t* handle,
) noexcept with gil:
    if __ensure_handle_data(<uv.uv_handle_t*>handle, "UVTimer callback") == 0:
        return

    cdef:
        UVTimer timer = <UVTimer> handle.data
        method_t cb = timer.callback

    timer.running = 0
    try:
        cb(timer.ctx)
    except BaseException as ex:
        timer._error(ex, False)
