# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.  See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------
import argparse
import datetime
import json
import logging
import os
import subprocess

import torch
from benchmark_helper import setup_logger
from metrics import BenchmarkRecord

logger = logging.getLogger(__name__)


def get_args():
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "-b",
        "--batch-sizes",
        type=str,
        default="1 2",
    )

    parser.add_argument(
        "-s",
        "--sequence-lengths",
        type=str,
        default="8 16 32 64 128 256 512",
    )

    parser.add_argument(
        "-w",
        "--warmup-runs",
        type=int,
        default=5,
    )

    parser.add_argument(
        "-n",
        "--num-runs",
        type=int,
        default=1000,
    )

    parser.add_argument(
        "--hf-pt-eager",
        default=False,
        action="store_true",
        help="Benchmark in PyTorch without `torch.compile`",
    )

    parser.add_argument(
        "--hf-pt-compile",
        default=False,
        action="store_true",
        help="Benchmark in PyTorch with `torch.compile`",
    )

    parser.add_argument(
        "--hf-ort-dir-path",
        type=str,
        default="",
        help="Path to folder containing ONNX models for Optimum + ORT benchmarking",
    )

    parser.add_argument(
        "--ort-msft-model-path",
        type=str,
        default="",
        help="Path to ONNX model from https://github.com/microsoft/Llama-2-Onnx",
    )

    parser.add_argument(
        "--ort-convert-to-onnx-model-path",
        type=str,
        default="",
        help="Path to ONNX model from convert_to_onnx",
    )

    parser.add_argument(
        "--cache-dir",
        type=str,
        default="./model_cache",
        help="Cache dir where Hugging Face files are stored",
    )

    parser.add_argument(
        "--model-name",
        type=str,
        required=True,
        help="Model name in Hugging Face",
    )

    parser.add_argument(
        "--precision",
        type=str,
        required=True,
        choices=["int4", "int8", "fp16", "fp32"],
        help="Precision to run model",
    )

    parser.add_argument(
        "--device",
        type=str,
        required=True,
        choices=["cpu", "cuda"],
        help="Device to benchmark models",
    )

    parser.add_argument(
        "--device-id",
        type=int,
        default=0,
        help="GPU device ID",
    )

    parser.add_argument(
        "--verbose",
        default=False,
        action="store_true",
        help="Print detailed logs",
    )

    parser.add_argument(
        "--timeout",
        type=int,
        default=10,
        help="Number of mins to attempt the benchmark before moving on",
    )

    parser.add_argument(
        "--log-folder",
        type=str,
        default=None,
        help="Path to folder to save logs and results",
    )

    args = parser.parse_args()

    setattr(args, "model_size", args.model_name.split("/")[-1].replace(".", "-"))  # noqa: B010
    log_folder_name = f"./{args.model_size}_{args.precision}"
    if not args.log_folder:
        args.log_folder = log_folder_name
    os.makedirs(args.log_folder, exist_ok=True)

    # Convert timeout value to secs
    args.timeout *= 60

    return args


def process_log_file(device_id, log_file, base_results):
    entries = []
    batch_size, sequence_length, step = None, None, None
    latency_s, latency_ms, throughput, memory = None, None, None, None

    batch_pattern = "Batch Size: "
    sequence_pattern = "Sequence Length: "
    prompt_step_pattern = "to get past_key_values"
    per_token_step_pattern = "with past_key_values"
    latency_pattern = "Latency: "
    throughput_pattern = "Throughput: "
    memory_pattern = "peak="

    with open(log_file) as f:
        for input_line in f:
            line = input_line.replace("\n", "")

            if batch_pattern in line:
                batch_size = int(line[len(batch_pattern) :])
            elif sequence_pattern in line:
                sequence_length = int(line[len(sequence_pattern) :])
            elif prompt_step_pattern in line:
                step = "prompt"
            elif per_token_step_pattern in line:
                step = "per-token"
            elif latency_pattern in line:
                latency_s = float(line[len(latency_pattern) : line.rfind(" ")])
                latency_ms = latency_s * 1000
            elif throughput_pattern in line:
                throughput = float(line[len(throughput_pattern) : line.rfind(" ")])
            elif memory_pattern in line:
                if "CPU" in line:
                    # Example format for log entry:
                    # CPU memory usage: before=1000.0 MB, peak=2000.0 MB
                    memory = float(line[line.rfind("=") + 1 : line.rfind(" MB")]) / 1000
                else:
                    # Example format for log entry:
                    # GPU memory usage: before=[{'device_id': 0, 'name': 'NVIDIA A100-SXM4-80GB', 'max_used_MB': 69637.25}, {'device_id': 1, 'name': 'NVIDIA A100-SXM4-80GB', 'max_used_MB': 890.625}]  peak=[{'device_id': 0, 'name': 'NVIDIA A100-SXM4-80GB', 'max_used_MB': 73861.25}, {'device_id': 1, 'name': 'NVIDIA A100-SXM4-80GB', 'max_used_MB': 890.625}]
                    peak = line[line.find(memory_pattern) + len(memory_pattern) :].replace("'", '"')
                    usage = json.loads(peak)[device_id]["max_used_MB"]
                    memory = float(usage) / 1000

                # Append log entry to list of entries
                entry = base_results + [  # noqa: RUF005
                    batch_size,
                    sequence_length,
                    step,
                    latency_s,
                    latency_ms,
                    throughput,
                    memory,
                ]
                entries.append(entry)

    return entries


def save_results(results, filename):
    import pandas as pd  # noqa: PLC0415

    df = pd.DataFrame(
        results,
        columns=[
            "Warmup Runs",
            "Measured Runs",
            "Model Name",
            "Engine",
            "Precision",
            "Device",
            "Batch Size",
            "Sequence Length",
            "Step",
            "Latency (s)",
            "Latency (ms)",
            "Throughput (tps)",
            "Memory (GB)",
        ],
    )

    # Set column types
    df["Warmup Runs"] = df["Warmup Runs"].astype("int")
    df["Measured Runs"] = df["Measured Runs"].astype("int")
    df["Batch Size"] = df["Batch Size"].astype("int")
    df["Sequence Length"] = df["Sequence Length"].astype("int")
    df["Latency (s)"] = df["Latency (s)"].astype("float")
    df["Latency (ms)"] = df["Latency (ms)"].astype("float")
    df["Throughput (tps)"] = df["Throughput (tps)"].astype("float")
    df["Memory (GB)"] = df["Memory (GB)"].astype("float")

    # get package name and version
    import pkg_resources  # noqa: PLC0415

    installed_packages = pkg_resources.working_set
    installed_packages_list = sorted(
        [f"{i.key}=={i.version}" for i in installed_packages if i.key in ["onnxruntime", "onnxruntime-gpu"]]
    )

    ort_pkg_name = ""
    ort_pkg_version = ""
    if installed_packages_list:
        ort_pkg_name = installed_packages_list[0].split("==")[0]
        ort_pkg_version = installed_packages_list[0].split("==")[1]

    # Save results to csv with standard format
    records = []
    for _, row in df.iterrows():
        if row["Engine"] in ["optimum-ort", "onnxruntime"]:
            record = BenchmarkRecord(
                row["Model Name"], row["Precision"], "onnxruntime", row["Device"], ort_pkg_name, ort_pkg_version
            )
        elif row["Engine"] in ["pytorch-eager", "pytorch-compile"]:
            record = BenchmarkRecord(
                row["Model Name"], row["Precision"], "pytorch", row["Device"], torch.__name__, torch.__version__
            )
        else:
            record = BenchmarkRecord(row["Model Name"], row["Precision"], row["Engine"], row["Device"], "", "")
        record.config.warmup_runs = row["Warmup Runs"]
        record.config.measured_runs = row["Measured Runs"]
        record.config.batch_size = row["Batch Size"]
        record.config.seq_length = row["Sequence Length"]
        record.config.customized["measure_step"] = row["Step"]
        record.config.customized["engine"] = row["Engine"]
        record.metrics.customized["latency_s_mean"] = row["Latency (s)"]
        record.metrics.latency_ms_mean = row["Latency (ms)"]
        record.metrics.customized["throughput_tps"] = row["Throughput (tps)"]
        record.metrics.max_memory_usage_GB = row["Memory (GB)"]

        records.append(record)

    BenchmarkRecord.save_as_csv(filename, records)
    BenchmarkRecord.save_as_json(filename.replace(".csv", ".json"), records)
    logger.info(f"Results saved in {filename}!")


def benchmark(args, benchmark_cmd, engine):
    log_filename = f"{engine}_{datetime.datetime.now():%Y-%m-%d_%H:%M:%S}.log"
    log_path = os.path.join(args.log_folder, log_filename)
    with open(log_path, "w") as log_file:
        process = subprocess.Popen(benchmark_cmd, stdout=log_file, stderr=log_file)
        try:
            process.wait(args.timeout)
        except subprocess.TimeoutExpired:
            process.kill()

    # Create entries for csv
    logger.info("Gathering data from log files...")
    base_results = [args.warmup_runs, args.num_runs, args.model_name, engine, args.precision, args.device]
    results = process_log_file(args.device_id, log_path, base_results)

    return results


def main():
    args = get_args()
    setup_logger(args.verbose)
    logger.info(args.__dict__)
    torch.backends.cudnn.benchmark = True

    all_results = []
    os.environ["CUDA_VISIBLE_DEVICES"] = str(args.device_id)

    # Benchmark PyTorch without torch.compile
    if args.hf_pt_eager:
        benchmark_cmd = [
            "python",
            "-m",
            "models.llama.benchmark",
            "--benchmark-type",
            "hf-pt-eager",
            "--model-name",
            args.model_name,
            "--precision",
            args.precision,
            "--batch-sizes",
            args.batch_sizes,
            "--sequence-lengths",
            args.sequence_lengths,
            "--device",
            args.device,
            "--warmup-runs",
            str(args.warmup_runs),
            "--num-runs",
            str(args.num_runs),
            "--log-folder",
            args.log_folder,
            "--cache-dir",
            args.cache_dir,
            "--auth",
        ]
        logger.info("Benchmark PyTorch without torch.compile")
        results = benchmark(args, benchmark_cmd, "pytorch-eager")
        all_results.extend(results)

    # Benchmark PyTorch with torch.compile
    if args.hf_pt_compile:
        benchmark_cmd = [
            "python",
            "-m",
            "models.llama.benchmark",
            "--benchmark-type",
            "hf-pt-compile",
            "--model-name",
            args.model_name,
            "--precision",
            args.precision,
            "--batch-sizes",
            args.batch_sizes,
            "--sequence-lengths",
            args.sequence_lengths,
            "--device",
            args.device,
            "--warmup-runs",
            str(args.warmup_runs),
            "--num-runs",
            str(args.num_runs),
            "--log-folder",
            args.log_folder,
            "--cache-dir",
            args.cache_dir,
            "--auth",
        ]
        logger.info("Benchmark PyTorch with torch.compile")
        results = benchmark(args, benchmark_cmd, "pytorch-compile")
        all_results.extend(results)

    # Benchmark Optimum + ONNX Runtime
    if args.hf_ort_dir_path:
        benchmark_cmd = [
            "python",
            "-m",
            "models.llama.benchmark",
            "--benchmark-type",
            "hf-ort",
            "--hf-ort-dir-path",
            args.hf_ort_dir_path,
            "--model-name",
            args.model_name,
            "--precision",
            args.precision,
            "--batch-sizes",
            args.batch_sizes,
            "--sequence-lengths",
            args.sequence_lengths,
            "--device",
            args.device,
            "--warmup-runs",
            str(args.warmup_runs),
            "--num-runs",
            str(args.num_runs),
            "--log-folder",
            args.log_folder,
            "--cache-dir",
            args.cache_dir,
            "--auth",
        ]
        logger.info("Benchmark Optimum + ONNX Runtime")
        results = benchmark(args, benchmark_cmd, "optimum-ort")
        all_results.extend(results)

    # Benchmark Microsoft model in ONNX Runtime
    if args.ort_msft_model_path:
        benchmark_cmd = [
            "python",
            "-m",
            "models.llama.benchmark",
            "--benchmark-type",
            "ort-msft",
            "--ort-model-path",
            args.ort_msft_model_path,
            "--model-name",
            args.model_name,
            "--precision",
            args.precision,
            "--batch-sizes",
            args.batch_sizes,
            "--sequence-lengths",
            args.sequence_lengths,
            "--device",
            args.device,
            "--warmup-runs",
            str(args.warmup_runs),
            "--num-runs",
            str(args.num_runs),
            "--log-folder",
            args.log_folder,
            "--cache-dir",
            args.cache_dir,
        ]
        logger.info("Benchmark Microsoft model in ONNX Runtime")
        results = benchmark(args, benchmark_cmd, "ort-msft")
        all_results.extend(results)

    # Benchmark convert_to_onnx model in ONNX Runtime
    if args.ort_convert_to_onnx_model_path:
        benchmark_cmd = [
            "python",
            "-m",
            "models.llama.benchmark",
            "--benchmark-type",
            "ort-convert-to-onnx",
            "--ort-model-path",
            args.ort_convert_to_onnx_model_path,
            "--model-name",
            args.model_name,
            "--precision",
            args.precision,
            "--batch-sizes",
            args.batch_sizes,
            "--sequence-lengths",
            args.sequence_lengths,
            "--device",
            args.device,
            "--warmup-runs",
            str(args.warmup_runs),
            "--num-runs",
            str(args.num_runs),
            "--log-folder",
            args.log_folder,
            "--cache-dir",
            args.cache_dir,
        ]
        logger.info("Benchmark convert_to_onnx model in ONNX Runtime")
        results = benchmark(args, benchmark_cmd, "onnxruntime")
        all_results.extend(results)

    csv_file = f"{args.model_size}_{args.precision}_{datetime.datetime.now():%Y-%m-%d_%H:%M:%S}.csv"
    save_results(all_results, os.path.join(args.log_folder, csv_file))


if __name__ == "__main__":
    main()
