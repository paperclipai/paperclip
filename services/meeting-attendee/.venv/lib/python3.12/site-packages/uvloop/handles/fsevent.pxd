cdef class UVFSEvent(UVHandle):
    cdef:
        object callback
        bint running

    cdef _init(self, Loop loop, object callback, object context)
    cdef _close(self)
    cdef start(self, char* path, int flags)
    cdef stop(self)

    @staticmethod
    cdef UVFSEvent new(Loop loop, object callback, object context)
