# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
import ctypes
import sys
import warnings


def find_cudart_versions(build_env=False, build_cuda_version=None):
    # ctypes.CDLL and ctypes.util.find_library load the latest installed library.
    # it may not the the library that would be loaded by onnxruntime.
    # for example, in an environment with Cuda 11.1 and subsequently
    # conda cudatoolkit 10.2.89 installed. ctypes will find cudart 10.2. however,
    # onnxruntime built with Cuda 11.1 will find and load cudart for Cuda 11.1.
    # for the above reason, we need find all versions in the environment and
    # only give warnings if the expected cuda version is not found.
    # in onnxruntime build environment, we expected only one Cuda version.
    if not sys.platform.startswith("linux"):
        warnings.warn("find_cudart_versions only works on Linux")
        return None

    cudart_possible_versions = {None, build_cuda_version}

    def get_cudart_version(find_cudart_version=None):
        cudart_lib_filename = "libcudart.so"
        if find_cudart_version:
            cudart_lib_filename = cudart_lib_filename + "." + find_cudart_version

        try:
            cudart = ctypes.CDLL(cudart_lib_filename)
            cudart.cudaRuntimeGetVersion.restype = int
            cudart.cudaRuntimeGetVersion.argtypes = [ctypes.POINTER(ctypes.c_int)]
            version = ctypes.c_int()
            status = cudart.cudaRuntimeGetVersion(ctypes.byref(version))
            if status != 0:
                return None
        except Exception:
            return None

        return version.value

    # use set to avoid duplications
    cudart_found_versions = {get_cudart_version(cudart_version) for cudart_version in cudart_possible_versions}

    # convert to list and remove None
    return [ver for ver in cudart_found_versions if ver]
