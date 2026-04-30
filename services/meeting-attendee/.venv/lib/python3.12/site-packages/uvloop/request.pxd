cdef class UVRequest:
    cdef:
        uv.uv_req_t *request
        bint done
        Loop loop

    cdef on_done(self)
    cdef cancel(self)
