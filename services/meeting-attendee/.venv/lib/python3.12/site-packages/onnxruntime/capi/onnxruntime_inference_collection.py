# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
from __future__ import annotations

import collections
import collections.abc
import os
import typing
import warnings
from collections.abc import Callable, Sequence
from enum import IntEnum
from typing import Any

from onnxruntime.capi import _pybind_state as C

if typing.TYPE_CHECKING:
    import numpy as np
    import numpy.typing as npt

    import onnxruntime


def get_ort_device_type(device_type: str) -> int:
    if device_type == "cuda":
        return C.OrtDevice.cuda()
    elif device_type == "cann":
        return C.OrtDevice.cann()
    elif device_type == "cpu":
        return C.OrtDevice.cpu()
    elif device_type == "dml":
        return C.OrtDevice.dml()
    elif device_type == "webgpu":
        return C.OrtDevice.webgpu()
    elif device_type == "gpu":
        return C.OrtDevice.gpu()
    elif device_type == "npu":
        return C.OrtDevice.npu()
    else:
        raise Exception("Unsupported device type: " + device_type)


class OrtDeviceVendorId(IntEnum):
    """Vendor IDs aligned with OrtDevice::VendorIds in ortdevice.h."""

    NONE = 0x0000
    AMD = 0x1002
    NVIDIA = 0x10DE
    ARM = 0x13B5
    MICROSOFT = 0x1414
    HUAWEI = 0x19E5
    QUALCOMM = 0x5143
    INTEL = 0x8086


def get_vendor_id_for_device_type(device_type: str) -> OrtDeviceVendorId | None:
    if device_type == "cuda":
        return OrtDeviceVendorId.NVIDIA
    elif device_type == "dml":
        return OrtDeviceVendorId.MICROSOFT
    elif device_type == "cann":
        return OrtDeviceVendorId.HUAWEI
    else:
        return None


class AdapterFormat:
    """
    This class is used to create adapter files from python structures
    """

    def __init__(self, adapter=None) -> None:
        if adapter is None:
            self._adapter = C.AdapterFormat()
        else:
            self._adapter = adapter

    @staticmethod
    def read_adapter(file_path: os.PathLike) -> AdapterFormat:
        return AdapterFormat(C.AdapterFormat.read_adapter(file_path))

    def export_adapter(self, file_path: os.PathLike):
        """
        This function writes a file at the specified location
        in onnxrunitme adapter format containing Lora parameters.

        :param file_path: absolute path for the adapter
        """
        self._adapter.export_adapter(file_path)

    def get_format_version(self) -> int:
        return self._adapter.format_version

    def set_adapter_version(self, adapter_version: int) -> None:
        self._adapter.adapter_version = adapter_version

    def get_adapter_version(self) -> int:
        return self._adapter.adapter_version

    def set_model_version(self, model_version: int) -> None:
        self._adapter.model_version = model_version

    def get_model_version(self) -> int:
        return self._adapter.model_version

    def set_parameters(self, params: dict[str, OrtValue]) -> None:
        self._adapter.parameters = {k: v._ortvalue for k, v in params.items()}

    def get_parameters(self) -> dict[str, OrtValue]:
        return {k: OrtValue(v) for k, v in self._adapter.parameters.items()}


def check_and_normalize_provider_args(
    providers: Sequence[str | tuple[str, dict[Any, Any]]] | None,
    provider_options: Sequence[dict[Any, Any]] | None,
    available_provider_names: Sequence[str],
):
    """
    Validates the 'providers' and 'provider_options' arguments and returns a
        normalized version.

    :param providers: Optional sequence of providers in order of decreasing
        precedence. Values can either be provider names or tuples of
        (provider name, options dict).
    :param provider_options: Optional sequence of options dicts corresponding
        to the providers listed in 'providers'.
    :param available_provider_names: The available provider names.

    :return: Tuple of (normalized 'providers' sequence, normalized
        'provider_options' sequence).

    'providers' can contain either names or names and options. When any options
        are given in 'providers', 'provider_options' should not be used.

    The normalized result is a tuple of:
    1. Sequence of provider names in the same order as 'providers'.
    2. Sequence of corresponding provider options dicts with string keys and
        values. Unspecified provider options yield empty dicts.
    """
    if providers is None:
        return [], []

    provider_name_to_options = collections.OrderedDict()

    def set_provider_options(name, options):
        if name not in available_provider_names:
            warnings.warn(
                "Specified provider '{}' is not in available provider names.Available providers: '{}'".format(
                    name, ", ".join(available_provider_names)
                )
            )

        if name in provider_name_to_options:
            warnings.warn(f"Duplicate provider '{name}' encountered, ignoring.")
            return

        normalized_options = {str(key): str(value) for key, value in options.items()}
        provider_name_to_options[name] = normalized_options

    if not isinstance(providers, collections.abc.Sequence):
        raise ValueError("'providers' should be a sequence.")

    if provider_options is not None:
        if not isinstance(provider_options, collections.abc.Sequence):
            raise ValueError("'provider_options' should be a sequence.")

        if len(providers) != len(provider_options):
            raise ValueError("'providers' and 'provider_options' should be the same length if both are given.")

        if not all(isinstance(provider, str) for provider in providers):
            raise ValueError("Only string values for 'providers' are supported if 'provider_options' is given.")

        if not all(isinstance(options_for_provider, dict) for options_for_provider in provider_options):
            raise ValueError("'provider_options' values must be dicts.")

        for name, options in zip(providers, provider_options, strict=False):
            set_provider_options(name, options)

    else:
        for provider in providers:
            if isinstance(provider, str):
                set_provider_options(provider, {})
            elif (
                isinstance(provider, tuple)
                and len(provider) == 2
                and isinstance(provider[0], str)
                and isinstance(provider[1], dict)
            ):
                set_provider_options(provider[0], provider[1])
            else:
                raise ValueError("'providers' values must be either strings or (string, dict) tuples.")

    return list(provider_name_to_options.keys()), list(provider_name_to_options.values())


class Session:
    """
    This is the main class used to run a model.
    """

    def __init__(self, enable_fallback: bool = True):
        # self._sess is managed by the derived class and relies on bindings from C.InferenceSession
        self._sess = None
        self._enable_fallback = enable_fallback

    def get_session_options(self) -> onnxruntime.SessionOptions:
        "Return the session options. See :class:`onnxruntime.SessionOptions`."
        return self._sess_options

    def get_inputs(self) -> Sequence[onnxruntime.NodeArg]:
        "Return the inputs metadata as a list of :class:`onnxruntime.NodeArg`."
        return self._inputs_meta

    def get_outputs(self) -> Sequence[onnxruntime.NodeArg]:
        "Return the outputs metadata as a list of :class:`onnxruntime.NodeArg`."
        return self._outputs_meta

    def get_overridable_initializers(self) -> Sequence[onnxruntime.NodeArg]:
        "Return the inputs (including initializers) metadata as a list of :class:`onnxruntime.NodeArg`."
        return self._overridable_initializers

    def get_modelmeta(self) -> onnxruntime.ModelMetadata:
        "Return the metadata. See :class:`onnxruntime.ModelMetadata`."
        return self._model_meta

    def get_input_memory_infos(self) -> Sequence[onnxruntime.MemoryInfo]:
        "Return the memory info for the inputs."
        return self._input_meminfos

    def get_output_memory_infos(self) -> Sequence[onnxruntime.MemoryInfo]:
        "Return the memory info for the outputs."
        return self._output_meminfos

    def get_input_epdevices(self) -> Sequence[onnxruntime.OrtEpDevice]:
        "Return the execution providers for the inputs."
        return self._input_epdevices

    def get_providers(self) -> Sequence[str]:
        "Return list of registered execution providers."
        return self._providers

    def get_provider_options(self):
        "Return registered execution providers' configurations."
        return self._provider_options

    def get_provider_graph_assignment_info(self) -> Sequence[onnxruntime.OrtEpAssignedSubgraph]:
        """
        Get information about the subgraphs assigned to each execution provider and the nodes within.

        Application must enable the recording of graph assignment information by setting the session configuration
        for the key "session.record_ep_graph_assignment_info" to "1".
        """
        return self._sess.get_provider_graph_assignment_info()

    def set_providers(self, providers=None, provider_options=None) -> None:
        """
        Register the input list of execution providers. The underlying session is re-created.

        :param providers: Optional sequence of providers in order of decreasing
            precedence. Values can either be provider names or tuples of
            (provider name, options dict). If not provided, then all available
            providers are used with the default precedence.
        :param provider_options: Optional sequence of options dicts corresponding
            to the providers listed in 'providers'.

        'providers' can contain either names or names and options. When any options
        are given in 'providers', 'provider_options' should not be used.

        The list of providers is ordered by precedence. For example
        `['CUDAExecutionProvider', 'CPUExecutionProvider']`
        means execute a node using CUDAExecutionProvider if capable,
        otherwise execute using CPUExecutionProvider.
        """
        # recreate the underlying C.InferenceSession
        self._reset_session(providers, provider_options)

    def disable_fallback(self) -> None:
        """
        Disable session.run() fallback mechanism.
        """
        self._enable_fallback = False

    def enable_fallback(self) -> None:
        """
        Enable session.Run() fallback mechanism. If session.Run() fails due to an internal Execution Provider failure,
        reset the Execution Providers enabled for this session.
        If GPU is enabled, fall back to CUDAExecutionProvider.
        otherwise fall back to CPUExecutionProvider.
        """
        self._enable_fallback = True

    def _validate_input(self, feed_input_names):
        missing_input_names = []
        for input in self._inputs_meta:
            if input.name not in feed_input_names and not input.type.startswith("optional"):
                missing_input_names.append(input.name)
        if missing_input_names:
            raise ValueError(
                f"Required inputs ({missing_input_names}) are missing from input feed ({feed_input_names})."
            )

    def run(self, output_names, input_feed, run_options=None) -> Sequence[np.ndarray | SparseTensor | list | dict]:
        """
        Compute the predictions.

        :param output_names: name of the outputs
        :param input_feed: dictionary ``{ input_name: input_value }``
        :param run_options: See :class:`onnxruntime.RunOptions`.
        :return: list of results, every result is either a numpy array,
            a sparse tensor, a list or a dictionary.

        ::

            sess.run([output_name], {input_name: x})
        """
        self._validate_input(list(input_feed.keys()))
        if not output_names:
            output_names = [output.name for output in self._outputs_meta]
        try:
            return self._sess.run(output_names, input_feed, run_options)
        except C.EPFail as err:
            if self._enable_fallback:
                print(f"EP Error: {err!s} using {self._providers}")
                print(f"Falling back to {self._fallback_providers} and retrying.")
                self.set_providers(self._fallback_providers)
                # Fallback only once.
                self.disable_fallback()
                return self._sess.run(output_names, input_feed, run_options)
            raise

    def run_async(self, output_names, input_feed, callback, user_data, run_options=None):
        """
        Compute the predictions asynchronously in a separate cxx thread from ort intra-op threadpool.

        :param output_names: name of the outputs
        :param input_feed: dictionary ``{ input_name: input_value }``
        :param callback: python function that accept array of results, and a status string on error.
            The callback will be invoked by a cxx thread from ort intra-op threadpool.
        :param run_options: See :class:`onnxruntime.RunOptions`.

        ::
            class MyData:
                def __init__(self):
                    # ...
                def save_results(self, results):
                    # ...

            def callback(results: np.ndarray, user_data: MyData, err: str) -> None:
              if err:
                 print (err)
              else:
                # save results to user_data

            sess.run_async([output_name], {input_name: x}, callback)
        """
        self._validate_input(list(input_feed.keys()))
        if not output_names:
            output_names = [output.name for output in self._outputs_meta]
        return self._sess.run_async(output_names, input_feed, callback, user_data, run_options)

    def run_with_ort_values(self, output_names, input_dict_ort_values, run_options=None) -> Sequence[OrtValue]:
        """
        Compute the predictions.

        :param output_names: name of the outputs
        :param input_dict_ort_values: dictionary ``{ input_name: input_ort_value }``
            See ``OrtValue`` class how to create `OrtValue`
            from numpy array or `SparseTensor`
        :param run_options: See :class:`onnxruntime.RunOptions`.
        :return: an array of `OrtValue`

        ::

            sess.run([output_name], {input_name: x})
        """

        def invoke(sess, output_names, input_dict_ort_values, run_options):
            input_dict = {}
            for n, v in input_dict_ort_values.items():
                input_dict[n] = v._get_c_value()
            result = sess.run_with_ort_values(input_dict, output_names, run_options)
            if not isinstance(result, C.OrtValueVector):
                raise TypeError("run_with_ort_values() must return a instance of type 'OrtValueVector'.")
            ort_values = [OrtValue(v) for v in result]
            return ort_values

        self._validate_input(list(input_dict_ort_values.keys()))
        if not output_names:
            output_names = [output.name for output in self._outputs_meta]
        try:
            return invoke(self._sess, output_names, input_dict_ort_values, run_options)
        except C.EPFail as err:
            if self._enable_fallback:
                print(f"EP Error: {err!s} using {self._providers}")
                print(f"Falling back to {self._fallback_providers} and retrying.")
                self.set_providers(self._fallback_providers)
                # Fallback only once.
                self.disable_fallback()
                return invoke(self._sess, output_names, input_dict_ort_values, run_options)
            raise

    def end_profiling(self):
        """
        End profiling and return results in a file.

        The results are stored in a filename if the option
        :meth:`onnxruntime.SessionOptions.enable_profiling`.
        """
        return self._sess.end_profiling()

    def get_profiling_start_time_ns(self):
        """
        Return the nanoseconds of profiling's start time
        Comparable to time.monotonic_ns() after Python 3.3
        On some platforms, this timer may not be as precise as nanoseconds
        For instance, on Windows and MacOS, the precision will be ~100ns
        """
        return self._sess.get_profiling_start_time_ns

    def io_binding(self) -> IOBinding:
        "Return an onnxruntime.IOBinding object`."
        return IOBinding(self)

    def run_with_iobinding(self, iobinding, run_options=None):
        """
        Compute the predictions.

        :param iobinding: the iobinding object that has graph inputs/outputs bind.
        :param run_options: See :class:`onnxruntime.RunOptions`.
        """
        self._sess.run_with_iobinding(iobinding._iobinding, run_options)

    def set_ep_dynamic_options(self, options: dict[str, str]):
        """
        Set dynamic options for execution providers.

        :param options: Dictionary of key-value pairs where both keys and values are strings.
                        These options will be passed to the execution providers to modify
                        their runtime behavior.
        """
        self._sess.set_ep_dynamic_options(options)

    def get_tuning_results(self):
        return self._sess.get_tuning_results()

    def set_tuning_results(self, results, *, error_on_invalid=False):
        return self._sess.set_tuning_results(results, error_on_invalid)

    def run_with_ortvaluevector(self, run_options, feed_names, feeds, fetch_names, fetches, fetch_devices):
        """
        Compute the predictions similar to other run_*() methods but with minimal C++/Python conversion overhead.

        :param run_options: See :class:`onnxruntime.RunOptions`.
        :param feed_names: list of input names.
        :param feeds: list of input OrtValue.
        :param fetch_names: list of output names.
        :param fetches: list of output OrtValue.
        :param fetch_devices: list of output devices.
        """
        self._sess.run_with_ortvaluevector(run_options, feed_names, feeds, fetch_names, fetches, fetch_devices)


class InferenceSession(Session):
    """
    This is the main class used to run a model.
    """

    def __init__(
        self,
        path_or_bytes: str | bytes | os.PathLike,
        sess_options: onnxruntime.SessionOptions | None = None,
        providers: Sequence[str | tuple[str, dict[Any, Any]]] | None = None,
        provider_options: Sequence[dict[Any, Any]] | None = None,
        **kwargs,
    ) -> None:
        """
        :param path_or_bytes: Filename or serialized ONNX or ORT format model in a byte string.
        :param sess_options: Session options.
        :param providers: Optional sequence of providers in order of decreasing
            precedence. Values can either be provider names or tuples of
            (provider name, options dict). If not provided, then all available
            providers are used with the default precedence.
        :param provider_options: Optional sequence of options dicts corresponding
            to the providers listed in 'providers'.

        The model type will be inferred unless explicitly set in the SessionOptions.
        To explicitly set:

        ::

            so = onnxruntime.SessionOptions()
            # so.add_session_config_entry('session.load_model_format', 'ONNX') or
            so.add_session_config_entry('session.load_model_format', 'ORT')

        A file extension of '.ort' will be inferred as an ORT format model.
        All other filenames are assumed to be ONNX format models.

        'providers' can contain either names or names and options. When any options
        are given in 'providers', 'provider_options' should not be used.

        The list of providers is ordered by precedence. For example
        `['CUDAExecutionProvider', 'CPUExecutionProvider']`
        means execute a node using `CUDAExecutionProvider`
        if capable, otherwise execute using `CPUExecutionProvider`.
        """
        super().__init__(enable_fallback=int(kwargs.get("enable_fallback", 1)) == 1)

        if isinstance(path_or_bytes, (str, os.PathLike)):
            self._model_path = os.fspath(path_or_bytes)
            self._model_bytes = None
        elif isinstance(path_or_bytes, bytes):
            self._model_path = None
            self._model_bytes = path_or_bytes  # TODO: This is bad as we're holding the memory indefinitely
        else:
            raise TypeError(f"Unable to load from type '{type(path_or_bytes)}'")

        self._sess_options = sess_options
        self._sess_options_initial = sess_options
        if "read_config_from_model" in kwargs:
            self._read_config_from_model = int(kwargs["read_config_from_model"]) == 1
        else:
            self._read_config_from_model = os.environ.get("ORT_LOAD_CONFIG_FROM_MODEL") == "1"

        # internal parameters that we don't expect to be used in general so aren't documented
        disabled_optimizers = kwargs.get("disabled_optimizers")

        try:
            self._create_inference_session(providers, provider_options, disabled_optimizers)
        except (ValueError, RuntimeError) as e:
            if self._enable_fallback:
                try:
                    print("*************** EP Error ***************")
                    print(f"EP Error {e} when using {providers}")
                    print(f"Falling back to {self._fallback_providers} and retrying.")
                    print("****************************************")
                    self._create_inference_session(self._fallback_providers, None)
                    # Fallback only once.
                    self.disable_fallback()
                    return
                except Exception as fallback_error:
                    raise fallback_error from e
            # Fallback is disabled. Raise the original error.
            raise e

    def _create_inference_session(self, providers, provider_options, disabled_optimizers=None):
        available_providers = C.get_available_providers()

        # Validate that TensorrtExecutionProvider and NvTensorRTRTXExecutionProvider are not both specified
        if providers:
            has_tensorrt = any(
                provider == "TensorrtExecutionProvider"
                or (isinstance(provider, tuple) and provider[0] == "TensorrtExecutionProvider")
                for provider in providers
            )
            has_tensorrt_rtx = any(
                provider == "NvTensorRTRTXExecutionProvider"
                or (isinstance(provider, tuple) and provider[0] == "NvTensorRTRTXExecutionProvider")
                for provider in providers
            )
            if has_tensorrt and has_tensorrt_rtx:
                raise ValueError(
                    "Cannot enable both 'TensorrtExecutionProvider' and 'NvTensorRTRTXExecutionProvider' "
                    "in the same session."
                )
        # Tensorrt and TensorRT RTX can fall back to CUDA if it's explicitly assigned. All others fall back to CPU.
        if "NvTensorRTRTXExecutionProvider" in available_providers:
            if (
                providers
                and any(
                    provider == "CUDAExecutionProvider"
                    or (isinstance(provider, tuple) and provider[0] == "CUDAExecutionProvider")
                    for provider in providers
                )
                and any(
                    provider == "NvTensorRTRTXExecutionProvider"
                    or (isinstance(provider, tuple) and provider[0] == "NvTensorRTRTXExecutionProvider")
                    for provider in providers
                )
            ):
                self._fallback_providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
            else:
                self._fallback_providers = ["CPUExecutionProvider"]
        elif "TensorrtExecutionProvider" in available_providers:
            if (
                providers
                and any(
                    provider == "CUDAExecutionProvider"
                    or (isinstance(provider, tuple) and provider[0] == "CUDAExecutionProvider")
                    for provider in providers
                )
                and any(
                    provider == "TensorrtExecutionProvider"
                    or (isinstance(provider, tuple) and provider[0] == "TensorrtExecutionProvider")
                    for provider in providers
                )
            ):
                self._fallback_providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
            else:
                self._fallback_providers = ["CPUExecutionProvider"]
        else:
            self._fallback_providers = ["CPUExecutionProvider"]

        # validate providers and provider_options before other initialization
        providers, provider_options = check_and_normalize_provider_args(
            providers, provider_options, available_providers
        )

        # Print a warning if user passed providers to InferenceSession() but the SessionOptions instance
        # already has provider information (e.g., via add_provider_for_devices()). The providers specified
        # here will take precedence.
        if self._sess_options is not None and (providers or provider_options) and self._sess_options.has_providers():
            warnings.warn(
                "Specified 'providers'/'provider_options' when creating InferenceSession but SessionOptions has "
                "already been configured with providers. InferenceSession will only use the providers "
                "passed to InferenceSession()."
            )

        session_options = self._sess_options if self._sess_options else C.get_default_session_options()

        self._register_ep_custom_ops(session_options, providers, provider_options, available_providers)

        if self._model_path:
            sess = C.InferenceSession(session_options, self._model_path, True, self._read_config_from_model)
        else:
            sess = C.InferenceSession(session_options, self._model_bytes, False, self._read_config_from_model)

        if disabled_optimizers is None:
            disabled_optimizers = set()
        elif not isinstance(disabled_optimizers, set):
            # convert to set. assumes iterable
            disabled_optimizers = set(disabled_optimizers)

        # initialize the C++ InferenceSession
        sess.initialize_session(providers, provider_options, disabled_optimizers)

        self._sess = sess
        self._sess_options = self._sess.session_options
        self._inputs_meta = self._sess.inputs_meta
        self._outputs_meta = self._sess.outputs_meta
        self._overridable_initializers = self._sess.overridable_initializers
        self._input_meminfos = self._sess.input_meminfos
        self._output_meminfos = self._sess.output_meminfos
        self._input_epdevices = self._sess.input_epdevices
        self._model_meta = self._sess.model_meta
        self._providers = self._sess.get_providers()
        self._provider_options = self._sess.get_provider_options()
        self._profiling_start_time_ns = self._sess.get_profiling_start_time_ns

    def _reset_session(self, providers, provider_options) -> None:
        "release underlying session object."
        # meta data references session internal structures
        # so they must be set to None to decrement _sess reference count.
        self._sess_options = None
        self._inputs_meta = None
        self._outputs_meta = None
        self._overridable_initializers = None
        self._input_meminfos = None
        self._output_meminfos = None
        self._input_epdevices = None
        self._model_meta = None
        self._providers = None
        self._provider_options = None
        self._profiling_start_time_ns = None

        # create a new C.InferenceSession
        self._sess = None
        self._sess_options = self._sess_options_initial
        self._create_inference_session(providers, provider_options)

    def _register_ep_custom_ops(self, session_options, providers, provider_options, available_providers):
        for i in range(len(providers)):
            if providers[i] in available_providers and providers[i] == "TensorrtExecutionProvider":
                C.register_tensorrt_plugins_as_custom_ops(session_options, provider_options[i])
            elif (
                isinstance(providers[i], tuple)
                and providers[i][0] in available_providers
                and providers[i][0] == "TensorrtExecutionProvider"
            ):
                C.register_tensorrt_plugins_as_custom_ops(session_options, providers[i][1])

            if providers[i] in available_providers and providers[i] == "NvTensorRTRTXExecutionProvider":
                C.register_nv_tensorrt_rtx_plugins_as_custom_ops(session_options, provider_options[i])
            elif (
                isinstance(providers[i], tuple)
                and providers[i][0] in available_providers
                and providers[i][0] == "NvTensorrtRTXExecutionProvider"
            ):
                C.register_nv_tensorrt_rtx_plugins_as_custom_ops(session_options, providers[i][1])


def make_get_initializer_location_func_wrapper(
    get_initializer_location_func: GetInitializerLocationFunc,
) -> GetInitializerLocationWrapperFunc:
    """
    Wraps a user's "get initializer location" function. The returned wrapper function adheres to the
    signature expected by ORT.

    Need this wrapper to:
      - Convert the `initializer_value` parameter from `C.OrtValue` to `onnxruntime.OrtValue`, which is more
        convenient for the user's function to use.
      - Allow the user's function to return the original `external_info` parameter (this wrapper makes a copy)
    """

    def get_initializer_location_func_wrapper(
        initializer_name: str,
        initializer_value: C.OrtValue,
        external_info: C.OrtExternalInitializerInfo | None,
    ) -> C.OrtExternalInitializerInfo | None:
        ret_val: C.OrtExternalInitializerInfo | None = get_initializer_location_func(
            initializer_name, OrtValue(initializer_value), external_info
        )
        if ret_val is not None and ret_val == external_info:
            # User returned `external_info` (const and owned by ORT). ORT expects the returned value to be
            # a new instance (that it deletes), so make a copy.
            ret_val = C.OrtExternalInitializerInfo(ret_val.filepath, ret_val.file_offset, ret_val.byte_size)
        return ret_val

    return get_initializer_location_func_wrapper


class ModelCompiler:
    """
    This class is used to compile an ONNX model. A compiled ONNX model has EPContext nodes that each
    encapsulates a subgraph compiled/optimized for a specific execution provider.

    Refer to the EPContext design document for more information about EPContext models:
    https://onnxruntime.ai/docs/execution-providers/EP-Context-Design.html

        ::

            sess_options = onnxruntime.SessionOptions()
            sess_options.add_provider("SomeExecutionProvider", {"option1": "value1"})
            # Alternatively, allow ONNX Runtime to select the provider automatically given a policy:
            # sess_options.set_provider_selection_policy(onnxrt.OrtExecutionProviderDevicePolicy.PREFER_NPU)

            model_compiler = onnxruntime.ModelCompiler(sess_options, "input_model.onnx")
            model_compiler.compile_to_file("output_model.onnx")
    """

    def __init__(
        self,
        sess_options: onnxruntime.SessionOptions,
        input_model_path_or_bytes: str | os.PathLike | bytes,
        embed_compiled_data_into_model: bool = False,
        external_initializers_file_path: str | os.PathLike | None = None,
        external_initializers_size_threshold: int = 1024,
        flags: int = C.OrtCompileApiFlags.NONE,
        graph_optimization_level: C.GraphOptimizationLevel = C.GraphOptimizationLevel.ORT_DISABLE_ALL,
        get_initializer_location_func: GetInitializerLocationFunc | None = None,
    ):
        """
        Creates a ModelCompiler instance.

        :param sess_options: Session options containing the providers for which the model will be compiled.
            Refer to SessionOptions.add_provider() and SessionOptions.set_provider_selection_policy().
        :param input_model_path_or_bytes: The path to the input model file or bytes representing a serialized
            ONNX model.
        :param embed_compiled_data_into_model: Defaults to False. Set to True to embed compiled binary data into
            EPContext nodes in the compiled model.
        :param external_initializers_file_path: Defaults to None. Set to a path for a file that will store the
            initializers for non-compiled nodes.
        :param external_initializers_size_threshold: Defaults to 1024. Ignored if `external_initializers_file_path`
            is None or empty. Initializers larger than this threshold are stored in the external initializers file.
        :param flags: Additional boolean options to enable. Set this parameter to a bitwise OR of
            flags in onnxruntime.OrtCompileApiFlags.
        :param graph_optimization_level: The graph optimization level.
            Defaults to onnxruntime.GraphOptimizationLevel.ORT_DISABLE_ALL.
        :param get_initializer_location_func: Optional function called for every initializer to allow user to specify
            whether an initializer should be stored within the model or externally. Example:
            ```
                def get_initializer_location(
                    initializer_name: str,
                    initializer_value: onnxrt.OrtValue,
                    external_info: onnxrt.OrtExternalInitializerInfo | None,
                ) -> onnxrt.OrtExternalInitializerInfo | None:
                    byte_size = initializer_value.tensor_size_in_bytes()

                    if byte_size < 64:
                        return None  # Store small initializer within compiled model.

                    # Else, write initializer to new external file.
                    value_np = initializer_value.numpy()
                    file_offset = ext_init_file.tell()
                    ext_init_file.write(value_np.tobytes())
                    return onnxrt.OrtExternalInitializerInfo(initializer_file_path, file_offset, byte_size)
            ```
        """
        input_model_path: str | os.PathLike | None = None
        input_model_bytes: bytes | None = None
        if isinstance(input_model_path_or_bytes, (str, os.PathLike)):
            if not input_model_path_or_bytes:
                raise ValueError("Input model path is empty")
            input_model_path = os.fspath(input_model_path_or_bytes)
        elif isinstance(input_model_path_or_bytes, bytes):
            if len(input_model_path_or_bytes) == 0:
                raise ValueError("Input model bytes array is empty")
            input_model_bytes = input_model_path_or_bytes
        else:
            raise TypeError(f"Unable to load from type '{type(input_model_path_or_bytes)}'")

        if external_initializers_file_path:
            if not isinstance(external_initializers_file_path, (str, os.PathLike)):
                arg_type = type(external_initializers_file_path)
                raise TypeError(f"Output external initializer filepath is of unexpected type '{arg_type}'")
            external_initializers_file_path = os.fspath(external_initializers_file_path)
        else:
            external_initializers_file_path = ""

        if get_initializer_location_func is not None:
            if external_initializers_file_path:
                raise ValueError(
                    "Cannot initialize ModelCompiler with both `external_initializers_file_path` "
                    "and `get_initializer_location_func`"
                )
            self.get_initializer_location_func_wrapper = make_get_initializer_location_func_wrapper(
                get_initializer_location_func
            )
        else:
            self.get_initializer_location_func_wrapper = None

        if input_model_path:
            self._model_compiler = C.ModelCompiler(
                sess_options,
                input_model_path,
                True,  # is path
                embed_compiled_data_into_model,
                external_initializers_file_path,
                external_initializers_size_threshold,
                flags,
                graph_optimization_level,
                self.get_initializer_location_func_wrapper,
            )
        else:
            self._model_compiler = C.ModelCompiler(
                sess_options,
                input_model_bytes,
                False,  # is bytes
                embed_compiled_data_into_model,
                external_initializers_file_path,
                external_initializers_size_threshold,
                flags,
                graph_optimization_level,
                self.get_initializer_location_func_wrapper,
            )

    def compile_to_file(self, output_model_path: str | None = None):
        """
        Compiles to an output file. If an output file path is not provided,
        the output file path is generated based on the input model path by replacing
        '.onnx' with '_ctx.onnx'. Ex: The generated output file is 'model_ctx.onnx' for
        an input model with path 'model.onnx'.

        Raises an 'InvalidArgument' exception if the compilation options are invalid.

        :param output_model_path: Defaults to None. The path for the output/compiled model.
        """
        if output_model_path:
            if not isinstance(output_model_path, (str, os.PathLike)):
                raise TypeError(f"Output model's filepath is of unexpected type '{type(output_model_path)}'")
            output_model_path = os.fspath(output_model_path)
        self._model_compiler.compile_to_file(output_model_path)

    def compile_to_bytes(self) -> bytes:
        """
        Compiles to bytes representing the serialized compiled ONNX model.

        Raises an 'InvalidArgument' exception if the compilation options are invalid.

        :return: A bytes object representing the compiled ONNX model.
        """
        return self._model_compiler.compile_to_bytes()

    def compile_to_stream(self, write_function: Callable[[bytes], None]):
        """
        Compiles the input model and writes the serialized ONNX bytes to a stream using the provided write function.
        Raises an 'InvalidArgument' exception if the compilation options are invalid.
        :param write_function: A callable that accepts a bytes buffer to write.
        """
        self._model_compiler.compile_to_stream(write_function)


class IOBinding:
    """
    This class provides API to bind input/output to a specified device, e.g. GPU.
    """

    def __init__(self, session: Session):
        self._iobinding = C.SessionIOBinding(session._sess)
        self._numpy_obj_references = {}

    def bind_cpu_input(self, name, arr_on_cpu):
        """
        bind an input to array on CPU
        :param name: input name
        :param arr_on_cpu: input values as a python array on CPU
        """
        # Hold a reference to the numpy object as the bound OrtValue is backed
        # directly by the data buffer of the numpy object and so the numpy object
        # must be around until this IOBinding instance is around
        self._numpy_obj_references[name] = arr_on_cpu
        self._iobinding.bind_input(name, arr_on_cpu)

    def bind_input(self, name, device_type, device_id, element_type, shape, buffer_ptr):
        """
        :param name: input name
        :param device_type: e.g. cpu, cuda, cann
        :param device_id: device id, e.g. 0
        :param element_type: input element type. It can be either numpy type (like numpy.float32) or an integer for onnx type (like onnx.TensorProto.BFLOAT16)
        :param shape: input shape
        :param buffer_ptr: memory pointer to input data
        """
        self._iobinding.bind_input(
            name,
            C.OrtDevice(
                get_ort_device_type(device_type),
                C.OrtDevice.default_memory(),
                device_id,
            ),
            element_type,
            shape,
            buffer_ptr,
        )

    def bind_ortvalue_input(self, name, ortvalue):
        """
        :param name: input name
        :param ortvalue: OrtValue instance to bind
        """
        self._iobinding.bind_ortvalue_input(name, ortvalue._ortvalue)

    def synchronize_inputs(self):
        self._iobinding.synchronize_inputs()

    def bind_output(
        self,
        name,
        device_type="cpu",
        device_id=0,
        element_type=None,
        shape=None,
        buffer_ptr=None,
    ):
        """
        :param name: output name
        :param device_type: e.g. cpu, cuda, cann, cpu by default
        :param device_id: device id, e.g. 0
        :param element_type: output element type. It can be either numpy type (like numpy.float32) or an integer for onnx type (like onnx.TensorProto.BFLOAT16)
        :param shape: output shape
        :param buffer_ptr: memory pointer to output data
        """

        # Follow the `if` path when the user has not provided any pre-allocated buffer but still
        # would like to bind an output to a specific device (e.g. cuda).
        # Pre-allocating an output buffer may not be an option for the user as :
        # (1) They may not want to use a custom allocator specific to the device they want to bind the output to,
        # in which case ORT will allocate the memory for the user
        # (2) The output has a dynamic shape and hence the size of the buffer may not be fixed across runs
        if buffer_ptr is None:
            self._iobinding.bind_output(
                name,
                C.OrtDevice(
                    get_ort_device_type(device_type),
                    C.OrtDevice.default_memory(),
                    device_id,
                ),
            )
        else:
            if element_type is None or shape is None:
                raise ValueError("`element_type` and `shape` are to be provided if pre-allocated memory is provided")
            self._iobinding.bind_output(
                name,
                C.OrtDevice(
                    get_ort_device_type(device_type),
                    C.OrtDevice.default_memory(),
                    device_id,
                ),
                element_type,
                shape,
                buffer_ptr,
            )

    def bind_ortvalue_output(self, name, ortvalue):
        """
        :param name: output name
        :param ortvalue: OrtValue instance to bind
        """
        self._iobinding.bind_ortvalue_output(name, ortvalue._ortvalue)

    def synchronize_outputs(self):
        self._iobinding.synchronize_outputs()

    def get_outputs(self):
        """
        Returns the output OrtValues from the Run() that preceded the call.
        The data buffer of the obtained OrtValues may not reside on CPU memory
        """
        outputs = self._iobinding.get_outputs()
        if not isinstance(outputs, C.OrtValueVector):
            raise TypeError("get_outputs() must return an instance of type 'OrtValueVector'.")
        return [OrtValue(ortvalue) for ortvalue in outputs]

    def get_outputs_as_ortvaluevector(self):
        return self._iobinding.get_outputs()

    def copy_outputs_to_cpu(self):
        """Copy output contents to CPU."""
        return self._iobinding.copy_outputs_to_cpu()

    def clear_binding_inputs(self):
        self._iobinding.clear_binding_inputs()

    def clear_binding_outputs(self):
        self._iobinding.clear_binding_outputs()


class OrtValue:
    """
    A data structure that supports all ONNX data formats (tensors and non-tensors) that allows users
    to place the data backing these on a device, for example, on a CUDA supported device.
    This class provides APIs to construct and deal with OrtValues.
    """

    def __init__(self, ortvalue: C.OrtValue, numpy_obj: np.ndarray | None = None):
        if isinstance(ortvalue, C.OrtValue):
            self._ortvalue = ortvalue
            # Hold a ref count to the numpy object if the OrtValue is backed directly
            # by its data buffer so that it isn't destroyed when the OrtValue is in use
            self._numpy_obj = numpy_obj
        else:
            # An end user won't hit this error
            raise ValueError(
                "`Provided ortvalue` needs to be of type `onnxruntime.capi.onnxruntime_pybind11_state.OrtValue`"
            )

    def _get_c_value(self) -> C.OrtValue:
        return self._ortvalue

    @classmethod
    def ortvalue_from_numpy(
        cls, numpy_obj: np.ndarray, /, device_type="cpu", device_id=0, vendor_id: int | OrtDeviceVendorId = -1
    ) -> OrtValue:
        """
        Factory method to construct an OrtValue (which holds a Tensor) from a given Numpy object
        A copy of the data in the Numpy object is held by the OrtValue only if the device is NOT cpu

        :param numpy_obj: The Numpy object to construct the OrtValue from
        :param device_type: e.g. cpu, cuda, cann, cpu by default
        :param device_id: device id, e.g. 0
        :param vendor_id: The device's PCI vendor id as an int or OrtDeviceVendorId. If provided, the device_type should be "gpu" or "npu".
        """
        # Hold a reference to the numpy object (if device_type is 'cpu') as the OrtValue
        # is backed directly by the data buffer of the numpy object and so the numpy object
        # must be around until this OrtValue instance is around
        return cls(
            C.OrtValue.ortvalue_from_numpy(
                numpy_obj,
                OrtDevice.make(device_type, device_id, vendor_id)._get_c_device(),
            ),
            numpy_obj if device_type.lower() == "cpu" else None,
        )

    @classmethod
    def ortvalue_from_numpy_with_onnx_type(cls, data: np.ndarray, /, onnx_element_type: int) -> OrtValue:
        """
        This method creates an instance of OrtValue on top of the numpy array.
        No data copy is made and the lifespan of the resulting OrtValue should never
        exceed the lifespan of bytes object. The API attempts to reinterpret
        the data type which is expected to be the same size. This is useful
        when we want to use an ONNX data type that is not supported by numpy.

        :param data: numpy.ndarray.
        :param onnx_element_type: a valid onnx TensorProto::DataType enum value
        """
        return cls(C.OrtValue.ortvalue_from_numpy_with_onnx_type(data, onnx_element_type), data)

    @classmethod
    def ortvalue_from_shape_and_type(
        cls,
        shape: Sequence[int],
        element_type,
        device_type: str = "cpu",
        device_id: int = 0,
        vendor_id: int | OrtDeviceVendorId = -1,
    ) -> OrtValue:
        """
        Factory method to construct an OrtValue (which holds a Tensor) from given shape and element_type

        :param shape: List of integers indicating the shape of the OrtValue
        :param element_type: The data type of the elements. It can be either numpy type (like numpy.float32) or an integer for onnx type (like onnx.TensorProto.BFLOAT16).
        :param device_type: e.g. cpu, cuda, cann, cpu by default
        :param device_id: device id, e.g. 0
        :param vendor_id: The device's PCI vendor id as an int or OrtDeviceVendorId. If provided, the device type should be "gpu" or "npu".
        """

        device = OrtDevice.make(device_type, device_id, vendor_id)._get_c_device()

        # Integer for onnx element type (see https://onnx.ai/onnx/api/mapping.html).
        # This is helpful for some data type (like TensorProto.BFLOAT16) that is not available in numpy.
        if isinstance(element_type, int):
            return cls(
                C.OrtValue.ortvalue_from_shape_and_onnx_type(
                    shape,
                    element_type,
                    device,
                )
            )

        return cls(
            C.OrtValue.ortvalue_from_shape_and_type(
                shape,
                element_type,
                device,
            )
        )

    @classmethod
    def ort_value_from_sparse_tensor(cls, sparse_tensor: SparseTensor) -> OrtValue:
        """
        The function will construct an OrtValue instance from a valid SparseTensor
        The new instance of OrtValue will assume the ownership of sparse_tensor
        """
        return cls(C.OrtValue.ort_value_from_sparse_tensor(sparse_tensor._get_c_tensor()))

    def as_sparse_tensor(self) -> SparseTensor:
        """
        The function will return SparseTensor contained in this OrtValue
        """
        return SparseTensor(self._ortvalue.as_sparse_tensor())

    def data_ptr(self) -> int:
        """
        Returns the address of the first element in the OrtValue's data buffer
        """
        return self._ortvalue.data_ptr()

    def device_name(self) -> str:
        """
        Returns the name of the device where the OrtValue's data buffer resides e.g. cpu, cuda, cann
        """
        return self._ortvalue.device_name().lower()

    def shape(self) -> Sequence[int]:
        """
        Returns the shape of the data in the OrtValue
        """
        return self._ortvalue.shape()

    def data_type(self) -> str:
        """
        Returns the data type of the data in the OrtValue. E.g. 'tensor(int64)'
        """
        return self._ortvalue.data_type()

    def element_type(self) -> int:
        """
        Returns the proto type of the data in the OrtValue
        if the OrtValue is a tensor.
        """
        return self._ortvalue.element_type()

    def tensor_size_in_bytes(self) -> int:
        """
        Returns the size of the data in the OrtValue in bytes
        if the OrtValue is a tensor.
        """
        return self._ortvalue.tensor_size_in_bytes()

    def has_value(self) -> bool:
        """
        Returns True if the OrtValue corresponding to an
        optional type contains data, else returns False
        """
        return self._ortvalue.has_value()

    def is_tensor(self) -> bool:
        """
        Returns True if the OrtValue contains a Tensor, else returns False
        """
        return self._ortvalue.is_tensor()

    def is_sparse_tensor(self) -> bool:
        """
        Returns True if the OrtValue contains a SparseTensor, else returns False
        """
        return self._ortvalue.is_sparse_tensor()

    def is_tensor_sequence(self) -> bool:
        """
        Returns True if the OrtValue contains a Tensor Sequence, else returns False
        """
        return self._ortvalue.is_tensor_sequence()

    def numpy(self) -> np.ndarray:
        """
        Returns a Numpy object from the OrtValue.
        Valid only for OrtValues holding Tensors. Throws for OrtValues holding non-Tensors.
        Use accessors to gain a reference to non-Tensor objects such as SparseTensor
        """
        return self._ortvalue.numpy()

    def update_inplace(self, np_arr) -> None:
        """
        Update the OrtValue in place with a new Numpy array. The numpy contents
        are copied over to the device memory backing the OrtValue. It can be used
        to update the input valuess for an InferenceSession with CUDA graph
        enabled or other scenarios where the OrtValue needs to be updated while
        the memory address can not be changed.
        """
        self._ortvalue.update_inplace(np_arr)


def copy_tensors(src: Sequence[OrtValue], dst: Sequence[OrtValue], stream=None) -> None:
    """
    Copy tensor data from source OrtValue sequence to destination OrtValue sequence.
    """
    c_sources = [s._get_c_value() for s in src]
    c_dsts = [d._get_c_value() for d in dst]
    C.copy_tensors(c_sources, c_dsts, stream)


class OrtDevice:
    """
    A data structure that exposes the underlying C++ OrtDevice
    """

    def __init__(self, c_ort_device):
        """
        Internal constructor
        """
        if isinstance(c_ort_device, C.OrtDevice):
            self._ort_device = c_ort_device
        else:
            # An end user won't hit this error
            raise ValueError(
                "`Provided object` needs to be of type `onnxruntime.capi.onnxruntime_pybind11_state.OrtDevice`"
            )

    def _get_c_device(self):
        """
        Internal accessor to underlying object
        """
        return self._ort_device

    @staticmethod
    def make(ort_device_name, device_id, vendor_id: int | OrtDeviceVendorId = -1):
        if vendor_id < 0:
            # Preserve the historical convenience aliases ("cuda", "dml", "cann")
            # while making them work with plugin EP shared allocators. Those
            # allocators are keyed by vendor-specific OrtDevice values even when the
            # Python package itself was built without the corresponding built-in EP.
            alias_vendor_id = get_vendor_id_for_device_type(ort_device_name)
            if alias_vendor_id is not None:
                return OrtDevice(
                    C.OrtDevice(
                        get_ort_device_type(ort_device_name),
                        C.OrtDevice.default_memory(),
                        int(alias_vendor_id),
                        device_id,
                    )
                )

            # backwards compatibility with generic predefined OrtDevice names
            return OrtDevice(
                C.OrtDevice(
                    get_ort_device_type(ort_device_name),
                    C.OrtDevice.default_memory(),
                    device_id,
                )
            )
        else:
            # generic. use GPU or NPU for ort_device_name and provide a vendor id.
            # vendor id of 0 is valid in some cases (e.g. webgpu is generic and does not have a vendor id)
            return OrtDevice(
                C.OrtDevice(
                    get_ort_device_type(ort_device_name),
                    C.OrtDevice.default_memory(),
                    int(vendor_id),
                    device_id,
                )
            )

    def device_id(self):
        return self._ort_device.device_id()

    def device_type(self):
        return self._ort_device.device_type()

    def device_vendor_id(self):
        return self._ort_device.vendor_id()

    def device_mem_type(self):
        return self._ort_device.mem_type()


class SparseTensor:
    """
    A data structure that project the C++ SparseTensor object
    The class provides API to work with the object.
    Depending on the format, the class will hold more than one buffer
    depending on the format
    """

    def __init__(self, sparse_tensor: C.SparseTensor):
        """
        Internal constructor
        """
        if isinstance(sparse_tensor, C.SparseTensor):
            self._tensor = sparse_tensor
        else:
            # An end user won't hit this error
            raise ValueError(
                "`Provided object` needs to be of type `onnxruntime.capi.onnxruntime_pybind11_state.SparseTensor`"
            )

    def _get_c_tensor(self) -> C.SparseTensor:
        return self._tensor

    @classmethod
    def sparse_coo_from_numpy(
        cls,
        dense_shape: npt.NDArray[np.int64],
        values: np.ndarray,
        coo_indices: npt.NDArray[np.int64],
        ort_device: OrtDevice,
    ) -> SparseTensor:
        """
        Factory method to construct a SparseTensor in COO format from given arguments

        :param dense_shape: 1-D  numpy array(int64) or a python list that contains a dense_shape of the sparse tensor
            must be on cpu memory
        :param values: a homogeneous, contiguous 1-D numpy array that contains non-zero elements of the tensor
            of a type.
        :param coo_indices:  contiguous numpy array(int64) that contains COO indices for the tensor. coo_indices may
            have a 1-D shape when it contains a linear index of non-zero values and its length must be equal to
            that of the values. It can also be of 2-D shape, in which has it contains pairs of coordinates for
            each of the nnz values and its length must be exactly twice of the values length.
        :param ort_device: - describes the backing memory owned by the supplied nummpy arrays. Only CPU memory is
            suppored for non-numeric data types.

        For primitive types, the method will map values and coo_indices arrays into native memory and will use
        them as backing storage. It will increment the reference count for numpy arrays and it will decrement it
        on GC. The buffers may reside in any storage either CPU or GPU.
        For strings and objects, it will create a copy of the arrays in CPU memory as ORT does not support those
        on other devices and their memory can not be mapped.
        """
        return cls(C.SparseTensor.sparse_coo_from_numpy(dense_shape, values, coo_indices, ort_device._get_c_device()))

    @classmethod
    def sparse_csr_from_numpy(
        cls,
        dense_shape: npt.NDArray[np.int64],
        values: np.ndarray,
        inner_indices: npt.NDArray[np.int64],
        outer_indices: npt.NDArray[np.int64],
        ort_device: OrtDevice,
    ) -> SparseTensor:
        """
        Factory method to construct a SparseTensor in CSR format from given arguments

        :param dense_shape: 1-D numpy array(int64) or a python list that contains a dense_shape of the
            sparse tensor (rows, cols) must be on cpu memory
        :param values: a  contiguous, homogeneous 1-D numpy array that contains non-zero elements of the tensor
            of a type.
        :param inner_indices:  contiguous 1-D numpy array(int64) that contains CSR inner indices for the tensor.
            Its length must be equal to that of the values.
        :param outer_indices:  contiguous 1-D numpy array(int64) that contains CSR outer indices for the tensor.
            Its length must be equal to the number of rows + 1.
        :param ort_device: - describes the backing memory owned by the supplied nummpy arrays. Only CPU memory is
            suppored for non-numeric data types.

        For primitive types, the method will map values and indices arrays into native memory and will use them as
        backing storage. It will increment the reference count and it will decrement then count when it is GCed.
        The buffers may reside in any storage either CPU or GPU.
        For strings and objects, it will create a copy of the arrays in CPU memory as ORT does not support those
        on other devices and their memory can not be mapped.
        """
        return cls(
            C.SparseTensor.sparse_csr_from_numpy(
                dense_shape,
                values,
                inner_indices,
                outer_indices,
                ort_device._get_c_device(),
            )
        )

    def values(self) -> np.ndarray:
        """
        The method returns a numpy array that is backed by the native memory
        if the data type is numeric. Otherwise, the returned numpy array that contains
        copies of the strings.
        """
        return self._tensor.values()

    def as_coo_view(self):
        """
        The method will return coo representation of the sparse tensor which will enable
        querying COO indices. If the instance did not contain COO format, it would throw.
        You can query coo indices as:

        ::

            coo_indices = sparse_tensor.as_coo_view().indices()

        which will return a numpy array that is backed by the native memory.
        """
        return self._tensor.get_coo_data()

    def as_csrc_view(self):
        """
        The method will return CSR(C) representation of the sparse tensor which will enable
        querying CRS(C) indices. If the instance dit not contain CSR(C) format, it would throw.
        You can query indices as:

        ::

            inner_ndices = sparse_tensor.as_csrc_view().inner()
            outer_ndices = sparse_tensor.as_csrc_view().outer()

        returning numpy arrays backed by the native memory.
        """
        return self._tensor.get_csrc_data()

    def as_blocksparse_view(self):
        """
        The method will return coo representation of the sparse tensor which will enable
        querying BlockSparse indices. If the instance did not contain BlockSparse format, it would throw.
        You can query coo indices as:

        ::

            block_sparse_indices = sparse_tensor.as_blocksparse_view().indices()

        which will return a numpy array that is backed by the native memory
        """
        return self._tensor.get_blocksparse_data()

    def to_cuda(self, ort_device):
        """
        Returns a copy of this instance on the specified cuda device

        :param ort_device: with name 'cuda' and valid gpu device id

        The method will throw if:

        - this instance contains strings
        - this instance is already on GPU. Cross GPU copy is not supported
        - CUDA is not present in this build
        - if the specified device is not valid
        """
        return SparseTensor(self._tensor.to_cuda(ort_device._get_c_device()))

    def format(self):
        """
        Returns a OrtSparseFormat enumeration
        """
        return self._tensor.format

    def dense_shape(self) -> npt.NDArray[np.int64]:
        """
        Returns a numpy array(int64) containing a dense shape of a sparse tensor
        """
        return self._tensor.dense_shape()

    def data_type(self) -> str:
        """
        Returns a string data type of the data in the OrtValue
        """
        return self._tensor.data_type()

    def device_name(self) -> str:
        """
        Returns the name of the device where the SparseTensor data buffers reside e.g. cpu, cuda
        """
        return self._tensor.device_name().lower()


# Type hint for user-specified function that allows the user to specify initializer locations when compiling a model.
GetInitializerLocationFunc = Callable[
    [str, OrtValue, C.OrtExternalInitializerInfo | None], C.OrtExternalInitializerInfo | None
]

# Type hint that adheres to the signature expected by ORT.
GetInitializerLocationWrapperFunc = Callable[
    [str, C.OrtValue, C.OrtExternalInitializerInfo | None], C.OrtExternalInitializerInfo | None
]
