cimport cpython


cdef extern from "Python.h":
    cpython.Py_buffer* PyMemoryView_GET_BUFFER(object)
    bint PyMemoryView_Check(object)
