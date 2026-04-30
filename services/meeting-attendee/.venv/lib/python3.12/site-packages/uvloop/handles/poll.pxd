cdef class UVPoll(UVHandle):
    cdef:
        int fd
        Handle reading_handle
        Handle writing_handle

    cdef _init(self, Loop loop, int fd)
    cdef _close(self)

    cdef inline _poll_start(self, int flags)
    cdef inline _poll_stop(self)

    cdef int is_active(self) noexcept

    cdef is_reading(self)
    cdef is_writing(self)

    cdef start_reading(self, Handle callback)
    cdef start_writing(self, Handle callback)
    cdef stop_reading(self)
    cdef stop_writing(self)
    cdef stop(self)

    @staticmethod
    cdef UVPoll new(Loop loop, int fd)
