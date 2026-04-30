@cython.no_gc_clear
cdef class UVCheck(UVHandle):
    cdef _init(self, Loop loop, Handle h):
        cdef int err

        self._start_init(loop)

        self._handle = <uv.uv_handle_t*>PyMem_RawMalloc(sizeof(uv.uv_check_t))
        if self._handle is NULL:
            self._abort_init()
            raise MemoryError()

        err = uv.uv_check_init(self._loop.uvloop, <uv.uv_check_t*>self._handle)
        if err < 0:
            self._abort_init()
            raise convert_error(err)

        self._finish_init()

        self.h = h
        self.running = 0

    cdef inline stop(self):
        cdef int err

        if not self._is_alive():
            self.running = 0
            return

        if self.running == 1:
            err = uv.uv_check_stop(<uv.uv_check_t*>self._handle)
            self.running = 0
            if err < 0:
                exc = convert_error(err)
                self._fatal_error(exc, True)
                return

    cdef inline start(self):
        cdef int err

        self._ensure_alive()

        if self.running == 0:
            err = uv.uv_check_start(<uv.uv_check_t*>self._handle,
                                    cb_check_callback)
            if err < 0:
                exc = convert_error(err)
                self._fatal_error(exc, True)
                return
            self.running = 1

    @staticmethod
    cdef UVCheck new(Loop loop, Handle h):
        cdef UVCheck handle
        handle = UVCheck.__new__(UVCheck)
        handle._init(loop, h)
        return handle


cdef void cb_check_callback(
    uv.uv_check_t* handle,
) noexcept with gil:
    if __ensure_handle_data(<uv.uv_handle_t*>handle, "UVCheck callback") == 0:
        return

    cdef:
        UVCheck check = <UVCheck> handle.data
        Handle h = check.h
    try:
        h._run()
    except BaseException as ex:
        check._error(ex, False)
