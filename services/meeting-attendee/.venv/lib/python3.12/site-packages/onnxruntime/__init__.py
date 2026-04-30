# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
"""
ONNX Runtime is a performance-focused scoring engine for Open Neural Network Exchange (ONNX) models.
For more information on ONNX Runtime, please see `aka.ms/onnxruntime <https://aka.ms/onnxruntime/>`_
or the `Github project <https://github.com/microsoft/onnxruntime/>`_.
"""

import contextlib

__version__ = "1.25.1"
__author__ = "Microsoft"

# we need to do device version validation (for example to check Cuda version for an onnxruntime-training package).
# in order to know whether the onnxruntime package is for training it needs
# to do import onnxruntime.training.ortmodule first.
# onnxruntime.capi._pybind_state is required before import onnxruntime.training.ortmodule.
# however, import onnxruntime.capi._pybind_state will already raise an exception if a required Cuda version
# is not found.
# here we need to save the exception and continue with Cuda version validation in order to post
# meaningful messages to the user.
# the saved exception is raised after device version validation.
try:
    from onnxruntime.capi._pybind_state import (
        ExecutionMode,  # noqa: F401
        ExecutionOrder,  # noqa: F401
        GraphOptimizationLevel,  # noqa: F401
        LoraAdapter,  # noqa: F401
        ModelMetadata,  # noqa: F401
        NodeArg,  # noqa: F401
        OrtAllocatorType,  # noqa: F401
        OrtArenaCfg,  # noqa: F401
        OrtCompileApiFlags,  # noqa: F401
        OrtDeviceMemoryType,  # noqa: F401
        OrtEpAssignedNode,  # noqa: F401
        OrtEpAssignedSubgraph,  # noqa: F401
        OrtEpDevice,  # noqa: F401
        OrtExecutionProviderDevicePolicy,  # noqa: F401
        OrtExternalInitializerInfo,  # noqa: F401
        OrtHardwareDevice,  # noqa: F401
        OrtHardwareDeviceType,  # noqa: F401
        OrtMemoryInfo,  # noqa: F401
        OrtMemoryInfoDeviceType,  # noqa: F401
        OrtMemType,  # noqa: F401
        OrtSparseFormat,  # noqa: F401
        OrtSyncStream,  # noqa: F401
        RunOptions,  # noqa: F401
        SessionIOBinding,  # noqa: F401
        SessionOptions,  # noqa: F401
        create_and_register_allocator,  # noqa: F401
        create_and_register_allocator_v2,  # noqa: F401
        disable_telemetry_events,  # noqa: F401
        enable_telemetry_events,  # noqa: F401
        get_all_providers,  # noqa: F401
        get_available_providers,  # noqa: F401
        get_build_info,  # noqa: F401
        get_device,  # noqa: F401
        get_ep_devices,  # noqa: F401
        get_version_string,  # noqa: F401
        has_collective_ops,  # noqa: F401
        register_execution_provider_library,  # noqa: F401
        set_default_logger_severity,  # noqa: F401
        set_default_logger_verbosity,  # noqa: F401
        set_global_thread_pool_sizes,  # noqa: F401
        set_seed,  # noqa: F401
        unregister_execution_provider_library,  # noqa: F401
    )

    import_capi_exception = None
except Exception as e:
    import_capi_exception = e

from onnxruntime.capi import onnxruntime_validation

if import_capi_exception:
    raise import_capi_exception

from onnxruntime.capi.onnxruntime_inference_collection import (
    AdapterFormat,  # noqa: F401
    InferenceSession,  # noqa: F401
    IOBinding,  # noqa: F401
    ModelCompiler,  # noqa: F401
    OrtDevice,  # noqa: F401
    OrtDeviceVendorId,  # noqa: F401
    OrtValue,  # noqa: F401
    SparseTensor,  # noqa: F401
    copy_tensors,  # noqa: F401
)

# TODO: thiagofc: Temporary experimental namespace for new PyTorch front-end
try:  # noqa: SIM105
    from . import experimental  # noqa: F401
except ImportError:
    pass


package_name, version, cuda_version = onnxruntime_validation.get_package_name_and_version_info()

if version:
    __version__ = version

onnxruntime_validation.check_distro_info()


def _get_package_version(package_name: str):
    from importlib.metadata import PackageNotFoundError, version  # noqa: PLC0415

    try:
        package_version = version(package_name)
    except PackageNotFoundError:
        package_version = None
    return package_version


def _get_package_root(package_name: str, directory_name: str | None = None):
    from importlib.metadata import PackageNotFoundError, distribution  # noqa: PLC0415

    root_directory_name = directory_name or package_name
    try:
        dist = distribution(package_name)
        files = dist.files or []

        for file in files:
            if file.name.endswith("__init__.py") and root_directory_name in file.parts:
                return file.locate().parent

        # Fallback to the first __init__.py
        if not directory_name:
            for file in files:
                if file.name.endswith("__init__.py"):
                    return file.locate().parent
    except PackageNotFoundError:
        # package not found, do nothing
        pass

    return None


def _extract_cuda_major_version(version_str: str) -> str:
    """Extract CUDA major version from version string (e.g., '12.1' -> '12').

    Args:
        version_str: CUDA version string to parse

    Returns:
        Major version as string, or "12" if parsing fails
    """
    return version_str.split(".")[0] if version_str else "12"


def _get_cufft_version(cuda_major: str) -> str:
    """Get cufft library version based on CUDA major version.

    Args:
        cuda_major: CUDA major version as string (e.g., "12", "13")

    Returns:
        cufft version as string
    """
    # cufft versions: CUDA 12.x -> 11, CUDA 13.x -> 12
    return "12" if cuda_major == "13" else "11"


def _get_nvidia_dll_paths(is_windows: bool, cuda: bool = True, cudnn: bool = True):
    # Dynamically determine CUDA major version from build info
    cuda_major_version = _extract_cuda_major_version(cuda_version)
    cufft_version = _get_cufft_version(cuda_major_version)

    if is_windows:
        # Path is relative to site-packages directory.
        cuda_dll_paths = [
            ("nvidia", "cublas", "bin", f"cublasLt64_{cuda_major_version}.dll"),
            ("nvidia", "cublas", "bin", f"cublas64_{cuda_major_version}.dll"),
            ("nvidia", "cufft", "bin", f"cufft64_{cufft_version}.dll"),
            ("nvidia", "cuda_runtime", "bin", f"cudart64_{cuda_major_version}.dll"),
        ]
        cudnn_dll_paths = [
            ("nvidia", "cudnn", "bin", "cudnn_engines_runtime_compiled64_9.dll"),
            ("nvidia", "cudnn", "bin", "cudnn_engines_precompiled64_9.dll"),
            ("nvidia", "cudnn", "bin", "cudnn_heuristic64_9.dll"),
            ("nvidia", "cudnn", "bin", "cudnn_ops64_9.dll"),
            ("nvidia", "cudnn", "bin", "cudnn_adv64_9.dll"),
            ("nvidia", "cudnn", "bin", "cudnn_graph64_9.dll"),
            ("nvidia", "cudnn", "bin", "cudnn64_9.dll"),
        ]
    else:  # Linux
        # cublas64 depends on cublasLt64, so cublasLt64 should be loaded first.
        cuda_dll_paths = [
            ("nvidia", "cublas", "lib", f"libcublasLt.so.{cuda_major_version}"),
            ("nvidia", "cublas", "lib", f"libcublas.so.{cuda_major_version}"),
            ("nvidia", "cuda_nvrtc", "lib", f"libnvrtc.so.{cuda_major_version}"),
            ("nvidia", "curand", "lib", "libcurand.so.10"),
            ("nvidia", "cufft", "lib", f"libcufft.so.{cufft_version}"),
            ("nvidia", "cuda_runtime", "lib", f"libcudart.so.{cuda_major_version}"),
        ]

        # Do not load cudnn sub DLLs (they will be dynamically loaded later) to be consistent with PyTorch in Linux.
        cudnn_dll_paths = [
            ("nvidia", "cudnn", "lib", "libcudnn.so.9"),
        ]

    return (cuda_dll_paths if cuda else []) + (cudnn_dll_paths if cudnn else [])


def print_debug_info():
    """Print information to help debugging."""
    import importlib.util  # noqa: PLC0415
    import os  # noqa: PLC0415
    import platform  # noqa: PLC0415
    from importlib.metadata import distributions  # noqa: PLC0415

    print(f"{package_name} version: {__version__}")
    if cuda_version:
        print(f"CUDA version used in build: {cuda_version}")
    print("platform:", platform.platform())

    print("\nPython package, version and location:")
    ort_packages = []
    for dist in distributions():
        package = dist.metadata["Name"]
        if package == "onnxruntime" or package.startswith(("onnxruntime-", "ort-")):
            # Exclude packages whose root directory name is not onnxruntime.
            location = _get_package_root(package, "onnxruntime")
            if location and (package not in ort_packages):
                ort_packages.append(package)
                print(f"{package}=={dist.version} at {location}")

    if len(ort_packages) > 1:
        print(
            "\033[33mWARNING: multiple onnxruntime packages are installed to the same location. "
            "Please 'pip uninstall` all above packages, then `pip install` only one of them.\033[0m"
        )

    if cuda_version:
        # Print version of installed packages that is related to CUDA or cuDNN DLLs.
        cuda_major = _extract_cuda_major_version(cuda_version)

        packages = [
            "torch",
            f"nvidia-cuda-runtime-cu{cuda_major}",
            f"nvidia-cudnn-cu{cuda_major}",
            f"nvidia-cublas-cu{cuda_major}",
            f"nvidia-cufft-cu{cuda_major}",
            f"nvidia-curand-cu{cuda_major}",
            f"nvidia-cuda-nvrtc-cu{cuda_major}",
            f"nvidia-nvjitlink-cu{cuda_major}",
        ]
        for package in packages:
            directory_name = "nvidia" if package.startswith("nvidia-") else None
            version = _get_package_version(package)
            if version:
                print(f"{package}=={version} at {_get_package_root(package, directory_name)}")
            else:
                print(f"{package} not installed")

    if platform.system() == "Windows":
        print(f"\nEnvironment variable:\nPATH={os.environ.get('PATH', '(unset)')}")
    elif platform.system() == "Linux":
        print(f"\nEnvironment variable:\nLD_LIBRARY_PATH={os.environ.get('LD_LIBRARY_PATH', '(unset)')}")

    if importlib.util.find_spec("psutil"):

        def is_target_dll(path: str):
            target_keywords = ["vcruntime140", "msvcp140"]
            if cuda_version:
                target_keywords = ["cufft", "cublas", "cudart", "nvrtc", "curand", "cudnn", *target_keywords]
            return any(keyword in path for keyword in target_keywords)

        import psutil  # noqa: PLC0415

        p = psutil.Process(os.getpid())

        print("\nList of loaded DLLs:")
        for lib in p.memory_maps():
            if is_target_dll(lib.path.lower()):
                print(lib.path)

        if cuda_version:
            if importlib.util.find_spec("cpuinfo") and importlib.util.find_spec("py3nvml"):
                from .transformers.machine_info import get_device_info  # noqa: PLC0415

                print("\nDevice information:")
                print(get_device_info())
            else:
                print("please `pip install py-cpuinfo py3nvml` to show device information.")
    else:
        print("please `pip install psutil` to show loaded DLLs.")


def preload_dlls(cuda: bool = True, cudnn: bool = True, msvc: bool = True, directory=None):
    """Preload CUDA 12.x+ and cuDNN 9.x DLLs in Windows or Linux, and MSVC runtime DLLs in Windows.

       When the installed PyTorch is compatible (using same major version of CUDA and cuDNN),
       there is no need to call this function if `import torch` is done before `import onnxruntime`.

    Args:
        cuda (bool, optional): enable loading CUDA DLLs. Defaults to True.
        cudnn (bool, optional): enable loading cuDNN DLLs. Defaults to True.
        msvc (bool, optional): enable loading MSVC DLLs in Windows. Defaults to True.
        directory(str, optional): a directory contains CUDA or cuDNN DLLs. It can be an absolute path,
           or a path relative to the directory of this file.
           If directory is None (default value), the search order: the lib directory of compatible PyTorch in Windows,
            nvidia site packages, default DLL loading paths.
           If directory is empty string (""), the search order: nvidia site packages, default DLL loading paths.
           If directory is a path, the search order: the directory, default DLL loading paths.
    """
    import ctypes  # noqa: PLC0415
    import os  # noqa: PLC0415
    import platform  # noqa: PLC0415
    import sys  # noqa: PLC0415

    if platform.system() not in ["Windows", "Linux"]:
        return

    is_windows = platform.system() == "Windows"
    if is_windows and msvc:
        try:
            ctypes.CDLL("vcruntime140.dll")
            ctypes.CDLL("msvcp140.dll")
            if platform.machine() != "ARM64":
                ctypes.CDLL("vcruntime140_1.dll")
        except OSError:
            print("Microsoft Visual C++ Redistributable is not installed, this may lead to the DLL load failure.")
            print("It can be downloaded at https://aka.ms/vs/17/release/vc_redist.x64.exe.")

    # Check if CUDA version is supported (12.x or 13.x+)
    ort_cuda_major = None
    if cuda_version:
        try:
            ort_cuda_major = int(cuda_version.split(".")[0])
            if ort_cuda_major < 12 and (cuda or cudnn):
                print(
                    f"\033[33mWARNING: {package_name} is built with CUDA {cuda_version}, which is not supported for preloading. "
                    f"CUDA 12.x or newer is required. Call preload_dlls with cuda=False and cudnn=False.\033[0m"
                )
                return
        except ValueError:
            print(
                f"\033[33mWARNING: Unable to parse CUDA version '{cuda_version}'. "
                "Skipping DLL preloading. Call preload_dlls with cuda=False and cudnn=False.\033[0m"
            )
            return
    elif cuda or cudnn:
        # No CUDA version info available but CUDA/cuDNN preloading requested
        return

    is_cuda_cudnn_imported_by_torch = False

    if is_windows:
        torch_version = _get_package_version("torch")
        # Check if torch CUDA version matches onnxruntime CUDA version
        torch_cuda_major = None
        if torch_version and "+cu" in torch_version:
            with contextlib.suppress(ValueError):
                # Extract CUDA version from torch (e.g., "2.0.0+cu121" -> 12)
                cu_part = torch_version.split("+cu")[1]
                torch_cuda_major = int(cu_part[:2])  # First 2 digits are major version

        is_torch_cuda_compatible = (
            torch_cuda_major == ort_cuda_major if (torch_cuda_major and ort_cuda_major) else False
        )

        if "torch" in sys.modules:
            is_cuda_cudnn_imported_by_torch = is_torch_cuda_compatible
            if torch_cuda_major and ort_cuda_major and torch_cuda_major != ort_cuda_major:
                print(
                    f"\033[33mWARNING: The installed PyTorch {torch_version} uses CUDA {torch_cuda_major}.x, "
                    f"but {package_name} is built with CUDA {ort_cuda_major}.x. "
                    f"Please install PyTorch for CUDA {ort_cuda_major}.x to be compatible.\033[0m"
                )

        if is_torch_cuda_compatible and directory is None:
            torch_root = _get_package_root("torch", "torch")
            if torch_root:
                directory = os.path.join(torch_root, "lib")

    base_directory = directory or ".."
    if not os.path.isabs(base_directory):
        base_directory = os.path.join(os.path.dirname(__file__), base_directory)
    base_directory = os.path.normpath(base_directory)
    if not os.path.isdir(base_directory):
        raise RuntimeError(f"Invalid parameter of directory={directory}. The directory does not exist!")

    if is_cuda_cudnn_imported_by_torch:
        # In Windows, PyTorch has loaded CUDA and cuDNN DLLs during `import torch`, no need to load them again.
        print("Skip loading CUDA and cuDNN DLLs since torch is imported.")
        return

    # Try load DLLs from nvidia site packages.
    dll_paths = _get_nvidia_dll_paths(is_windows, cuda, cudnn)
    loaded_dlls = []
    for relative_path in dll_paths:
        dll_path = (
            os.path.join(base_directory, relative_path[-1])
            if directory
            else os.path.join(base_directory, *relative_path)
        )
        if os.path.isfile(dll_path):
            try:
                _ = ctypes.CDLL(dll_path)
                loaded_dlls.append(relative_path[-1])
            except Exception as e:
                print(f"Failed to load {dll_path}: {e}")

    # Try load DLLs with default path settings.
    has_failure = False
    for relative_path in dll_paths:
        dll_filename = relative_path[-1]
        if dll_filename not in loaded_dlls:
            try:
                _ = ctypes.CDLL(dll_filename)
            except Exception as e:
                has_failure = True
                print(f"Failed to load {dll_filename}: {e}")

    if has_failure:
        print("Please follow https://onnxruntime.ai/docs/install/#cuda-and-cudnn to install CUDA and CuDNN.")
