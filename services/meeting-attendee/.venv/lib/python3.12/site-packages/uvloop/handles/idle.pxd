cdef class UVIdle(UVHandle):
    cdef:
        Handle h
        bint running

    # All "inline" methods are final

    cdef _init(self, Loop loop, Handle h)

    cdef inline stop(self)
    cdef inline start(self)

    @staticmethod
    cdef UVIdle new(Loop loop, Handle h)
