cdef class Handle:
    cdef:
        Loop loop
        object context
        bint _cancelled

        str meth_name
        int cb_type
        void *callback
        object arg1, arg2, arg3, arg4

        object __weakref__

        readonly _source_traceback

    cdef inline _set_loop(self, Loop loop)
    cdef inline _set_context(self, object context)

    cdef inline _run(self)
    cdef _cancel(self)

    cdef _format_handle(self)


cdef class TimerHandle:
    cdef:
        object callback
        tuple args
        bint _cancelled
        UVTimer timer
        Loop loop
        object context
        tuple _debug_info
        object __weakref__
        object _when

    cdef _run(self)
    cdef _cancel(self)
    cdef inline _clear(self)
