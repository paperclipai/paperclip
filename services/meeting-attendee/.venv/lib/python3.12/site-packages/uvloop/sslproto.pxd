cdef enum SSLProtocolState:
    UNWRAPPED = 0
    DO_HANDSHAKE = 1
    WRAPPED = 2
    FLUSHING = 3
    SHUTDOWN = 4


cdef enum AppProtocolState:
    # This tracks the state of app protocol (https://git.io/fj59P):
    #
    #     INIT -cm-> CON_MADE [-dr*->] [-er-> EOF?] -cl-> CON_LOST
    #
    # * cm: connection_made()
    # * dr: data_received()
    # * er: eof_received()
    # * cl: connection_lost()

    STATE_INIT = 0
    STATE_CON_MADE = 1
    STATE_EOF = 2
    STATE_CON_LOST = 3


cdef class _SSLProtocolTransport:
    cdef:
        Loop _loop
        SSLProtocol _ssl_protocol
        bint _closed
        object context


cdef class SSLProtocol:
    cdef:
        bint _server_side
        str _server_hostname
        object _sslcontext

        object _extra

        object _write_backlog
        size_t _write_buffer_size

        object _waiter
        Loop _loop
        _SSLProtocolTransport _app_transport
        bint _app_transport_created

        object _transport
        object _ssl_handshake_timeout
        object _ssl_shutdown_timeout

        object _sslobj
        object _sslobj_read
        object _sslobj_write
        object _incoming
        object _incoming_write
        object _outgoing
        object _outgoing_read
        char* _ssl_buffer
        size_t _ssl_buffer_len
        object _ssl_buffer_view
        SSLProtocolState _state
        size_t _conn_lost
        AppProtocolState _app_state

        bint _ssl_writing_paused
        bint _app_reading_paused

        size_t _incoming_high_water
        size_t _incoming_low_water
        bint _ssl_reading_paused

        bint _app_writing_paused
        size_t _outgoing_high_water
        size_t _outgoing_low_water

        object _app_protocol
        bint _app_protocol_is_buffer
        object _app_protocol_get_buffer
        object _app_protocol_buffer_updated

        object _handshake_start_time
        object _handshake_timeout_handle
        object _shutdown_timeout_handle

    cdef _set_app_protocol(self, app_protocol)
    cdef _wakeup_waiter(self, exc=*)
    cdef _get_extra_info(self, name, default=*)
    cdef _set_state(self, SSLProtocolState new_state)

    # Handshake flow

    cdef _start_handshake(self)
    cdef _check_handshake_timeout(self)
    cdef _do_handshake(self)
    cdef _on_handshake_complete(self, handshake_exc)

    # Shutdown flow

    cdef _start_shutdown(self, object context=*)
    cdef _check_shutdown_timeout(self)
    cdef _do_read_into_void(self, object context)
    cdef _do_flush(self, object context=*)
    cdef _do_shutdown(self, object context=*)
    cdef _on_shutdown_complete(self, shutdown_exc)
    cdef _abort(self, exc)

    # Outgoing flow

    cdef _write_appdata(self, list_of_data, object context)
    cdef _do_write(self)
    cdef _process_outgoing(self)

    # Incoming flow

    cdef _do_read(self)
    cdef _do_read__buffered(self)
    cdef _do_read__copied(self)
    cdef _call_eof_received(self, object context=*)

    # Flow control for writes from APP socket

    cdef _control_app_writing(self, object context=*)
    cdef size_t _get_write_buffer_size(self)
    cdef _set_write_buffer_limits(self, high=*, low=*)

    # Flow control for reads to APP socket

    cdef _pause_reading(self)
    cdef _resume_reading(self, object context)

    # Flow control for reads from SSL socket

    cdef _control_ssl_reading(self)
    cdef _set_read_buffer_limits(self, high=*, low=*)
    cdef size_t _get_read_buffer_size(self)
    cdef _fatal_error(self, exc, message=*)
