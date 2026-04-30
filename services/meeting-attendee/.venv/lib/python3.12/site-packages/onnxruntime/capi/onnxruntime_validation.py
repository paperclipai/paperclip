# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
"""
Check OS requirements for ONNX Runtime Python Bindings.
"""

import linecache
import platform
import warnings


def check_distro_info():
    __my_distro__ = ""
    __my_distro_ver__ = ""
    __my_system__ = platform.system().lower()

    __OS_RELEASE_FILE__ = "/etc/os-release"  # noqa: N806
    __LSB_RELEASE_FILE__ = "/etc/lsb-release"  # noqa: N806

    if __my_system__ == "windows":
        __my_distro__ = __my_system__
        __my_distro_ver__ = platform.release().lower()

        if __my_distro_ver__ not in ["10", "11", "2016server", "2019server", "2022server", "2025server"]:
            warnings.warn(
                f"Unsupported Windows version ({__my_distro_ver__}). ONNX Runtime supports Windows 10 and above, or Windows Server 2016 and above."
            )
    elif __my_system__ == "linux":
        """Although the 'platform' python module for getting Distro information works well on standard OS images
        running on real hardware, it is not accurate when running on Azure VMs, Git Bash, Cygwin, etc.
        The returned values for release and version are unpredictable for virtualized or emulated environments.
        /etc/os-release and /etc/lsb_release files, on the other hand, are guaranteed to exist and have standard values
        in all OSes supported by onnxruntime. The former is the current standard file to check OS info and the latter
        is its predecessor.
        """
        # Newer systems have /etc/os-release with relevant distro info
        __my_distro__ = linecache.getline(__OS_RELEASE_FILE__, 3)[3:-1]
        __my_distro_ver__ = linecache.getline(__OS_RELEASE_FILE__, 6)[12:-2]

        # Older systems may have /etc/os-release instead
        if not __my_distro__:
            __my_distro__ = linecache.getline(__LSB_RELEASE_FILE__, 1)[11:-1]
            __my_distro_ver__ = linecache.getline(__LSB_RELEASE_FILE__, 2)[16:-1]

        # Instead of trying to parse distro specific files,
        # warn the user ONNX Runtime may not work out of the box
        __my_distro__ = __my_distro__.lower()
        __my_distro_ver__ = __my_distro_ver__.lower()
    elif __my_system__ == "darwin":
        __my_distro__ = __my_system__
        __my_distro_ver__ = platform.release().lower()

        if int(__my_distro_ver__.split(".")[0]) < 11:
            warnings.warn(
                f"Unsupported macOS version ({__my_distro_ver__}). ONNX Runtime supports macOS 11.0 or later."
            )
    elif __my_system__ == "aix":
        import subprocess  # noqa: PLC0415

        returned_output = subprocess.check_output("oslevel")
        __my_distro_ver__str = returned_output.decode("utf-8")
        __my_distro_ver = __my_distro_ver__str[:3]
    else:
        warnings.warn(
            f"Unsupported platform ({__my_system__}). ONNX Runtime supports Linux, macOS, AIX and Windows platforms, only."
        )


def get_package_name_and_version_info():
    package_name = ""
    version = ""
    cuda_version = ""

    try:
        from .build_and_package_info import __version__ as version  # noqa: PLC0415
        from .build_and_package_info import package_name  # noqa: PLC0415

        try:  # noqa: SIM105
            from .build_and_package_info import cuda_version  # noqa: PLC0415
        except ImportError:
            # cuda_version is optional. For example, cpu only package does not have the attribute.
            pass
    except Exception as e:
        warnings.warn("WARNING: failed to collect package name and version info")
        print(e)

    return package_name, version, cuda_version


def check_training_module():
    import_ortmodule_exception = None

    has_ortmodule = False
    try:
        from onnxruntime.training.ortmodule import ORTModule  # noqa: F401, PLC0415

        has_ortmodule = True
    except ImportError:
        # ORTModule not present
        has_ortmodule = False
    except Exception as e:
        # this may happen if Cuda is not installed, we want to raise it after
        # for any exception other than not having ortmodule, we want to continue
        # device version validation and raise the exception after.
        try:
            from onnxruntime.training.ortmodule._fallback import ORTModuleInitException  # noqa: PLC0415

            if isinstance(e, ORTModuleInitException):
                # ORTModule is present but not ready to run yet
                has_ortmodule = True
        except Exception:
            # ORTModule not present
            has_ortmodule = False

        if not has_ortmodule:
            import_ortmodule_exception = e

    # collect onnxruntime package name, version, and cuda version
    package_name, version, cuda_version = get_package_name_and_version_info()

    if has_ortmodule and cuda_version:
        try:
            # collect cuda library build info. the library info may not be available
            # when the build environment has none or multiple libraries installed
            try:
                from .build_and_package_info import cudart_version  # noqa: PLC0415
            except ImportError:
                warnings.warn("WARNING: failed to get cudart_version from onnxruntime build info.")
                cudart_version = None

            def print_build_package_info():
                warnings.warn(f"onnxruntime training package info: package_name: {package_name}")
                warnings.warn(f"onnxruntime training package info: __version__: {version}")
                warnings.warn(f"onnxruntime training package info: cuda_version: {cuda_version}")
                warnings.warn(f"onnxruntime build info: cudart_version: {cudart_version}")

            # collection cuda library info from current environment.
            from onnxruntime.capi.onnxruntime_collect_build_info import find_cudart_versions  # noqa: PLC0415

            local_cudart_versions = find_cudart_versions(build_env=False, build_cuda_version=cuda_version)
            if cudart_version and local_cudart_versions and cudart_version not in local_cudart_versions:
                print_build_package_info()
                warnings.warn("WARNING: failed to find cudart version that matches onnxruntime build info")
                warnings.warn(f"WARNING: found cudart versions: {local_cudart_versions}")
        except Exception as e:
            warnings.warn("WARNING: failed to collect onnxruntime version and build info")
            print(e)

    if import_ortmodule_exception:
        raise import_ortmodule_exception

    return has_ortmodule, package_name, version, cuda_version
