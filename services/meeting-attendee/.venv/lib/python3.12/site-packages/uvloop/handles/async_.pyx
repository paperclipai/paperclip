@cython.no_gc_clear
cdef class UVAsync(UVHandle):
    cdef _init(self, Loop loop, method_t callback, object ctx):
        cdef int err

        self._start_init(loop)

        self._handle = <uv.uv_handle_t*>PyMem_RawMalloc(sizeof(uv.uv_async_t))
        if self._handle is NULL:
            self._abort_init()
            raise MemoryError()

        err = uv.uv_async_init(self._loop.uvloop,
                               <uv.uv_async_t*>self._handle,
                               __uvasync_callback)
        if err < 0:
            self._abort_init()
            raise convert_error(err)

        self._finish_init()

        self.callback = callback
        self.ctx = ctx

    cdef send(self):
        cdef int err

        self._ensure_alive()

        err = uv.uv_async_send(<uv.uv_async_t*>self._handle)
        if err < 0:
            exc = convert_error(err)
            self._fatal_error(exc, True)
            return

    @staticmethod
    cdef UVAsync new(Loop loop, method_t callback, object ctx):
        cdef UVAsync handle
        handle = UVAsync.__new__(UVAsync)
        handle._init(loop, callback, ctx)
        return handle


cdef void __uvasync_callback(
    uv.uv_async_t* handle,
) noexcept with gil:
    if __ensure_handle_data(<uv.uv_handle_t*>handle, "UVAsync callback") == 0:
        return

    cdef:
        UVAsync async_ = <UVAsync> handle.data
        method_t cb = async_.callback
    try:
        cb(async_.ctx)
    except BaseException as ex:
        async_._error(ex, False)
