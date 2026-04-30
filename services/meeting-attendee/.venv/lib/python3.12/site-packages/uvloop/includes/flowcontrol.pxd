# flake8: noqa


cdef inline add_flowcontrol_defaults(high, low, int kb):
    cdef int h, l
    if high is None:
        if low is None:
            h = kb * 1024
        else:
            l = low
            h = 4 * l
    else:
        h = high
    if low is None:
        l = h // 4
    else:
        l = low

    if not h >= l >= 0:
        raise ValueError('high (%r) must be >= low (%r) must be >= 0' %
                         (h, l))

    return h, l
