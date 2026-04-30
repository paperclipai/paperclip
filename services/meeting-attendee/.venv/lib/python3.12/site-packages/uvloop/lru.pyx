cdef object _LRU_MARKER = object()


@cython.final
cdef class LruCache:

    cdef:
        object _dict
        int _maxsize
        object _dict_move_to_end
        object _dict_get

    # We use an OrderedDict for LRU implementation.  Operations:
    #
    # * We use a simple `__setitem__` to push a new entry:
    #       `entries[key] = new_entry`
    #   That will push `new_entry` to the *end* of the entries dict.
    #
    # * When we have a cache hit, we call
    #       `entries.move_to_end(key, last=True)`
    #   to move the entry to the *end* of the entries dict.
    #
    # * When we need to remove entries to maintain `max_size`, we call
    #       `entries.popitem(last=False)`
    #   to remove an entry from the *beginning* of the entries dict.
    #
    # So new entries and hits are always promoted to the end of the
    # entries dict, whereas the unused one will group in the
    # beginning of it.

    def __init__(self, *, maxsize):
        if maxsize <= 0:
            raise ValueError(
                f'maxsize is expected to be greater than 0, got {maxsize}')

        self._dict = col_OrderedDict()
        self._dict_move_to_end = self._dict.move_to_end
        self._dict_get = self._dict.get
        self._maxsize = maxsize

    cdef get(self, key, default):
        o = self._dict_get(key, _LRU_MARKER)
        if o is _LRU_MARKER:
            return default
        self._dict_move_to_end(key)  # last=True
        return o

    cdef inline needs_cleanup(self):
        return len(self._dict) > self._maxsize

    cdef inline cleanup_one(self):
        k, _ = self._dict.popitem(last=False)
        return k

    def __getitem__(self, key):
        o = self._dict[key]
        self._dict_move_to_end(key)  # last=True
        return o

    def __setitem__(self, key, o):
        if key in self._dict:
            self._dict[key] = o
            self._dict_move_to_end(key)  # last=True
        else:
            self._dict[key] = o
        while self.needs_cleanup():
            self.cleanup_one()

    def __delitem__(self, key):
        del self._dict[key]

    def __contains__(self, key):
        return key in self._dict

    def __len__(self):
        return len(self._dict)

    def __iter__(self):
        return iter(self._dict)
