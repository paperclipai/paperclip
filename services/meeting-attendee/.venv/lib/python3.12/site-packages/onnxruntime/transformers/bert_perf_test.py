# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

# This tool measures the inference performance of onnxruntime on BERT-like model with inputs like input_ids,
# token_type_ids (optional), and attention_mask (optional).
#
# If the model does not have exactly three inputs like above, you might need specify names of inputs with
# --input_ids_name, --segment_ids_name and --input_mask_name

# Example command to run test on batch_size 1 and 2 for a model on GPU:
#   python bert_perf_test.py --model bert.onnx --batch_size 1 2 --sequence_length 128 --use_gpu --samples 1000 --test_times 1

import argparse
import csv
import json
import multiprocessing
import os
import random
import statistics
import timeit
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np
import psutil
import torch
from bert_test_data import generate_test_data, get_bert_inputs


@dataclass
class TestSetting:
    batch_size: int
    sequence_length: int
    test_cases: int
    test_times: int
    use_gpu: bool
    use_io_binding: bool
    provider: str
    intra_op_num_threads: int
    seed: int
    verbose: bool
    log_severity: int
    average_sequence_length: int
    random_sequence_length: bool


@dataclass
class ModelSetting:
    model_path: str
    input_ids_name: str
    segment_ids_name: str
    input_mask_name: str
    opt_level: int
    input_tuning_results: str | None
    output_tuning_results: str | None
    mask_type: int


def create_session(
    model_path,
    use_gpu,
    provider,
    intra_op_num_threads,
    graph_optimization_level=None,
    log_severity=2,
    tuning_results_path=None,
):
    import onnxruntime  # noqa: PLC0415

    onnxruntime.set_default_logger_severity(log_severity)

    if use_gpu and ("CUDAExecutionProvider" not in onnxruntime.get_available_providers()):
        print(
            "Warning: Please install onnxruntime-gpu package instead of onnxruntime, and use a machine with GPU for testing gpu performance."
        )

    if use_gpu:
        if provider == "dml":
            execution_providers = ["DmlExecutionProvider", "CPUExecutionProvider"]
        elif provider == "migraphx":
            execution_providers = [
                "MIGraphXExecutionProvider",
                "CPUExecutionProvider",
            ]
        elif provider == "cuda":
            execution_providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        elif provider == "tensorrt":
            execution_providers = [
                "TensorrtExecutionProvider",
                "CUDAExecutionProvider",
                "CPUExecutionProvider",
            ]
        else:
            execution_providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    else:
        execution_providers = ["CPUExecutionProvider"]

    sess_options = onnxruntime.SessionOptions()
    sess_options.log_severity_level = log_severity
    sess_options.execution_mode = onnxruntime.ExecutionMode.ORT_SEQUENTIAL

    if graph_optimization_level is None:
        sess_options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_ALL
    elif graph_optimization_level == 0:
        sess_options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_DISABLE_ALL
    elif graph_optimization_level == 1:
        sess_options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_BASIC
    elif graph_optimization_level == 2:
        sess_options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_EXTENDED
    elif graph_optimization_level == 3:
        sess_options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_LAYOUT
    elif graph_optimization_level == 99:
        sess_options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_ALL
    else:
        sess_options.graph_optimization_level = graph_optimization_level

    if intra_op_num_threads is not None:
        sess_options.intra_op_num_threads = intra_op_num_threads

    session = onnxruntime.InferenceSession(model_path, sess_options, providers=execution_providers)

    if use_gpu:
        if provider == "dml":
            assert "DmlExecutionProvider" in session.get_providers()
        elif provider == "migraphx":
            assert "MIGraphXExecutionProvider" in session.get_providers()
        elif provider == "cuda":
            assert "CUDAExecutionProvider" in session.get_providers()
        elif provider == "tensorrt":
            assert "TensorrtExecutionProvider" in session.get_providers()
            assert "CUDAExecutionProvider" in session.get_providers()
        else:
            assert "CUDAExecutionProvider" in session.get_providers()
    else:
        assert "CPUExecutionProvider" in session.get_providers()

    if tuning_results_path is not None:
        with open(tuning_results_path) as f:
            session.set_tuning_results(json.load(f))

    return session


def numpy_type(torch_type):
    type_map = {
        torch.float32: np.float32,
        torch.float16: np.float16,
        torch.int32: np.int32,
        torch.int64: np.longlong,
    }
    return type_map[torch_type]


def create_input_output_tensors(inputs, outputs, device):
    input_tensors = {name: torch.from_numpy(array).to(device) for name, array in inputs.items()}
    output_tensors = {name: torch.from_numpy(array).to(device) for name, array in outputs.items()}
    return input_tensors, output_tensors


def create_io_binding(sess, input_tensors, output_tensors):
    io_binding = sess.io_binding()
    for name, tensor in input_tensors.items():
        io_binding.bind_input(
            name,
            tensor.device.type,
            0,
            numpy_type(tensor.dtype),
            tensor.shape,
            tensor.data_ptr(),
        )
    for name, tensor in output_tensors.items():
        io_binding.bind_output(
            name,
            tensor.device.type,
            0,
            numpy_type(tensor.dtype),
            tensor.shape,
            tensor.data_ptr(),
        )
    return io_binding


def onnxruntime_inference_with_io_binding(session, all_inputs, output_names, test_setting):
    results = []
    latency_list = []
    device = "cuda" if test_setting.use_gpu else "cpu"
    for _test_case_id, inputs in enumerate(all_inputs):
        result = session.run(output_names, inputs)
        results.append(result)
        outputs = {}
        for i in range(len(output_names)):
            outputs[output_names[i]] = result[i]

        input_tensors, output_tensors = create_input_output_tensors(inputs, outputs, device)
        io_binding = create_io_binding(session, input_tensors, output_tensors)

        # warm up once
        session.run_with_iobinding(io_binding)

        start_time = timeit.default_timer()
        session.run_with_iobinding(io_binding)
        latency = timeit.default_timer() - start_time
        latency_list.append(latency)

    return results, latency_list


def onnxruntime_inference(session, all_inputs, output_names):
    if len(all_inputs) > 0:
        # Use a random input as warm up.
        session.run(output_names, random.choice(all_inputs))

    results = []
    latency_list = []
    for _test_case_id, inputs in enumerate(all_inputs):
        start_time = timeit.default_timer()
        result = session.run(output_names, inputs)
        latency = timeit.default_timer() - start_time
        results.append(result)
        latency_list.append(latency)
    return results, latency_list


def to_string(model_path, session, test_setting):
    sess_options = session.get_session_options()
    option = f"model={os.path.basename(model_path)},"
    option += f"graph_optimization_level={sess_options.graph_optimization_level},intra_op_num_threads={sess_options.intra_op_num_threads},".replace(
        "GraphOptimizationLevel.ORT_", ""
    )

    option += f"batch_size={test_setting.batch_size},sequence_length={test_setting.sequence_length},"
    option += f"test_cases={test_setting.test_cases},test_times={test_setting.test_times},"
    option += f"use_gpu={test_setting.use_gpu},use_io_binding={test_setting.use_io_binding},"
    option += f"average_sequence_length={test_setting.average_sequence_length},"
    option += f"random_sequence_length={test_setting.random_sequence_length}"
    return option


def run_one_test(model_setting, test_setting, perf_results, all_inputs, intra_op_num_threads):
    session = create_session(
        model_setting.model_path,
        test_setting.use_gpu,
        test_setting.provider,
        intra_op_num_threads,
        model_setting.opt_level,
        log_severity=test_setting.log_severity,
        tuning_results_path=model_setting.input_tuning_results,
    )
    output_names = [output.name for output in session.get_outputs()]

    key = to_string(model_setting.model_path, session, test_setting)
    if key in perf_results:
        print("skip duplicated test:", key)
        return

    print("Running test:", key)

    all_latency_list = []
    if test_setting.use_io_binding:
        for _i in range(test_setting.test_times):
            results, latency_list = onnxruntime_inference_with_io_binding(
                session, all_inputs, output_names, test_setting
            )
            all_latency_list.extend(latency_list)
    else:
        for _i in range(test_setting.test_times):
            results, latency_list = onnxruntime_inference(session, all_inputs, output_names)
            all_latency_list.extend(latency_list)

    # latency in milliseconds
    latency_ms = np.array(all_latency_list) * 1000

    average_latency = statistics.mean(latency_ms)
    latency_50 = np.percentile(latency_ms, 50)
    latency_75 = np.percentile(latency_ms, 75)
    latency_90 = np.percentile(latency_ms, 90)
    latency_95 = np.percentile(latency_ms, 95)
    latency_99 = np.percentile(latency_ms, 99)
    throughput = test_setting.batch_size * (1000.0 / average_latency)

    perf_results[key] = (
        average_latency,
        latency_50,
        latency_75,
        latency_90,
        latency_95,
        latency_99,
        throughput,
    )

    print(
        "Average latency = {} ms, Throughput = {} QPS".format(format(average_latency, ".2f"), format(throughput, ".2f"))
    )

    if model_setting.output_tuning_results:
        output_path = os.path.abspath(model_setting.output_tuning_results)
        if os.path.exists(output_path):
            old_output_path = output_path
            output_path = f"""{output_path.rsplit(".json", 1)[0]}.{datetime.now().timestamp()}.json"""
            print("WARNING:", old_output_path, "exists, will write to", output_path, "instead.")

        trs = session.get_tuning_results()
        with open(output_path, "w") as f:
            json.dump(trs, f)
        print("Tuning results is saved to", output_path)


def launch_test(model_setting, test_setting, perf_results, all_inputs, intra_op_num_threads):
    process = multiprocessing.Process(
        target=run_one_test,
        args=(
            model_setting,
            test_setting,
            perf_results,
            all_inputs,
            intra_op_num_threads,
        ),
    )
    process.start()
    process.join()


def run_perf_tests(model_setting, test_setting, perf_results, all_inputs):
    if test_setting.intra_op_num_threads is not None:
        launch_test(
            model_setting,
            test_setting,
            perf_results,
            all_inputs,
            test_setting.intra_op_num_threads,
        )
        return

    cpu_count = psutil.cpu_count(logical=False)
    logical_cores = psutil.cpu_count(logical=True)

    candidate_threads = list({logical_cores, cpu_count})
    for i in range(1, min(16, logical_cores)):
        if i not in candidate_threads:
            candidate_threads.append(i)
    candidate_threads.sort(reverse=True)

    for intra_op_num_threads in candidate_threads:
        launch_test(model_setting, test_setting, perf_results, all_inputs, intra_op_num_threads)


def run_performance(model_setting, test_setting, perf_results):
    input_ids, segment_ids, input_mask = get_bert_inputs(
        model_setting.model_path,
        model_setting.input_ids_name,
        model_setting.segment_ids_name,
        model_setting.input_mask_name,
    )

    # Do not generate random mask for performance test.
    print(
        f"Generating {test_setting.test_cases} samples for batch_size={test_setting.batch_size} sequence_length={test_setting.sequence_length}"
    )
    all_inputs = generate_test_data(
        test_setting.batch_size,
        test_setting.sequence_length,
        test_setting.test_cases,
        test_setting.seed,
        test_setting.verbose,
        input_ids,
        segment_ids,
        input_mask,
        test_setting.average_sequence_length,
        test_setting.random_sequence_length,
        mask_type=model_setting.mask_type,
    )

    run_perf_tests(model_setting, test_setting, perf_results, all_inputs)


def parse_arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, type=str, help="bert onnx model path")

    parser.add_argument(
        "-b",
        "--batch_size",
        required=True,
        type=int,
        nargs="+",
        help="batch size of input. Allow one or multiple values in the range of [1, 128].",
    )

    parser.add_argument(
        "-s",
        "--sequence_length",
        required=True,
        type=int,
        help="maximum sequence length of input",
    )

    parser.add_argument(
        "--samples",
        required=False,
        type=int,
        default=10,
        help="number of samples to be generated",
    )

    parser.add_argument(
        "-t",
        "--test_times",
        required=False,
        type=int,
        default=0,
        help="number of times to run per sample. By default, the value is 1000 / samples",
    )

    parser.add_argument(
        "--opt_level",
        required=False,
        type=int,
        choices=[0, 1, 2, 3, 99],
        default=99,
        help="onnxruntime optimization level: 0 - disable all, 1 - basic, 2 - extended, 3 - layout, 99 - enable all.",
    )

    parser.add_argument(
        "--seed",
        required=False,
        type=int,
        default=3,
        help="random seed. Use the same seed to make sure test data is same in multiple tests.",
    )

    parser.add_argument(
        "--verbose",
        required=False,
        action="store_true",
        help="print verbose information",
    )
    parser.set_defaults(verbose=False)

    parser.add_argument(
        "--log_severity",
        required=False,
        type=int,
        default=2,
        choices=[0, 1, 2, 3, 4],
        help="0:Verbose, 1:Info, 2:Warning, 3:Error, 4:Fatal",
    )

    parser.add_argument("--use_gpu", required=False, action="store_true", help="use GPU")
    parser.set_defaults(use_gpu=False)

    parser.add_argument("--use_io_binding", required=False, action="store_true", help="use io_binding")
    parser.set_defaults(use_io_binding=False)

    parser.add_argument(
        "--provider",
        required=False,
        type=str,
        default=None,
        help="Execution provider to use",
    )

    parser.add_argument(
        "-n",
        "--intra_op_num_threads",
        required=False,
        type=int,
        default=None,
        help=">=0, set intra_op_num_threads",
    )

    parser.add_argument(
        "--input_ids_name",
        required=False,
        type=str,
        default=None,
        help="input name for input ids",
    )

    parser.add_argument(
        "--segment_ids_name",
        required=False,
        type=str,
        default=None,
        help="input name for segment ids",
    )

    parser.add_argument(
        "--input_mask_name",
        required=False,
        type=str,
        default=None,
        help="input name for attention mask",
    )

    parser.add_argument(
        "--input_tuning_results",
        default=None,
        type=str,
        help="tuning results (json) to be loaded before benchmark",
    )

    parser.add_argument(
        "--output_tuning_results",
        default=None,
        type=str,
        help="tuning results (json) to be saved after benchmark",
    )

    parser.add_argument(
        "-a",
        "--average_sequence_length",
        default=-1,
        type=int,
        help="average sequence length excluding padding",
    )

    parser.add_argument(
        "-r",
        "--random_sequence_length",
        required=False,
        action="store_true",
        help="use uniform random instead of fixed sequence length",
    )
    parser.set_defaults(random_sequence_length=False)

    parser.add_argument(
        "--mask_type",
        required=False,
        type=int,
        default=2,
        help="mask type: (1: mask index or sequence length, 2: raw 2D mask, 3: key len, cumulated lengths of query and key)",
    )

    args = parser.parse_args()
    return args


def main():
    args = parse_arguments()

    if args.test_times == 0:
        args.test_times = max(1, int(1000 / args.samples))

    if args.average_sequence_length <= 0:
        args.average_sequence_length = args.sequence_length

    manager = multiprocessing.Manager()
    perf_results = manager.dict()

    batch_size_set = set(args.batch_size)
    if not (min(batch_size_set) >= 1 and max(batch_size_set) <= 128):
        raise Exception("batch_size not in range [1, 128]")

    model_setting = ModelSetting(
        args.model,
        args.input_ids_name,
        args.segment_ids_name,
        args.input_mask_name,
        args.opt_level,
        args.input_tuning_results,
        args.output_tuning_results,
        args.mask_type,
    )

    for batch_size in batch_size_set:
        test_setting = TestSetting(
            batch_size,
            args.sequence_length,
            args.samples,
            args.test_times,
            args.use_gpu,
            args.use_io_binding,
            args.provider,
            args.intra_op_num_threads,
            args.seed,
            args.verbose,
            args.log_severity,
            args.average_sequence_length,
            args.random_sequence_length,
        )

        print("test setting", test_setting)
        run_performance(model_setting, test_setting, perf_results)

    # Sort the results so that the first one has smallest latency.
    sorted_results = sorted(perf_results.items(), reverse=False, key=lambda x: x[1])

    summary_file = os.path.join(
        Path(args.model).parent,
        "perf_results_{}_B{}_S{}_{}.txt".format(
            "GPU" if args.use_gpu else "CPU",
            "-".join([str(x) for x in sorted(batch_size_set)]),
            args.sequence_length,
            datetime.now().strftime("%Y%m%d-%H%M%S"),
        ),
    )
    with open(summary_file, "w+", newline="") as tsv_file:
        tsv_writer = csv.writer(tsv_file, delimiter="\t", lineterminator="\n")
        headers = None
        for key, perf_result in sorted_results:
            params = key.split(",")
            if headers is None:
                headers = [
                    "Latency(ms)",
                    "Latency_P50",
                    "Latency_P75",
                    "Latency_P90",
                    "Latency_P95",
                    "Latency_P99",
                    "Throughput(QPS)",
                ]
                headers.extend([x.split("=")[0] for x in params])
                tsv_writer.writerow(headers)

            values = [format(x, ".2f") for x in perf_result]
            values.extend([x.split("=")[1] for x in params])
            tsv_writer.writerow(values)

    print("Test summary is saved to", summary_file)


if __name__ == "__main__":
    # work around for AnaConda Jupyter. See https://stackoverflow.com/questions/45720153/python-multiprocessing-error-attributeerror-module-main-has-no-attribute
    __spec__ = None

    main()
