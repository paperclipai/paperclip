# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.  See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------

import csv
import logging
import os
import random
import sys
import time
import timeit
from abc import ABC, abstractmethod
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from enum import Enum
from time import sleep
from typing import Any

import numpy
import torch
import transformers
from packaging import version

import onnxruntime

logger = logging.getLogger(__name__)


class Precision(Enum):
    FLOAT32 = "fp32"
    FLOAT16 = "fp16"
    INT8 = "int8"
    INT4 = "int4"

    def __str__(self):
        return self.value


class OptimizerInfo(Enum):
    # no_opt means using the raw ONNX model, but OnnxRuntime might still apply optimization as long as
    # graph optimization level is not 0 (disable all).
    NOOPT = "no_opt"
    BYORT = "by_ort"
    BYSCRIPT = "by_script"

    def __str__(self):
        return self.value


class ConfigModifier:
    def __init__(self, num_layers):
        self.num_layers = num_layers

    def modify(self, config):
        if self.num_layers is None:
            return
        if hasattr(config, "num_hidden_layers"):
            config.num_hidden_layers = self.num_layers
            logger.info(f"Modifying pytorch model's number of hidden layers to: {self.num_layers}")
        if hasattr(config, "encoder_layers"):
            config.encoder_layers = self.num_layers
            logger.info(f"Modifying pytorch model's number of encoder layers to: {self.num_layers}")
        if hasattr(config, "decoder_layers "):
            config.decoder_layers = self.num_layers
            logger.info(f"Modifying pytorch model's number of decoder layers to: {self.num_layers}")

    def get_layer_num(self):
        return self.num_layers


IO_BINDING_DATA_TYPE_MAP = {
    "float32": numpy.float32,
    # TODO: Add more.
}


def create_onnxruntime_session(
    onnx_model_path,
    use_gpu,
    provider=None,
    enable_all_optimization=True,
    num_threads=-1,
    enable_profiling=False,
    verbose=False,
    enable_mlas_gemm_fastmath_arm64_bfloat16=False,
    provider_options={},  # map execution provider name to its option  # noqa: B006
):
    sess_options = onnxruntime.SessionOptions()

    if enable_all_optimization:
        sess_options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_ALL
    else:
        sess_options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_BASIC

    if enable_profiling:
        sess_options.enable_profiling = True

    if num_threads > 0:
        sess_options.intra_op_num_threads = num_threads
        logger.debug(f"Session option: intra_op_num_threads={sess_options.intra_op_num_threads}")

    if verbose:
        sess_options.log_severity_level = 0
    else:
        sess_options.log_severity_level = 4

    if provider in onnxruntime.get_available_providers():
        providers = [provider]
    elif use_gpu:
        if provider == "dml":
            providers = ["DmlExecutionProvider", "CPUExecutionProvider"]
        elif provider == "migraphx":
            providers = [
                "MIGraphXExecutionProvider",
                "CPUExecutionProvider",
            ]
        elif provider == "cuda" or provider is None:
            providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        elif provider == "tensorrt":
            providers = [
                "TensorrtExecutionProvider",
                "CUDAExecutionProvider",
                "CPUExecutionProvider",
            ]
        else:
            raise RuntimeError(f"The execution provider is not supported: {provider}")
    else:
        providers = ["CPUExecutionProvider"]

    if provider_options:
        providers = [(name, provider_options[name]) if name in provider_options else name for name in providers]

    if enable_mlas_gemm_fastmath_arm64_bfloat16:
        sess_options.add_session_config_entry("mlas.enable_gemm_fastmath_arm64_bfloat16", "1")

    session = None
    try:
        session = onnxruntime.InferenceSession(onnx_model_path, sess_options, providers=providers)
    except Exception:
        logger.exception(f"Failed to create session for {onnx_model_path} with providers={providers}")

    return session


def setup_logger(verbose=True):
    if verbose:
        logging.basicConfig(
            format="[%(filename)s:%(lineno)s - %(funcName)20s()] %(message)s",
            level=logging.DEBUG,
        )
    else:
        logging.basicConfig(format="%(message)s", level=logging.INFO)
        logging.getLogger("transformers").setLevel(logging.WARNING)


def prepare_environment(cache_dir, output_dir, use_gpu, provider=None):
    if cache_dir and not os.path.exists(cache_dir):
        os.makedirs(cache_dir)

    if output_dir and not os.path.exists(output_dir):
        os.makedirs(output_dir)

    if use_gpu:
        if provider == "dml":
            assert "DmlExecutionProvider" in onnxruntime.get_available_providers(), (
                "Please install onnxruntime-directml package to test GPU inference."
            )

        else:
            assert not set(onnxruntime.get_available_providers()).isdisjoint(
                ["CUDAExecutionProvider", "MIGraphXExecutionProvider"]
            ), "Please install onnxruntime-gpu package, or install migraphx, to test GPU inference."

    logger.info(f"PyTorch Version:{torch.__version__}")
    logger.info(f"Transformers Version:{transformers.__version__}")
    logger.info(f"OnnxRuntime Version:{onnxruntime.__version__}")

    # Support three major versions of PyTorch and OnnxRuntime, and up to 9 months of transformers.
    assert version.parse(torch.__version__) >= version.parse("1.10.0")
    assert version.parse(transformers.__version__) >= version.parse("4.12.0")
    assert version.parse(onnxruntime.__version__) >= version.parse("1.10.0")


def get_latency_result(latency_list, batch_size):
    latency_ms = sum(latency_list) / float(len(latency_list)) * 1000.0
    latency_variance = numpy.var(latency_list, dtype=numpy.float64) * 1000.0
    throughput = batch_size * (1000.0 / latency_ms)

    return {
        "test_times": len(latency_list),
        "latency_variance": f"{latency_variance:.2f}",
        "latency_90_percentile": f"{numpy.percentile(latency_list, 90) * 1000.0:.2f}",
        "latency_95_percentile": f"{numpy.percentile(latency_list, 95) * 1000.0:.2f}",
        "latency_99_percentile": f"{numpy.percentile(latency_list, 99) * 1000.0:.2f}",
        "average_latency_ms": f"{latency_ms:.2f}",
        "QPS": f"{throughput:.2f}",
    }


def output_details(results, csv_filename):
    with open(csv_filename, mode="a", newline="", encoding="ascii") as csv_file:
        column_names = [
            "engine",
            "version",
            "providers",
            "device",
            "precision",
            "optimizer",
            "io_binding",
            "model_name",
            "inputs",
            "threads",
            "batch_size",
            "sequence_length",
            "custom_layer_num",
            "datetime",
            "test_times",
            "QPS",
            "average_latency_ms",
            "latency_variance",
            "latency_90_percentile",
            "latency_95_percentile",
            "latency_99_percentile",
        ]

        csv_writer = csv.DictWriter(csv_file, fieldnames=column_names)
        csv_writer.writeheader()
        for result in results:
            csv_writer.writerow(result)

    logger.info(f"Detail results are saved to csv file: {csv_filename}")


def output_summary(results, csv_filename, args):
    with open(csv_filename, mode="a", newline="", encoding="ascii") as csv_file:
        header_names = [
            "model_name",
            "inputs",
            "custom_layer_num",
            "engine",
            "version",
            "providers",
            "device",
            "precision",
            "optimizer",
            "io_binding",
            "threads",
        ]
        data_names = []
        for batch_size in args.batch_sizes:
            if args.sequence_lengths == [""]:
                data_names.append(f"b{batch_size}")
            else:
                for sequence_length in args.sequence_lengths:
                    data_names.append(f"b{batch_size}_s{sequence_length}")

        csv_writer = csv.DictWriter(csv_file, fieldnames=header_names + data_names)
        csv_writer.writeheader()
        for model_name in args.models:
            for input_count in [1, 2, 3]:
                for engine_name in args.engines:
                    for io_binding in [True, False, ""]:
                        for threads in args.num_threads:
                            row = {}
                            for result in results:
                                if (
                                    result["model_name"] == model_name
                                    and result["inputs"] == input_count
                                    and result["engine"] == engine_name
                                    and result["io_binding"] == io_binding
                                    and result["threads"] == threads
                                ):
                                    headers = {k: v for k, v in result.items() if k in header_names}
                                    if not row:
                                        row.update(headers)
                                        row.update(dict.fromkeys(data_names, ""))
                                    else:
                                        for k in header_names:
                                            assert row[k] == headers[k]
                                    b = result["batch_size"]
                                    s = result["sequence_length"]
                                    if s:
                                        row[f"b{b}_s{s}"] = result["average_latency_ms"]
                                    else:
                                        row[f"b{b}"] = result["average_latency_ms"]
                            if row:
                                csv_writer.writerow(row)

    logger.info(f"Summary results are saved to csv file: {csv_filename}")


def output_fusion_statistics(model_fusion_statistics, csv_filename):
    with open(csv_filename, mode="a", newline="", encoding="ascii") as csv_file:
        column_names = [
            "model_filename",
            "datetime",
            "transformers",
            "torch",
            *list(next(iter(model_fusion_statistics.values())).keys()),
        ]
        csv_writer = csv.DictWriter(csv_file, fieldnames=column_names)
        csv_writer.writeheader()
        for key in model_fusion_statistics:
            model_fusion_statistics[key]["datetime"] = str(datetime.now())
            model_fusion_statistics[key]["transformers"] = transformers.__version__
            model_fusion_statistics[key]["torch"] = torch.__version__
            model_fusion_statistics[key]["model_filename"] = key
            csv_writer.writerow(model_fusion_statistics[key])
    logger.info(f"Fusion statistics is saved to csv file: {csv_filename}")


def inference_ort(ort_session, ort_inputs, result_template, repeat_times, batch_size, warm_up_repeat=0):
    result = {}
    timeit.repeat(lambda: ort_session.run(None, ort_inputs), number=1, repeat=warm_up_repeat)  # Dry run
    latency_list = timeit.repeat(lambda: ort_session.run(None, ort_inputs), number=1, repeat=repeat_times)
    result.update(result_template)
    result.update({"io_binding": False})
    result.update(get_latency_result(latency_list, batch_size))
    return result


def inference_ort_with_io_binding(
    ort_session,
    ort_inputs,
    result_template,
    repeat_times,
    ort_output_names,
    ort_outputs,
    output_buffers,
    output_buffer_max_sizes,
    batch_size,
    device,
    data_type=numpy.longlong,
    warm_up_repeat=0,
):
    result = {}

    # Bind inputs and outputs to onnxruntime session
    io_binding = ort_session.io_binding()
    # Bind inputs to device
    for name in ort_inputs:
        np_input = torch.from_numpy(ort_inputs[name]).to(device)
        input_type = IO_BINDING_DATA_TYPE_MAP.get(str(ort_inputs[name].dtype), data_type)
        io_binding.bind_input(
            name,
            np_input.device.type,
            0,
            input_type,
            np_input.shape,
            np_input.data_ptr(),
        )
    # Bind outputs buffers with the sizes needed if not allocated already
    if len(output_buffers) == 0:
        allocateOutputBuffers(output_buffers, output_buffer_max_sizes, device)

    for i, ort_output_name in enumerate(ort_output_names):
        io_binding.bind_output(
            ort_output_name,
            output_buffers[i].device.type,
            0,
            numpy.float32,
            ort_outputs[i].shape,
            output_buffers[i].data_ptr(),
        )

    timeit.repeat(
        lambda: ort_session.run_with_iobinding(io_binding),
        number=1,
        repeat=warm_up_repeat,
    )  # Dry run

    latency_list = timeit.repeat(
        lambda: ort_session.run_with_iobinding(io_binding),
        number=1,
        repeat=repeat_times,
    )
    result.update(result_template)
    result.update({"io_binding": True})
    result.update(get_latency_result(latency_list, batch_size))
    return result


def allocateOutputBuffers(output_buffers, output_buffer_max_sizes, device):  # noqa: N802
    # Allocate output tensors with the largest test size needed. So the allocated memory can be reused
    # for each test run.

    for i in output_buffer_max_sizes:
        output_buffers.append(torch.empty(i, dtype=torch.float32, device=device))


def set_random_seed(seed=123):
    """Set random seed manually to get deterministic results"""
    random.seed(seed)
    numpy.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    # torch.backends.cudnn.enabled = False
    # torch.backends.cudnn.benchmark = False
    # torch.backends.cudnn.deterministic = True


def get_gpu_info() -> list[dict[str, Any]] | None:
    from py3nvml.py3nvml import (  # noqa: PLC0415
        NVMLError,
        nvmlDeviceGetCount,
        nvmlDeviceGetHandleByIndex,
        nvmlDeviceGetMemoryInfo,
        nvmlDeviceGetName,
        nvmlInit,
        nvmlShutdown,
    )

    try:
        nvmlInit()
        result = []
        device_count = nvmlDeviceGetCount()
        if not isinstance(device_count, int):
            return None

        for i in range(device_count):
            info = nvmlDeviceGetMemoryInfo(nvmlDeviceGetHandleByIndex(i))
            if isinstance(info, str):
                return None
            result.append(
                {
                    "id": i,
                    "name": nvmlDeviceGetName(nvmlDeviceGetHandleByIndex(i)),
                    "total": info.total,
                    "free": info.free,
                    "used": info.used,
                }
            )
        nvmlShutdown()
        return result
    except NVMLError as error:
        print("Error fetching GPU information using nvml: %s", error)
        return None


class MemoryMonitor(ABC):
    def __init__(self, keep_measuring=True):
        self.keep_measuring = keep_measuring

    def measure_cpu_usage(self):
        import psutil  # noqa: PLC0415

        max_usage = 0
        while True:
            max_usage = max(max_usage, psutil.Process(os.getpid()).memory_info().rss / 1024**2)
            sleep(0.005)  # 5ms
            if not self.keep_measuring:
                break
        return max_usage

    @abstractmethod
    def measure_gpu_usage(self) -> list[dict[str, Any]] | None:
        raise NotImplementedError()


class CudaMemoryMonitor(MemoryMonitor):
    def __init__(self, keep_measuring=True):
        super().__init__(keep_measuring)

    def measure_gpu_usage(self) -> list[dict[str, Any]] | None:
        from py3nvml.py3nvml import (  # noqa: PLC0415
            NVMLError,
            nvmlDeviceGetCount,
            nvmlDeviceGetHandleByIndex,
            nvmlDeviceGetMemoryInfo,
            nvmlDeviceGetName,
            nvmlInit,
            nvmlShutdown,
        )

        max_gpu_usage = []
        gpu_name = []
        try:
            nvmlInit()
            device_count = nvmlDeviceGetCount()
            if not isinstance(device_count, int):
                logger.error(f"nvmlDeviceGetCount result is not integer: {device_count}")
                return None

            max_gpu_usage = [0 for i in range(device_count)]
            gpu_name = [nvmlDeviceGetName(nvmlDeviceGetHandleByIndex(i)) for i in range(device_count)]
            while True:
                for i in range(device_count):
                    info = nvmlDeviceGetMemoryInfo(nvmlDeviceGetHandleByIndex(i))
                    if isinstance(info, str):
                        logger.error(f"nvmlDeviceGetMemoryInfo returns str: {info}")
                        return None
                    max_gpu_usage[i] = max(max_gpu_usage[i], info.used / 1024**2)
                sleep(0.005)  # 5ms
                if not self.keep_measuring:
                    break
            nvmlShutdown()
            return [
                {
                    "device_id": i,
                    "name": gpu_name[i],
                    "max_used_MB": max_gpu_usage[i],
                }
                for i in range(device_count)
            ]
        except NVMLError as error:
            logger.error("Error fetching GPU information using nvml: %s", error)
            return None


class RocmMemoryMonitor(MemoryMonitor):
    def __init__(self, keep_measuring=True):
        super().__init__(keep_measuring)
        rocm_smi_path = "/opt/rocm/libexec/rocm_smi"
        if os.path.exists(rocm_smi_path):
            if rocm_smi_path not in sys.path:
                sys.path.append(rocm_smi_path)
        try:
            import rocm_smi  # noqa: PLC0415

            self.rocm_smi = rocm_smi
            self.rocm_smi.initializeRsmi()
        except ImportError:
            self.rocm_smi = None

    def get_used_memory(self, dev):
        if self.rocm_smi is None:
            return -1
        return self.rocm_smi.getMemInfo(dev, "VRAM")[0] / 1024 / 1024

    def measure_gpu_usage(self):
        if self.rocm_smi is None:
            return None

        device_count = len(self.rocm_smi.listDevices()) if self.rocm_smi is not None else 0
        max_gpu_usage = [0 for i in range(device_count)]
        gpu_name = [f"GPU{i}" for i in range(device_count)]
        while True:
            for i in range(device_count):
                max_gpu_usage[i] = max(max_gpu_usage[i], self.get_used_memory(i))
            time.sleep(0.005)  # 5ms
            if not self.keep_measuring:
                break
        return [
            {
                "device_id": i,
                "name": gpu_name[i],
                "max_used_MB": max_gpu_usage[i],
            }
            for i in range(device_count)
        ]


def measure_memory(is_gpu, func, monitor_type="cuda", start_memory=None):
    memory_monitor_type = None
    if monitor_type == "rocm":
        memory_monitor_type = RocmMemoryMonitor
    else:
        memory_monitor_type = CudaMemoryMonitor

    monitor = memory_monitor_type(False)

    if is_gpu:
        if start_memory is not None:
            memory_before_test = start_memory
        else:
            memory_before_test = monitor.measure_gpu_usage()
        if memory_before_test is None:
            return None

        if func is None:
            return memory_before_test

        with ThreadPoolExecutor() as executor:
            monitor = memory_monitor_type()
            mem_thread = executor.submit(monitor.measure_gpu_usage)
            try:
                fn_thread = executor.submit(func)
                _ = fn_thread.result()
            finally:
                monitor.keep_measuring = False
                max_usage = mem_thread.result()

            if max_usage is None:
                return None

            logger.info(f"GPU memory usage: before={memory_before_test}  peak={max_usage}")
            if len(memory_before_test) >= 1 and len(max_usage) >= 1 and len(memory_before_test) == len(max_usage):
                # When there are multiple GPUs, we will check the one with maximum usage.
                max_used = 0
                for i, memory_before in enumerate(memory_before_test):
                    before = memory_before["max_used_MB"]
                    after = max_usage[i]["max_used_MB"]
                    used = after - before
                    max_used = max(max_used, used)
                return max_used
        return None

    # CPU memory
    if start_memory is not None:
        memory_before_test = start_memory
    else:
        memory_before_test = monitor.measure_cpu_usage()

    if func is None:
        return memory_before_test

    with ThreadPoolExecutor() as executor:
        monitor = memory_monitor_type()
        mem_thread = executor.submit(monitor.measure_cpu_usage)
        try:
            fn_thread = executor.submit(func)
            _ = fn_thread.result()
        finally:
            monitor.keep_measuring = False
            max_usage = mem_thread.result()

        logger.info(f"CPU memory usage: before={memory_before_test:.1f} MB, peak={max_usage:.1f} MB")
        return max_usage - memory_before_test


def get_ort_environment_variables():
    # Environment variables might impact ORT performance on transformer models. Note that they are for testing only.
    env_names = [
        "ORT_DISABLE_FUSED_ATTENTION",
        "ORT_ENABLE_FUSED_CAUSAL_ATTENTION",
        "ORT_DISABLE_FUSED_CROSS_ATTENTION",
        "ORT_DISABLE_TRT_FLASH_ATTENTION",
        "ORT_DISABLE_MEMORY_EFFICIENT_ATTENTION",
        "ORT_TRANSFORMER_OPTIONS",
        "ORT_CUDA_GEMM_OPTIONS",
    ]
    env = ""
    for name in env_names:
        value = os.getenv(name)
        if value is None:
            continue
        if env:
            env += ","
        env += f"{name}={value}"
    return env
