"""Pickler class to extend the standard pickle.Pickler functionality

The main objective is to make it natural to perform distributed computing on
clusters (such as PySpark, Dask, Ray...) with interactively defined code
(functions, classes, ...) written in notebooks or console.

In particular this pickler adds the following features:
- serialize interactively-defined or locally-defined functions, classes,
  enums, typevars, lambdas and nested functions to compiled byte code;
- deal with some other non-serializable objects in an ad-hoc manner where
  applicable.

This pickler is therefore meant to be used for the communication between short
lived Python processes running the same version of Python and libraries. In
particular, it is not meant to be used for long term storage of Python objects.

It does not include an unpickler, as standard Python unpickling suffices.

This module was extracted from the `cloud` package, developed by `PiCloud, Inc.
<https://web.archive.org/web/20140626004012/http://www.picloud.com/>`_.

Copyright (c) 2012-now, CloudPickle developers and contributors.
Copyright (c) 2012, Regents of the University of California.
Copyright (c) 2009 `PiCloud, Inc. <https://web.archive.org/web/20140626004012/http://www.picloud.com/>`_.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * Neither the name of the University of California, Berkeley nor the
      names of its contributors may be used to endorse or promote
      products derived from this software without specific prior written
      permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED
TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
"""

import _collections_abc
from collections import ChainMap, OrderedDict
import abc
import builtins
import copyreg
import dataclasses
import dis
from enum import Enum
import io
import itertools
import logging
import opcode
import pickle
from pickle import _getattribute as _pickle_getattribute
import platform
import struct
import sys
import threading
import types
import typing
import uuid
import warnings
import weakref

# The following import is required to be imported in the cloudpickle
# namespace to be able to load pickle files generated with older versions of
# cloudpickle. See: tests/test_backward_compat.py
from types import CellType  # noqa: F401


# cloudpickle is meant for inter process communication: we expect all
# communicating processes to run the same Python version hence we favor
# communication speed over compatibility:
DEFAULT_PROTOCOL = pickle.HIGHEST_PROTOCOL

# Names of modules whose resources should be treated as dynamic.
_PICKLE_BY_VALUE_MODULES = set()

# Track the provenance of reconstructed dynamic classes to make it possible to
# reconstruct instances from the matching singleton class definition when
# appropriate and preserve the usual "isinstance" semantics of Python objects.
_DYNAMIC_CLASS_TRACKER_BY_CLASS = weakref.WeakKeyDictionary()
_DYNAMIC_CLASS_TRACKER_BY_ID = weakref.WeakValueDictionary()
_DYNAMIC_CLASS_TRACKER_LOCK = threading.Lock()

PYPY = platform.python_implementation() == "PyPy"

builtin_code_type = None
if PYPY:
    # builtin-code objects only exist in pypy
    builtin_code_type = type(float.__new__.__code__)

_extract_code_globals_cache = weakref.WeakKeyDictionary()


def _get_or_create_tracker_id(class_def):
    with _DYNAMIC_CLASS_TRACKER_LOCK:
        class_tracker_id = _DYNAMIC_CLASS_TRACKER_BY_CLASS.get(class_def)
        if class_tracker_id is None:
            class_tracker_id = uuid.uuid4().hex
            _DYNAMIC_CLASS_TRACKER_BY_CLASS[class_def] = class_tracker_id
            _DYNAMIC_CLASS_TRACKER_BY_ID[class_tracker_id] = class_def
    return class_tracker_id


def _lookup_class_or_track(class_tracker_id, class_def):
    if class_tracker_id is not None:
        with _DYNAMIC_CLASS_TRACKER_LOCK:
            class_def = _DYNAMIC_CLASS_TRACKER_BY_ID.setdefault(
                class_tracker_id, class_def
            )
            _DYNAMIC_CLASS_TRACKER_BY_CLASS[class_def] = class_tracker_id
    return class_def


def register_pickle_by_value(module):
    """Register a module to make its functions and classes picklable by value.

    By default, functions and classes that are attributes of an importable
    module are to be pickled by reference, that is relying on re-importing
    the attribute from the module at load time.

    If `register_pickle_by_value(module)` is called, all its functions and
    classes are subsequently to be pickled by value, meaning that they can
    be loaded in Python processes where the module is not importable.

    This is especially useful when developing a module in a distributed
    execution environment: restarting the client Python process with the new
    source code is enough: there is no need to re-install the new version
    of the module on all the worker nodes nor to restart the workers.

    Note: this feature is considered experimental. See the cloudpickle
    README.md file for more details and limitations.
    """
    if not isinstance(module, types.ModuleType):
        raise ValueError(f"Input should be a module object, got {str(module)} instead")
    # In the future, cloudpickle may need a way to access any module registered
    # for pickling by value in order to introspect relative imports inside
    # functions pickled by value. (see
    # https://github.com/cloudpipe/cloudpickle/pull/417#issuecomment-873684633).
    # This access can be ensured by checking that module is present in
    # sys.modules at registering time and assuming that it will still be in
    # there when accessed during pickling. Another alternative would be to
    # store a weakref to the module. Even though cloudpickle does not implement
    # this introspection yet, in order to avoid a possible breaking change
    # later, we still enforce the presence of module inside sys.modules.
    if module.__name__ not in sys.modules:
        raise ValueError(
            f"{module} was not imported correctly, have you used an "
            "`import` statement to access it?"
        )
    _PICKLE_BY_VALUE_MODULES.add(module.__name__)


def unregister_pickle_by_value(module):
    """Unregister that the input module should be pickled by value."""
    if not isinstance(module, types.ModuleType):
        raise ValueError(f"Input should be a module object, got {str(module)} instead")
    if module.__name__ not in _PICKLE_BY_VALUE_MODULES:
        raise ValueError(f"{module} is not registered for pickle by value")
    else:
        _PICKLE_BY_VALUE_MODULES.remove(module.__name__)


def list_registry_pickle_by_value():
    return _PICKLE_BY_VALUE_MODULES.copy()


def _is_registered_pickle_by_value(module):
    module_name = module.__name__
    if module_name in _PICKLE_BY_VALUE_MODULES:
        return True
    while True:
        parent_name = module_name.rsplit(".", 1)[0]
        if parent_name == module_name:
            break
        if parent_name in _PICKLE_BY_VALUE_MODULES:
            return True
        module_name = parent_name
    return False


if sys.version_info >= (3, 14):
    def _getattribute(obj, name):
        return _pickle_getattribute(obj, name.split('.'))
else:
    def _getattribute(obj, name):
        return _pickle_getattribute(obj, name)[0]


def _whichmodule(obj, name):
    """Find the module an object belongs to.

    This function differs from ``pickle.whichmodule`` in two ways:
    - it does not mangle the cases where obj's module is __main__ and obj was
      not found in any module.
    - Errors arising during module introspection are ignored, as those errors
      are considered unwanted side effects.
    """
    module_name = getattr(obj, "__module__", None)

    if module_name is not None:
        return module_name
    # Protect the iteration by using a copy of sys.modules against dynamic
    # modules that trigger imports of other modules upon calls to getattr or
    # other threads importing at the same time.
    for module_name, module in sys.modules.copy().items():
        # Some modules such as coverage can inject non-module objects inside
        # sys.modules
        if (
            module_name == "__main__"
            or module_name == "__mp_main__"
            or module is None
            or not isinstance(module, types.ModuleType)
        ):
            continue
        try:
            if _getattribute(module, name) is obj:
                return module_name
        except Exception:
            pass
    return None


def _should_pickle_by_reference(obj, name=None):
    """Test whether an function or a class should be pickled by reference

    Pickling by reference means by that the object (typically a function or a
    class) is an attribute of a module that is assumed to be importable in the
    target Python environment. Loading will therefore rely on importing the
    module and then calling `getattr` on it to access the function or class.

    Pickling by reference is the only option to pickle functions and classes
    in the standard library. In cloudpickle the alternative option is to
    pickle by value (for instance for interactively or locally defined
    functions and classes or for attributes of modules that have been
    explicitly registered to be pickled by value.
    """
    if isinstance(obj, types.FunctionType) or issubclass(type(obj), type):
        module_and_name = _lookup_module_and_qualname(obj, name=name)
        if module_and_name is None:
            return False
        module, name = module_and_name
        return not _is_registered_pickle_by_value(module)

    elif isinstance(obj, types.ModuleType):
        # We assume that sys.modules is primarily used as a cache mechanism for
        # the Python import machinery. Checking if a module has been added in
        # is sys.modules therefore a cheap and simple heuristic to tell us
        # whether we can assume that a given module could be imported by name
        # in another Python process.
        if _is_registered_pickle_by_value(obj):
            return False
        return obj.__name__ in sys.modules
    else:
        raise TypeError(
            "cannot check importability of {} instances".format(type(obj).__name__)
        )


def _lookup_module_and_qualname(obj, name=None):
    if name is None:
        name = getattr(obj, "__qualname__", None)
    if name is None:  # pragma: no cover
        # This used to be needed for Python 2.7 support but is probably not
        # needed anymore. However we keep the __name__ introspection in case
        # users of cloudpickle rely on this old behavior for unknown reasons.
        name = getattr(obj, "__name__", None)

    module_name = _whichmodule(obj, name)

    if module_name is None:
        # In this case, obj.__module__ is None AND obj was not found in any
        # imported module. obj is thus treated as dynamic.
        return None

    if module_name == "__main__":
        return None

    # Note: if module_name is in sys.modules, the corresponding module is
    # assumed importable at unpickling time. See #357
    module = sys.modules.get(module_name, None)
    if module is None:
        # The main reason why obj's module would not be imported is that this
        # module has been dynamically created, using for example
        # types.ModuleType. The other possibility is that module was removed
        # from sys.modules after obj was created/imported. But this case is not
        # supported, as the standard pickle does not support it either.
        return None

    try:
        obj2 = _getattribute(module, name)
    except AttributeError:
        # obj was not found inside the module it points to
        return None
    if obj2 is not obj:
        return None
    return module, name


def _extract_code_globals(co):
    """Find all globals names read or written to by codeblock co."""
    out_names = _extract_code_globals_cache.get(co)
    if out_names is None:
        # We use a dict with None values instead of a set to get a
        # deterministic order and avoid introducing non-deterministic pickle
        # bytes as a results.
        out_names = {name: None for name in _walk_global_ops(co)}

        # Declaring a function inside another one using the "def ..." syntax
        # generates a constant code object corresponding to the one of the
        # nested function's As the nested function may itself need global
        # variables, we need to introspect its code, extract its globals, (look
        # for code object in it's co_consts attribute..) and add the result to
        # code_globals
        if co.co_consts:
            for const in co.co_consts:
                if isinstance(const, types.CodeType):
                    out_names.update(_extract_code_globals(const))

        _extract_code_globals_cache[co] = out_names

    return out_names


def _find_imported_submodules(code, top_level_dependencies):
    """Find currently imported submodules used by a function.

    Submodules used by a function need to be detected and referenced for the
    function to work correctly at depickling time. Because submodules can be
    referenced as attribute of their parent package (``package.submodule``), we
    need a special introspection technique that does not rely on GLOBAL-related
    opcodes to find references of them in a code object.

    Example:
    ```
    import concurrent.futures
    import cloudpickle
    def func():
        x = concurrent.futures.ThreadPoolExecutor
    if __name__ == '__main__':
        cloudpickle.dumps(func)
    ```
    The globals extracted by cloudpickle in the function's state include the
    concurrent package, but not its submodule (here, concurrent.futures), which
    is the module used by func. Find_imported_submodules will detect the usage
    of concurrent.futures. Saving this module alongside with func will ensure
    that calling func once depickled does not fail due to concurrent.futures
    not being imported
    """

    subimports = []
    # check if any known dependency is an imported package
    for x in top_level_dependencies:
        if (
            isinstance(x, types.ModuleType)
            and hasattr(x, "__package__")
            and x.__package__
        ):
            # check if the package has any currently loaded sub-imports
            prefix = x.__name__ + "."
            # A concurrent thread could mutate sys.modules,
            # make sure we iterate over a copy to avoid exceptions
            for name in list(sys.modules):
                # Older versions of pytest will add a "None" module to
                # sys.modules.
                if name is not None and name.startswith(prefix):
                    # check whether the function can address the sub-module
                    tokens = set(name[len(prefix) :].split("."))
                    if not tokens - set(code.co_names):
                        subimports.append(sys.modules[name])
    return subimports


# relevant opcodes
STORE_GLOBAL = opcode.opmap["STORE_GLOBAL"]
DELETE_GLOBAL = opcode.opmap["DELETE_GLOBAL"]
LOAD_GLOBAL = opcode.opmap["LOAD_GLOBAL"]
GLOBAL_OPS = (STORE_GLOBAL, DELETE_GLOBAL, LOAD_GLOBAL)
HAVE_ARGUMENT = dis.HAVE_ARGUMENT
EXTENDED_ARG = dis.EXTENDED_ARG


_BUILTIN_TYPE_NAMES = {}
for k, v in types.__dict__.items():
    if type(v) is type:
        _BUILTIN_TYPE_NAMES[v] = k


def _builtin_type(name):
    if name == "ClassType":  # pragma: no cover
        # Backward compat to load pickle files generated with cloudpickle
        # < 1.3 even if loading pickle files from older versions is not
        # officially supported.
        return type
    return getattr(types, name)


def _walk_global_ops(code):
    """Yield referenced name for global-referencing instructions in code."""
    for instr in dis.get_instructions(code):
        op = instr.opcode
        if op in GLOBAL_OPS:
            yield instr.argval


def _extract_class_dict(cls):
    """Retrieve a copy of the dict of a class without the inherited method."""
    # Hack to circumvent non-predictable memoization caused by string interning.
    # See the inline comment in _class_setstate for details.
    clsdict = {"".join(k): cls.__dict__[k] for k in sorted(cls.__dict__)}

    if len(cls.__bases__) == 1:
        inherited_dict = cls.__bases__[0].__dict__
    else:
        inherited_dict = {}
        for base in reversed(cls.__bases__):
            inherited_dict.update(base.__dict__)
    to_remove = []
    for name, value in clsdict.items():
        try:
            base_value = inherited_dict[name]
            if value is base_value:
                to_remove.append(name)
        except KeyError:
            pass
    for name in to_remove:
        clsdict.pop(name)
    return clsdict


def is_tornado_coroutine(func):
    """Return whether `func` is a Tornado coroutine function.

    Running coroutines are not supported.
    """
    warnings.warn(
        "is_tornado_coroutine is deprecated in cloudpickle 3.0 and will be "
        "removed in cloudpickle 4.0. Use tornado.gen.is_coroutine_function "
        "directly instead.",
        category=DeprecationWarning,
    )
    if "tornado.gen" not in sys.modules:
        return False
    gen = sys.modules["tornado.gen"]
    if not hasattr(gen, "is_coroutine_function"):
        # Tornado version is too old
        return False
    return gen.is_coroutine_function(func)


def subimport(name):
    # We cannot do simply: `return __import__(name)`: Indeed, if ``name`` is
    # the name of a submodule, __import__ will return the top-level root module
    # of this submodule. For instance, __import__('os.path') returns the `os`
    # module.
    __import__(name)
    return sys.modules[name]


def dynamic_subimport(name, vars):
    mod = types.ModuleType(name)
    mod.__dict__.update(vars)
    mod.__dict__["__builtins__"] = builtins.__dict__
    return mod


def _get_cell_contents(cell):
    try:
        return cell.cell_contents
    except ValueError:
        # Handle empty cells explicitly with a sentinel value.
        return _empty_cell_value


def instance(cls):
    """Create a new instance of a class.

    Parameters
    ----------
    cls : type
        The class to create an instance of.

    Returns
    -------
    instance : cls
        A new instance of ``cls``.
    """
    return cls()


@instance
class _empty_cell_value:
    """Sentinel for empty closures."""

    @classmethod
    def __reduce__(cls):
        return cls.__name__


def _make_function(code, globals, name, argdefs, closure):
    # Setting __builtins__ in globals is needed for nogil CPython.
    globals["__builtins__"] = __builtins__
    return types.FunctionType(code, globals, name, argdefs, closure)


def _make_empty_cell():
    if False:
        # trick the compiler into creating an empty cell in our lambda
        cell = None
        raise AssertionError("this route should not be executed")

    return (lambda: cell).__closure__[0]


def _make_cell(value=_empty_cell_value):
    cell = _make_empty_cell()
    if value is not _empty_cell_value:
        cell.cell_contents = value
    return cell


def _make_skeleton_class(
    type_constructor, name, bases, type_kwargs, class_tracker_id, extra
):
    """Build dynamic class with an empty __dict__ to be filled once memoized

    If class_tracker_id is not None, try to lookup an existing class definition
    matching that id. If none is found, track a newly reconstructed class
    definition under that id so that other instances stemming from the same
    class id will also reuse this class definition.

    The "extra" variable is meant to be a dict (or None) that can be used for
    forward compatibility shall the need arise.
    """
    # We need to intern the keys of the type_kwargs dict to avoid having
    # different pickles for the same dynamic class depending on whether it was
    # dynamically created or reconstructed from a pickled stream.
    type_kwargs = {sys.intern(k): v for k, v in type_kwargs.items()}

    skeleton_class = types.new_class(
        name, bases, {"metaclass": type_constructor}, lambda ns: ns.update(type_kwargs)
    )

    return _lookup_class_or_track(class_tracker_id, skeleton_class)


def _make_skeleton_enum(
    bases, name, qualname, members, module, class_tracker_id, extra
):
    """Build dynamic enum with an empty __dict__ to be filled once memoized

    The creation of the enum class is inspired by the code of
    EnumMeta._create_.

    If class_tracker_id is not None, try to lookup an existing enum definition
    matching that id. If none is found, track a newly reconstructed enum
    definition under that id so that other instances stemming from the same
    class id will also reuse this enum definition.

    The "extra" variable is meant to be a dict (or None) that can be used for
    forward compatibility shall the need arise.
    """
    # enums always inherit from their base Enum class at the last position in
    # the list of base classes:
    enum_base = bases[-1]
    metacls = enum_base.__class__
    classdict = metacls.__prepare__(name, bases)

    for member_name, member_value in members.items():
        classdict[member_name] = member_value
    enum_class = metacls.__new__(metacls, name, bases, classdict)
    enum_class.__module__ = module
    enum_class.__qualname__ = qualname

    return _lookup_class_or_track(class_tracker_id, enum_class)


def _make_typevar(name, bound, constraints, covariant, contravariant, class_tracker_id):
    tv = typing.TypeVar(
        name,
        *constraints,
        bound=bound,
        covariant=covariant,
        contravariant=contravariant,
    )
    return _lookup_class_or_track(class_tracker_id, tv)


def _decompose_typevar(obj):
    return (
        obj.__name__,
        obj.__bound__,
        obj.__constraints__,
        obj.__covariant__,
        obj.__contravariant__,
        _get_or_create_tracker_id(obj),
    )


def _typevar_reduce(obj):
    # TypeVar instances require the module information hence why we
    # are not using the _should_pickle_by_reference directly
    module_and_name = _lookup_module_and_qualname(obj, name=obj.__name__)

    if module_and_name is None:
        return (_make_typevar, _decompose_typevar(obj))
    elif _is_registered_pickle_by_value(module_and_name[0]):
        return (_make_typevar, _decompose_typevar(obj))

    return (getattr, module_and_name)


def _get_bases(typ):
    if "__orig_bases__" in getattr(typ, "__dict__", {}):
        # For generic types (see PEP 560)
        # Note that simply checking `hasattr(typ, '__orig_bases__')` is not
        # correct.  Subclasses of a fully-parameterized generic class does not
        # have `__orig_bases__` defined, but `hasattr(typ, '__orig_bases__')`
        # will return True because it's defined in the base class.
        bases_attr = "__orig_bases__"
    else:
        # For regular class objects
        bases_attr = "__bases__"
    return getattr(typ, bases_attr)


def _make_dict_keys(obj, is_ordered=False):
    if is_ordered:
        return OrderedDict.fromkeys(obj).keys()
    else:
        return dict.fromkeys(obj).keys()


def _make_dict_values(obj, is_ordered=False):
    if is_ordered:
        return OrderedDict((i, _) for i, _ in enumerate(obj)).values()
    else:
        return {i: _ for i, _ in enumerate(obj)}.values()


def _make_dict_items(obj, is_ordered=False):
    if is_ordered:
        return OrderedDict(obj).items()
    else:
        return obj.items()


# COLLECTION OF OBJECTS __getnewargs__-LIKE METHODS
# -------------------------------------------------


def _class_getnewargs(obj):
    type_kwargs = {}
    if "__module__" in obj.__dict__:
        type_kwargs["__module__"] = obj.__module__

    __dict__ = obj.__dict__.get("__dict__", None)
    if isinstance(__dict__, property):
        type_kwargs["__dict__"] = __dict__

    return (
        type(obj),
        obj.__name__,
        _get_bases(obj),
        type_kwargs,
        _get_or_create_tracker_id(obj),
        None,
    )


def _enum_getnewargs(obj):
    members = {e.name: e.value for e in obj}
    return (
        obj.__bases__,
        obj.__name__,
        obj.__qualname__,
        members,
        obj.__module__,
        _get_or_create_tracker_id(obj),
        None,
    )


# COLLECTION OF OBJECTS RECONSTRUCTORS
# ------------------------------------
def _file_reconstructor(retval):
    return retval


# COLLECTION OF OBJECTS STATE GETTERS
# -----------------------------------


def _function_getstate(func):
    # - Put func's dynamic attributes (stored in func.__dict__) in state. These
    #   attributes will be restored at unpickling time using
    #   f.__dict__.update(state)
    # - Put func's members into slotstate. Such attributes will be restored at
    #   unpickling time by iterating over slotstate and calling setattr(func,
    #   slotname, slotvalue)
    slotstate = {
        # Hack to circumvent non-predictable memoization caused by string interning.
        # See the inline comment in _class_setstate for details.
        "__name__": "".join(func.__name__),
        "__qualname__": "".join(func.__qualname__),
        "__annotations__": func.__annotations__,
        "__kwdefaults__": func.__kwdefaults__,
        "__defaults__": func.__defaults__,
        "__module__": func.__module__,
        "__doc__": func.__doc__,
        "__closure__": func.__closure__,
    }

    f_globals_ref = _extract_code_globals(func.__code__)
    f_globals = {k: func.__globals__[k] for k in f_globals_ref if k in func.__globals__}

    if func.__closure__ is not None:
        closure_values = list(map(_get_cell_contents, func.__closure__))
    else:
        closure_values = ()

    # Extract currently-imported submodules used by func. Storing these modules
    # in a smoke _cloudpickle_subimports attribute of the object's state will
    # trigger the side effect of importing these modules at unpickling time
    # (which is necessary for func to work correctly once depickled)
    slotstate["_cloudpickle_submodules"] = _find_imported_submodules(
        func.__code__, itertools.chain(f_globals.values(), closure_values)
    )
    slotstate["__globals__"] = f_globals

    # Hack to circumvent non-predictable memoization caused by string interning.
    # See the inline comment in _class_setstate for details.
    state = {"".join(k): v for k, v in func.__dict__.items()}
    return state, slotstate


def _class_getstate(obj):
    clsdict = _extract_class_dict(obj)
    clsdict.pop("__weakref__", None)

    if issubclass(type(obj), abc.ABCMeta):
        # If obj is an instance of an ABCMeta subclass, don't pickle the
        # cache/negative caches populated during isinstance/issubclass
        # checks, but pickle the list of registered subclasses of obj.
        clsdict.pop("_abc_cache", None)
        clsdict.pop("_abc_negative_cache", None)
        clsdict.pop("_abc_negative_cache_version", None)
        registry = clsdict.pop("_abc_registry", None)
        if registry is None:
            # The abc caches and registered subclasses of a
            # class are bundled into the single _abc_impl attribute
            clsdict.pop("_abc_impl", None)
            (registry, _, _, _) = abc._get_dump(obj)

            clsdict["_abc_impl"] = [subclass_weakref() for subclass_weakref in registry]
        else:
            # In the above if clause, registry is a set of weakrefs -- in
            # this case, registry is a WeakSet
            clsdict["_abc_impl"] = [type_ for type_ in registry]

    if "__slots__" in clsdict:
        # pickle string length optimization: member descriptors of obj are
        # created automatically from obj's __slots__ attribute, no need to
        # save them in obj's state
        if isinstance(obj.__slots__, str):
            clsdict.pop(obj.__slots__)
        else:
            for k in obj.__slots__:
                clsdict.pop(k, None)

    clsdict.pop("__dict__", None)  # unpicklable property object

    if sys.version_info >= (3, 14):
        # PEP-649/749: __annotate_func__ contains a closure that references the class
        # dict. We need to exclude it from pickling. Python will recreate it when
        # __annotations__ is accessed at unpickling time.
        clsdict.pop("__annotate_func__", None)

    return (clsdict, {})


def _enum_getstate(obj):
    clsdict, slotstate = _class_getstate(obj)

    members = {e.name: e.value for e in obj}
    # Cleanup the clsdict that will be passed to _make_skeleton_enum:
    # Those attributes are already handled by the metaclass.
    for attrname in [
        "_generate_next_value_",
        "_member_names_",
        "_member_map_",
        "_member_type_",
        "_value2member_map_",
    ]:
        clsdict.pop(attrname, None)
    for member in members:
        clsdict.pop(member)
        # Special handling of Enum subclasses
    return clsdict, slotstate


# COLLECTIONS OF OBJECTS REDUCERS
# -------------------------------
# A reducer is a function taking a single argument (obj), and that returns a
# tuple with all the necessary data to re-construct obj. Apart from a few
# exceptions (list, dict, bytes, int, etc.), a reducer is necessary to
# correctly pickle an object.
# While many built-in objects (Exceptions objects, instances of the "object"
# class, etc), are shipped with their own built-in reducer (invoked using
# obj.__reduce__), some do not. The following methods were created to "fill
# these holes".


def _code_reduce(obj):
    """code object reducer."""
    # If you are not sure about the order of arguments, take a look at help
    # of the specific type from types, for example:
    # >>> from types import CodeType
    # >>> help(CodeType)

    # Hack to circumvent non-predictable memoization caused by string interning.
    # See the inline comment in _class_setstate for details.
    co_name = "".join(obj.co_name)

    # Create shallow copies of these tuple to make cloudpickle payload deterministic.
    # When creating a code object during load, copies of these four tuples are
    # created, while in the main process, these tuples can be shared.
    # By always creating copies, we make sure the resulting payload is deterministic.
    co_names = tuple(name for name in obj.co_names)
    co_varnames = tuple(name for name in obj.co_varnames)
    co_freevars = tuple(name for name in obj.co_freevars)
    co_cellvars = tuple(name for name in obj.co_cellvars)
    if hasattr(obj, "co_exceptiontable"):
        # Python 3.11 and later: there are some new attributes
        # related to the enhanced exceptions.
        args = (
            obj.co_argcount,
            obj.co_posonlyargcount,
            obj.co_kwonlyargcount,
            obj.co_nlocals,
            obj.co_stacksize,
            obj.co_flags,
            obj.co_code,
            obj.co_consts,
            co_names,
            co_varnames,
            obj.co_filename,
            co_name,
            obj.co_qualname,
            obj.co_firstlineno,
            obj.co_linetable,
            obj.co_exceptiontable,
            co_freevars,
            co_cellvars,
        )
    elif hasattr(obj, "co_linetable"):
        # Python 3.10 and later: obj.co_lnotab is deprecated and constructor
        # expects obj.co_linetable instead.
        args = (
            obj.co_argcount,
            obj.co_posonlyargcount,
            obj.co_kwonlyargcount,
            obj.co_nlocals,
            obj.co_stacksize,
            obj.co_flags,
            obj.co_code,
            obj.co_consts,
            co_names,
            co_varnames,
            obj.co_filename,
            co_name,
            obj.co_firstlineno,
            obj.co_linetable,
            co_freevars,
            co_cellvars,
        )
    elif hasattr(obj, "co_nmeta"):  # pragma: no cover
        # "nogil" Python: modified attributes from 3.9
        args = (
            obj.co_argcount,
            obj.co_posonlyargcount,
            obj.co_kwonlyargcount,
            obj.co_nlocals,
            obj.co_framesize,
            obj.co_ndefaultargs,
            obj.co_nmeta,
            obj.co_flags,
            obj.co_code,
            obj.co_consts,
            co_varnames,
            obj.co_filename,
            co_name,
            obj.co_firstlineno,
            obj.co_lnotab,
            obj.co_exc_handlers,
            obj.co_jump_table,
            co_freevars,
            co_cellvars,
            obj.co_free2reg,
            obj.co_cell2reg,
        )
    else:
        # Backward compat for 3.8 and 3.9
        args = (
            obj.co_argcount,
            obj.co_posonlyargcount,
            obj.co_kwonlyargcount,
            obj.co_nlocals,
            obj.co_stacksize,
            obj.co_flags,
            obj.co_code,
            obj.co_consts,
            co_names,
            co_varnames,
            obj.co_filename,
            co_name,
            obj.co_firstlineno,
            obj.co_lnotab,
            co_freevars,
            co_cellvars,
        )
    return types.CodeType, args


def _cell_reduce(obj):
    """Cell (containing values of a function's free variables) reducer."""
    try:
        obj.cell_contents
    except ValueError:  # cell is empty
        return _make_empty_cell, ()
    else:
        return _make_cell, (obj.cell_contents,)


def _classmethod_reduce(obj):
    orig_func = obj.__func__
    return type(obj), (orig_func,)


def _file_reduce(obj):
    """Save a file."""
    import io

    if not hasattr(obj, "name") or not hasattr(obj, "mode"):
        raise pickle.PicklingError(
            "Cannot pickle files that do not map to an actual file"
        )
    if obj is sys.stdout:
        return getattr, (sys, "stdout")
    if obj is sys.stderr:
        return getattr, (sys, "stderr")
    if obj is sys.stdin:
        raise pickle.PicklingError("Cannot pickle standard input")
    if obj.closed:
        raise pickle.PicklingError("Cannot pickle closed files")
    if hasattr(obj, "isatty") and obj.isatty():
        raise pickle.PicklingError("Cannot pickle files that map to tty objects")
    if "r" not in obj.mode and "+" not in obj.mode:
        raise pickle.PicklingError(
            "Cannot pickle files that are not opened for reading: %s" % obj.mode
        )

    name = obj.name

    retval = io.StringIO()

    try:
        # Read the whole file
        curloc = obj.tell()
        obj.seek(0)
        contents = obj.read()
        obj.seek(curloc)
    except OSError as e:
        raise pickle.PicklingError(
            "Cannot pickle file %s as it cannot be read" % name
        ) from e
    retval.write(contents)
    retval.seek(curloc)

    retval.name = name
    return _file_reconstructor, (retval,)


def _getset_descriptor_reduce(obj):
    return getattr, (obj.__objclass__, obj.__name__)


def _mappingproxy_reduce(obj):
    return types.MappingProxyType, (dict(obj),)


def _memoryview_reduce(obj):
    return bytes, (obj.tobytes(),)


def _module_reduce(obj):
    if _should_pickle_by_reference(obj):
        return subimport, (obj.__name__,)
    else:
        # Some external libraries can populate the "__builtins__" entry of a
        # module's `__dict__` with unpicklable objects (see #316). For that
        # reason, we do not attempt to pickle the "__builtins__" entry, and
        # restore a default value for it at unpickling time.
        state = obj.__dict__.copy()
        state.pop("__builtins__", None)
        return dynamic_subimport, (obj.__name__, state)


def _method_reduce(obj):
    return (types.MethodType, (obj.__func__, obj.__self__))


def _logger_reduce(obj):
    return logging.getLogger, (obj.name,)


def _root_logger_reduce(obj):
    return logging.getLogger, ()


def _property_reduce(obj):
    return property, (obj.fget, obj.fset, obj.fdel, obj.__doc__)


def _weakset_reduce(obj):
    return weakref.WeakSet, (list(obj),)


def _dynamic_class_reduce(obj):
    """Save a class that can't be referenced as a module attribute.

    This method is used to serialize classes that are defined inside
    functions, or that otherwise can't be serialized as attribute lookups
    from importable modules.
    """
    if Enum is not None and issubclass(obj, Enum):
        return (
            _make_skeleton_enum,
            _enum_getnewargs(obj),
            _enum_getstate(obj),
            None,
            None,
            _class_setstate,
        )
    else:
        return (
            _make_skeleton_class,
            _class_getnewargs(obj),
            _class_getstate(obj),
            None,
            None,
            _class_setstate,
        )


def _class_reduce(obj):
    """Select the reducer depending on the dynamic nature of the class obj."""
    if obj is type(None):  # noqa
        return type, (None,)
    elif obj is type(Ellipsis):
        return type, (Ellipsis,)
    elif obj is type(NotImplemented):
        return type, (NotImplemented,)
    elif obj in _BUILTIN_TYPE_NAMES:
        return _builtin_type, (_BUILTIN_TYPE_NAMES[obj],)
    elif not _should_pickle_by_reference(obj):
        return _dynamic_class_reduce(obj)
    return NotImplemented


def _dict_keys_reduce(obj):
    # Safer not to ship the full dict as sending the rest might
    # be unintended and could potentially cause leaking of
    # sensitive information
    return _make_dict_keys, (list(obj),)


def _dict_values_reduce(obj):
    # Safer not to ship the full dict as sending the rest might
    # be unintended and could potentially cause leaking of
    # sensitive information
    return _make_dict_values, (list(obj),)


def _dict_items_reduce(obj):
    return _make_dict_items, (dict(obj),)


def _odict_keys_reduce(obj):
    # Safer not to ship the full dict as sending the rest might
    # be unintended and could potentially cause leaking of
    # sensitive information
    return _make_dict_keys, (list(obj), True)


def _odict_values_reduce(obj):
    # Safer not to ship the full dict as sending the rest might
    # be unintended and could potentially cause leaking of
    # sensitive information
    return _make_dict_values, (list(obj), True)


def _odict_items_reduce(obj):
    return _make_dict_items, (dict(obj), True)


def _dataclass_field_base_reduce(obj):
    return _get_dataclass_field_type_sentinel, (obj.name,)


# COLLECTIONS OF OBJECTS STATE SETTERS
# ------------------------------------
# state setters are called at unpickling time, once the object is created and
# it has to be updated to how it was at unpickling time.


def _function_setstate(obj, state):
    """Update the state of a dynamic function.

    As __closure__ and __globals__ are readonly attributes of a function, we
    cannot rely on the native setstate routine of pickle.load_build, that calls
    setattr on items of the slotstate. Instead, we have to modify them inplace.
    """
    state, slotstate = state
    obj.__dict__.update(state)

    obj_globals = slotstate.pop("__globals__")
    obj_closure = slotstate.pop("__closure__")
    # _cloudpickle_subimports is a set of submodules that must be loaded for
    # the pickled function to work correctly at unpickling time. Now that these
    # submodules are depickled (hence imported), they can be removed from the
    # object's state (the object state only served as a reference holder to
    # these submodules)
    slotstate.pop("_cloudpickle_submodules")

    obj.__globals__.update(obj_globals)
    obj.__globals__["__builtins__"] = __builtins__

    if obj_closure is not None:
        for i, cell in enumerate(obj_closure):
            try:
                value = cell.cell_contents
            except ValueError:  # cell is empty
                continue
            obj.__closure__[i].cell_contents = value

    for k, v in slotstate.items():
        setattr(obj, k, v)


def _class_setstate(obj, state):
    state, slotstate = state
    registry = None
    for attrname, attr in state.items():
        if attrname == "_abc_impl":
            registry = attr
        else:
            # Note: setting attribute names on a class automatically triggers their
            # interning in CPython:
            # https://github.com/python/cpython/blob/v3.12.0/Objects/object.c#L957
            #
            # This means that to get deterministic pickling for a dynamic class that
            # was initially defined in a different Python process, the pickler
            # needs to ensure that dynamic class and function attribute names are
            # systematically copied into a non-interned version to avoid
            # unpredictable pickle payloads.
            #
            # Indeed the Pickler's memoizer relies on physical object identity to break
            # cycles in the reference graph of the object being serialized.
            setattr(obj, attrname, attr)

    if sys.version_info >= (3, 13) and "__firstlineno__" in state:
        # Set the Python 3.13+ only __firstlineno__  attribute one more time, as it
        # will be automatically deleted by the `setattr(obj, attrname, attr)` call
        # above when `attrname` is "__firstlineno__". We assume that preserving this
        # information might be important for some users and that it not stale in the
        # context of cloudpickle usage, hence legitimate to propagate. Furthermore it
        # is necessary to do so to keep deterministic chained pickling as tested in
        # test_deterministic_str_interning_for_chained_dynamic_class_pickling.
        obj.__firstlineno__ = state["__firstlineno__"]

    if registry is not None:
        for subclass in registry:
            obj.register(subclass)

    # PEP-649/749: During pickling, we excluded the __annotate_func__ attribute but it
    # will be created by Python. Subsequently, annotations will be recreated when
    # __annotations__ is accessed.

    return obj


# COLLECTION OF DATACLASS UTILITIES
# ---------------------------------
# There are some internal sentinel values whose identity must be preserved when
# unpickling dataclass fields. Each sentinel value has a unique name that we can
# use to retrieve its identity at unpickling time.


_DATACLASSE_FIELD_TYPE_SENTINELS = {
    dataclasses._FIELD.name: dataclasses._FIELD,
    dataclasses._FIELD_CLASSVAR.name: dataclasses._FIELD_CLASSVAR,
    dataclasses._FIELD_INITVAR.name: dataclasses._FIELD_INITVAR,
}


def _get_dataclass_field_type_sentinel(name):
    return _DATACLASSE_FIELD_TYPE_SENTINELS[name]


class Pickler(pickle.Pickler):
    # set of reducers defined and used by cloudpickle (private)
    _dispatch_table = {}
    _dispatch_table[classmethod] = _classmethod_reduce
    _dispatch_table[io.TextIOWrapper] = _file_reduce
    _dispatch_table[logging.Logger] = _logger_reduce
    _dispatch_table[logging.RootLogger] = _root_logger_reduce
    _dispatch_table[memoryview] = _memoryview_reduce
    _dispatch_table[property] = _property_reduce
    _dispatch_table[staticmethod] = _classmethod_reduce
    _dispatch_table[CellType] = _cell_reduce
    _dispatch_table[types.CodeType] = _code_reduce
    _dispatch_table[types.GetSetDescriptorType] = _getset_descriptor_reduce
    _dispatch_table[types.ModuleType] = _module_reduce
    _dispatch_table[types.MethodType] = _method_reduce
    _dispatch_table[types.MappingProxyType] = _mappingproxy_reduce
    _dispatch_table[weakref.WeakSet] = _weakset_reduce
    _dispatch_table[typing.TypeVar] = _typevar_reduce
    _dispatch_table[_collections_abc.dict_keys] = _dict_keys_reduce
    _dispatch_table[_collections_abc.dict_values] = _dict_values_reduce
    _dispatch_table[_collections_abc.dict_items] = _dict_items_reduce
    _dispatch_table[type(OrderedDict().keys())] = _odict_keys_reduce
    _dispatch_table[type(OrderedDict().values())] = _odict_values_reduce
    _dispatch_table[type(OrderedDict().items())] = _odict_items_reduce
    _dispatch_table[abc.abstractmethod] = _classmethod_reduce
    _dispatch_table[abc.abstractclassmethod] = _classmethod_reduce
    _dispatch_table[abc.abstractstaticmethod] = _classmethod_reduce
    _dispatch_table[abc.abstractproperty] = _property_reduce
    _dispatch_table[dataclasses._FIELD_BASE] = _dataclass_field_base_reduce

    dispatch_table = ChainMap(_dispatch_table, copyreg.dispatch_table)

    # function reducers are defined as instance methods of cloudpickle.Pickler
    # objects, as they rely on a cloudpickle.Pickler attribute (globals_ref)
    def _dynamic_function_reduce(self, func):
        """Reduce a function that is not pickleable via attribute lookup."""
        newargs = self._function_getnewargs(func)
        state = _function_getstate(func)
        return (_make_function, newargs, state, None, None, _function_setstate)

    def _function_reduce(self, obj):
        """Reducer for function objects.

        If obj is a top-level attribute of a file-backed module, this reducer
        returns NotImplemented, making the cloudpickle.Pickler fall back to
        traditional pickle.Pickler routines to save obj. Otherwise, it reduces
        obj using a custom cloudpickle reducer designed specifically to handle
        dynamic functions.
        """
        if _should_pickle_by_reference(obj):
            return NotImplemented
        else:
            return self._dynamic_function_reduce(obj)

    def _function_getnewargs(self, func):
        code = func.__code__

        # base_globals represents the future global namespace of func at
        # unpickling time. Looking it up and storing it in
        # cloudpickle.Pickler.globals_ref allow functions sharing the same
        # globals at pickling time to also share them once unpickled, at one
        # condition: since globals_ref is an attribute of a cloudpickle.Pickler
        # instance, and that a new cloudpickle.Pickler is created each time
        # cloudpickle.dump or cloudpickle.dumps is called, functions also need
        # to be saved within the same invocation of
        # cloudpickle.dump/cloudpickle.dumps (for example:
        # cloudpickle.dumps([f1, f2])). There is no such limitation when using
        # cloudpickle.Pickler.dump, as long as the multiple invocations are
        # bound to the same cloudpickle.Pickler instance.
        base_globals = self.globals_ref.setdefault(id(func.__globals__), {})

        if base_globals == {}:
            # Add module attributes used to resolve relative imports
            # instructions inside func.
            for k in ["__package__", "__name__", "__path__", "__file__"]:
                if k in func.__globals__:
                    base_globals[k] = func.__globals__[k]

        # Do not bind the free variables before the function is created to
        # avoid infinite recursion.
        if func.__closure__ is None:
            closure = None
        else:
            closure = tuple(_make_empty_cell() for _ in range(len(code.co_freevars)))

        return code, base_globals, None, None, closure

    def dump(self, obj):
        try:
            return super().dump(obj)
        except RecursionError as e:
            msg = "Could not pickle object as excessively deep recursion required."
            raise pickle.PicklingError(msg) from e

    def __init__(self, file, protocol=None, buffer_callback=None):
        if protocol is None:
            protocol = DEFAULT_PROTOCOL
        super().__init__(file, protocol=protocol, buffer_callback=buffer_callback)
        # map functions __globals__ attribute ids, to ensure that functions
        # sharing the same global namespace at pickling time also share
        # their global namespace at unpickling time.
        self.globals_ref = {}
        self.proto = int(protocol)

    if not PYPY:
        # pickle.Pickler is the C implementation of the CPython pickler and
        # therefore we rely on reduce_override method to customize the pickler
        # behavior.

        # `cloudpickle.Pickler.dispatch` is only left for backward
        # compatibility - note that when using protocol 5,
        # `cloudpickle.Pickler.dispatch` is not an extension of
        # `pickle._Pickler.dispatch` dictionary, because `cloudpickle.Pickler`
        # subclasses the C-implemented `pickle.Pickler`, which does not expose
        # a `dispatch` attribute.  Earlier versions of `cloudpickle.Pickler`
        # used `cloudpickle.Pickler.dispatch` as a class-level attribute
        # storing all reducers implemented by cloudpickle, but the attribute
        # name was not a great choice given because it would collide with a
        # similarly named attribute in the pure-Python `pickle._Pickler`
        # implementation in the standard library.
        dispatch = dispatch_table

        # Implementation of the reducer_override callback, in order to
        # efficiently serialize dynamic functions and classes by subclassing
        # the C-implemented `pickle.Pickler`.
        # TODO: decorrelate reducer_override (which is tied to CPython's
        # implementation - would it make sense to backport it to pypy? - and
        # pickle's protocol 5 which is implementation agnostic. Currently, the
        # availability of both notions coincide on CPython's pickle, but it may
        # not be the case anymore when pypy implements protocol 5.

        def reducer_override(self, obj):
            """Type-agnostic reducing callback for function and classes.

            For performance reasons, subclasses of the C `pickle.Pickler` class
            cannot register custom reducers for functions and classes in the
            dispatch_table attribute. Reducers for such types must instead
            implemented via the special `reducer_override` method.

            Note that this method will be called for any object except a few
            builtin-types (int, lists, dicts etc.), which differs from reducers
            in the Pickler's dispatch_table, each of them being invoked for
            objects of a specific type only.

            This property comes in handy for classes: although most classes are
            instances of the ``type`` metaclass, some of them can be instances
            of other custom metaclasses (such as enum.EnumMeta for example). In
            particular, the metaclass will likely not be known in advance, and
            thus cannot be special-cased using an entry in the dispatch_table.
            reducer_override, among other things, allows us to register a
            reducer that will be called for any class, independently of its
            type.

            Notes:

            * reducer_override has the priority over dispatch_table-registered
            reducers.
            * reducer_override can be used to fix other limitations of
              cloudpickle for other types that suffered from type-specific
              reducers, such as Exceptions. See
              https://github.com/cloudpipe/cloudpickle/issues/248
            """
            t = type(obj)
            try:
                is_anyclass = issubclass(t, type)
            except TypeError:  # t is not a class (old Boost; see SF #502085)
                is_anyclass = False

            if is_anyclass:
                return _class_reduce(obj)
            elif isinstance(obj, types.FunctionType):
                return self._function_reduce(obj)
            else:
                # fallback to save_global, including the Pickler's
                # dispatch_table
                return NotImplemented

    else:
        # When reducer_override is not available, hack the pure-Python
        # Pickler's types.FunctionType and type savers. Note: the type saver
        # must override Pickler.save_global, because pickle.py contains a
        # hard-coded call to save_global when pickling meta-classes.
        dispatch = pickle.Pickler.dispatch.copy()

        def _save_reduce_pickle5(
            self,
            func,
            args,
            state=None,
            listitems=None,
            dictitems=None,
            state_setter=None,
            obj=None,
        ):
            save = self.save
            write = self.write
            self.save_reduce(
                func,
                args,
                state=None,
                listitems=listitems,
                dictitems=dictitems,
                obj=obj,
            )
            # backport of the Python 3.8 state_setter pickle operations
            save(state_setter)
            save(obj)  # simple BINGET opcode as obj is already memoized.
            save(state)
            write(pickle.TUPLE2)
            # Trigger a state_setter(obj, state) function call.
            write(pickle.REDUCE)
            # The purpose of state_setter is to carry-out an
            # inplace modification of obj. We do not care about what the
            # method might return, so its output is eventually removed from
            # the stack.
            write(pickle.POP)

        def save_global(self, obj, name=None, pack=struct.pack):
            """Main dispatch method.

            The name of this method is somewhat misleading: all types get
            dispatched here.
            """
            if obj is type(None):  # noqa
                return self.save_reduce(type, (None,), obj=obj)
            elif obj is type(Ellipsis):
                return self.save_reduce(type, (Ellipsis,), obj=obj)
            elif obj is type(NotImplemented):
                return self.save_reduce(type, (NotImplemented,), obj=obj)
            elif obj in _BUILTIN_TYPE_NAMES:
                return self.save_reduce(
                    _builtin_type, (_BUILTIN_TYPE_NAMES[obj],), obj=obj
                )

            if name is not None:
                super().save_global(obj, name=name)
            elif not _should_pickle_by_reference(obj, name=name):
                self._save_reduce_pickle5(*_dynamic_class_reduce(obj), obj=obj)
            else:
                super().save_global(obj, name=name)

        dispatch[type] = save_global

        def save_function(self, obj, name=None):
            """Registered with the dispatch to handle all function types.

            Determines what kind of function obj is (e.g. lambda, defined at
            interactive prompt, etc) and handles the pickling appropriately.
            """
            if _should_pickle_by_reference(obj, name=name):
                return super().save_global(obj, name=name)
            elif PYPY and isinstance(obj.__code__, builtin_code_type):
                return self.save_pypy_builtin_func(obj)
            else:
                return self._save_reduce_pickle5(
                    *self._dynamic_function_reduce(obj), obj=obj
                )

        def save_pypy_builtin_func(self, obj):
            """Save pypy equivalent of builtin functions.

            PyPy does not have the concept of builtin-functions. Instead,
            builtin-functions are simple function instances, but with a
            builtin-code attribute.
            Most of the time, builtin functions should be pickled by attribute.
            But PyPy has flaky support for __qualname__, so some builtin
            functions such as float.__new__ will be classified as dynamic. For
            this reason only, we created this special routine. Because
            builtin-functions are not expected to have closure or globals,
            there is no additional hack (compared the one already implemented
            in pickle) to protect ourselves from reference cycles. A simple
            (reconstructor, newargs, obj.__dict__) tuple is save_reduced.  Note
            also that PyPy improved their support for __qualname__ in v3.6, so
            this routing should be removed when cloudpickle supports only PyPy
            3.6 and later.
            """
            rv = (
                types.FunctionType,
                (obj.__code__, {}, obj.__name__, obj.__defaults__, obj.__closure__),
                obj.__dict__,
            )
            self.save_reduce(*rv, obj=obj)

        dispatch[types.FunctionType] = save_function


# Shorthands similar to pickle.dump/pickle.dumps


def dump(obj, file, protocol=None, buffer_callback=None):
    """Serialize obj as bytes streamed into file

    protocol defaults to cloudpickle.DEFAULT_PROTOCOL which is an alias to
    pickle.HIGHEST_PROTOCOL. This setting favors maximum communication
    speed between processes running the same Python version.

    Set protocol=pickle.DEFAULT_PROTOCOL instead if you need to ensure
    compatibility with older versions of Python (although this is not always
    guaranteed to work because cloudpickle relies on some internal
    implementation details that can change from one Python version to the
    next).
    """
    Pickler(file, protocol=protocol, buffer_callback=buffer_callback).dump(obj)


def dumps(obj, protocol=None, buffer_callback=None):
    """Serialize obj as a string of bytes allocated in memory

    protocol defaults to cloudpickle.DEFAULT_PROTOCOL which is an alias to
    pickle.HIGHEST_PROTOCOL. This setting favors maximum communication
    speed between processes running the same Python version.

    Set protocol=pickle.DEFAULT_PROTOCOL instead if you need to ensure
    compatibility with older versions of Python (although this is not always
    guaranteed to work because cloudpickle relies on some internal
    implementation details that can change from one Python version to the
    next).
    """
    with io.BytesIO() as file:
        cp = Pickler(file, protocol=protocol, buffer_callback=buffer_callback)
        cp.dump(obj)
        return file.getvalue()


# Include pickles unloading functions in this namespace for convenience.
load, loads = pickle.load, pickle.loads

# Backward compat alias.
CloudPickler = Pickler
