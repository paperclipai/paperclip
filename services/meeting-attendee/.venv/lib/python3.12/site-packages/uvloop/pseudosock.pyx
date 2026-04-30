cdef class PseudoSocket:
    cdef:
        int _family
        int _type
        int _proto
        int _fd
        object _peername
        object _sockname

    def __init__(self, int family, int type, int proto, int fd):
        self._family = family
        self._type = type
        self._proto = proto
        self._fd = fd
        self._peername = None
        self._sockname = None

    cdef _na(self, what):
        raise TypeError('transport sockets do not support {}'.format(what))

    cdef _make_sock(self):
        return socket_socket(self._family, self._type, self._proto, self._fd)

    property family:
        def __get__(self):
            try:
                return socket_AddressFamily(self._family)
            except ValueError:
                return self._family

    property type:
        def __get__(self):
            try:
                return socket_SocketKind(self._type)
            except ValueError:
                return self._type

    property proto:
        def __get__(self):
            return self._proto

    def __repr__(self):
        s = ("<uvloop.PseudoSocket fd={}, family={!s}, "
             "type={!s}, proto={}").format(self.fileno(), self.family.name,
                                           self.type.name, self.proto)

        if self._fd != -1:
            try:
                laddr = self.getsockname()
                if laddr:
                    s += ", laddr=%s" % str(laddr)
            except socket_error:
                pass
            try:
                raddr = self.getpeername()
                if raddr:
                    s += ", raddr=%s" % str(raddr)
            except socket_error:
                pass
        s += '>'
        return s

    def __getstate__(self):
        raise TypeError("Cannot serialize socket object")

    def fileno(self):
        return self._fd

    def dup(self):
        fd = os_dup(self._fd)
        sock = socket_socket(self._family, self._type, self._proto, fileno=fd)
        sock.settimeout(0)
        return sock

    def get_inheritable(self):
        return os_get_inheritable(self._fd)

    def set_inheritable(self):
        os_set_inheritable(self._fd)

    def ioctl(self, *args, **kwargs):
        pass

    def getsockopt(self, *args, **kwargs):
        sock = self._make_sock()
        try:
            return sock.getsockopt(*args, **kwargs)
        finally:
            sock.detach()

    def setsockopt(self, *args, **kwargs):
        sock = self._make_sock()
        try:
            return sock.setsockopt(*args, **kwargs)
        finally:
            sock.detach()

    def getpeername(self):
        if self._peername is not None:
            return self._peername

        sock = self._make_sock()
        try:
            self._peername = sock.getpeername()
            return self._peername
        finally:
            sock.detach()

    def getsockname(self):
        if self._sockname is not None:
            return self._sockname

        sock = self._make_sock()
        try:
            self._sockname = sock.getsockname()
            return self._sockname
        finally:
            sock.detach()

    def share(self, process_id):
        sock = self._make_sock()
        try:
            return sock.share(process_id)
        finally:
            sock.detach()

    def accept(self):
        self._na('accept() method')

    def connect(self, *args):
        self._na('connect() method')

    def connect_ex(self, *args):
        self._na('connect_ex() method')

    def bind(self, *args):
        self._na('bind() method')

    def listen(self, *args, **kwargs):
        self._na('listen() method')

    def makefile(self):
        self._na('makefile() method')

    def sendfile(self, *args, **kwargs):
        self._na('sendfile() method')

    def close(self):
        self._na('close() method')

    def detach(self):
        self._na('detach() method')

    def shutdown(self, *args):
        self._na('shutdown() method')

    def sendmsg_afalg(self, *args, **kwargs):
        self._na('sendmsg_afalg() method')

    def sendmsg(self):
        self._na('sendmsg() method')

    def sendto(self, *args, **kwargs):
        self._na('sendto() method')

    def send(self, *args, **kwargs):
        self._na('send() method')

    def sendall(self, *args, **kwargs):
        self._na('sendall() method')

    def recv_into(self, *args, **kwargs):
        self._na('recv_into() method')

    def recvfrom_into(self, *args, **kwargs):
        self._na('recvfrom_into() method')

    def recvmsg_into(self, *args, **kwargs):
        self._na('recvmsg_into() method')

    def recvmsg(self, *args, **kwargs):
        self._na('recvmsg() method')

    def recvfrom(self, *args, **kwargs):
        self._na('recvfrom() method')

    def recv(self, *args, **kwargs):
        self._na('recv() method')

    def settimeout(self, value):
        if value == 0:
            return
        raise ValueError(
            'settimeout(): only 0 timeout is allowed on transport sockets')

    def gettimeout(self):
        return 0

    def setblocking(self, flag):
        if not flag:
            return
        raise ValueError(
            'setblocking(): transport sockets cannot be blocking')

    def __enter__(self):
        self._na('context manager protocol')

    def __exit__(self, *err):
        self._na('context manager protocol')
