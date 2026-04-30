# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
#
# This script evaluates accuracy of ONNX models for question-answering task on SQuAD data set.
# Example to evaluate raw and optimized model for CUDA in Linux:
#   pip3 install datasets evaluate optimum transformers onnxruntime-gpu
#
#   python3 eval_squad.py -m bert-large-uncased-whole-word-masking-finetuned-squad -s 384 -b 1 --use_io_binding
#
#   python3 -m onnxruntime.transformers.optimizer \
#           --input ./bert-large-uncased-whole-word-masking-finetuned-squad/model.onnx \
#           --output ./bert-large-uncased-whole-word-masking-finetuned-squad/optimized_model.onnx
#
#   python3 eval_squad.py -m bert-large-uncased-whole-word-masking-finetuned-squad -s 384 -b 1 --use_io_binding \
#           --onnx ./bert-large-uncased-whole-word-masking-finetuned-squad/optimized_model.onnx
#
#   Snippet of example output in A100:
#   {'exact': 86.65089877010406, 'f1': 92.99433524952254, 'total': 10570, 'HasAns_exact': 86.65089877010406
#    'total_time_in_seconds': 81.69239814393222, 'samples_per_second': 129.387804008115,
#    'latency_in_seconds': 0.007728703703304846, 'provider': 'CUDAExecutionProvider',
#    'pretrained_model_name': 'bert-large-uncased-whole-word-masking-finetuned-squad',
#    'batch_size': 1, 'sequence_length': 384, 'use_io_binding': True}
import argparse
import csv
import os
import time

try:
    from importlib.metadata import PackageNotFoundError, version
except ImportError:
    from importlib_metadata import PackageNotFoundError, version

from pathlib import Path
from typing import Any

from datasets import load_dataset
from evaluate import evaluator
from optimum.onnxruntime import ORTModelForQuestionAnswering
from optimum.version import __version__ as optimum_version
from packaging import version as version_check
from transformers import AutoTokenizer, pipeline

if version_check.parse(optimum_version) < version_check.parse("1.13.1"):
    raise ImportError(f"Please install optimum>=1.13.1. Current version: {optimum_version}.")

PRETRAINED_SQUAD_MODELS = [
    "bert-large-uncased-whole-word-masking-finetuned-squad",
    "deepset/roberta-base-squad2",
    "distilbert-base-cased-distilled-squad",
]


def get_package_version(package_name: str):
    try:
        return version(package_name)
    except PackageNotFoundError:
        return None


def load_onnx_model(
    model_id: str, onnx_path: str | None = None, provider="CUDAExecutionProvider", use_io_binding: bool = False
):
    """Load onnx model given pretrained model name and optional ONNX model path. If onnx_path is None,
    the default onnx model from optimum will be used.

    Args:
        model_id (str): pretrained model name or checkpoint path
        onnx_path (Optional[str], optional): path of onnx model to evaluate. Defaults to None.

    Returns:
        model: ORTModel for the onnx model
        onnx_path: the path of onnx model
    """

    if onnx_path is None:
        # Export onnx to a sub-directory named by the model id
        model = ORTModelForQuestionAnswering.from_pretrained(
            model_id, export=True, provider=provider, use_io_binding=use_io_binding
        )
        save_onnx_dir = os.path.join(".", model_id)
        model.save_pretrained(save_onnx_dir)
        onnx_path = os.path.join(save_onnx_dir, "model.onnx")
        print("Model is exported to onnx file:", onnx_path)
    else:
        model = ORTModelForQuestionAnswering.from_pretrained(
            os.path.dirname(onnx_path),
            file_name=Path(onnx_path).name,
            provider=provider,
            use_io_binding=use_io_binding,
            # provider_options={"enable_skip_layer_norm_strict_mode": True},
        )

    return model, onnx_path


def output_details(results: list[dict[str, Any]], csv_filename: str):
    """Output a CSV file with detail of each test results.

    Args:
        results (List[Dict[str, Any]]): list of JSON results.
        csv_filename (str): path of output CSV file
    """
    with open(csv_filename, mode="a", newline="", encoding="ascii") as csv_file:
        column_names = [
            "pretrained_model_name",
            "onnx_path",
            "provider",
            "disable_fused_attention",
            "batch_size",
            "sequence_length",
            "use_io_binding",
            "exact",
            "f1",
            "total",
            "HasAns_exact",
            "HasAns_f1",
            "HasAns_total",
            "best_exact",
            "best_exact_thresh",
            "best_f1",
            "best_f1_thresh",
            "total_time_in_seconds",
            "samples_per_second",
            "latency_in_seconds",
        ]

        csv_writer = csv.DictWriter(csv_file, fieldnames=column_names)
        csv_writer.writeheader()
        for result in results:
            csv_writer.writerow(result)

        csv_file.flush()

    print(f"Detail results are saved to csv file: {csv_filename}")


def output_summary(results: list[dict[str, Any]], csv_filename: str, metric_name: str):
    """Output a CSV file with summary of a metric on combinations of batch_size and sequence_length.

    Args:
        results (List[Dict[str, Any]]): list of JSON results.
        csv_filename (str): path of output CSV file
        metric_name (str): the metric to summarize
    """
    with open(csv_filename, mode="a", newline="", encoding="ascii") as csv_file:
        header_names = [
            "pretrained_model_name",
            "onnx_path",
            "provider",
            "disable_fused_attention",
            "use_io_binding",
        ]

        model_list = list({result["onnx_path"] for result in results})
        model_list.sort()

        batch_sizes = list({result["batch_size"] for result in results})
        batch_sizes.sort()

        sequence_lengths = list({result["sequence_length"] for result in results})
        sequence_lengths.sort()

        key_names = []
        for sequence_length in sequence_lengths:
            for batch_size in batch_sizes:
                key_names.append(f"b{batch_size}_s{sequence_length}")

        csv_writer = csv.DictWriter(csv_file, fieldnames=header_names + key_names)
        csv_writer.writeheader()

        for model in model_list:
            row = {}

            # Metric value for given pair of batch_size and sequence_length.
            # Assume that (onnx_path, batch_size and sequence_length) are unique so keep first occurrence only.
            values = {}
            values.update(dict.fromkeys(key_names, ""))

            for result in results:
                if result["onnx_path"] == model and result[metric_name]:
                    headers = {k: v for k, v in result.items() if k in header_names}
                    if not row:
                        row.update(headers)

                    batch_size = result["batch_size"]
                    sequence_length = result["sequence_length"]
                    key = f"b{batch_size}_s{sequence_length}"

                    if key in key_names:
                        values[key] = result[metric_name]

            if row:
                for key in key_names:
                    row[key] = values.get(key, "")
                csv_writer.writerow(row)

        csv_file.flush()

    print(f"Summary results for {metric_name} are saved to csv file: {csv_filename}")


def main():
    args = parse_arguments()
    print(args)

    for name in ["onnxruntime-gpu", "onnxruntime", "onnx", "torch", "transformers", "optimum", "datasets", "evaluate"]:
        package_version = get_package_version(name)
        if package_version:
            print(f"{name} version", package_version)

    pretrained_model_name = args.model_name
    if args.onnx and not os.path.exists(args.onnx):
        raise RuntimeError(f"Onnx model path does not exist: {args.onnx}")

    disable_fused_attention = os.environ.get("ORT_DISABLE_FUSED_ATTENTION", "0") == "1"

    all_results = []
    tokenizer = AutoTokenizer.from_pretrained(pretrained_model_name)
    for sequence_length in args.sequence_lengths:
        tokenizer.model_max_length = sequence_length
        tokenizer.doc_stride = min(sequence_length // 2, 128)
        if args.onnx is None:
            print("Exporting onnx model. It might take a few minutes...")
        start_time = time.time()
        ort_model, onnx_path = load_onnx_model(pretrained_model_name, args.onnx, args.provider, args.use_io_binding)
        latency = time.time() - start_time
        print(f"Onnx model exported or loaded in {latency:.1f} seconds")

        print(ort_model.config)
        if sequence_length > ort_model.config.max_position_embeddings:
            raise RuntimeError("sequence length should not be larger than {ort_model.config.max_position_embeddings}")

        qa_pipeline = pipeline(
            "question-answering", model=ort_model, tokenizer=tokenizer, question_first=True, batch_size=args.batch_size
        )

        task_evaluator = evaluator("question-answering")
        print("Loading dataset...")
        start_time = time.time()
        squad_dataset = load_dataset("squad", split=f"validation[:{args.total}]" if args.total > 0 else "validation")
        latency = time.time() - start_time
        print(f"Dataset loaded in {latency:.1f} seconds")

        print("Evaluating squad_v2 with ORT. It might take a few minutes...")
        start_time = time.time()
        result = task_evaluator.compute(
            model_or_pipeline=qa_pipeline,
            data=squad_dataset,
            metric="squad_v2",
            squad_v2_format=True,
        )
        latency = time.time() - start_time
        print(f"Evaluation done in {latency:.1f} seconds")

        result["provider"] = args.provider
        result["disable_fused_attention"] = disable_fused_attention
        result["pretrained_model_name"] = pretrained_model_name
        result["onnx_path"] = onnx_path
        result["batch_size"] = args.batch_size
        result["sequence_length"] = sequence_length
        result["use_io_binding"] = args.use_io_binding
        print(result)

        all_results.append(result)

    output_details(all_results, "detail.csv")

    for metric_name in ["f1", "exact", "samples_per_second"]:
        output_summary(all_results, f"{metric_name}.csv", metric_name)


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "-m",
        "--model_name",
        required=False,
        type=str,
        default=PRETRAINED_SQUAD_MODELS[0],
        help=f"Checkpoint directory or pre-trained model names in the list: {PRETRAINED_SQUAD_MODELS}",
    )

    parser.add_argument(
        "-s",
        "--sequence_lengths",
        nargs="+",
        type=int,
        default=[384],
        help="Sequence lengths for onnx model inputs. It could have multiple values.",
    )

    parser.add_argument(
        "-b",
        "--batch_size",
        type=int,
        default=1,
        help="batch size for inference.",
    )

    parser.add_argument("-t", "--total", type=int, default=0, help="Total samples to test. 0 means all samples.")

    parser.add_argument(
        "--onnx",
        required=False,
        type=str,
        default=None,
        help="Optional onnx model path. If not specified, optimum will be used to export onnx model for testing.",
    )

    parser.add_argument(
        "--provider",
        required=False,
        default="CUDAExecutionProvider",
        help="Select which Execution Provider to use for runs. Default is CUDAExecutionProvider.",
    )

    parser.add_argument("--use_io_binding", required=False, action="store_true", help="Use IO Binding for GPU.")
    parser.set_defaults(use_io_binding=False)

    args = parser.parse_args(argv)

    return args


if __name__ == "__main__":
    main()
