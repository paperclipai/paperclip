from __future__ import annotations

import logging
from os import mkdir
from os.path import abspath, exists
from threading import Thread
from typing import (
    TYPE_CHECKING,
    Any,
    Callable,
    Dict,
    Generator,
    List,
    Optional,
    Tuple,
    Union,
)
from urllib.request import pathname2url

from rdflib.store import NO_STORE, VALID_STORE, Store
from rdflib.term import Identifier, Node, URIRef

if TYPE_CHECKING:
    from rdflib.graph import Graph, _ContextType, _TriplePatternType, _TripleType


def bb(u: str) -> bytes:
    return u.encode("utf-8")


try:
    from berkeleydb import db

    has_bsddb = True
except ImportError:
    has_bsddb = False


if has_bsddb:
    # These are passed to bsddb when creating DBs

    # passed to db.DBEnv.set_flags
    ENVSETFLAGS = db.DB_CDB_ALLDB
    # passed to db.DBEnv.open
    ENVFLAGS = db.DB_INIT_MPOOL | db.DB_INIT_CDB | db.DB_THREAD
    CACHESIZE = 1024 * 1024 * 50

    # passed to db.DB.Open()
    DBOPENFLAGS = db.DB_THREAD

logger = logging.getLogger(__name__)

__all__ = [
    "BerkeleyDB",
    "_ToKeyFunc",
    "_FromKeyFunc",
    "_GetPrefixFunc",
    "_ResultsFromKeyFunc",
]


_ToKeyFunc = Callable[[Tuple[bytes, bytes, bytes], bytes], bytes]
_FromKeyFunc = Callable[[bytes], Tuple[bytes, bytes, bytes, bytes]]
_GetPrefixFunc = Callable[
    [Tuple[str, str, str], Optional[str]], Generator[str, None, None]
]
_ResultsFromKeyFunc = Callable[
    [bytes, Optional[Node], Optional[Node], Optional[Node], bytes],
    Tuple[Tuple[Node, Node, Node], Generator[Node, None, None]],
]


class BerkeleyDB(Store):
    """A store that allows for on-disk persistent using BerkeleyDB, a fast key/value DB.

    This store implementation used to be known, previous to rdflib 6.0.0
    as 'Sleepycat' due to that being the then name of the Python wrapper
    for BerkeleyDB.

    This store allows for quads as well as triples. See examples of use
    in both the `examples.berkeleydb_example` and `test/test_store/test_store_berkeleydb.py`
    files.

    **NOTE on installation**:

    To use this store, you must have BerkeleyDB installed on your system
    separately to Python (`brew install berkeley-db` on a Mac) and also have
    the BerkeleyDB Python wrapper installed (`pip install berkeleydb`).
    You may need to install BerkeleyDB Python wrapper like this:
    `YES_I_HAVE_THE_RIGHT_TO_USE_THIS_BERKELEY_DB_VERSION=1 pip install berkeleydb`
    """

    context_aware = True
    formula_aware = True
    transaction_aware = False
    graph_aware = True
    db_env: db.DBEnv = None

    def __init__(
        self,
        configuration: Optional[str] = None,
        identifier: Optional[Identifier] = None,
    ):
        if not has_bsddb:
            raise ImportError("Unable to import berkeleydb, store is unusable.")
        self.__open = False
        self.__identifier = identifier
        super(BerkeleyDB, self).__init__(configuration)
        self._loads = self.node_pickler.loads
        self._dumps = self.node_pickler.dumps
        self.__indicies_info: List[Tuple[Any, _ToKeyFunc, _FromKeyFunc]]

    def __get_identifier(self) -> Optional[Identifier]:
        return self.__identifier

    identifier = property(__get_identifier)

    def _init_db_environment(
        self, homeDir: str, create: bool = True  # noqa: N803
    ) -> db.DBEnv:
        if not exists(homeDir):
            if create is True:
                mkdir(homeDir)
                # TODO: implement create method and refactor this to it
                self.create(homeDir)
            else:
                return NO_STORE
        db_env = db.DBEnv()
        db_env.set_cachesize(0, CACHESIZE)  # TODO
        # db_env.set_lg_max(1024*1024)
        db_env.set_flags(ENVSETFLAGS, 1)
        db_env.open(homeDir, ENVFLAGS | db.DB_CREATE)
        return db_env

    def is_open(self) -> bool:
        return self.__open

    def open(
        self, configuration: Union[str, tuple[str, str]], create: bool = True
    ) -> Optional[int]:
        if not has_bsddb:
            return NO_STORE

        if type(configuration) is str:
            homeDir = configuration  # noqa: N806
        else:
            raise Exception("Invalid configuration provided")

        if self.__identifier is None:
            self.__identifier = URIRef(pathname2url(abspath(homeDir)))

        db_env = self._init_db_environment(homeDir, create)
        if db_env == NO_STORE:
            return NO_STORE
        self.db_env = db_env
        self.__open = True

        dbname = None
        dbtype = db.DB_BTREE
        # auto-commit ensures that the open-call commits when transactions
        # are enabled

        dbopenflags = DBOPENFLAGS
        if self.transaction_aware is True:
            dbopenflags |= db.DB_AUTO_COMMIT

        if create:
            dbopenflags |= db.DB_CREATE

        dbmode = 0o660
        dbsetflags = 0

        # create and open the DBs
        self.__indicies: List[db.DB] = [
            None,
        ] * 3
        # NOTE on type ingore: this is because type checker does not like this
        # way of initializing, using a temporary variable will solve it.
        # type error: error: List item 0 has incompatible type "None"; expected "Tuple[Any, Callable[[Tuple[bytes, bytes, bytes], bytes], bytes], Callable[[bytes], Tuple[bytes, bytes, bytes, bytes]]]"
        self.__indicies_info = [
            None,  # type: ignore[list-item]
        ] * 3
        for i in range(0, 3):
            index_name = to_key_func(i)(
                ("s".encode("latin-1"), "p".encode("latin-1"), "o".encode("latin-1")),
                "c".encode("latin-1"),
            ).decode()
            index = db.DB(db_env)
            index.set_flags(dbsetflags)
            index.open(index_name, dbname, dbtype, dbopenflags, dbmode)
            self.__indicies[i] = index
            self.__indicies_info[i] = (index, to_key_func(i), from_key_func(i))

        lookup: Dict[
            int, Tuple[db.DB, _GetPrefixFunc, _FromKeyFunc, _ResultsFromKeyFunc]
        ] = {}
        for i in range(0, 8):
            results: List[Tuple[Tuple[int, int], int, int]] = []
            for start in range(0, 3):
                score = 1
                len = 0
                for j in range(start, start + 3):
                    if i & (1 << (j % 3)):
                        score = score << 1
                        len += 1
                    else:
                        break
                tie_break = 2 - start
                results.append(((score, tie_break), start, len))

            results.sort()
            # NOTE on type error: this is because the variable `score` is
            # reused with different type
            # type error: Incompatible types in assignment (expression has type "Tuple[int, int]", variable has type "int")
            score, start, len = results[-1]  # type: ignore[assignment]

            def get_prefix_func(start: int, end: int) -> _GetPrefixFunc:
                def get_prefix(
                    triple: Tuple[str, str, str], context: Optional[str]
                ) -> Generator[str, None, None]:
                    if context is None:
                        yield ""
                    else:
                        yield context
                    i = start
                    while i < end:
                        yield triple[i % 3]
                        i += 1
                    yield ""

                return get_prefix

            lookup[i] = (
                self.__indicies[start],
                get_prefix_func(start, start + len),
                from_key_func(start),
                results_from_key_func(start, self._from_string),
            )

        self.__lookup_dict = lookup

        self.__contexts = db.DB(db_env)
        self.__contexts.set_flags(dbsetflags)
        self.__contexts.open("contexts", dbname, dbtype, dbopenflags, dbmode)

        self.__namespace = db.DB(db_env)
        self.__namespace.set_flags(dbsetflags)
        self.__namespace.open("namespace", dbname, dbtype, dbopenflags, dbmode)

        self.__prefix = db.DB(db_env)
        self.__prefix.set_flags(dbsetflags)
        self.__prefix.open("prefix", dbname, dbtype, dbopenflags, dbmode)

        self.__k2i = db.DB(db_env)
        self.__k2i.set_flags(dbsetflags)
        self.__k2i.open("k2i", dbname, db.DB_HASH, dbopenflags, dbmode)

        self.__i2k = db.DB(db_env)
        self.__i2k.set_flags(dbsetflags)
        self.__i2k.open("i2k", dbname, db.DB_RECNO, dbopenflags, dbmode)

        self.__needs_sync = False
        t = Thread(target=self.__sync_run)
        t.setDaemon(True)
        t.start()
        self.__sync_thread = t
        return VALID_STORE

    def __sync_run(self) -> None:
        from time import sleep, time

        try:
            min_seconds, max_seconds = 10, 300
            while self.__open:
                if self.__needs_sync:
                    t0 = t1 = time()
                    self.__needs_sync = False
                    while self.__open:
                        sleep(0.1)
                        if self.__needs_sync:
                            t1 = time()
                            self.__needs_sync = False
                        if time() - t1 > min_seconds or time() - t0 > max_seconds:
                            self.__needs_sync = False
                            logger.debug("sync")
                            self.sync()
                            break
                else:
                    sleep(1)
        except Exception as e:
            logger.exception(e)

    def sync(self) -> None:
        if self.__open:
            for i in self.__indicies:
                i.sync()
            self.__contexts.sync()
            self.__namespace.sync()
            self.__prefix.sync()
            self.__i2k.sync()
            self.__k2i.sync()

    def close(self, commit_pending_transaction: bool = False) -> None:
        self.__open = False
        self.__sync_thread.join()
        for i in self.__indicies:
            i.close()
        self.__contexts.close()
        self.__namespace.close()
        self.__prefix.close()
        self.__i2k.close()
        self.__k2i.close()
        self.db_env.close()

    def add(
        self,
        triple: _TripleType,
        context: _ContextType,
        quoted: bool = False,
        txn: Optional[Any] = None,
    ) -> None:
        """\
        Add a triple to the store of triples.
        """
        (subject, predicate, object) = triple
        assert self.__open, "The Store must be open."
        assert context != self, "Can not add triple directly to store"
        Store.add(self, (subject, predicate, object), context, quoted)

        _to_string = self._to_string

        s = _to_string(subject, txn=txn)
        p = _to_string(predicate, txn=txn)
        o = _to_string(object, txn=txn)
        c = _to_string(context, txn=txn)

        cspo, cpos, cosp = self.__indicies

        value = cspo.get(bb("%s^%s^%s^%s^" % (c, s, p, o)), txn=txn)
        if value is None:
            self.__contexts.put(bb(c), b"", txn=txn)

            contexts_value = cspo.get(
                bb("%s^%s^%s^%s^" % ("", s, p, o)), txn=txn
            ) or "".encode("latin-1")
            contexts = set(contexts_value.split("^".encode("latin-1")))
            contexts.add(bb(c))
            contexts_value = "^".encode("latin-1").join(contexts)
            assert contexts_value is not None

            cspo.put(bb("%s^%s^%s^%s^" % (c, s, p, o)), b"", txn=txn)
            cpos.put(bb("%s^%s^%s^%s^" % (c, p, o, s)), b"", txn=txn)
            cosp.put(bb("%s^%s^%s^%s^" % (c, o, s, p)), b"", txn=txn)
            if not quoted:
                cspo.put(bb("%s^%s^%s^%s^" % ("", s, p, o)), contexts_value, txn=txn)
                cpos.put(bb("%s^%s^%s^%s^" % ("", p, o, s)), contexts_value, txn=txn)
                cosp.put(bb("%s^%s^%s^%s^" % ("", o, s, p)), contexts_value, txn=txn)

            self.__needs_sync = True

    def __remove(
        self,
        spo: Tuple[bytes, bytes, bytes],
        c: bytes,
        quoted: bool = False,
        txn: Optional[Any] = None,
    ) -> None:
        s, p, o = spo
        cspo, cpos, cosp = self.__indicies
        contexts_value = cspo.get(
            "^".encode("latin-1").join(
                ["".encode("latin-1"), s, p, o, "".encode("latin-1")]
            ),
            txn=txn,
        ) or "".encode("latin-1")
        contexts = set(contexts_value.split("^".encode("latin-1")))
        contexts.discard(c)
        contexts_value = "^".encode("latin-1").join(contexts)
        for i, _to_key, _from_key in self.__indicies_info:
            i.delete(_to_key((s, p, o), c), txn=txn)
        if not quoted:
            if contexts_value:
                for i, _to_key, _from_key in self.__indicies_info:
                    i.put(
                        _to_key((s, p, o), "".encode("latin-1")),
                        contexts_value,
                        txn=txn,
                    )
            else:
                for i, _to_key, _from_key in self.__indicies_info:
                    try:
                        i.delete(_to_key((s, p, o), "".encode("latin-1")), txn=txn)
                    except db.DBNotFoundError:
                        pass  # TODO: is it okay to ignore these?

    # type error: Signature of "remove" incompatible with supertype "Store"
    def remove(  # type: ignore[override]
        self,
        spo: _TriplePatternType,
        context: Optional[_ContextType],
        txn: Optional[Any] = None,
    ) -> None:
        subject, predicate, object = spo
        assert self.__open, "The Store must be open."
        Store.remove(self, (subject, predicate, object), context)
        _to_string = self._to_string

        if context is not None:
            if context == self:
                context = None

        if (
            subject is not None
            and predicate is not None
            and object is not None
            and context is not None
        ):
            s = _to_string(subject, txn=txn)
            p = _to_string(predicate, txn=txn)
            o = _to_string(object, txn=txn)
            c = _to_string(context, txn=txn)
            value = self.__indicies[0].get(bb("%s^%s^%s^%s^" % (c, s, p, o)), txn=txn)
            if value is not None:
                self.__remove((bb(s), bb(p), bb(o)), bb(c), txn=txn)
                self.__needs_sync = True
        else:
            cspo, cpos, cosp = self.__indicies
            index, prefix, from_key, results_from_key = self.__lookup(
                (subject, predicate, object), context, txn=txn
            )

            cursor = index.cursor(txn=txn)
            try:
                current = cursor.set_range(prefix)
                needs_sync = True
            except db.DBNotFoundError:
                current = None
                needs_sync = False
            cursor.close()
            while current:
                key, value = current
                cursor = index.cursor(txn=txn)
                try:
                    cursor.set_range(key)
                    # Hack to stop 2to3 converting this to next(cursor)
                    current = getattr(cursor, "next")()
                except db.DBNotFoundError:
                    current = None
                cursor.close()
                if key.startswith(prefix):
                    # NOTE on type error: variables are being reused with a
                    # different type
                    # type error: Incompatible types in assignment (expression has type "bytes", variable has type "str")
                    c, s, p, o = from_key(key)  # type: ignore[assignment]
                    if context is None:
                        contexts_value = index.get(key, txn=txn) or "".encode("latin-1")
                        # remove triple from all non quoted contexts
                        contexts = set(contexts_value.split("^".encode("latin-1")))
                        # and from the conjunctive index
                        contexts.add("".encode("latin-1"))
                        for c in contexts:
                            for i, _to_key, _ in self.__indicies_info:
                                # NOTE on type error: variables are being
                                # reused with a different type
                                # type error: Argument 1 has incompatible type "Tuple[str, str, str]"; expected "Tuple[bytes, bytes, bytes]"
                                # type error: Argument 2 has incompatible type "str"; expected "bytes"
                                i.delete(_to_key((s, p, o), c), txn=txn)  # type: ignore[arg-type]
                    else:
                        # type error: Argument 1 to "__remove" of "BerkeleyDB" has incompatible type "Tuple[str, str, str]"; expected "Tuple[bytes, bytes, bytes]"
                        # type error: Argument 2 to "__remove" of "BerkeleyDB" has incompatible type "str"; expected "bytes"
                        self.__remove((s, p, o), c, txn=txn)  # type: ignore[arg-type]
                else:
                    break

            if context is not None:
                if subject is None and predicate is None and object is None:
                    # TODO: also if context becomes empty and not just on
                    # remove((None, None, None), c)
                    try:
                        self.__contexts.delete(
                            bb(_to_string(context, txn=txn)), txn=txn
                        )
                    except db.DBNotFoundError:
                        pass

            self.__needs_sync = needs_sync

    def triples(
        self,
        spo: _TriplePatternType,
        context: Optional[_ContextType] = None,
        txn: Optional[Any] = None,
    ) -> Generator[
        Tuple[_TripleType, Generator[Optional[_ContextType], None, None]],
        None,
        None,
    ]:
        """A generator over all the triples matching"""
        assert self.__open, "The Store must be open."

        subject, predicate, object = spo

        if context is not None:
            if context == self:
                context = None

        # _from_string = self._from_string ## UNUSED
        index, prefix, from_key, results_from_key = self.__lookup(
            (subject, predicate, object), context, txn=txn
        )

        cursor = index.cursor(txn=txn)
        try:
            current = cursor.set_range(prefix)
        except db.DBNotFoundError:
            current = None
        cursor.close()
        while current:
            key, value = current
            cursor = index.cursor(txn=txn)
            try:
                cursor.set_range(key)
                # Cheap hack so 2to3 doesn't convert to next(cursor)
                current = getattr(cursor, "next")()
            except db.DBNotFoundError:
                current = None
            cursor.close()
            if key and key.startswith(prefix):
                contexts_value = index.get(key, txn=txn)
                # type error: Incompatible types in "yield" (actual type "Tuple[Tuple[Node, Node, Node], Generator[Node, None, None]]", expected type "Tuple[Tuple[IdentifiedNode, URIRef, Identifier], Iterator[Optional[Graph]]]")
                # NOTE on type ignore: this is needed because some context is
                # lost in the process of extracting triples from the database.
                yield results_from_key(key, subject, predicate, object, contexts_value)  # type: ignore[misc]
            else:
                break

    def __len__(self, context: Optional[_ContextType] = None) -> int:
        assert self.__open, "The Store must be open."
        if context is not None:
            if context == self:
                context = None

        if context is None:
            prefix = "^".encode("latin-1")
        else:
            prefix = bb("%s^" % self._to_string(context))

        index = self.__indicies[0]
        cursor = index.cursor()
        current = cursor.set_range(prefix)
        count = 0
        while current:
            key, value = current
            if key.startswith(prefix):
                count += 1
                # Hack to stop 2to3 converting this to next(cursor)
                current = getattr(cursor, "next")()
            else:
                break
        cursor.close()
        return count

    def bind(self, prefix: str, namespace: URIRef, override: bool = True) -> None:
        # NOTE on type error: this is because the variables are reused with
        # another type.
        # type error: Incompatible types in assignment (expression has type "bytes", variable has type "str")
        prefix = prefix.encode("utf-8")  # type: ignore[assignment]
        # type error: Incompatible types in assignment (expression has type "bytes", variable has type "URIRef")
        namespace = namespace.encode("utf-8")  # type: ignore[assignment]
        bound_prefix = self.__prefix.get(namespace)
        bound_namespace = self.__namespace.get(prefix)
        if override:
            if bound_prefix:
                self.__namespace.delete(bound_prefix)
            if bound_namespace:
                self.__prefix.delete(bound_namespace)
            self.__prefix[namespace] = prefix
            self.__namespace[prefix] = namespace
        else:
            self.__prefix[bound_namespace or namespace] = bound_prefix or prefix
            self.__namespace[bound_prefix or prefix] = bound_namespace or namespace

    def namespace(self, prefix: str) -> Optional[URIRef]:
        # NOTE on type error: this is because the variable is reused with
        # another type.
        # type error: Incompatible types in assignment (expression has type "bytes", variable has type "str")
        prefix = prefix.encode("utf-8")  # type: ignore[assignment]
        ns = self.__namespace.get(prefix, None)
        if ns is not None:
            return URIRef(ns.decode("utf-8"))
        return None

    def prefix(self, namespace: URIRef) -> Optional[str]:
        # NOTE on type error: this is because the variable is reused with
        # another type.
        # type error: Incompatible types in assignment (expression has type "bytes", variable has type "URIRef")
        namespace = namespace.encode("utf-8")  # type: ignore[assignment]
        prefix = self.__prefix.get(namespace, None)
        if prefix is not None:
            return prefix.decode("utf-8")
        return None

    def namespaces(self) -> Generator[Tuple[str, URIRef], None, None]:
        cursor = self.__namespace.cursor()
        results = []
        current = cursor.first()
        while current:
            prefix, namespace = current
            results.append((prefix.decode("utf-8"), namespace.decode("utf-8")))
            # Hack to stop 2to3 converting this to next(cursor)
            current = getattr(cursor, "next")()
        cursor.close()
        for prefix, namespace in results:
            yield prefix, URIRef(namespace)

    def contexts(
        self, triple: Optional[_TripleType] = None
    ) -> Generator[_ContextType, None, None]:
        _from_string = self._from_string
        _to_string = self._to_string
        # NOTE on type errors: context is lost because of how data is loaded
        # from the DB.
        if triple:
            s: str
            p: str
            o: str
            # type error: Incompatible types in assignment (expression has type "Node", variable has type "str")
            s, p, o = triple  # type: ignore[assignment]
            # type error: Argument 1 has incompatible type "str"; expected "Node"
            s = _to_string(s)  # type: ignore[arg-type]
            # type error: Argument 1 has incompatible type "str"; expected "Node"
            p = _to_string(p)  # type: ignore[arg-type]
            # type error: Argument 1 has incompatible type "str"; expected "Node"
            o = _to_string(o)  # type: ignore[arg-type]
            contexts = self.__indicies[0].get(bb("%s^%s^%s^%s^" % ("", s, p, o)))
            if contexts:
                for c in contexts.split("^".encode("latin-1")):
                    if c:
                        # type error: Incompatible types in "yield" (actual type "Node", expected type "Graph")
                        yield _from_string(c)  # type: ignore[misc]
        else:
            index = self.__contexts
            cursor = index.cursor()
            current = cursor.first()
            cursor.close()
            while current:
                key, value = current
                context = _from_string(key)
                # type error: Incompatible types in "yield" (actual type "Node", expected type "Graph")
                yield context  # type: ignore[misc]
                cursor = index.cursor()
                try:
                    cursor.set_range(key)
                    # Hack to stop 2to3 converting this to next(cursor)
                    current = getattr(cursor, "next")()
                except db.DBNotFoundError:
                    current = None
                cursor.close()

    def add_graph(self, graph: Graph) -> None:
        self.__contexts.put(bb(self._to_string(graph)), b"")

    def remove_graph(self, graph: Graph):
        self.remove((None, None, None), graph)

    def _from_string(self, i: bytes) -> Node:
        k = self.__i2k.get(int(i))
        return self._loads(k)

    def _to_string(self, term: Node, txn: Optional[Any] = None) -> str:
        k = self._dumps(term)
        i = self.__k2i.get(k, txn=txn)
        if i is None:
            # weird behaviour from bsddb not taking a txn as a keyword argument
            # for append
            if self.transaction_aware:
                i = "%s" % self.__i2k.append(k, txn)
            else:
                i = "%s" % self.__i2k.append(k)

            self.__k2i.put(k, i.encode(), txn=txn)
        else:
            i = i.decode()
        return i

    def __lookup(
        self,
        spo: _TriplePatternType,
        context: Optional[_ContextType],
        txn: Optional[Any] = None,
    ) -> Tuple[db.DB, bytes, _FromKeyFunc, _ResultsFromKeyFunc]:
        subject, predicate, object = spo
        _to_string = self._to_string
        # NOTE on type errors: this is because the same variable is used with different types.
        if context is not None:
            # type error: Incompatible types in assignment (expression has type "str", variable has type "Optional[Graph]")
            context = _to_string(context, txn=txn)  # type: ignore[assignment]
        i = 0
        if subject is not None:
            i += 1
            # type error: Incompatible types in assignment (expression has type "str", variable has type "Node")
            subject = _to_string(subject, txn=txn)  # type: ignore[assignment]
        if predicate is not None:
            i += 2
            # type error: Incompatible types in assignment (expression has type "str", variable has type "Node")
            predicate = _to_string(predicate, txn=txn)  # type: ignore[assignment]
        if object is not None:
            i += 4
            # type error: Incompatible types in assignment (expression has type "str", variable has type "Node")
            object = _to_string(object, txn=txn)  # type: ignore[assignment]
        index, prefix_func, from_key, results_from_key = self.__lookup_dict[i]
        # print (subject, predicate, object), context, prefix_func, index
        # #DEBUG
        # type error: Argument 1 has incompatible type "Tuple[Node, Node, Node]"; expected "Tuple[str, str, str]"
        # type error: Argument 2 has incompatible type "Optional[Graph]"; expected "Optional[str]"
        prefix = bb("^".join(prefix_func((subject, predicate, object), context)))  # type: ignore[arg-type]
        return index, prefix, from_key, results_from_key


def to_key_func(i: int) -> _ToKeyFunc:
    def to_key(triple: Tuple[bytes, bytes, bytes], context: bytes) -> bytes:
        "Takes a string; returns key"
        return "^".encode("latin-1").join(
            (
                context,
                triple[i % 3],
                triple[(i + 1) % 3],
                triple[(i + 2) % 3],
                "".encode("latin-1"),
            )
        )  # "" to tac on the trailing ^

    return to_key


def from_key_func(i: int) -> _FromKeyFunc:
    def from_key(key: bytes) -> Tuple[bytes, bytes, bytes, bytes]:
        "Takes a key; returns string"
        parts = key.split("^".encode("latin-1"))
        return (
            parts[0],
            parts[(3 - i + 0) % 3 + 1],
            parts[(3 - i + 1) % 3 + 1],
            parts[(3 - i + 2) % 3 + 1],
        )

    return from_key


def results_from_key_func(
    i: int, from_string: Callable[[bytes], Node]
) -> _ResultsFromKeyFunc:
    def from_key(
        key: bytes,
        subject: Optional[Node],
        predicate: Optional[Node],
        object: Optional[Node],
        contexts_value: bytes,
    ) -> Tuple[Tuple[Node, Node, Node], Generator[Node, None, None]]:
        "Takes a key and subject, predicate, object; returns tuple for yield"
        parts = key.split("^".encode("latin-1"))
        if subject is None:
            # TODO: i & 1: # dis assemble and/or measure to see which is faster
            # subject is None or i & 1
            s = from_string(parts[(3 - i + 0) % 3 + 1])
        else:
            s = subject
        if predicate is None:  # i & 2:
            p = from_string(parts[(3 - i + 1) % 3 + 1])
        else:
            p = predicate
        if object is None:  # i & 4:
            o = from_string(parts[(3 - i + 2) % 3 + 1])
        else:
            o = object
        return (
            (s, p, o),
            (from_string(c) for c in contexts_value.split("^".encode("latin-1")) if c),
        )

    return from_key


# TODO: Remove unused
def readable_index(i: int) -> str:
    # type error: Unpacking a string is disallowed
    s, p, o = "?" * 3  # type: ignore[misc]
    if i & 1:
        s = "s"
    if i & 2:
        p = "p"
    if i & 4:
        o = "o"
    return "%s,%s,%s" % (s, p, o)
