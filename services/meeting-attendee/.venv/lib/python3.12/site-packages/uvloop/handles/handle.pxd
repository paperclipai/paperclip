cdef class UVHandle:
    cdef:
        uv.uv_handle_t *_handle
        Loop _loop
        readonly _source_traceback
        bint _closed
        bint _inited
        object context

        # Added to enable current UDPTransport implementation,
        # which doesn't use libuv handles.
        bint _has_handle

    # All "inline" methods are final

    cdef inline _start_init(self, Loop loop)
    cdef inline _abort_init(self)
    cdef inline _finish_init(self)

    cdef inline bint _is_alive(self)
    cdef inline _ensure_alive(self)

    cdef _error(self, exc, throw)
    cdef _fatal_error(self, exc, throw, reason=?)

    cdef _warn_unclosed(self)

    cdef _free(self)
    cdef _close(self)


cdef class UVSocketHandle(UVHandle):
    cdef:
        # Points to a Python file-object that should be closed
        # when the transport is closing.  Used by pipes.  This
        # should probably be refactored somehow.
        object _fileobj
        object __cached_socket

    # All "inline" methods are final

    cdef _fileno(self)

    cdef _new_socket(self)
    cdef inline _get_socket(self)
    cdef inline _attach_fileobj(self, object file)

    cdef _open(self, int sockfd)
