"""
Implementation of the JSON-LD Context structure. See: http://json-ld.org/
"""

# https://github.com/RDFLib/rdflib-jsonld/blob/feature/json-ld-1.1/rdflib_jsonld/context.py
from __future__ import annotations

from collections import namedtuple
from typing import (
    TYPE_CHECKING,
    Any,
    Collection,
    Dict,
    Generator,
    List,
    Optional,
    Set,
    Tuple,
    Union,
)
from urllib.parse import urljoin, urlsplit

from rdflib.namespace import RDF

from .errors import (
    INVALID_CONTEXT_ENTRY,
    INVALID_REMOTE_CONTEXT,
    RECURSIVE_CONTEXT_INCLUSION,
)
from .keys import (
    BASE,
    CONTAINER,
    CONTEXT,
    GRAPH,
    ID,
    IMPORT,
    INCLUDED,
    INDEX,
    JSON,
    LANG,
    LIST,
    NEST,
    NONE,
    PREFIX,
    PROPAGATE,
    PROTECTED,
    REV,
    SET,
    TYPE,
    VALUE,
    VERSION,
    VOCAB,
)
from .util import norm_url, source_to_json, split_iri

NODE_KEYS = {GRAPH, ID, INCLUDED, JSON, LIST, NEST, NONE, REV, SET, TYPE, VALUE, LANG}


class Defined(int):
    pass


UNDEF = Defined(0)

# From <https://tools.ietf.org/html/rfc3986#section-2.2>
URI_GEN_DELIMS = (":", "/", "?", "#", "[", "]", "@")

_ContextSourceType = Union[
    List[Union[Dict[str, Any], str, None]], Dict[str, Any], str, None
]


class Context:
    def __init__(
        self,
        source: _ContextSourceType = None,
        base: Optional[str] = None,
        version: Optional[float] = 1.1,
    ):
        self.version: float = version or 1.1
        self.language = None
        self.vocab: Optional[str] = None
        self._base: Optional[str]
        self.base = base
        self.doc_base = base
        self.terms: Dict[str, Any] = {}
        # _alias maps NODE_KEY to list of aliases
        self._alias: Dict[str, List[str]] = {}
        self._lookup: Dict[Tuple[str, Any, Union[Defined, str], bool], Term] = {}
        self._prefixes: Dict[str, Any] = {}
        self.active = False
        self.parent: Optional[Context] = None
        self.propagate = True
        self._context_cache: Dict[str, Any] = {}
        if source:
            self.load(source)

    @property
    def base(self) -> Optional[str]:
        return self._base

    @base.setter
    def base(self, base: Optional[str]):
        if base:
            hash_index = base.find("#")
            if hash_index > -1:
                base = base[0:hash_index]
        self._base = (
            self.resolve_iri(base)
            if (hasattr(self, "_base") and base is not None)
            else base
        )
        self._basedomain = "%s://%s" % urlsplit(base)[0:2] if base else None

    def subcontext(self, source: Any, propagate: bool = True) -> Context:
        # IMPROVE: to optimize, implement SubContext with parent fallback support
        parent = self.parent if self.propagate is False else self
        # type error: Item "None" of "Optional[Context]" has no attribute "_subcontext"
        return parent._subcontext(source, propagate)  # type: ignore[union-attr]

    def _subcontext(self, source: Any, propagate: bool) -> Context:
        ctx = Context(version=self.version)
        ctx.propagate = propagate
        ctx.parent = self
        ctx.language = self.language
        ctx.vocab = self.vocab
        ctx.base = self.base
        ctx.doc_base = self.doc_base
        ctx._alias = {k: l[:] for k, l in self._alias.items()}  # noqa: E741
        ctx.terms = self.terms.copy()
        ctx._lookup = self._lookup.copy()
        ctx._prefixes = self._prefixes.copy()
        ctx._context_cache = self._context_cache
        ctx.load(source)
        return ctx

    def _clear(self) -> None:
        self.language = None
        self.vocab = None
        self.terms = {}
        self._alias = {}
        self._lookup = {}
        self._prefixes = {}
        self.active = False
        self.propagate = True

    def get_context_for_term(self, term: Optional[Term]) -> Context:
        if term and term.context is not UNDEF:
            return self._subcontext(term.context, propagate=True)
        return self

    def get_context_for_type(self, node: Any) -> Optional[Context]:
        if self.version >= 1.1:
            rtype = self.get_type(node) if isinstance(node, dict) else None
            if not isinstance(rtype, list):
                rtype = [rtype] if rtype else []

            typeterm = None
            for rt in rtype:
                try:
                    typeterm = self.terms.get(rt)
                except TypeError:
                    # extra lenience, triggers if type is set to a literal
                    pass
                if typeterm is not None:
                    break

            if typeterm and typeterm.context:
                subcontext = self.subcontext(typeterm.context, propagate=False)
                if subcontext:
                    return subcontext

        return self.parent if self.propagate is False else self

    def get_id(self, obj: Dict[str, Any]) -> Any:
        return self._get(obj, ID)

    def get_type(self, obj: Dict[str, Any]) -> Any:
        return self._get(obj, TYPE)

    def get_language(self, obj: Dict[str, Any]) -> Any:
        return self._get(obj, LANG)

    def get_value(self, obj: Dict[str, Any]) -> Any:
        return self._get(obj, VALUE)

    def get_graph(self, obj: Dict[str, Any]) -> Any:
        return self._get(obj, GRAPH)

    def get_list(self, obj: Dict[str, Any]) -> Any:
        return self._get(obj, LIST)

    def get_set(self, obj: Dict[str, Any]) -> Any:
        return self._get(obj, SET)

    def get_rev(self, obj: Dict[str, Any]) -> Any:
        return self._get(obj, REV)

    def _get(self, obj: Dict[str, Any], key: str) -> Any:
        for alias in self._alias.get(key, []):
            if alias in obj:
                return obj.get(alias)
        return obj.get(key)

    # type error: Missing return statement
    def get_key(self, key: str) -> str:  # type: ignore[return]
        for alias in self.get_keys(key):
            return alias

    def get_keys(self, key: str) -> Generator[str, None, None]:
        if key in self._alias:
            for alias in self._alias[key]:
                yield alias
        yield key

    lang_key = property(lambda self: self.get_key(LANG))
    id_key = property(lambda self: self.get_key(ID))
    type_key = property(lambda self: self.get_key(TYPE))
    value_key = property(lambda self: self.get_key(VALUE))
    list_key = property(lambda self: self.get_key(LIST))
    rev_key = property(lambda self: self.get_key(REV))
    graph_key = property(lambda self: self.get_key(GRAPH))

    def add_term(
        self,
        name: str,
        idref: str,
        coercion: Union[Defined, str] = UNDEF,
        container: Union[Collection[Any], str, Defined] = UNDEF,
        index: Optional[Union[str, Defined]] = None,
        language: Optional[Union[str, Defined]] = UNDEF,
        reverse: bool = False,
        context: Any = UNDEF,
        prefix: Optional[bool] = None,
        protected: bool = False,
    ):
        if self.version < 1.1 or prefix is None:
            prefix = isinstance(idref, str) and idref.endswith(URI_GEN_DELIMS)

        if not self._accept_term(name):
            return

        if self.version >= 1.1:
            existing = self.terms.get(name)
            if existing and existing.protected:
                return

        if isinstance(container, (list, set, tuple)):
            container = set(container)
        elif container is not UNDEF:
            container = set([container])
        else:
            container = set()

        term = Term(
            idref,
            name,
            coercion,
            container,
            index,
            language,
            reverse,
            context,
            prefix,
            protected,
        )

        self.terms[name] = term

        container_key: Union[Defined, str]
        for container_key in (LIST, LANG, SET):  # , INDEX, ID, GRAPH):
            if container_key in container:
                break
        else:
            container_key = UNDEF

        self._lookup[(idref, coercion or language, container_key, reverse)] = term

        if term.prefix is True:
            self._prefixes[idref] = name

    def find_term(
        self,
        idref: str,
        coercion: Optional[Union[str, Defined]] = None,
        container: Union[Defined, str] = UNDEF,
        language: Optional[str] = None,
        reverse: bool = False,
    ):
        lu = self._lookup

        if coercion is None:
            coercion = language

        if coercion is not UNDEF and container:
            found = lu.get((idref, coercion, container, reverse))
            if found:
                return found

        if coercion is not UNDEF:
            found = lu.get((idref, coercion, UNDEF, reverse))
            if found:
                return found

        if container:
            found = lu.get((idref, coercion, container, reverse))
            if found:
                return found
        elif language:
            found = lu.get((idref, UNDEF, LANG, reverse))
            if found:
                return found
        else:
            found = lu.get((idref, coercion or UNDEF, SET, reverse))
            if found:
                return found

        return lu.get((idref, UNDEF, UNDEF, reverse))

    def resolve(self, curie_or_iri: str) -> str:
        iri = self.expand(curie_or_iri, False)
        # type error: Argument 1 to "isblank" of "Context" has incompatible type "Optional[str]"; expected "str"
        if self.isblank(iri):  # type: ignore[arg-type]
            # type error: Incompatible return value type (got "Optional[str]", expected "str")
            return iri  # type: ignore[return-value]
        # type error: Unsupported right operand type for in ("Optional[str]")
        if " " in iri:  # type: ignore[operator]
            return ""
        # type error: Argument 1 to "resolve_iri" of "Context" has incompatible type "Optional[str]"; expected "str"
        return self.resolve_iri(iri)  # type: ignore[arg-type]

    def resolve_iri(self, iri: str) -> str:
        # type error: Argument 1 to "norm_url" has incompatible type "Optional[str]"; expected "str"
        return norm_url(self._base, iri)  # type: ignore[arg-type]

    def isblank(self, ref: str) -> bool:
        return ref.startswith("_:")

    def expand(self, term_curie_or_iri: Any, use_vocab: bool = True) -> Optional[str]:
        if not isinstance(term_curie_or_iri, str):
            return term_curie_or_iri

        if not self._accept_term(term_curie_or_iri):
            return ""

        if use_vocab:
            term = self.terms.get(term_curie_or_iri)
            if term:
                return term.id

        is_term, pfx, local = self._prep_expand(term_curie_or_iri)
        if pfx == "_":
            return term_curie_or_iri

        if pfx is not None:
            ns = self.terms.get(pfx)
            if ns and ns.prefix and ns.id:
                return ns.id + local
        elif is_term and use_vocab:
            if self.vocab:
                return self.vocab + term_curie_or_iri
            return None

        return self.resolve_iri(term_curie_or_iri)

    def shrink_iri(self, iri: str) -> str:
        ns, name = split_iri(str(iri))
        pfx = self._prefixes.get(ns)
        if pfx:
            # type error: Argument 1 to "join" of "str" has incompatible type "Tuple[Any, Optional[str]]"; expected "Iterable[str]"
            return ":".join((pfx, name))  # type: ignore[arg-type]
        elif self._base:
            if str(iri) == self._base:
                return ""
            # type error: Argument 1 to "startswith" of "str" has incompatible type "Optional[str]"; expected "Union[str, Tuple[str, ...]]"
            elif iri.startswith(self._basedomain):  # type: ignore[arg-type]
                # type error: Argument 1 to "len" has incompatible type "Optional[str]"; expected "Sized"
                return iri[len(self._basedomain) :]  # type: ignore[arg-type]
        return iri

    def to_symbol(self, iri: str) -> Optional[str]:
        iri = str(iri)
        term = self.find_term(iri)
        if term:
            return term.name
        ns, name = split_iri(iri)
        if ns == self.vocab:
            return name
        pfx = self._prefixes.get(ns)
        if pfx:
            # type error: Argument 1 to "join" of "str" has incompatible type "Tuple[Any, Optional[str]]"; expected "Iterable[str]"
            return ":".join((pfx, name))  # type: ignore[arg-type]
        return iri

    def load(
        self,
        source: _ContextSourceType,
        base: Optional[str] = None,
        referenced_contexts: Set[Any] = None,
    ):
        self.active = True
        sources: List[Tuple[Optional[str], Union[Dict[str, Any], str, None]]] = []
        # "Union[List[Union[Dict[str, Any], str]], List[Dict[str, Any]], List[str]]" : expression
        # "Union[List[Dict[str, Any]], Dict[str, Any], List[str], str]" : variable
        source = source if isinstance(source, list) else [source]
        referenced_contexts = referenced_contexts or set()
        self._prep_sources(base, source, sources, referenced_contexts)
        for source_url, source in sources:
            if source is None:
                self._clear()
            else:
                # type error: Argument 1 to "_read_source" of "Context" has incompatible type "Union[Dict[str, Any], str]"; expected "Dict[str, Any]"
                self._read_source(source, source_url, referenced_contexts)  # type: ignore[arg-type]

    def _accept_term(self, key: str) -> bool:
        if self.version < 1.1:
            return True
        if key and len(key) > 1 and key[0] == "@" and key[1].isalnum():
            return key in NODE_KEYS
        else:
            return True

    def _prep_sources(
        self,
        base: Optional[str],
        inputs: Union[List[Union[Dict[str, Any], str, None]], List[str]],
        sources: List[Tuple[Optional[str], Union[Dict[str, Any], str, None]]],
        referenced_contexts: Set[str],
        in_source_url: Optional[str] = None,
    ):
        for source in inputs:
            source_url = in_source_url
            new_base = base
            if isinstance(source, str):
                source_url = source
                source_doc_base = base or self.doc_base
                new_ctx = self._fetch_context(
                    source, source_doc_base, referenced_contexts
                )
                if new_ctx is None:
                    continue
                else:
                    if base:
                        if TYPE_CHECKING:
                            # if base is not None, then source_doc_base won't be
                            # none due to how it is assigned.
                            assert source_doc_base is not None
                        new_base = urljoin(source_doc_base, source_url)
                    source = new_ctx

            if isinstance(source, dict):
                if CONTEXT in source:
                    source = source[CONTEXT]
                    # type ignore: Incompatible types in assignment (expression has type "List[Union[Dict[str, Any], str, None]]", variable has type "Union[Dict[str, Any], str, None]")
                    source = source if isinstance(source, list) else [source]  # type: ignore[assignment]

            if isinstance(source, list):
                # type error: Statement is unreachable
                self._prep_sources(  # type: ignore[unreachable]
                    new_base, source, sources, referenced_contexts, source_url
                )
            else:
                sources.append((source_url, source))

    def _fetch_context(
        self, source: str, base: Optional[str], referenced_contexts: Set[str]
    ):
        # type error: Value of type variable "AnyStr" of "urljoin" cannot be "Optional[str]"
        source_url = urljoin(base, source)  # type: ignore[type-var]

        if source_url in referenced_contexts:
            raise RECURSIVE_CONTEXT_INCLUSION

        # type error: Argument 1 to "add" of "set" has incompatible type "Optional[str]"; expected "str"
        referenced_contexts.add(source_url)  # type: ignore[arg-type]

        if source_url in self._context_cache:
            return self._context_cache[source_url]

        # type error: Incompatible types in assignment (expression has type "Optional[Any]", variable has type "str")
        source_json, _ = source_to_json(source_url)
        if source_json and CONTEXT not in source_json:
            raise INVALID_REMOTE_CONTEXT

        # type error: Invalid index type "Optional[str]" for "Dict[str, Any]"; expected type "str"
        self._context_cache[source_url] = source_json  # type: ignore[index]

        return source_json

    def _read_source(
        self,
        source: Dict[str, Any],
        source_url: Optional[str] = None,
        referenced_contexts: Optional[Set[str]] = None,
    ):
        imports = source.get(IMPORT)
        if imports:
            if not isinstance(imports, str):
                raise INVALID_CONTEXT_ENTRY

            imported = self._fetch_context(
                imports, self.base, referenced_contexts or set()
            )
            if not isinstance(imported, dict):
                raise INVALID_CONTEXT_ENTRY

            imported = imported[CONTEXT]
            imported.update(source)
            source = imported

        self.vocab = source.get(VOCAB, self.vocab)
        self.version = source.get(VERSION, self.version)
        protected = source.get(PROTECTED, False)

        for key, value in source.items():
            if key in {VOCAB, VERSION, IMPORT, PROTECTED}:
                continue
            elif key == PROPAGATE and isinstance(value, bool):
                self.propagate = value
            elif key == LANG:
                self.language = value
            elif key == BASE:
                if not source_url and not imports:
                    self.base = value
            else:
                self._read_term(source, key, value, protected)

    def _read_term(
        self,
        source: Dict[str, Any],
        name: str,
        dfn: Union[Dict[str, Any], str],
        protected: bool = False,
    ) -> None:
        idref = None
        if isinstance(dfn, dict):
            # term = self._create_term(source, key, value)
            rev = dfn.get(REV)
            protected = dfn.get(PROTECTED, protected)

            coercion = dfn.get(TYPE, UNDEF)
            if coercion and coercion not in (ID, TYPE, VOCAB):
                coercion = self._rec_expand(source, coercion)

            idref = rev or dfn.get(ID, UNDEF)
            if idref == TYPE:
                idref = str(RDF.type)
                coercion = VOCAB
            elif idref is not UNDEF:
                idref = self._rec_expand(source, idref)
            elif ":" in name:
                idref = self._rec_expand(source, name)
            elif self.vocab:
                idref = self.vocab + name

            context = dfn.get(CONTEXT, UNDEF)

            self.add_term(
                name,
                idref,
                coercion,
                dfn.get(CONTAINER, UNDEF),
                dfn.get(INDEX, UNDEF),
                dfn.get(LANG, UNDEF),
                bool(rev),
                context,
                dfn.get(PREFIX),
                protected=protected,
            )
        else:
            if isinstance(dfn, str):
                if not self._accept_term(dfn):
                    return
                idref = self._rec_expand(source, dfn)
            # type error: Argument 2 to "add_term" of "Context" has incompatible type "Optional[str]"; expected "str"
            self.add_term(name, idref, protected=protected)  # type: ignore[arg-type]

        if idref in NODE_KEYS:
            self._alias.setdefault(idref, []).append(name)
        else:
            # undo aliases that may have been inherited from parent context
            for v in self._alias.values():
                if name in v:
                    v.remove(name)

    def _rec_expand(
        self, source: Dict[str, Any], expr: Optional[str], prev: Optional[str] = None
    ) -> Optional[str]:
        if expr == prev or expr in NODE_KEYS:
            return expr

        nxt: Optional[str]
        # type error: Argument 1 to "_prep_expand" of "Context" has incompatible type "Optional[str]"; expected "str"
        is_term, pfx, nxt = self._prep_expand(expr)  # type: ignore[arg-type]
        if pfx:
            iri = self._get_source_id(source, pfx)
            if iri is None:
                if pfx + ":" == self.vocab:
                    return expr
                else:
                    term = self.terms.get(pfx)
                    if term:
                        iri = term.id

            if iri is None:
                nxt = expr
            else:
                nxt = iri + nxt
        else:
            nxt = self._get_source_id(source, nxt) or nxt
            if ":" not in nxt and self.vocab:
                return self.vocab + nxt

        return self._rec_expand(source, nxt, expr)

    def _prep_expand(self, expr: str) -> Tuple[bool, Optional[str], str]:
        if ":" not in expr:
            return True, None, expr
        pfx, local = expr.split(":", 1)
        if not local.startswith("//"):
            return False, pfx, local
        else:
            return False, None, expr

    def _get_source_id(self, source: Dict[str, Any], key: str) -> Optional[str]:
        # .. from source dict or if already defined
        term = source.get(key)
        if term is None:
            dfn = self.terms.get(key)
            if dfn:
                term = dfn.id
        elif isinstance(term, dict):
            term = term.get(ID)
        return term

    def _term_dict(self, term: Term) -> Union[Dict[str, Any], str]:
        tdict: Dict[str, Any] = {}
        if term.type != UNDEF:
            tdict[TYPE] = self.shrink_iri(term.type)
        if term.container:
            tdict[CONTAINER] = list(term.container)
        if term.language != UNDEF:
            tdict[LANG] = term.language
        if term.reverse:
            tdict[REV] = term.id
        else:
            tdict[ID] = term.id
        if tdict.keys() == {ID}:
            return tdict[ID]
        return tdict

    def to_dict(self) -> Dict[str, Any]:
        """
        Returns a dictionary representation of the context that can be
        serialized to JSON.

        Returns:
            a dictionary representation of the context.
        """
        r = {v: k for (k, v) in self._prefixes.items()}
        r.update({term.name: self._term_dict(term) for term in self._lookup.values()})
        if self.base:
            r[BASE] = self.base
        if self.language:
            r[LANG] = self.language
        return r


Term = namedtuple(
    "Term",
    "id, name, type, container, index, language, reverse, context," "prefix, protected",
)

Term.__new__.__defaults__ = (UNDEF, UNDEF, UNDEF, UNDEF, False, UNDEF, False, False)
