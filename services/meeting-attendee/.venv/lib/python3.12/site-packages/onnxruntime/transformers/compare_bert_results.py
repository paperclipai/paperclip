# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

# It is a tool to compare the inference results of the original model and optimized model.

import argparse
import statistics
from pathlib import Path

import numpy as np
import psutil
from bert_perf_test import create_session, onnxruntime_inference
from bert_test_data import generate_test_data, get_bert_inputs, output_test_data


def run_model(model_path, all_inputs, use_gpu, disable_optimization):
    import onnxruntime  # noqa: PLC0415

    graph_optimization_level = None
    if disable_optimization:
        graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_DISABLE_ALL

    intra_op_num_threads = psutil.cpu_count(logical=False)

    session = create_session(
        model_path, use_gpu, "cuda" if use_gpu else "cpu", intra_op_num_threads, graph_optimization_level
    )

    output_names = [output.name for output in session.get_outputs()]
    results, latency_list = onnxruntime_inference(session, all_inputs, output_names)
    return results, latency_list, output_names


def compare(baseline_results, treatment_results, verbose, rtol=1e-1, atol=1e-3):
    # Validate the output of baseline and treatment, to make sure the results are similar.
    diff_count = 0
    max_abs_diff = 0
    max_diff_percentage = 0
    case_passed = True
    for test_case_id, results in enumerate(baseline_results):
        for i in range(len(results)):
            treatment_output = treatment_results[test_case_id][i]
            abs_diff_tensor = np.abs(treatment_output - results[i])
            abs_diff = np.amax(abs_diff_tensor)
            if verbose and abs_diff > atol:
                print("abs_diff", abs_diff)
                print("treatment", treatment_output)
                print("baseline", results[i])

            count_exceeding = np.sum(abs_diff_tensor > atol)
            total_elements = abs_diff_tensor.size
            percentage_exceeding = (count_exceeding / total_elements) * 100
            max_diff_percentage = max(max_diff_percentage, percentage_exceeding)

            max_abs_diff = max(max_abs_diff, abs_diff)
            if not np.allclose(results[i].tolist(), treatment_output.tolist(), rtol=rtol, atol=atol):
                if case_passed:
                    case_passed = False
                    diff_count += 1

                    if verbose:
                        print(f"case {test_case_id} output {i}")
                        print(f"baseline={results[i].tolist()}\ntreatment={treatment_output}")
                        print(f"abs_diff={abs_diff}")

    if diff_count == 0:
        print(f"100% passed for {len(baseline_results)} random inputs given thresholds (rtol={rtol}, atol={atol}).")
    else:
        print(
            f"WARNING: {diff_count} out of {len(baseline_results)} results NOT passed for thresholds (rtol={rtol}, atol={atol})."
        )

    print(f"maximum absolute difference={max_abs_diff}")
    print(f"maximum percentage of elements that exceeds atol={atol} is {max_diff_percentage:.3f}%")
    return max_abs_diff, case_passed


def run_test(
    baseline_model,
    optimized_model,
    output_dir,
    batch_size,
    sequence_length,
    use_gpu,
    test_cases,
    seed,
    verbose,
    rtol,
    atol,
    input_ids_name,
    segment_ids_name,
    input_mask_name,
    mask_type,
    dictionary_size: int = 1024,
):
    # Try deduce input names from optimized model.
    input_ids, segment_ids, input_mask = get_bert_inputs(
        optimized_model, input_ids_name, segment_ids_name, input_mask_name
    )

    # Use random mask length for accuracy test. It might introduce slight inflation in latency reported in this script.
    average_sequence_length = int(sequence_length / 2) if sequence_length >= 2 else sequence_length
    all_inputs = generate_test_data(
        batch_size,
        sequence_length,
        test_cases,
        seed,
        verbose,
        input_ids,
        segment_ids,
        input_mask,
        average_sequence_length,
        True,  # random sequence length
        mask_type,
        dictionary_size=dictionary_size,
    )

    baseline_results, baseline_latency, output_names = run_model(
        baseline_model, all_inputs, use_gpu, disable_optimization=True
    )
    if verbose:
        print(f"baseline average latency (all optimizations disabled): {statistics.mean(baseline_latency) * 1000} ms")

    if output_dir is not None:
        for i, inputs in enumerate(all_inputs):
            output_test_data(output_dir, i, inputs)

    treatment_results, treatment_latency, treatment_output_names = run_model(
        optimized_model, all_inputs, use_gpu, disable_optimization=False
    )
    if verbose:
        print(f"treatment average latency: {statistics.mean(treatment_latency) * 1000} ms")

    # Validate the output of baseline and treatment, to make sure the results are similar.
    return compare(baseline_results, treatment_results, verbose, rtol, atol)


def parse_arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline_model", required=True, type=str, help="baseline onnx model path.")

    parser.add_argument(
        "--optimized_model",
        required=True,
        type=str,
        default=None,
        help="path of the optimized model. It shall have same inputs as the baseline model.",
    )

    parser.add_argument(
        "--output_dir",
        required=False,
        type=str,
        default=None,
        help="output test data path. If not specified, test data will not be saved.",
    )

    parser.add_argument("--batch_size", required=True, type=int, help="batch size of input")

    parser.add_argument(
        "--sequence_length",
        required=True,
        type=int,
        help="maximum sequence length of input",
    )

    parser.add_argument("--rtol", required=False, type=float, default=1e-3, help="relative tolerance")

    parser.add_argument("--atol", required=False, type=float, default=1e-4, help="absolute tolerance")

    parser.add_argument(
        "--samples",
        required=False,
        type=int,
        default=100,
        help="number of test cases to be generated",
    )

    parser.add_argument("--seed", required=False, type=int, default=3, help="random seed")

    parser.add_argument("--use_gpu", required=False, action="store_true", help="use GPU")
    parser.set_defaults(use_gpu=False)

    parser.add_argument(
        "--verbose",
        required=False,
        action="store_true",
        help="print verbose information",
    )
    parser.set_defaults(verbose=False)

    parser.add_argument(
        "--input_ids",
        required=False,
        type=str,
        default=None,
        help="input name for input ids",
    )
    parser.add_argument(
        "--segment_ids",
        required=False,
        type=str,
        default=None,
        help="input name for segment ids",
    )
    parser.add_argument(
        "--input_mask",
        required=False,
        type=str,
        default=None,
        help="input name for attention mask",
    )

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

    if args.output_dir is not None:
        # create the output directory if not existed
        path = Path(args.output_dir)
        path.mkdir(parents=True, exist_ok=True)

    run_test(
        args.baseline_model,
        args.optimized_model,
        args.output_dir,
        args.batch_size,
        args.sequence_length,
        args.use_gpu,
        args.samples,
        args.seed,
        args.verbose,
        args.rtol,
        args.atol,
        args.input_ids,
        args.segment_ids,
        args.input_mask,
        args.mask_type,
    )


if __name__ == "__main__":
    main()
