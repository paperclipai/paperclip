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

import librosa
import torch
from benchmark_helper import setup_logger
from metrics import BenchmarkRecord
from transformers import WhisperConfig, WhisperProcessor

logger = logging.getLogger(__name__)


def get_args():
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "-a",
        "--audio-path",
        type=str,
        required=True,
        help="Path to folder of audio files for E2E evaluation",
    )

    parser.add_argument(
        "-l",
        "--language",
        default=None,
        help="Language of audio file",
    )

    parser.add_argument(
        "-t",
        "--task",
        default=None,
        choices=["transcribe", "translate"],
        help="Task to complete",
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
        default=10,
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
        help="Path to folder containing ONNX models for Optimum + ORT benchmarking",
    )

    parser.add_argument(
        "--ort-model-path",
        type=str,
        help="Path to ONNX model for ORT benchmarking",
    )

    parser.add_argument(
        "--model-name",
        type=str,
        required=True,
        help="Model name in Hugging Face (e.g. openai/whisper-large-v2)",
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
        default=5,
        help="Number of mins to attempt the benchmark before moving on",
    )

    parser.add_argument(
        "--log-folder",
        type=str,
        default=None,
        help="Path to folder to save logs and results",
    )

    parser.add_argument("--tune", default=False, action="store_true")

    args = parser.parse_args()

    setattr(args, "model_size", args.model_name.split("/")[-1].replace(".", "-"))  # noqa: B010
    log_folder_name = f"./{args.model_size}-{args.precision}"
    if not args.log_folder:
        args.log_folder = log_folder_name
    os.makedirs(args.log_folder, exist_ok=True)

    # Convert timeout value to secs
    args.timeout *= 60

    return args


def process_log_file(device_id, log_file, base_results):
    entries = []

    # Detect steps in speech pipeline
    step = None
    load_audio_pattern = "Load audio: "
    feat_ext_pattern = "Feature extraction: "
    pytorch_pattern = "Evaluating PyTorch..."
    onnxruntime_pattern = "Evaluating ONNX Runtime..."

    load_audio_latency_s, load_audio_throughput_s = None, None
    feat_ext_latency_s, feat_ext_throughput_s = None, None
    token_length, latency_s, per_token_latency_s, per_token_latency_ms = None, None, None, None
    throughput, memory = None, None

    # Detect metrics
    latency_pattern = "Latency: "
    throughput_pattern = "Throughput: "
    token_length_pattern = "Generated token length: "
    memory_pattern = "peak="

    with open(log_file) as f:
        for input_line in f:
            line = input_line.replace("\n", "")

            # Get step in speech recognition pipeline
            if load_audio_pattern in line:
                step = "load-audio"
            elif feat_ext_pattern in line:
                step = "feature-extraction"
            elif pytorch_pattern in line or onnxruntime_pattern in line:
                step = "process"

            # Check metrics
            if latency_pattern in line:
                latency_s = float(line[len(latency_pattern) : line.rfind(" ")])
            elif throughput_pattern in line:
                throughput = float(line[len(throughput_pattern) : line.rfind(" ")])
                if step == "load-audio":
                    load_audio_latency_s, load_audio_throughput_s = latency_s, throughput
                    step = None
                if step == "feature-extraction":
                    feat_ext_latency_s, feat_ext_throughput_s = latency_s, throughput
                    step = None
            elif token_length_pattern in line:
                token_length = int(line[len(token_length_pattern) : line.rfind(" ")])
                per_token_latency_s = latency_s / token_length
                per_token_latency_ms = per_token_latency_s * 1000
            elif memory_pattern in line:
                if "CPU" in line:
                    # Example format for log entry:
                    # CPU memory usage: before=1000.0 MB, peak=2000.0 MB
                    memory = float(line[line.rfind("=") + 1 : line.rfind(" MB")]) / 1000
                else:
                    # Example format for log entry:
                    # GPU memory usage: before=[{'device_id': 0, 'name': 'Tesla V100-PCIE-16GB', 'max_used_MB': 1638.875}, {'device_id': 1, 'name': 'Tesla V100-PCIE-16GB', 'max_used_MB': 236.875},  peak=[{'device_id': 0, 'name': 'Tesla V100-PCIE-16GB', 'max_used_MB': 1780.875}, {'device_id': 1, 'name': 'Tesla V100-PCIE-16GB', 'max_used_MB': 236.875}]
                    peak = line[line.find(memory_pattern) + len(memory_pattern) :].replace("'", '"')
                    usage = json.loads(peak)[device_id]["max_used_MB"]
                    memory = float(usage) / 1000

                # Calculate real-time factor (RTF):
                # RTF = total latency / audio duration
                total_latency = (
                    (load_audio_latency_s if load_audio_latency_s else 0)
                    + (feat_ext_latency_s if feat_ext_latency_s else 0)
                    + (latency_s if latency_s else 0)
                )
                audio_duration = base_results[-1]
                rtf = (total_latency / audio_duration) if audio_duration else -1
                logger.info(f"Total latency: {total_latency} s")
                logger.info(f"Audio duration: {audio_duration} s")
                logger.info(f"Real-time factor: {rtf}")

                # Append log entry to list of entries
                entry = base_results + [  # noqa: RUF005
                    token_length,
                    load_audio_latency_s,
                    load_audio_throughput_s,
                    feat_ext_latency_s if feat_ext_latency_s else -1,
                    feat_ext_throughput_s if feat_ext_throughput_s else -1,
                    latency_s,
                    per_token_latency_ms,
                    throughput,
                    memory,
                    rtf,
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
            "Audio File",
            "Duration (s)",
            "Token Length",
            "Load Audio Latency (s)",
            "Load Audio Throughput (qps)",
            "Feature Extractor Latency (s)",
            "Feature Extractor Throughput (qps)",
            "Latency (s)",
            "Per Token Latency (ms/token)",
            "Throughput (qps)",
            "Memory (GB)",
            "Real Time Factor (RTF)",
        ],
    )

    # Set column types
    df["Warmup Runs"] = df["Warmup Runs"].astype("int")
    df["Measured Runs"] = df["Measured Runs"].astype("int")
    df["Duration (s)"] = df["Duration (s)"].astype("float")
    df["Token Length"] = df["Token Length"].astype("int")
    df["Load Audio Latency (s)"] = df["Load Audio Latency (s)"].astype("float")
    df["Load Audio Throughput (qps)"] = df["Load Audio Throughput (qps)"].astype("float")
    df["Feature Extractor Latency (s)"] = df["Feature Extractor Latency (s)"].astype("float")
    df["Feature Extractor Throughput (qps)"] = df["Feature Extractor Throughput (qps)"].astype("float")
    df["Latency (s)"] = df["Latency (s)"].astype("float")
    df["Per Token Latency (ms/token)"] = df["Per Token Latency (ms/token)"].astype("float")
    df["Throughput (qps)"] = df["Throughput (qps)"].astype("float")
    df["Memory (GB)"] = df["Memory (GB)"].astype("float")
    df["Real Time Factor (RTF)"] = df["Real Time Factor (RTF)"].astype("float")

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
        if row["Engine"] == "onnxruntime":
            record = BenchmarkRecord(
                row["Model Name"], row["Precision"], row["Engine"], row["Device"], ort_pkg_name, ort_pkg_version
            )
        else:
            record = BenchmarkRecord(
                row["Model Name"], row["Precision"], row["Engine"], row["Device"], torch.__name__, torch.__version__
            )
        record.config.customized["audio_file"] = row["Audio File"]
        record.config.warmup_runs = row["Warmup Runs"]
        record.config.measured_runs = row["Measured Runs"]

        record.metrics.customized["duration"] = row["Duration (s)"]
        record.metrics.customized["token_length"] = row["Token Length"]
        record.metrics.customized["load_audio_latency"] = row["Load Audio Latency (s)"]
        record.metrics.customized["load_audio_throughput"] = row["Load Audio Throughput (qps)"]
        record.metrics.customized["feature_extractor_latency_s"] = row["Feature Extractor Latency (s)"]
        record.metrics.customized["feature_extractor_throughput_qps"] = row["Feature Extractor Throughput (qps)"]
        record.metrics.customized["per_token_latency_ms"] = row["Per Token Latency (ms/token)"]
        record.metrics.customized["rtf"] = row["Real Time Factor (RTF)"]

        record.metrics.latency_ms_mean = row["Latency (s)"] * 1000
        record.metrics.throughput_qps = row["Throughput (qps)"]
        record.metrics.max_memory_usage_GB = row["Memory (GB)"]

        records.append(record)

    BenchmarkRecord.save_as_csv(filename, records)
    BenchmarkRecord.save_as_json(filename.replace(".csv", ".json"), records)
    logger.info(f"Results saved in {filename}!")


def benchmark(args, benchmark_cmd, engine, audio_file, duration):
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
    base_results = [
        args.warmup_runs,
        args.num_runs,
        args.model_name,
        engine,
        args.precision,
        args.device,
        audio_file,
        duration,
    ]
    results = process_log_file(args.device_id, log_path, base_results)

    return results


def main():
    args = get_args()
    setup_logger(args.verbose)
    logger.info(args.__dict__)
    torch.backends.cudnn.benchmark = True

    config = WhisperConfig.from_pretrained(args.model_name)
    processor = WhisperProcessor.from_pretrained(args.model_name)

    # Calculate forced decoder input ids
    hf_forced_decoder_ids = processor.get_decoder_prompt_ids(language=args.language, task=args.task)
    ort_forced_decoder_ids = [config.decoder_start_token_id] + [token_id[1] for token_id in hf_forced_decoder_ids]
    hf_decoder_input_ids_cmd = (
        ["--decoder-input-ids", str(hf_forced_decoder_ids)] if args.language and args.task else []
    )
    ort_decoder_input_ids_cmd = (
        ["--decoder-input-ids", str(ort_forced_decoder_ids)] if args.language and args.task else []
    )
    ort_tune_cmd = ["--tune"] if args.tune else []

    all_results = []
    for audio_file in os.listdir(args.audio_path):
        audio_path = os.path.join(args.audio_path, audio_file)
        try:
            duration = librosa.get_duration(path=audio_path)
        except Exception as e:
            duration = -1
            logger.warning(f"An error occurred while trying to calculate the audio duration: {e}", exc_info=True)
            logger.warning(
                f"If you get an error that says:\n\tsoundfile.LibsndfileError: Error opening '{audio_file}': File contains data in an unknown format.\nyou may not have installed `ffmpeg` in addition to installing `librosa`."
            )
        logger.info(f"Testing {audio_path}...")

        # Benchmark PyTorch without torch.compile
        if args.hf_pt_eager:
            benchmark_cmd = [  # noqa: RUF005
                "python",
                "-m",
                "models.whisper.benchmark",
                "--audio-path",
                audio_path,
                "--benchmark-type",
                "hf-pt-eager",
                "--model-name",
                args.model_name,
                "--precision",
                args.precision,
                "--device",
                args.device,
                "--device-id",
                str(args.device_id),
                "--warmup-runs",
                str(args.warmup_runs),
                "--num-runs",
                str(args.num_runs),
                "--log-folder",
                args.log_folder,
            ] + hf_decoder_input_ids_cmd
            logger.info("Benchmark PyTorch without torch.compile")
            results = benchmark(args, benchmark_cmd, "pytorch-eager", audio_file, duration)
            all_results.extend(results)

        # Benchmark PyTorch with torch.compile
        if args.hf_pt_compile:
            benchmark_cmd = [  # noqa: RUF005
                "python",
                "-m",
                "models.whisper.benchmark",
                "--audio-path",
                audio_path,
                "--benchmark-type",
                "hf-pt-compile",
                "--model-name",
                args.model_name,
                "--precision",
                args.precision,
                "--device",
                args.device,
                "--device-id",
                str(args.device_id),
                "--warmup-runs",
                str(args.warmup_runs),
                "--num-runs",
                str(args.num_runs),
                "--log-folder",
                args.log_folder,
            ] + hf_decoder_input_ids_cmd
            logger.info("Benchmark PyTorch with torch.compile")
            results = benchmark(args, benchmark_cmd, "pytorch-compile", audio_file, duration)
            all_results.extend(results)

        # Benchmark Optimum + ONNX Runtime
        if args.hf_ort_dir_path:
            benchmark_cmd = [  # noqa: RUF005
                "python",
                "-m",
                "models.whisper.benchmark",
                "--audio-path",
                audio_path,
                "--benchmark-type",
                "hf-ort",
                "--hf-ort-dir-path",
                args.hf_ort_dir_path,
                "--model-name",
                args.model_name,
                "--precision",
                args.precision,
                "--device",
                args.device,
                "--device-id",
                str(args.device_id),
                "--warmup-runs",
                str(args.warmup_runs),
                "--num-runs",
                str(args.num_runs),
                "--log-folder",
                args.log_folder,
            ] + hf_decoder_input_ids_cmd
            logger.info("Benchmark Optimum + ONNX Runtime")
            results = benchmark(args, benchmark_cmd, "optimum-ort", audio_file, duration)
            all_results.extend(results)

        # Benchmark ONNX Runtime
        if args.ort_model_path:
            benchmark_cmd = (
                [  # noqa: RUF005
                    "python",
                    "-m",
                    "models.whisper.benchmark",
                    "--audio-path",
                    audio_path,
                    "--benchmark-type",
                    "ort",
                    "--ort-model-path",
                    args.ort_model_path,
                    "--model-name",
                    args.model_name,
                    "--precision",
                    args.precision,
                    "--device",
                    args.device,
                    "--device-id",
                    str(args.device_id),
                    "--warmup-runs",
                    str(args.warmup_runs),
                    "--num-runs",
                    str(args.num_runs),
                    "--log-folder",
                    args.log_folder,
                ]
                + ort_decoder_input_ids_cmd
                + ort_tune_cmd
            )
            logger.info("Benchmark ONNX Runtime")
            results = benchmark(args, benchmark_cmd, "onnxruntime", audio_file, duration)
            all_results.extend(results)

    csv_file = f"{args.model_size}-{args.precision}_{datetime.datetime.now():%Y-%m-%d_%H:%M:%S}.csv"
    save_results(all_results, os.path.join(args.log_folder, csv_file))


if __name__ == "__main__":
    main()
