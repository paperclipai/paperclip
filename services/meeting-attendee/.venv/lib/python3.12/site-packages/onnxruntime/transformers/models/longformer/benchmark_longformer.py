# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.  See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------
#
# This script run benchmark of latency or peak memory usage of Longformer model inference.
# Please run convert_to_onnx.py to get onnx model before running benchmark.
#
# It is tested with python 3.8, onnxruntime-gpu 1.11.0, PyTorch 1.11.0, transformers 4.18.0, CUDA 11.3 like:
#   conda create -n gpu_env python=3.8
#   conda activate gpu_env
#   pip3 install torch torchvision torchaudio --extra-index-url https://download.pytorch.org/whl/cu113
#   pip3 install onnx transformers onnxruntime-gpu numpy sympy psutil py3nvml
#   python benchmark_longformer.py
#
# When there is no parameter, pre-defined tests will run on the longformer-base-4096 model.

# Benchmark the latency:
#   python benchmark_longformer.py --model longformer-base-4096 --batch_sizes 1 --sequence_lengths 512 1024 2048 4096 \
#          --global_lengths 8 --onnx ./longformer-base-4096_fp16.onnx -t 100
#
# Benchmark GPU peak memory:
#   export ORT_LONGFORMER_COMPACT_MEMORY=0
#   python benchmark_longformer.py --model longformer-base-4096 --batch_sizes 1 --sequence_lengths 4096 \
#          --global_lengths 8 --onnx ./longformer-base-4096_fp32.onnx --memory -t 10 --engine onnxruntime
#   export ORT_LONGFORMER_COMPACT_MEMORY=1
#   python benchmark_longformer.py --model longformer-base-4096 --batch_sizes 1 --sequence_lengths 4096 \
#          --global_lengths 8 --onnx ./longformer-base-4096_fp32.onnx --memory -t 10 --engine onnxruntime
#
# By default, compact memory kernel is enabled. To disable it, set environment variable ORT_LONGFORMER_COMPACT_MEMORY=0.

import argparse
import csv
import logging
import math
import os
import re
import sys
import timeit
import traceback
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime
from typing import Any

import benchmark_helper
import numpy as np
import torch
from longformer_helper import PRETRAINED_LONGFORMER_MODELS, LongformerHelper, LongformerInputs
from transformers import LongformerModel

import onnxruntime

logger = logging.getLogger("")


def test_torch_latency(
    device,
    model,
    model_name,
    batch_sizes,
    sequence_lengths,
    global_lengths,
    test_times,
    num_threads,
) -> list[dict[str, Any]]:
    if num_threads > 0:
        torch.set_num_threads(num_threads)

    results = []
    for batch_size in batch_sizes:
        for sequence_length in sequence_lengths:
            for global_length in global_lengths:
                logger.info(f"batch_size={batch_size} sequence_length={sequence_length} global_length={global_length}")
                inputs: LongformerInputs = LongformerHelper.get_dummy_inputs(
                    batch_size, sequence_length, global_length, device
                )
                input_list = inputs.to_list()

                _ = model(*input_list)
                runtimes = timeit.repeat(lambda: model(*input_list), repeat=test_times, number=1)  # noqa: B023
                result = {
                    "engine": "torch",  # TODO: test torchscript
                    "version": torch.__version__,
                    "device": "cuda",
                    "optimizer": "",
                    "precision": "fp32",
                    "io_binding": "",
                    "model_name": model_name,
                    "description": model_name + " [torch]",
                    "inputs": 3,
                    "threads": num_threads,
                    "batch_size": batch_size,
                    "sequence_length": sequence_length,
                    "global_length": global_length,
                    "datetime": str(datetime.now()),
                    "memory": "NA",
                    "diff_max": 0,
                    "diff_90_percentile": 0,
                    "diff_95_percentile": 0,
                    "diff_99_percentile": 0,
                    "use_compact_memory": "NA",
                }
                result.update(benchmark_helper.get_latency_result(runtimes, batch_size))
                logger.info("%s", result)
                results.append(result)
    return results


def test_parity(device, model, ort_session, batch_size, sequence_length, global_length, verbose=True):
    parameters = f"batch_size={batch_size} sequence_length={sequence_length} global_length={global_length}"
    logger.info(f"Comparing Torch and ORT outputs for {parameters}...")
    dummy_inputs: LongformerInputs = LongformerHelper.get_dummy_inputs(
        batch_size, sequence_length, global_length, device
    )
    ort_inputs = dummy_inputs.get_ort_inputs()
    ort_outputs = ort_session.run(None, ort_inputs)
    input_list = dummy_inputs.to_list()
    torch_outputs = model(*input_list)
    max_diff = np.amax(torch_outputs[0].cpu().numpy() - ort_outputs[0])
    logger.info(f"last_state max diff = {max_diff}")
    if verbose and (math.isnan(max_diff) or max_diff > 0.001):
        print("torch last_state:", torch_outputs[0])
        print("ort last_state:", ort_outputs[0])
    return float(max_diff)


def test_ort_latency(
    device,
    model,
    model_name,
    description,
    ort_session,
    batch_sizes,
    sequence_lengths,
    global_lengths,
    test_times,
    num_threads,
    optimizer=False,
    precision="fp32",
    disable_io_binding=False,
    verbose=True,
    use_compact_memory=False,
    use_half4=False,
    disable_parity=False,
) -> list[dict[str, Any]]:
    results = []
    for batch_size in batch_sizes:
        for sequence_length in sequence_lengths:
            for global_length in global_lengths:
                assert global_length <= model.config.attention_window[0], (
                    "Limitation of current implementation: number of global token <= attention_window"
                )

                logger.info(
                    f"Testing batch_size={batch_size} sequence_length={sequence_length} global_length={global_length} "
                    f"optimizer={optimizer}, precision={precision} io_binding={not disable_io_binding}..."
                )
                dummy_inputs: LongformerInputs = LongformerHelper.get_dummy_inputs(
                    batch_size, sequence_length, global_length, device
                )

                # Run OnnxRuntime
                ort_inputs = dummy_inputs.get_ort_inputs()

                if verbose:
                    print(ort_inputs)

                # run one query for warm up
                ort_outputs = ort_session.run(None, ort_inputs)

                result_template = {
                    "model_name": model_name,
                    "description": description,
                    "inputs": 3,
                    "engine": "OnnxRuntime",
                    "version": str(onnxruntime.__version__),
                    "device": "cuda",
                    "precision": str(precision),
                    "optimizer": int(optimizer),
                    "threads": int(num_threads),
                    "batch_size": int(batch_size),
                    "sequence_length": int(sequence_length),
                    "global_length": int(global_length),
                    "test_times": int(test_times),
                    "datetime": str(datetime.now()),
                    "memory": "",
                    "diff_max": None,
                    "diff_90_percentile": None,
                    "diff_95_percentile": None,
                    "diff_99_percentile": None,
                    "use_compact_memory": use_compact_memory,
                    "use_half4": use_half4,
                }

                if not disable_io_binding:
                    max_last_state_size = max(batch_sizes) * max(sequence_lengths) * model.config.hidden_size
                    max_pooler_size = max(batch_sizes) * max(sequence_lengths)
                    result = benchmark_helper.inference_ort_with_io_binding(
                        ort_session,
                        ort_inputs,
                        result_template=result_template,
                        repeat_times=test_times,
                        ort_output_names=["last_state", "pooler"],
                        ort_outputs=ort_outputs,
                        output_buffers=[],
                        output_buffer_max_sizes=[max_last_state_size, max_pooler_size],
                        batch_size=batch_size,
                        device=device,
                        data_type=np.longlong,  # input data type
                    )
                else:
                    result = benchmark_helper.inference_ort(
                        ort_session,
                        ort_inputs,
                        result_template=result_template,
                        repeat_times=test_times,
                        batch_size=batch_size,
                    )

                # measure result difference between PyTorch and OnnxRuntime
                if not disable_parity:
                    diff_results = [
                        test_parity(
                            device,
                            model,
                            ort_session,
                            batch_size,
                            sequence_length,
                            global_length,
                            verbose,
                        )
                        for _ in range(test_times)
                    ]

                    result["diff_max"] = max(diff_results)
                    result["diff_90_percentile"] = np.percentile(diff_results, 90)
                    result["diff_95_percentile"] = np.percentile(diff_results, 95)
                    result["diff_99_percentile"] = np.percentile(diff_results, 99)

                results.append(result)
    return results


def test_ort_memory(
    device,
    onnx_model_path,
    batch_size,
    sequence_length,
    global_length,
    test_times,
    num_threads,
) -> dict[str, Any]:
    logger.info(
        f"Testing memory for model={onnx_model_path}, batch_size={batch_size}, sequence_length={sequence_length}, "
        f"global_length={global_length}, test_times={test_times}, num_threads={num_threads}"
    )

    def inference():
        # Update Arena strategy so that we can measure the minimum memory required
        cuda_provider_options = {"arena_extend_strategy": "kSameAsRequested"}
        provider_options = {"CUDAExecutionProvider": cuda_provider_options}
        session = benchmark_helper.create_onnxruntime_session(
            onnx_model_path,
            use_gpu=True,
            enable_all_optimization=True,
            num_threads=num_threads,
            provider_options=provider_options,
        )

        dummy_inputs: LongformerInputs = LongformerHelper.get_dummy_inputs(
            batch_size, sequence_length, global_length, device
        )
        ort_inputs = dummy_inputs.get_ort_inputs()
        for _ in range(test_times):
            _ = session.run(None, ort_inputs)

    memory_used = benchmark_helper.measure_memory(is_gpu=True, func=inference)

    return {
        "onnx_model": onnx_model_path,
        "batch_size": batch_size,
        "sequence_length": sequence_length,
        "global_length": global_length,
        "test_times": test_times,
        "num_threads": num_threads,
        "memory": memory_used,
    }


def load_torch_model(model_name, device):
    torch_model_name_or_dir = PRETRAINED_LONGFORMER_MODELS.get(model_name, model_name)
    model = LongformerModel.from_pretrained(torch_model_name_or_dir)
    model.to(device)
    return model


def find_onnx_model(model_name, onnx_dir="."):
    # Search onnx model in the following order: optimized fp16 model, optimized fp32 model, raw model
    onnx_model_path = os.path.join(onnx_dir, model_name + ".onnx")
    optimized_fp32_model = os.path.join(onnx_dir, model_name + "_fp32.onnx")
    optimized_fp16_model = os.path.join(onnx_dir, model_name + "_fp16.onnx")
    if os.path.isfile(optimized_fp16_model):
        onnx_model_path = optimized_fp16_model
    elif os.path.isfile(optimized_fp32_model):
        onnx_model_path = optimized_fp32_model
    return onnx_model_path


def test_memory(args, device) -> dict[str, Any]:
    if len(args.batch_sizes) > 1:
        raise RuntimeError("For memory test, only one batch_size (-b) is allowed.")
    if len(args.sequence_lengths) > 1:
        raise RuntimeError("For memory test, only one sequence_length (-s) is allowed.")
    if len(args.global_lengths) > 1:
        raise RuntimeError("For memory test, only one global_length (-g) is allowed.")

    model_name = args.model
    onnx_model_path = find_onnx_model(model_name) if not args.onnx else args.onnx

    torch.cuda.empty_cache()
    return test_ort_memory(
        device,
        onnx_model_path,
        args.batch_sizes[0],
        args.sequence_lengths[0],
        args.global_lengths[0],
        args.test_times,
        args.num_threads,
    )


def test_ort(args, device) -> list[dict[str, Any]]:
    model_name = args.model

    onnx_model_path = find_onnx_model(model_name) if not args.onnx else args.onnx

    optimized = onnx_model_path.endswith("_fp16.onnx") or onnx_model_path.endswith("_fp32.onnx")  # noqa: PIE810
    precision = "fp32" if not onnx_model_path.endswith("_fp16.onnx") else "fp16"

    model = load_torch_model(model_name, device)

    num_threads = args.num_threads

    cuda_provider_options = {"arena_extend_strategy": "kSameAsRequested"}
    provider_options = {"CUDAExecutionProvider": cuda_provider_options}
    session = benchmark_helper.create_onnxruntime_session(
        onnx_model_path,
        use_gpu=True,
        enable_all_optimization=True,
        num_threads=num_threads,
        provider_options=provider_options,
    )
    if session is None:
        raise RuntimeError(f"Failed to create ORT session from ONNX file {onnx_model_path}")

    use_compact_memory = os.environ.get("ORT_LONGFORMER_COMPACT_MEMORY", "1") == "1"
    description = onnx_model_path
    if not use_compact_memory:
        description += "[non_compact_memory]"

    if args.use_half4:
        description += "[half4]" if precision == "fp16" else "[float4]"
    else:
        description += "[half2]" if precision == "fp16" else "[float4]"

    return test_ort_latency(
        device,
        model,
        model_name,
        description,
        session,
        args.batch_sizes,
        args.sequence_lengths,
        args.global_lengths,
        args.test_times,
        num_threads,
        optimized,
        precision,
        args.disable_io_binding,
        args.verbose,
        use_compact_memory,
        args.use_half4,
        args.disable_parity,
    )


def test_torch(args, device) -> list[dict[str, Any]]:
    model = load_torch_model(args.model, device)
    return test_torch_latency(
        device,
        model,
        args.model,
        args.batch_sizes,
        args.sequence_lengths,
        args.global_lengths,
        args.test_times,
        args.num_threads,
    )


def test_latency(args, device) -> list[dict[str, Any]]:
    if args.engine == "onnxruntime":
        return test_ort(args, device)

    return test_torch(args, device)


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "-m",
        "--model",
        required=False,
        type=str,
        default="longformer-base-4096",
        help="Checkpoint directory or pre-trained model names in the list: "
        + ", ".join(PRETRAINED_LONGFORMER_MODELS.keys()),
    )

    parser.add_argument(
        "-e",
        "--engine",
        required=False,
        type=str,
        default="onnxruntime",
        choices=["onnxruntime", "torch"],
        help="Engine to benchmark.",
    )

    parser.add_argument(
        "-t",
        "--test_times",
        required=False,
        default=1000,
        type=int,
        help="Number of repeat times to get average inference latency.",
    )

    parser.add_argument("-b", "--batch_sizes", nargs="+", type=int, default=[1])

    # If --export_padding is not used in exporting onnx model, there is no padding in ONNX model,
    # and you will need padding inputs by yourself before running onnx model.
    # Here, we only test sequence length that is multiple of attention window size.
    parser.add_argument(
        "-s",
        "--sequence_lengths",
        nargs="+",
        type=int,
        default=[512, 1024, 2048, 4096],
        help="Sequence lengths. It could have multiple values in latency test."
        "If --export_padding is not used, sequence length shall be multiple of window size.",
    )

    parser.add_argument("--onnx", required=False, type=str, default=None, help="Onnx model path")

    parser.add_argument(
        "-g",
        "--global_lengths",
        nargs="+",
        type=int,
        default=[0],
        help="Number of global tokens. It could have multiple values in latency test.",
    )

    parser.add_argument(
        "-n",
        "--num_threads",
        required=False,
        type=int,
        default=0,
        help="Threads to use.",
    )

    parser.add_argument(
        "--disable_io_binding",
        required=False,
        action="store_true",
        help="Do not use IO Binding.",
    )

    parser.add_argument(
        "--memory",
        required=False,
        action="store_true",
        help="Test memory usage instead of latency.",
    )

    parser.add_argument("--verbose", required=False, action="store_true", help="Print more information.")
    parser.set_defaults(verbose=False)

    parser.add_argument("--use_half4", required=False, action="store_true", help="Use half4 kernel.")
    parser.set_defaults(use_half4=False)

    parser.add_argument("--disable_parity", required=False, action="store_true", help="Do not run parity test.")
    parser.set_defaults(disable_parity=False)

    args = parser.parse_args(argv)

    return args


def output_details(results, csv_filename):
    latency_results = [result for result in results if "average_latency_ms" in result]
    if len(latency_results) == 0:
        print("No latency results for output.")
        return

    with open(csv_filename, mode="a", newline="", encoding="ascii") as csv_file:
        column_names = [
            "engine",
            "version",
            "device",
            "precision",
            "optimizer",
            "io_binding",
            "model_name",
            "inputs",
            "threads",
            "datetime",
            "test_times",
            "description",
            "batch_size",
            "sequence_length",
            "global_length",
            "use_compact_memory",
            "use_half4",
            "diff_max",
            "diff_90_percentile",
            "diff_95_percentile",
            "diff_99_percentile",
            "memory",
            "QPS",
            "average_latency_ms",
            "latency_variance",
            "latency_90_percentile",
            "latency_95_percentile",
            "latency_99_percentile",
        ]

        csv_writer = csv.DictWriter(csv_file, fieldnames=column_names)
        csv_writer.writeheader()
        for result in latency_results:
            print(result)
            csv_writer.writerow(result)

        csv_file.flush()

    print(f"Detail results are saved to csv file: {csv_filename}")


def run(args) -> list[dict[str, Any]]:
    torch.set_grad_enabled(False)

    # set random seed manually to get deterministic results
    benchmark_helper.set_random_seed(123)

    # Currently, the longformer attention operator could only run in GPU (no CPU implementation yet).
    device = torch.device("cuda:0")

    if args.memory:
        return [test_memory(args, device)]  # Convert to List so that return type is same as test_latency

    return test_latency(args, device)


def launch_test(arguments) -> list[dict[str, Any]]:
    if not torch.cuda.is_available():
        raise RuntimeError("Please install PyTorch with Cuda, and use a machine with GPU for testing gpu performance.")

    with ProcessPoolExecutor() as executor:
        results = list(executor.map(run, [arguments]))
        assert len(results) == 1
        return results[0]


def run_tests(
    use_compact_memory=True,
    run_torch=False,
    run_memory=True,
    use_io_binding=True,
    use_fp16=True,
    use_merged_qkv_weights=True,
    use_half4=True,
    batch_size=1,
):
    compact_memory = "1" if use_compact_memory else "0"
    os.environ["ORT_LONGFORMER_COMPACT_MEMORY"] = compact_memory
    logger.info(f"ORT_LONGFORMER_COMPACT_MEMORY={compact_memory}")

    os.environ["ORT_LONGFORMER_USE_HALF4"] = "1" if use_half4 else "0"
    logger.info("ORT_LONGFORMER_USE_HALF4={}".format("1" if use_half4 else "0"))  # noqa: G001

    results = []
    test_times = 1000
    sequence_lengths = [4096, 2048, 1024, 512]
    batch_sizes = [batch_size]
    for model_name in ["longformer-base-4096"]:
        for batch_size in batch_sizes:
            for sequence_length in sequence_lengths:
                for global_length in [16]:
                    if run_torch:
                        engine_name = "torch"
                        args = parse_arguments(
                            f"-e {engine_name} -t {test_times} -b {batch_size} -s {sequence_length} -g {global_length} "
                            f"-t {test_times} -m {model_name}".split(" ")
                        )
                        results += run(args)

                    engine_name = "onnxruntime"
                    file_format = 1 if use_merged_qkv_weights else 0
                    onnx_path = (
                        f"{model_name}_f{file_format}_fp16.onnx"
                        if use_fp16
                        else f"{model_name}_f{file_format}_fp32.onnx"
                    )
                    if not os.path.exists(onnx_path):
                        raise RuntimeError(f"onnx file not exists:{onnx_path}")

                    arguments = (
                        f"-e {engine_name} --onnx {onnx_path} "
                        f"-b {batch_size} -s {sequence_length} -g {global_length} -m {model_name}"
                    )

                    if not use_io_binding:
                        arguments += " --disable_io_binding"

                    if use_half4:
                        arguments += " --use_half4"

                    # Disable parity test to avoid out of memory for large batch size
                    if batch_size >= 4:
                        arguments += " --disable_parity"

                    memory_results = None
                    try:
                        if run_memory:
                            args = parse_arguments(f"{arguments} -t 10 --memory".split(" "))
                            memory_results = launch_test(args)

                        args = parse_arguments(f"{arguments} -t {test_times}".split(" "))
                        latency_results = launch_test(args)
                    except KeyboardInterrupt as exc:
                        raise RuntimeError("Keyboard Interrupted") from exc
                    except Exception:
                        traceback.print_exc()
                        continue

                    if len(latency_results) == 1:
                        latency_results[0]["memory"] = memory_results[0]["memory"] if memory_results else "N/A"
                    else:
                        raise RuntimeError("length of latency_results should be 1")

                    logger.info("%s", latency_results)

                    results += latency_results
    return results


def output_summary(results, csv_filename, data_field="average_latency_ms"):
    with open(csv_filename, mode="a", newline="", encoding="ascii") as csv_file:
        header_names = [
            "model_name",
            "precision",
            "engine",
            "version",
            "global_length",
            "use_compact_memory",
            "use_half4",
            "description",
        ]

        description_list = list({result["description"] for result in results})
        description_list.sort()

        batch_sizes = list({result["batch_size"] for result in results})
        batch_sizes.sort()

        sequence_lengths = list({result["sequence_length"] for result in results})
        sequence_lengths.sort()

        data_names = []
        for sequence_length in sequence_lengths:
            for batch_size in batch_sizes:
                data_names.append(f"b{batch_size}_s{sequence_length}")

        csv_writer = csv.DictWriter(csv_file, fieldnames=header_names + data_names)
        csv_writer.writeheader()

        for description in description_list:
            row = {}

            sum_latency = {}
            sum_latency.update(dict.fromkeys(data_names, 0))

            count_latency = {}
            count_latency.update(dict.fromkeys(data_names, 0))

            for result in results:
                if result["description"] == description and result[data_field]:
                    headers = {k: v for k, v in result.items() if k in header_names}
                    if not row:
                        row.update(headers)
                    else:
                        for k in header_names:
                            if row[k] != headers[k]:
                                raise RuntimeError("Description shall be unique")

                    batch_size = result["batch_size"]
                    sequence_length = result["sequence_length"]
                    key = f"b{batch_size}_s{sequence_length}"

                    try:
                        latency = float(result[data_field])
                    except ValueError:
                        continue

                    sum_latency[key] += latency
                    count_latency[key] += 1

            if row:
                for key in data_names:
                    if key in count_latency and count_latency[key] > 0:
                        row[key] = sum_latency[key] / count_latency[key]
                    else:
                        row[key] = ""

                csv_writer.writerow(row)

        csv_file.flush()


def run_experiments(use_fp16, batch_size, is_baseline=False):
    """Run experiments to compare different algorithms on one batch size"""
    test_results = run_tests(
        use_fp16=use_fp16,
        use_merged_qkv_weights=True,
        use_half4=False,
        batch_size=batch_size,
    )

    if is_baseline:
        return test_results

    if use_fp16:
        test_results += run_tests(
            use_fp16=use_fp16,
            use_merged_qkv_weights=True,
            use_half4=True,
            batch_size=batch_size,
        )

        test_results += run_tests(
            use_fp16=use_fp16,
            use_merged_qkv_weights=False,
            use_half4=True,
            batch_size=batch_size,
        )

    test_results += run_tests(
        use_fp16=use_fp16,
        use_merged_qkv_weights=False,
        use_half4=False,
        batch_size=batch_size,
    )

    return test_results


def main():
    torch.multiprocessing.set_start_method("spawn")

    args = parse_arguments()

    benchmark_helper.setup_logger(args.verbose)

    if len(sys.argv) > 1:
        test_results = launch_test(args)
        time_stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        csv_filename = f"benchmark_detail_{time_stamp}.csv"
        output_details(test_results, csv_filename)
        return

    gpu_list = benchmark_helper.get_gpu_info()
    logger.info("GPU info: %s", gpu_list)
    fp16_batch_sizes = [16, 8, 4, 2, 1]
    fp32_batch_sizes = [4, 2, 1]
    if gpu_list and gpu_list[0]["total"] >= 32 * 1024 * 1024 * 1024:  # 32 GB
        fp16_batch_sizes = [64, 32, 16, 8, 4, 2, 1]
        fp32_batch_sizes = [16, 8, 4, 2, 1]

    gpu_name = re.sub(r"(?u)[^-\w.]", "_", gpu_list[0]["name"]) if gpu_list else "gpu"
    is_baseline = os.environ.get("ORT_LONGFORMER_BASELINE", "0") == "1"
    experiment_name = f"longformer_base_{gpu_name}" + ("_baseline" if is_baseline else "")
    logger.info(
        f"experiment_name={experiment_name}, fp16_batch_sizes={fp16_batch_sizes}, fp32_batch_sizes={fp32_batch_sizes}"
    )

    total_runs = 1
    all_results = []
    for _ in range(total_runs):
        for batch_size in fp16_batch_sizes:
            fp16_results = run_experiments(use_fp16=True, batch_size=batch_size, is_baseline=is_baseline)
            output_details(fp16_results, "longformer_base_fp16.csv")
            all_results += fp16_results
    for metric_name in ["average_latency_ms", "QPS", "memory", "diff_90_percentile"]:
        output_summary(all_results, f"{experiment_name}_{metric_name}.csv", metric_name)

    all_results = []
    for _ in range(total_runs):
        for batch_size in fp32_batch_sizes:
            fp32_results = run_experiments(use_fp16=False, batch_size=batch_size, is_baseline=is_baseline)
            output_details(fp32_results, "longformer_base_fp32.csv")
            all_results += fp32_results
    for metric_name in ["average_latency_ms", "QPS", "memory", "diff_90_percentile"]:
        output_summary(all_results, f"{experiment_name}_{metric_name}.csv", metric_name)


if __name__ == "__main__":
    main()
