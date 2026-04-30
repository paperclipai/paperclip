import enum


class FileSystemEvent(enum.IntEnum):
    RENAME = uv.UV_RENAME
    CHANGE = uv.UV_CHANGE
    RENAME_CHANGE = RENAME | CHANGE


@cython.no_gc_clear
cdef class UVFSEvent(UVHandle):
    cdef _init(self, Loop loop, object callback, object context):
        cdef int err

        self._start_init(loop)

        self._handle = <uv.uv_handle_t*>PyMem_RawMalloc(
            sizeof(uv.uv_fs_event_t)
        )
        if self._handle is NULL:
            self._abort_init()
            raise MemoryError()

        err = uv.uv_fs_event_init(
            self._loop.uvloop, <uv.uv_fs_event_t*>self._handle
        )
        if err < 0:
            self._abort_init()
            raise convert_error(err)

        self._finish_init()

        self.running = 0
        self.callback = callback
        if context is None:
            context = Context_CopyCurrent()
        self.context = context

    cdef start(self, char* path, int flags):
        cdef int err

        self._ensure_alive()

        if self.running == 0:
            err = uv.uv_fs_event_start(
                <uv.uv_fs_event_t*>self._handle,
                __uvfsevent_callback,
                path,
                flags,
            )
            if err < 0:
                exc = convert_error(err)
                self._fatal_error(exc, True)
                return
            self.running = 1

    cdef stop(self):
        cdef int err

        if not self._is_alive():
            self.running = 0
            return

        if self.running == 1:
            err = uv.uv_fs_event_stop(<uv.uv_fs_event_t*>self._handle)
            self.running = 0
            if err < 0:
                exc = convert_error(err)
                self._fatal_error(exc, True)
                return

    cdef _close(self):
        try:
            self.stop()
        finally:
            UVHandle._close(<UVHandle>self)

    def cancel(self):
        self._close()

    def cancelled(self):
        return self.running == 0

    @staticmethod
    cdef UVFSEvent new(Loop loop, object callback, object context):
        cdef UVFSEvent handle
        handle = UVFSEvent.__new__(UVFSEvent)
        handle._init(loop, callback, context)
        return handle


cdef void __uvfsevent_callback(
    uv.uv_fs_event_t* handle,
    const char *filename,
    int events,
    int status,
) noexcept with gil:
    if __ensure_handle_data(
        <uv.uv_handle_t*>handle, "UVFSEvent callback"
    ) == 0:
        return

    cdef:
        UVFSEvent fs_event = <UVFSEvent> handle.data
        Handle h

    try:
        h = new_Handle(
            fs_event._loop,
            fs_event.callback,
            (filename, FileSystemEvent(events)),
            fs_event.context,
        )
        h._run()
    except BaseException as ex:
        fs_event._error(ex, False)
