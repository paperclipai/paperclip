"""
Backends for embarrassingly parallel code.
"""

import contextlib
import gc
import os
import threading
import warnings
from abc import ABCMeta, abstractmethod

from ._multiprocessing_helpers import mp
from ._utils import (
    _retrieve_traceback_capturing_wrapped_call,
    _TracebackCapturingWrapper,
)

if mp is not None:
    from multiprocessing.pool import ThreadPool

    from .executor import get_memmapping_executor

    # Import loky only if multiprocessing is present
    from .externals.loky import cpu_count, process_executor
    from .externals.loky.process_executor import ShutdownExecutorError
    from .pool import MemmappingPool


class ParallelBackendBase(metaclass=ABCMeta):
    """Helper abc which defines all methods a ParallelBackend must implement"""

    default_n_jobs = 1

    supports_inner_max_num_threads = False

    # This flag was introduced for backward compatibility reasons.
    # New backends should always set it to True and implement the
    # `retrieve_result_callback` method.
    supports_retrieve_callback = False

    @property
    def supports_return_generator(self):
        return self.supports_retrieve_callback

    @property
    def supports_timeout(self):
        return self.supports_retrieve_callback

    nesting_level = None

    def __init__(
        self, nesting_level=None, inner_max_num_threads=None, **backend_kwargs
    ):
        super().__init__()
        self.nesting_level = nesting_level
        self.inner_max_num_threads = inner_max_num_threads
        self.backend_kwargs = backend_kwargs

    MAX_NUM_THREADS_VARS = [
        "OMP_NUM_THREADS",
        "OPENBLAS_NUM_THREADS",
        "MKL_NUM_THREADS",
        "BLIS_NUM_THREADS",
        "VECLIB_MAXIMUM_THREADS",
        "NUMBA_NUM_THREADS",
        "NUMEXPR_NUM_THREADS",
    ]

    TBB_ENABLE_IPC_VAR = "ENABLE_IPC"

    @abstractmethod
    def effective_n_jobs(self, n_jobs):
        """Determine the number of jobs that can actually run in parallel

        n_jobs is the number of workers requested by the callers. Passing
        n_jobs=-1 means requesting all available workers for instance matching
        the number of CPU cores on the worker host(s).

        This method should return a guesstimate of the number of workers that
        can actually perform work concurrently. The primary use case is to make
        it possible for the caller to know in how many chunks to slice the
        work.

        In general working on larger data chunks is more efficient (less
        scheduling overhead and better use of CPU cache prefetching heuristics)
        as long as all the workers have enough work to do.
        """

    def apply_async(self, func, callback=None):
        """Deprecated: implement `submit` instead."""
        raise NotImplementedError("Implement `submit` instead.")

    def submit(self, func, callback=None):
        """Schedule a function to be run and return a future-like object.

        This method should return a future-like object that allow tracking
        the progress of the task.

        If ``supports_retrieve_callback`` is False, the return value of this
        method is passed to ``retrieve_result`` instead of calling
        ``retrieve_result_callback``.

        Parameters
        ----------
        func: callable
            The function to be run in parallel.

        callback: callable
            A callable that will be called when the task is completed. This callable
            is a wrapper around ``retrieve_result_callback``. This should be added
            to the future-like object returned by this method, so that the callback
            is called when the task is completed.

            For future-like backends, this can be achieved with something like
            ``future.add_done_callback(callback)``.

        Returns
        -------
        future: future-like
            A future-like object to track the execution of the submitted function.
        """
        warnings.warn(
            "`apply_async` is deprecated, implement and use `submit` instead.",
            DeprecationWarning,
        )
        return self.apply_async(func, callback)

    def retrieve_result_callback(self, out):
        """Called within the callback function passed to `submit`.

        This method can customise how the result of the function is retrieved
        from the future-like object.

        Parameters
        ----------
        future: future-like
            The future-like object returned by the `submit` method.

        Returns
        -------
        result: object
            The result of the function executed in parallel.
        """

    def retrieve_result(self, out, timeout=None):
        """Hook to retrieve the result when support_retrieve_callback=False.

        The argument `out` is the result of the `submit` call. This method
        should return the result of the computation or raise an exception if
        the computation failed.
        """
        if self.supports_timeout:
            return out.get(timeout=timeout)
        else:
            return out.get()

    def configure(
        self, n_jobs=1, parallel=None, prefer=None, require=None, **backend_kwargs
    ):
        """Reconfigure the backend and return the number of workers.

        This makes it possible to reuse an existing backend instance for
        successive independent calls to Parallel with different parameters.
        """
        self.parallel = parallel
        return self.effective_n_jobs(n_jobs)

    def start_call(self):
        """Call-back method called at the beginning of a Parallel call"""

    def stop_call(self):
        """Call-back method called at the end of a Parallel call"""

    def terminate(self):
        """Shutdown the workers and free the shared memory."""

    def compute_batch_size(self):
        """Determine the optimal batch size"""
        return 1

    def batch_completed(self, batch_size, duration):
        """Callback indicate how long it took to run a batch"""

    def abort_everything(self, ensure_ready=True):
        """Abort any running tasks

        This is called when an exception has been raised when executing a task
        and all the remaining tasks will be ignored and can therefore be
        aborted to spare computation resources.

        If ensure_ready is True, the backend should be left in an operating
        state as future tasks might be re-submitted via that same backend
        instance.

        If ensure_ready is False, the implementer of this method can decide
        to leave the backend in a closed / terminated state as no new task
        are expected to be submitted to this backend.

        Setting ensure_ready to False is an optimization that can be leveraged
        when aborting tasks via killing processes from a local process pool
        managed by the backend it-self: if we expect no new tasks, there is no
        point in re-creating new workers.
        """
        # Does nothing by default: to be overridden in subclasses when
        # canceling tasks is possible.
        pass

    def get_nested_backend(self):
        """Backend instance to be used by nested Parallel calls.

        By default a thread-based backend is used for the first level of
        nesting. Beyond, switch to sequential backend to avoid spawning too
        many threads on the host.
        """
        nesting_level = getattr(self, "nesting_level", 0) + 1
        if nesting_level > 1:
            return SequentialBackend(nesting_level=nesting_level), None
        else:
            return ThreadingBackend(nesting_level=nesting_level), None

    def _prepare_worker_env(self, n_jobs):
        """Return environment variables limiting threadpools in external libs.

        This function return a dict containing environment variables to pass
        when creating a pool of process. These environment variables limit the
        number of threads to `n_threads` for OpenMP, MKL, Accelerated and
        OpenBLAS libraries in the child processes.
        """
        explicit_n_threads = self.inner_max_num_threads
        default_n_threads = max(cpu_count() // n_jobs, 1)

        # Set the inner environment variables to self.inner_max_num_threads if
        # it is given. Else, default to cpu_count // n_jobs unless the variable
        # is already present in the parent process environment.
        env = {}
        for var in self.MAX_NUM_THREADS_VARS:
            if explicit_n_threads is None:
                var_value = os.environ.get(var, default_n_threads)
            else:
                var_value = explicit_n_threads

            env[var] = str(var_value)

        if self.TBB_ENABLE_IPC_VAR not in os.environ:
            # To avoid over-subscription when using TBB, let the TBB schedulers
            # use Inter Process Communication to coordinate:
            env[self.TBB_ENABLE_IPC_VAR] = "1"
        return env

    @contextlib.contextmanager
    def retrieval_context(self):
        """Context manager to manage an execution context.

        Calls to Parallel.retrieve will be made inside this context.

        By default, this does nothing. It may be useful for subclasses to
        handle nested parallelism. In particular, it may be required to avoid
        deadlocks if a backend manages a fixed number of workers, when those
        workers may be asked to do nested Parallel calls. Without
        'retrieval_context' this could lead to deadlock, as all the workers
        managed by the backend may be "busy" waiting for the nested parallel
        calls to finish, but the backend has no free workers to execute those
        tasks.
        """
        yield

    @staticmethod
    def in_main_thread():
        return isinstance(threading.current_thread(), threading._MainThread)


class SequentialBackend(ParallelBackendBase):
    """A ParallelBackend which will execute all batches sequentially.

    Does not use/create any threading objects, and hence has minimal
    overhead. Used when n_jobs == 1.
    """

    uses_threads = True
    supports_timeout = False
    supports_retrieve_callback = False
    supports_sharedmem = True

    def effective_n_jobs(self, n_jobs):
        """Determine the number of jobs which are going to run in parallel"""
        if n_jobs == 0:
            raise ValueError("n_jobs == 0 in Parallel has no meaning")
        return 1

    def submit(self, func, callback=None):
        """Schedule a func to be run"""
        raise RuntimeError("Should never be called for SequentialBackend.")

    def retrieve_result_callback(self, out):
        raise RuntimeError("Should never be called for SequentialBackend.")

    def get_nested_backend(self):
        # import is not top level to avoid cyclic import errors.
        from .parallel import get_active_backend

        # SequentialBackend should neither change the nesting level, the
        # default backend or the number of jobs. Just return the current one.
        return get_active_backend()


class PoolManagerMixin(object):
    """A helper class for managing pool of workers."""

    _pool = None

    def effective_n_jobs(self, n_jobs):
        """Determine the number of jobs which are going to run in parallel"""
        if n_jobs == 0:
            raise ValueError("n_jobs == 0 in Parallel has no meaning")
        elif mp is None or n_jobs is None:
            # multiprocessing is not available or disabled, fallback
            # to sequential mode
            return 1
        elif n_jobs < 0:
            n_jobs = max(cpu_count() + 1 + n_jobs, 1)
        return n_jobs

    def terminate(self):
        """Shutdown the process or thread pool"""
        if self._pool is not None:
            self._pool.close()
            self._pool.terminate()  # terminate does a join()
            self._pool = None

    def _get_pool(self):
        """Used by `submit` to make it possible to implement lazy init"""
        return self._pool

    def submit(self, func, callback=None):
        """Schedule a func to be run"""
        # Here, we need a wrapper to avoid crashes on KeyboardInterruptErrors.
        # We also call the callback on error, to make sure the pool does not
        # wait on crashed jobs.
        return self._get_pool().apply_async(
            _TracebackCapturingWrapper(func),
            (),
            callback=callback,
            error_callback=callback,
        )

    def retrieve_result_callback(self, result):
        """Mimic concurrent.futures results, raising an error if needed."""
        # In the multiprocessing Pool API, the callback are called with the
        # result value as an argument so `result`(`out`) is the output of
        # job.get(). It's either the result or the exception raised while
        # collecting the result.
        return _retrieve_traceback_capturing_wrapped_call(result)

    def abort_everything(self, ensure_ready=True):
        """Shutdown the pool and restart a new one with the same parameters"""
        self.terminate()
        if ensure_ready:
            self.configure(
                n_jobs=self.parallel.n_jobs,
                parallel=self.parallel,
                **self.parallel._backend_kwargs,
            )


class AutoBatchingMixin(object):
    """A helper class for automagically batching jobs."""

    # In seconds, should be big enough to hide multiprocessing dispatching
    # overhead.
    # This settings was found by running benchmarks/bench_auto_batching.py
    # with various parameters on various platforms.
    MIN_IDEAL_BATCH_DURATION = 0.2

    # Should not be too high to avoid stragglers: long jobs running alone
    # on a single worker while other workers have no work to process any more.
    MAX_IDEAL_BATCH_DURATION = 2

    # Batching counters default values
    _DEFAULT_EFFECTIVE_BATCH_SIZE = 1
    _DEFAULT_SMOOTHED_BATCH_DURATION = 0.0

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._effective_batch_size = self._DEFAULT_EFFECTIVE_BATCH_SIZE
        self._smoothed_batch_duration = self._DEFAULT_SMOOTHED_BATCH_DURATION

    def compute_batch_size(self):
        """Determine the optimal batch size"""
        old_batch_size = self._effective_batch_size
        batch_duration = self._smoothed_batch_duration
        if batch_duration > 0 and batch_duration < self.MIN_IDEAL_BATCH_DURATION:
            # The current batch size is too small: the duration of the
            # processing of a batch of task is not large enough to hide
            # the scheduling overhead.
            ideal_batch_size = int(
                old_batch_size * self.MIN_IDEAL_BATCH_DURATION / batch_duration
            )
            # Multiply by two to limit oscilations between min and max.
            ideal_batch_size *= 2

            # dont increase the batch size too fast to limit huge batch sizes
            # potentially leading to starving worker
            batch_size = min(2 * old_batch_size, ideal_batch_size)

            batch_size = max(batch_size, 1)

            self._effective_batch_size = batch_size
            if self.parallel.verbose >= 10:
                self.parallel._print(
                    f"Batch computation too fast ({batch_duration}s.) "
                    f"Setting batch_size={batch_size}."
                )
        elif batch_duration > self.MAX_IDEAL_BATCH_DURATION and old_batch_size >= 2:
            # The current batch size is too big. If we schedule overly long
            # running batches some CPUs might wait with nothing left to do
            # while a couple of CPUs a left processing a few long running
            # batches. Better reduce the batch size a bit to limit the
            # likelihood of scheduling such stragglers.

            # decrease the batch size quickly to limit potential starving
            ideal_batch_size = int(
                old_batch_size * self.MIN_IDEAL_BATCH_DURATION / batch_duration
            )
            # Multiply by two to limit oscilations between min and max.
            batch_size = max(2 * ideal_batch_size, 1)
            self._effective_batch_size = batch_size
            if self.parallel.verbose >= 10:
                self.parallel._print(
                    f"Batch computation too slow ({batch_duration}s.) "
                    f"Setting batch_size={batch_size}."
                )
        else:
            # No batch size adjustment
            batch_size = old_batch_size

        if batch_size != old_batch_size:
            # Reset estimation of the smoothed mean batch duration: this
            # estimate is updated in the multiprocessing apply_async
            # CallBack as long as the batch_size is constant. Therefore
            # we need to reset the estimate whenever we re-tune the batch
            # size.
            self._smoothed_batch_duration = self._DEFAULT_SMOOTHED_BATCH_DURATION

        return batch_size

    def batch_completed(self, batch_size, duration):
        """Callback indicate how long it took to run a batch"""
        if batch_size == self._effective_batch_size:
            # Update the smoothed streaming estimate of the duration of a batch
            # from dispatch to completion
            old_duration = self._smoothed_batch_duration
            if old_duration == self._DEFAULT_SMOOTHED_BATCH_DURATION:
                # First record of duration for this batch size after the last
                # reset.
                new_duration = duration
            else:
                # Update the exponentially weighted average of the duration of
                # batch for the current effective size.
                new_duration = 0.8 * old_duration + 0.2 * duration
            self._smoothed_batch_duration = new_duration

    def reset_batch_stats(self):
        """Reset batch statistics to default values.

        This avoids interferences with future jobs.
        """
        self._effective_batch_size = self._DEFAULT_EFFECTIVE_BATCH_SIZE
        self._smoothed_batch_duration = self._DEFAULT_SMOOTHED_BATCH_DURATION


class ThreadingBackend(PoolManagerMixin, ParallelBackendBase):
    """A ParallelBackend which will use a thread pool to execute batches in.

    This is a low-overhead backend but it suffers from the Python Global
    Interpreter Lock if the called function relies a lot on Python objects.
    Mostly useful when the execution bottleneck is a compiled extension that
    explicitly releases the GIL (for instance a Cython loop wrapped in a "with
    nogil" block or an expensive call to a library such as NumPy).

    The actual thread pool is lazily initialized: the actual thread pool
    construction is delayed to the first call to apply_async.

    ThreadingBackend is used as the default backend for nested calls.
    """

    supports_retrieve_callback = True
    uses_threads = True
    supports_sharedmem = True

    def configure(self, n_jobs=1, parallel=None, **backend_kwargs):
        """Build a process or thread pool and return the number of workers"""
        n_jobs = self.effective_n_jobs(n_jobs)
        if n_jobs == 1:
            # Avoid unnecessary overhead and use sequential backend instead.
            raise FallbackToBackend(SequentialBackend(nesting_level=self.nesting_level))
        self.parallel = parallel
        self._n_jobs = n_jobs
        return n_jobs

    def _get_pool(self):
        """Lazily initialize the thread pool

        The actual pool of worker threads is only initialized at the first
        call to apply_async.
        """
        if self._pool is None:
            self._pool = ThreadPool(self._n_jobs)
        return self._pool


class MultiprocessingBackend(PoolManagerMixin, AutoBatchingMixin, ParallelBackendBase):
    """A ParallelBackend which will use a multiprocessing.Pool.

    Will introduce some communication and memory overhead when exchanging
    input and output data with the with the worker Python processes.
    However, does not suffer from the Python Global Interpreter Lock.
    """

    supports_retrieve_callback = True
    supports_return_generator = False

    def effective_n_jobs(self, n_jobs):
        """Determine the number of jobs which are going to run in parallel.

        This also checks if we are attempting to create a nested parallel
        loop.
        """
        if mp is None:
            return 1

        if mp.current_process().daemon:
            # Daemonic processes cannot have children
            if n_jobs != 1:
                if inside_dask_worker():
                    msg = (
                        "Inside a Dask worker with daemon=True, "
                        "setting n_jobs=1.\nPossible work-arounds:\n"
                        "- dask.config.set("
                        "{'distributed.worker.daemon': False})"
                        "- set the environment variable "
                        "DASK_DISTRIBUTED__WORKER__DAEMON=False\n"
                        "before creating your Dask cluster."
                    )
                else:
                    msg = (
                        "Multiprocessing-backed parallel loops "
                        "cannot be nested, setting n_jobs=1"
                    )
                warnings.warn(msg, stacklevel=3)
            return 1

        if process_executor._CURRENT_DEPTH > 0:
            # Mixing loky and multiprocessing in nested loop is not supported
            if n_jobs != 1:
                warnings.warn(
                    "Multiprocessing-backed parallel loops cannot be nested,"
                    " below loky, setting n_jobs=1",
                    stacklevel=3,
                )
            return 1

        elif not (self.in_main_thread() or self.nesting_level == 0):
            # Prevent posix fork inside in non-main posix threads
            if n_jobs != 1:
                warnings.warn(
                    "Multiprocessing-backed parallel loops cannot be nested"
                    " below threads, setting n_jobs=1",
                    stacklevel=3,
                )
            return 1

        return super(MultiprocessingBackend, self).effective_n_jobs(n_jobs)

    def configure(
        self,
        n_jobs=1,
        parallel=None,
        prefer=None,
        require=None,
        **memmapping_pool_kwargs,
    ):
        """Build a process or thread pool and return the number of workers"""
        n_jobs = self.effective_n_jobs(n_jobs)
        if n_jobs == 1:
            raise FallbackToBackend(SequentialBackend(nesting_level=self.nesting_level))

        memmapping_pool_kwargs = {
            **self.backend_kwargs,
            **memmapping_pool_kwargs,
        }

        # Make sure to free as much memory as possible before forking
        gc.collect()
        self._pool = MemmappingPool(n_jobs, **memmapping_pool_kwargs)
        self.parallel = parallel
        return n_jobs

    def terminate(self):
        """Shutdown the process or thread pool"""
        super(MultiprocessingBackend, self).terminate()
        self.reset_batch_stats()


class LokyBackend(AutoBatchingMixin, ParallelBackendBase):
    """Managing pool of workers with loky instead of multiprocessing."""

    supports_retrieve_callback = True
    supports_inner_max_num_threads = True

    def configure(
        self,
        n_jobs=1,
        parallel=None,
        prefer=None,
        require=None,
        idle_worker_timeout=None,
        **memmapping_executor_kwargs,
    ):
        """Build a process executor and return the number of workers"""
        n_jobs = self.effective_n_jobs(n_jobs)
        if n_jobs == 1:
            raise FallbackToBackend(SequentialBackend(nesting_level=self.nesting_level))

        memmapping_executor_kwargs = {
            **self.backend_kwargs,
            **memmapping_executor_kwargs,
        }

        # Prohibit the use of 'timeout' in the LokyBackend, as 'idle_worker_timeout'
        # better describes the backend's behavior.
        if "timeout" in memmapping_executor_kwargs:
            raise ValueError(
                "The 'timeout' parameter is not supported by the LokyBackend. "
                "Please use the `idle_worker_timeout` parameter instead."
            )
        if idle_worker_timeout is None:
            idle_worker_timeout = self.backend_kwargs.get("idle_worker_timeout", 300)

        self._workers = get_memmapping_executor(
            n_jobs,
            timeout=idle_worker_timeout,
            env=self._prepare_worker_env(n_jobs=n_jobs),
            context_id=parallel._id,
            **memmapping_executor_kwargs,
        )
        self.parallel = parallel
        return n_jobs

    def effective_n_jobs(self, n_jobs):
        """Determine the number of jobs which are going to run in parallel"""
        if n_jobs == 0:
            raise ValueError("n_jobs == 0 in Parallel has no meaning")
        elif mp is None or n_jobs is None:
            # multiprocessing is not available or disabled, fallback
            # to sequential mode
            return 1
        elif mp.current_process().daemon:
            # Daemonic processes cannot have children
            if n_jobs != 1:
                if inside_dask_worker():
                    msg = (
                        "Inside a Dask worker with daemon=True, "
                        "setting n_jobs=1.\nPossible work-arounds:\n"
                        "- dask.config.set("
                        "{'distributed.worker.daemon': False})\n"
                        "- set the environment variable "
                        "DASK_DISTRIBUTED__WORKER__DAEMON=False\n"
                        "before creating your Dask cluster."
                    )
                else:
                    msg = (
                        "Loky-backed parallel loops cannot be called in a"
                        " multiprocessing, setting n_jobs=1"
                    )
                warnings.warn(msg, stacklevel=3)

            return 1
        elif not (self.in_main_thread() or self.nesting_level == 0):
            # Prevent posix fork inside in non-main posix threads
            if n_jobs != 1:
                warnings.warn(
                    "Loky-backed parallel loops cannot be nested below "
                    "threads, setting n_jobs=1",
                    stacklevel=3,
                )
            return 1
        elif n_jobs < 0:
            n_jobs = max(cpu_count() + 1 + n_jobs, 1)
        return n_jobs

    def submit(self, func, callback=None):
        """Schedule a func to be run"""
        future = self._workers.submit(func)
        if callback is not None:
            future.add_done_callback(callback)
        return future

    def retrieve_result_callback(self, future):
        """Retrieve the result, here out is the future given by submit"""
        try:
            return future.result()
        except ShutdownExecutorError:
            raise RuntimeError(
                "The executor underlying Parallel has been shutdown. "
                "This is likely due to the garbage collection of a previous "
                "generator from a call to Parallel with return_as='generator'."
                " Make sure the generator is not garbage collected when "
                "submitting a new job or that it is first properly exhausted."
            )

    def terminate(self):
        if self._workers is not None:
            # Don't terminate the workers as we want to reuse them in later
            # calls, but cleanup the temporary resources that the Parallel call
            # created. This 'hack' requires a private, low-level operation.
            self._workers._temp_folder_manager._clean_temporary_resources(
                context_id=self.parallel._id, force=False
            )
            self._workers = None

        self.reset_batch_stats()

    def abort_everything(self, ensure_ready=True):
        """Shutdown the workers and restart a new one with the same parameters"""
        self._workers.terminate(kill_workers=True)
        self._workers = None

        if ensure_ready:
            self.configure(n_jobs=self.parallel.n_jobs, parallel=self.parallel)


class FallbackToBackend(Exception):
    """Raised when configuration should fallback to another backend"""

    def __init__(self, backend):
        self.backend = backend


def inside_dask_worker():
    """Check whether the current function is executed inside a Dask worker."""
    # This function can not be in joblib._dask because there would be a
    # circular import:
    # _dask imports _parallel_backend that imports _dask ...
    try:
        from distributed import get_worker
    except ImportError:
        return False

    try:
        get_worker()
        return True
    except ValueError:
        return False
