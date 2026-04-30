import sys
from functools import partial


def find_entrypoints(group_name: str):
    """
    Find entrypoints of a given group using either `importlib.metadata` or the
    older `pkg_resources` mechanism.

    Yields tuples of the entrypoint name and a callable function that will
    load the actual entrypoint.
    """
    if sys.version_info >= (3, 10):
        # "Changed in version 3.10: importlib.metadata is no longer provisional."
        try:
            from importlib.metadata import entry_points
        except ImportError:
            pass
        else:
            eps = entry_points(group=group_name)
            # Only do this if this implementation of `importlib.metadata` is
            # modern enough to not return a dict.
            if not isinstance(eps, dict):
                for entry_point in eps:
                    yield (entry_point.name, entry_point.load)
                return

    try:
        from pkg_resources import working_set
    except ImportError:
        pass
    else:
        for entry_point in working_set.iter_entry_points(group_name):
            yield (entry_point.name, partial(entry_point.load, require=True))
