import asyncio
import gc
import shutil

import pytest

from joblib.memory import (
    AsyncMemorizedFunc,
    AsyncNotMemorizedFunc,
    MemorizedResult,
    Memory,
    NotMemorizedResult,
)
from joblib.test.common import np, with_numpy
from joblib.testing import raises

from .test_memory import corrupt_single_cache_item, monkeypatch_cached_func_warn


async def check_identity_lazy_async(func, accumulator, location):
    """Similar to check_identity_lazy_async for coroutine functions"""
    memory = Memory(location=location, verbose=0)
    func = memory.cache(func)
    for i in range(3):
        for _ in range(2):
            value = await func(i)
            assert value == i
            assert len(accumulator) == i + 1


@pytest.mark.asyncio
async def test_memory_integration_async(tmpdir):
    accumulator = list()

    async def f(n):
        await asyncio.sleep(0.1)
        accumulator.append(1)
        return n

    await check_identity_lazy_async(f, accumulator, tmpdir.strpath)

    # Now test clearing
    for compress in (False, True):
        for mmap_mode in ("r", None):
            memory = Memory(
                location=tmpdir.strpath,
                verbose=10,
                mmap_mode=mmap_mode,
                compress=compress,
            )
            # First clear the cache directory, to check that our code can
            # handle that
            # NOTE: this line would raise an exception, as the database
            # file is still open; we ignore the error since we want to
            # test what happens if the directory disappears
            shutil.rmtree(tmpdir.strpath, ignore_errors=True)
            g = memory.cache(f)
            await g(1)
            g.clear(warn=False)
            current_accumulator = len(accumulator)
            out = await g(1)

        assert len(accumulator) == current_accumulator + 1
        # Also, check that Memory.eval works similarly
        evaled = await memory.eval(f, 1)
        assert evaled == out
        assert len(accumulator) == current_accumulator + 1

    # Now do a smoke test with a function defined in __main__, as the name
    # mangling rules are more complex
    f.__module__ = "__main__"
    memory = Memory(location=tmpdir.strpath, verbose=0)
    await memory.cache(f)(1)


@pytest.mark.asyncio
async def test_no_memory_async():
    accumulator = list()

    async def ff(x):
        await asyncio.sleep(0.1)
        accumulator.append(1)
        return x

    memory = Memory(location=None, verbose=0)
    gg = memory.cache(ff)
    for _ in range(4):
        current_accumulator = len(accumulator)
        await gg(1)
        assert len(accumulator) == current_accumulator + 1


@with_numpy
@pytest.mark.asyncio
async def test_memory_numpy_check_mmap_mode_async(tmpdir, monkeypatch):
    """Check that mmap_mode is respected even at the first call"""

    memory = Memory(location=tmpdir.strpath, mmap_mode="r", verbose=0)

    @memory.cache()
    async def twice(a):
        return a * 2

    a = np.ones(3)
    b = await twice(a)
    c = await twice(a)

    assert isinstance(c, np.memmap)
    assert c.mode == "r"

    assert isinstance(b, np.memmap)
    assert b.mode == "r"

    # Corrupts the file,  Deleting b and c mmaps
    # is necessary to be able edit the file
    del b
    del c
    gc.collect()
    corrupt_single_cache_item(memory)

    # Make sure that corrupting the file causes recomputation and that
    # a warning is issued.
    recorded_warnings = monkeypatch_cached_func_warn(twice, monkeypatch)
    d = await twice(a)
    assert len(recorded_warnings) == 1
    exception_msg = "Exception while loading results"
    assert exception_msg in recorded_warnings[0]
    # Asserts that the recomputation returns a mmap
    assert isinstance(d, np.memmap)
    assert d.mode == "r"


@pytest.mark.asyncio
async def test_call_and_shelve_async(tmpdir):
    async def f(x, y=1):
        await asyncio.sleep(0.1)
        return x**2 + y

    # Test MemorizedFunc outputting a reference to cache.
    for func, Result in zip(
        (
            AsyncMemorizedFunc(f, tmpdir.strpath),
            AsyncNotMemorizedFunc(f),
            Memory(location=tmpdir.strpath, verbose=0).cache(f),
            Memory(location=None).cache(f),
        ),
        (
            MemorizedResult,
            NotMemorizedResult,
            MemorizedResult,
            NotMemorizedResult,
        ),
    ):
        for _ in range(2):
            result = await func.call_and_shelve(2)
            assert isinstance(result, Result)
            assert result.get() == 5

        result.clear()
        with raises(KeyError):
            result.get()
        result.clear()  # Do nothing if there is no cache.


@pytest.mark.asyncio
async def test_memorized_func_call_async(memory):
    async def ff(x, counter):
        await asyncio.sleep(0.1)
        counter[x] = counter.get(x, 0) + 1
        return counter[x]

    gg = memory.cache(ff, ignore=["counter"])

    counter = {}
    assert await gg(2, counter) == 1
    assert await gg(2, counter) == 1

    x, meta = await gg.call(2, counter)
    assert x == 2, "f has not been called properly"
    assert isinstance(meta, dict), "Metadata are not returned by MemorizedFunc.call."
