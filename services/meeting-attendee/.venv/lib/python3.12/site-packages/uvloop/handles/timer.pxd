cdef class UVTimer(UVHandle):
    cdef:
        method_t callback
        object ctx
        bint running
        uint64_t timeout
        uint64_t start_t

    cdef _init(self, Loop loop, method_t callback, object ctx,
               uint64_t timeout)

    cdef stop(self)
    cdef start(self)
    cdef get_when(self)

    @staticmethod
    cdef UVTimer new(Loop loop, method_t callback, object ctx,
                     uint64_t timeout)
