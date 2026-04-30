cdef enum:
    UV_STREAM_RECV_BUF_SIZE = 256000  # 250kb

    FLOW_CONTROL_HIGH_WATER = 64  # KiB
    FLOW_CONTROL_HIGH_WATER_SSL_READ = 256  # KiB
    FLOW_CONTROL_HIGH_WATER_SSL_WRITE = 512  # KiB

    DEFAULT_FREELIST_SIZE = 250
    DNS_PYADDR_TO_SOCKADDR_CACHE_SIZE = 2048

    DEBUG_STACK_DEPTH = 10


    __PROCESS_DEBUG_SLEEP_AFTER_FORK = 1


    LOG_THRESHOLD_FOR_CONNLOST_WRITES = 5
    SSL_READ_MAX_SIZE = 256 * 1024


cdef extern from *:
    '''
    // Number of seconds to wait for SSL handshake to complete
    // The default timeout matches that of Nginx.
    #define SSL_HANDSHAKE_TIMEOUT 60.0

    // Number of seconds to wait for SSL shutdown to complete
    // The default timeout mimics lingering_time
    #define SSL_SHUTDOWN_TIMEOUT 30.0
    '''

    const float SSL_HANDSHAKE_TIMEOUT
    const float SSL_SHUTDOWN_TIMEOUT
