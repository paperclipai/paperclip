# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

"""This profiler result processor print out the kernel time spent on each Node of the model.
Example of importing profile result file from onnxruntime_perf_test:
    python profile_result_processor.py --input profile_2021-10-25_12-02-41.json
"""

import argparse
import json

_NODES_TYPE_CONTAINING_SUBGRAPH = frozenset(("Scan", "Loop", "If"))


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "-i",
        "--input",
        required=False,
        type=str,
        help="Set the input file for reading the profile results",
    )

    parser.add_argument(
        "--threshold",
        required=False,
        type=float,
        default=0.01,
        help="Threshold of run time ratio among all nodes. Nodes with larger ratio will show in top expensive nodes.",
    )

    parser.add_argument(
        "--provider",
        required=False,
        type=str,
        default="cuda",
        help="Execution provider to use",
    )

    parser.add_argument(
        "--kernel_time_only",
        required=False,
        action="store_true",
        help="Only include the kernel time and no fence time",
    )

    parser.set_defaults(kernel_time_only=False)

    parser.add_argument("-v", "--verbose", required=False, action="store_true")
    parser.set_defaults(verbose=False)

    return parser.parse_args(argv)


def load_profile_json(profile_file):
    print(f"loading profile output {profile_file} ...")

    with open(profile_file) as opened_file:
        sess_time = json.load(opened_file)

    assert isinstance(sess_time, list)
    return sess_time


def parse_kernel_results(sess_time, threshold=0):
    """Parse profile data and output nodes in two sections - nodes in the original order, and top expensive nodes.

    Args:
        sess_time (List[Dict]): profile data
        threshold (int, optional): Minimum ratio of duration among all. Defaults to 0.

    Returns:
        List[str]: lines of string for output.
    """
    kernel_name_to_op_name = {}
    kernel_time = {}
    kernel_freq = {}
    total = 0
    session_init = False
    for item in sess_time:
        # Skip all MemcpyHostToDevice before session_initialization
        if item["cat"] == "Session" and item["name"] == "session_initialization":
            session_init = True
        if not session_init:
            continue

        if item["cat"] == "Kernel" and "dur" in item and "args" in item and "op_name" in item["args"]:
            kernel_name = item["name"]

            op_name = item["args"]["op_name"]
            if op_name in _NODES_TYPE_CONTAINING_SUBGRAPH:
                continue

            # Handle MemcpyHostToDevice and MemcpyDeviceToHost here
            if not op_name:
                op_name = f"({kernel_name})"

            if kernel_name in kernel_time:
                kernel_time[kernel_name] += item["dur"]
                kernel_freq[kernel_name] += 1
            else:
                kernel_time[kernel_name] = item["dur"]
                kernel_freq[kernel_name] = 1
                kernel_name_to_op_name[kernel_name] = op_name

            total += item["dur"]

    if not kernel_time:
        return ["No kernel record found!"]

    # Output items with run time ratio > thresholds, and sorted by duration in the descending order.
    lines = []
    lines.append(f"\nTop expensive kernels with Time% >= {threshold * 100:.2f}:")
    lines.append("-" * 64)
    lines.append("Total(μs)\tTime%\tCalls\tAvg(μs)\tKernel")
    for kernel_name, duration in sorted(kernel_time.items(), key=lambda x: x[1], reverse=True):
        ratio = duration / total
        if ratio < threshold:
            continue

        calls = kernel_freq[kernel_name]
        avg_time = duration / float(calls)
        lines.append(f"{duration:10d}\t{ratio * 100.0:5.2f}\t{calls:5d}\t{avg_time:8.1f}\t{kernel_name}")

    # Group by operator
    op_time = {}
    for kernel_name, op_name in kernel_name_to_op_name.items():
        duration = kernel_time[kernel_name]
        if op_name in op_time:
            op_time[op_name] += duration
        else:
            op_time[op_name] = duration

    lines.append("\nGroup kernel time by operator:")
    lines.append("-" * 64)
    lines.append("Total(μs)\tTime%\tOperator")
    for op_name, duration in sorted(op_time.items(), key=lambda x: x[1], reverse=True):
        ratio = duration / total
        lines.append(f"{duration:10d}\t{ratio * 100.0:5.2f}\t{op_name}")

    return lines


def parse_node_results(sess_time, kernel_time_only=False, threshold=0):
    """Parse profile data and output nodes in two sections - nodes in the original order, and top expensive nodes.

    Args:
        sess_time (List[Dict]): profile data
        kernel_time_only (bool, optional): Only include items for kernel time. Defaults to False.
        threshold (int, optional): Minimum ratio of duration among all. Defaults to 0.

    Returns:
        List[str]: lines of string for output.
    """
    node_name_list = []
    node_time = {}
    node_freq = {}
    node_provider = {}
    total = 0
    for item in sess_time:
        if item["cat"] == "Node" and "dur" in item and "args" in item and "op_name" in item["args"]:
            node_name = (
                item["name"].replace("_kernel_time", "").replace("_fence_before", "").replace("_fence_after", "")
            )

            if "provider" in item["args"]:
                if item["args"]["provider"] == "CPUExecutionProvider":
                    device = "CPU"
                elif item["args"]["provider"] == "CUDAExecutionProvider":
                    device = "CUDA"
                elif item["args"]["provider"] == "DmlExecutionProvider":
                    device = "DML"

                if node_name not in node_provider:
                    node_provider[node_name] = device
                else:
                    assert node_provider[node_name] == device
            elif kernel_time_only:
                continue

            op_name = item["args"]["op_name"]
            if op_name in _NODES_TYPE_CONTAINING_SUBGRAPH:
                continue

            if node_name in node_time:
                node_time[node_name] += item["dur"]
                node_freq[node_name] += 1
            else:
                node_time[node_name] = item["dur"]
                node_freq[node_name] = 1
                node_name_list.append(node_name)

            total += item["dur"]

    # Output items in the original order.
    lines = [
        "\nNodes in the original order:",
        "-" * 64,
        "Total(μs)\tTime%\tAcc %\tAvg(μs)\tCalls\tProvider\tNode",
    ]
    before_percentage = 0.0
    for node_name in node_name_list:
        duration = node_time[node_name]
        calls = node_freq[node_name]
        avg_time = duration / float(calls)
        percentage = (duration / total) * 100.0
        provider = node_provider.get(node_name, "")
        before_percentage += percentage
        lines.append(
            f"{duration:10d}\t{percentage:5.2f}\t{before_percentage:5.2f}\t{avg_time:8.1f}\t{calls:5d}\t{provider:8s}\t{node_name}"
        )

    # Output items with run time ratio > thresholds, and sorted by duration in the descending order.
    lines.append(f"\nTop expensive nodes with Time% >= {threshold * 100:.2f}:")
    lines.append("-" * 64)
    lines.append("Total(μs)\tTime%\tAvg(μs)\tCalls\tProvider\tNode")
    for node_name, duration in sorted(node_time.items(), key=lambda x: x[1], reverse=True):
        ratio = duration / total
        if ratio < threshold:
            continue

        calls = node_freq[node_name]
        avg_time = duration / float(calls)
        percentage = (duration / total) * 100.0
        provider = node_provider.get(node_name, "")
        lines.append(f"{duration:10d}\t{percentage:5.2f}\t{avg_time:8.1f}\t{calls:5d}\t{provider:8s}\t{node_name}")

    return lines


def group_node_results(sess_time):
    """Group results by operator name.

    Args:
        sess_time (List[Dict]): profile data

    Returns:
        List[str]: lines of string for output.
    """
    op_kernel_time = {}
    op_kernel_records = {}
    total_kernel_time = 0

    provider_op_kernel_time = {}
    provider_op_kernel_records = {}
    provider_kernel_time = {}

    op_fence_time = {}
    total_fence_time = 0

    provider_counter = {}
    for item in sess_time:
        if item["cat"] == "Node" and "dur" in item and "args" in item and "op_name" in item["args"]:
            op_name = item["args"]["op_name"]

            # TODO: shall we have a separated group for nodes with subgraph?
            if op_name in _NODES_TYPE_CONTAINING_SUBGRAPH:
                continue

            if "provider" not in item["args"]:
                if "fence" in item["name"]:
                    if op_name in op_fence_time:
                        op_fence_time[op_name] += item["dur"]
                    else:
                        op_fence_time[op_name] = item["dur"]
                    total_fence_time += item["dur"]
                continue

            provider = item["args"].get("provider", "")
            if provider in provider_counter:
                provider_counter[provider] += 1
            else:
                provider_counter[provider] = 1

            key = f"{provider}:{op_name}"
            if key in provider_op_kernel_time:
                provider_op_kernel_time[key] += item["dur"]
                provider_op_kernel_records[key] += 1
            else:
                provider_op_kernel_time[key] = item["dur"]
                provider_op_kernel_records[key] = 1

            if provider in provider_kernel_time:
                provider_kernel_time[provider] += item["dur"]
            else:
                provider_kernel_time[provider] = item["dur"]

            if op_name in op_kernel_time:
                op_kernel_time[op_name] += item["dur"]
                op_kernel_records[op_name] += 1
            else:
                op_kernel_time[op_name] = item["dur"]
                op_kernel_records[op_name] = 1

            total_kernel_time += item["dur"]

    lines = ["", "Grouped by operator"]
    lines.append("-" * 64)
    lines.append("Total(μs)\tTime%\tKernel(μs)\tKernel%\tCalls\tAvgKernel(μs)\tFence(μs)\tOperator")
    for op_name, kernel_time in sorted(op_kernel_time.items(), key=lambda x: x[1], reverse=True):
        fence_time = op_fence_time.get(op_name, 0)
        kernel_time_ratio = kernel_time / total_kernel_time
        total_time = kernel_time + fence_time
        time_ratio = total_time / (total_kernel_time + total_fence_time)
        kernel_calls = op_kernel_records[op_name]
        avg_kernel_time = kernel_time / kernel_calls
        lines.append(
            f"{total_time:10d}\t{time_ratio * 100.0:5.2f}\t{kernel_time:11d}\t{kernel_time_ratio * 100.0:5.2f}\t{kernel_calls:5d}\t{avg_kernel_time:14.1f}\t{fence_time:10d}\t{op_name}"
        )

    lines += ["", "Grouped by provider + operator"]
    lines.append("-" * 64)
    lines.append("Kernel(μs)\tProvider%\tCalls\tAvgKernel(μs)\tProvider\tOperator")
    for key, kernel_time in sorted(provider_op_kernel_time.items(), key=lambda x: x[1], reverse=True):
        parts = key.split(":")
        provider = parts[0]
        op_name = parts[1]
        short_ep = provider.replace("ExecutionProvider", "")
        calls = provider_op_kernel_records[key]
        avg_kernel_time = kernel_time / calls
        provider_time_ratio = kernel_time / provider_kernel_time[provider]
        lines.append(
            f"{kernel_time:10d}\t{provider_time_ratio * 100.0:9.2f}\t{calls:5d}\t{avg_kernel_time:14.1f}\t{short_ep:8s}\t{op_name}"
        )

    return lines


def process_results(profile_file, args):
    profile_records = load_profile_json(profile_file)

    lines = parse_kernel_results(profile_records, args.threshold)

    lines += parse_node_results(profile_records, args.kernel_time_only, args.threshold)

    lines += group_node_results(profile_records)

    return lines


if __name__ == "__main__":
    arguments = parse_arguments()
    print("Arguments", arguments)

    from benchmark_helper import setup_logger

    setup_logger(arguments.verbose)

    profile_file = arguments.input

    results = process_results(profile_file, arguments)

    for line in results:
        print(line)
