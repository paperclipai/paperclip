cdef class UVBaseTransport(UVSocketHandle):

    cdef:
        readonly bint _closing

        bint _protocol_connected
        bint _protocol_paused
        object _protocol_data_received
        size_t _high_water
        size_t _low_water

        object _protocol
        Server _server
        object _waiter

        dict _extra_info

        uint32_t _conn_lost

        object __weakref__

    # All "inline" methods are final

    cdef inline _maybe_pause_protocol(self)
    cdef inline _maybe_resume_protocol(self)

    cdef inline _schedule_call_connection_made(self)
    cdef inline _schedule_call_connection_lost(self, exc)

    cdef _wakeup_waiter(self)
    cdef _call_connection_made(self)
    cdef _call_connection_lost(self, exc)

    # Overloads of UVHandle methods:
    cdef _fatal_error(self, exc, throw, reason=?)
    cdef _close(self)

    cdef inline _set_server(self, Server server)
    cdef inline _set_waiter(self, object waiter)

    cdef _set_protocol(self, object protocol)
    cdef _clear_protocol(self)

    cdef inline _init_protocol(self)
    cdef inline _add_extra_info(self, str name, object obj)

    # === overloads ===

    cdef _new_socket(self)
    cdef size_t _get_write_buffer_size(self)

    cdef bint _is_reading(self)
    cdef _start_reading(self)
    cdef _stop_reading(self)
