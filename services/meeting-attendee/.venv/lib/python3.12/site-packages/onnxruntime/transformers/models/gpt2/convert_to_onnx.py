# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.  See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------
"""
This converts GPT2 model to onnx. Examples:
(1) Convert pretrained model 'gpt2' to ONNX
   python convert_to_onnx.py -m gpt2 --output gpt2.onnx
(2) Convert pretrained model 'distilgpt2' to ONNX, and use optimizer to get float16 model.
   python convert_to_onnx.py -m distilgpt2 --output distilgpt2_fp16.onnx -o -p fp16
(3) Convert a model check point to ONNX, and run optimization and int8 quantization
   python convert_to_onnx.py -m ./my_model_checkpoint/ --output my_model_int8.onnx -o -p int8

"""

import argparse
import csv
import json
import logging
import os
import shutil
import sys
import warnings
from pathlib import Path

import numpy
import torch
from benchmark_helper import (
    Precision,
    create_onnxruntime_session,
    get_ort_environment_variables,
    prepare_environment,
    setup_logger,
)
from gpt2_helper import DEFAULT_TOLERANCE, MODEL_CLASSES, PRETRAINED_GPT2_MODELS, Gpt2Helper
from gpt2_tester import Gpt2Tester
from packaging import version
from quantize_helper import QuantizeHelper
from transformers import AutoConfig
from transformers import __version__ as transformers_version

from onnxruntime import __version__ as ort_version

logger = logging.getLogger("")


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "-m",
        "--model_name_or_path",
        required=True,
        type=str,
        help="Model path, or pretrained model name in the list: " + ", ".join(PRETRAINED_GPT2_MODELS),
    )

    parser.add_argument(
        "--model_class",
        required=False,
        type=str,
        default="GPT2LMHeadModel",
        choices=list(MODEL_CLASSES.keys()),
        help="Model type selected in the list: " + ", ".join(MODEL_CLASSES.keys()),
    )

    parser.add_argument(
        "--cache_dir",
        required=False,
        type=str,
        default=os.path.join(".", "cache_models"),
        help="Directory to cache pre-trained models",
    )

    parser.add_argument(
        "--output",
        required=False,
        type=str,
        default=os.path.join(".", "onnx_models"),
        help="Output directory, or model path ends with .onnx",
    )

    parser.add_argument(
        "-o",
        "--optimize_onnx",
        required=False,
        action="store_true",
        help="Use optimizer.py to optimize onnx model",
    )
    parser.set_defaults(optimize_onnx=False)

    parser.add_argument("--use_gpu", required=False, action="store_true", help="use GPU for inference")
    parser.set_defaults(use_gpu=False)

    parser.add_argument(
        "--provider",
        required=False,
        default=None,
        choices=["dml", "migraphx", "cuda", "tensorrt"],
        help="use dml, cuda, tensorrt or migraphx for respective backend",
    )

    parser.add_argument(
        "--tolerance",
        required=False,
        type=float,
        default=0,
        help="the absolute and relative tolerance for parity verification",
    )

    parser.add_argument(
        "--input_test_file",
        "-i",
        required=False,
        type=str,
        default="",
        help="Path to the file with inputs to test with",
    )

    parser.add_argument(
        "-p",
        "--precision",
        required=False,
        type=Precision,
        default=Precision.FLOAT32,
        choices=list(Precision),
        help="Precision of model to run. fp32 for full precision, fp16 for half or mixed precision, and int8 for quantization",
    )

    parser.add_argument(
        "-t",
        "--test_cases",
        required=False,
        type=int,
        default=1000,
        help="Number of test cases per run for parity",
    )
    parser.add_argument(
        "-r",
        "--test_runs",
        required=False,
        type=int,
        default=10,
        help="Number of runs for parity. It is used for significance test.",
    )

    parser.add_argument("--verbose", required=False, action="store_true")
    parser.set_defaults(verbose=False)

    parser.add_argument("-e", "--use_external_data_format", required=False, action="store_true")
    parser.set_defaults(use_external_data_format=False)

    parser.add_argument("--overwrite", required=False, action="store_true")
    parser.set_defaults(overwrite=False)

    parser.add_argument(
        "--use_int64_inputs",
        required=False,
        action="store_true",
        help="Use int32 instead of int64 for input_ids, position_ids and attention_mask.",
    )
    parser.set_defaults(use_int64_inputs=False)

    parser.add_argument(
        "-s",
        "--stage",
        type=int,
        default=0,
        required=False,
        choices=[0, 1, 2],
        help="Stage in generation: 1 (initial decoder), 2 (decoder), 0 (both). "
        "1 - decode the first token when past_sequence_length is zero; "
        "2 - decode the remaining tokens when past_sequence_length is not zero; "
        "0 - one onnx model for both stages 1 and 2. "
        "Note that we will optimize 1 and 2 differently for best performance.",
    )

    fp16_option_group = parser.add_argument_group(
        'float to float16 conversion parameters that works when "--precision fp16" is specified'
    )

    fp16_option_group.add_argument(
        "-a",
        "--auto_mixed_precision",
        required=False,
        action="store_true",
        help="Convert to mixed precision automatically. Other float16 conversion parameters will be ignored.",
    )
    fp16_option_group.set_defaults(auto_mixed_precision=False)

    fp16_option_group.add_argument(
        "--keep_io_types",
        required=False,
        action="store_true",
        help="Use float32 for past inputs, present and logits outputs.",
    )
    fp16_option_group.set_defaults(keep_io_types=False)

    fp16_option_group.add_argument(
        "--io_block_list",
        nargs="+",
        default=[],
        help="List of inputs or outputs in float32 instead of float16",
    )

    fp16_option_group.add_argument(
        "--op_block_list",
        nargs="+",
        default=[],
        help="List of operators (like Add LayerNormalization SkipLayerNormalization EmbedLayerNormalization FastGelu) "
        "to compute in float32 instead of float16.",
    )

    fp16_option_group.add_argument(
        "--node_block_list",
        nargs="+",
        default=[],
        help="List of node names to compute in float32 instead of float16.",
    )

    fp16_option_group.add_argument(
        "--force_fp16_initializers",
        required=False,
        action="store_true",
        help="Convert all float initializers to float16.",
    )
    fp16_option_group.set_defaults(force_fp16_initializers=False)

    args = parser.parse_args(argv)

    return args


def get_onnx_model_size(onnx_path: str, use_external_data_format: bool):
    if not use_external_data_format:
        return os.path.getsize(onnx_path)
    else:
        return sum([f.stat().st_size for f in Path(onnx_path).parent.rglob("*")])


def get_latency_name(batch_size, sequence_length, past_sequence_length):
    return f"average_latency(batch_size={batch_size},sequence_length={sequence_length},past_sequence_length={past_sequence_length})"


def main(argv=None, experiment_name: str = "", run_id: str = "0", csv_filename: str = "gpt2_parity_results.csv"):
    warnings.warn(
        "This example is deprecated. Use the Olive recipe instead: "
        "https://github.com/microsoft/olive-recipes/tree/main",
        DeprecationWarning,
        stacklevel=2,
    )

    result = {}
    if version.parse(transformers_version) < version.parse(
        "3.1.0"
    ):  # past_key_values name does not exist in 3.0.2 or older
        raise RuntimeError("This tool requires transformers 3.1.0 or later.")

    args = parse_arguments(argv)
    setup_logger(args.verbose)

    if not experiment_name:
        experiment_name = " ".join(argv if argv else sys.argv[1:])

    if args.tolerance == 0:
        args.tolerance = DEFAULT_TOLERANCE[args.precision]

    logger.info(f"Arguments:{args}")

    cache_dir = args.cache_dir
    output_dir = args.output if not args.output.endswith(".onnx") else os.path.dirname(args.output)
    prepare_environment(cache_dir, output_dir, args.use_gpu)

    if args.precision != Precision.FLOAT32:
        assert args.optimize_onnx, "fp16/int8 requires --optimize_onnx"

    if args.precision == Precision.FLOAT16:
        assert args.use_gpu, "fp16 requires --use_gpu"

    if args.precision == Precision.INT8:
        assert not args.use_gpu, "quantization only supports CPU"

    model_class = MODEL_CLASSES[args.model_class][0]
    use_padding = MODEL_CLASSES[args.model_class][2]

    gpt2helper = Gpt2Helper
    config = AutoConfig.from_pretrained(args.model_name_or_path, cache_dir=cache_dir)
    model = model_class.from_pretrained(args.model_name_or_path, config=config, cache_dir=cache_dir)

    device = torch.device("cuda:0" if args.use_gpu else "cpu")
    model.eval().to(device)

    if (not args.use_external_data_format) and (config.n_layer > 24):
        logger.info("Try --use_external_data_format when model size > 2GB")

    onnx_model_paths = gpt2helper.get_onnx_paths(
        output_dir,
        args.model_name_or_path,
        args.model_class,
        new_folder=(args.precision == Precision.INT8),
        remove_existing=["fp32", "fp16", "int8"],
    )  # Do not remove raw model to save time in parity test

    raw_onnx_model = onnx_model_paths["raw"]

    int_data_type = torch.int64 if args.use_int64_inputs else torch.int32

    if os.path.exists(raw_onnx_model) and not args.overwrite:
        logger.warning(f"Skip exporting ONNX model since it existed: {raw_onnx_model}")
    else:
        logger.info(f"Exporting ONNX model to {raw_onnx_model}")
        gpt2helper.export_onnx(
            model,
            device,
            raw_onnx_model,
            args.verbose,
            args.use_external_data_format,
            has_position_ids=use_padding,
            has_attention_mask=use_padding,
            input_ids_dtype=int_data_type,
            position_ids_dtype=int_data_type,
            attention_mask_dtype=int_data_type,
        )

    fp16_params = {"keep_io_types": args.keep_io_types}
    if args.io_block_list:
        fp16_params["keep_io_types"] = args.io_block_list
    if args.node_block_list:
        fp16_params["node_block_list"] = args.node_block_list
    if args.op_block_list:
        fp16_params["op_block_list"] = args.op_block_list
    if args.force_fp16_initializers:
        fp16_params["force_fp16_initializers"] = args.force_fp16_initializers

    is_io_float16 = args.precision == Precision.FLOAT16 and not args.keep_io_types

    optimized_ops = ""
    all_ops = ""
    if args.optimize_onnx or args.precision != Precision.FLOAT32:
        output_path = onnx_model_paths[str(args.precision) if args.precision != Precision.INT8 else "fp32"]

        logger.info(f"Optimizing model to {output_path}")
        m = gpt2helper.optimize_onnx(
            raw_onnx_model,
            output_path,
            args.precision == Precision.FLOAT16,
            model.config.num_attention_heads,
            model.config.hidden_size,
            args.use_external_data_format,
            auto_mixed_precision=args.auto_mixed_precision,
            stage=args.stage,
            **fp16_params,
        )

        nodes = m.nodes()
        op_list = {node.op_type for node in nodes}
        all_ops = ",".join(op_list)

        # print optimized operators
        optimized_op_counter = m.get_fused_operator_statistics()
        if optimized_op_counter:
            optimized_ops = ",".join([key for key in optimized_op_counter if optimized_op_counter[key] > 0])
    else:
        output_path = raw_onnx_model

    if args.precision == Precision.INT8:
        logger.info("quantizing model...")
        QuantizeHelper.quantize_onnx_model(output_path, onnx_model_paths["int8"], args.use_external_data_format)
        model = QuantizeHelper.quantize_torch_model(model)
        logger.info("finished quantizing model")
        output_path = onnx_model_paths["int8"]

    if args.output.endswith(".onnx") and output_path != args.output and not args.use_external_data_format:
        shutil.move(output_path, args.output)
        output_path = args.output

    logger.info(f"Output path: {output_path}")
    model_size_in_MB = int(get_onnx_model_size(output_path, args.use_external_data_format) / 1024 / 1024)  # noqa: N806

    provider = args.provider
    session = create_onnxruntime_session(
        output_path, args.use_gpu, provider, enable_all_optimization=True, verbose=args.verbose
    )
    if args.model_class == "GPT2LMHeadModel" and session is not None:
        parity_result = gpt2helper.test_parity(
            session,
            model,
            device,
            is_io_float16,
            rtol=args.tolerance,
            atol=args.tolerance,
            model_class=args.model_class,
            has_position_ids=use_padding,
            has_attention_mask=use_padding,
            input_ids_dtype=int_data_type,
            position_ids_dtype=int_data_type,
            attention_mask_dtype=int_data_type,
            test_cases_per_run=args.test_cases,
            total_runs=args.test_runs,
            stage=args.stage,
            verbose=args.verbose,
        )

        # An example configuration for testing performance
        batch_size = 8
        sequence_length = 32 if args.stage == 1 else 1
        past_sequence_length = 0 if args.stage == 1 else 32

        latency = gpt2helper.test_performance(
            session,
            model,
            device,
            is_io_float16,
            total_runs=100,
            use_io_binding=True,
            model_class=args.model_class,
            has_position_ids=use_padding,
            has_attention_mask=use_padding,
            input_ids_dtype=int_data_type,
            position_ids_dtype=int_data_type,
            attention_mask_dtype=int_data_type,
            batch_size=batch_size,
            sequence_length=sequence_length,
            past_sequence_length=past_sequence_length,
        )

        if args.precision == Precision.FLOAT16:
            logger.info(f"fp16 conversion parameters:{fp16_params}")

        # Write results to file
        latency_name = get_latency_name(batch_size, sequence_length, past_sequence_length)
        csv_file_existed = os.path.exists(csv_filename)
        with open(csv_filename, mode="a", newline="") as csv_file:
            column_names = [
                "experiment",
                "run_id",
                "model_name",
                "model_class",
                "stage",
                "gpu",
                "precision",
                "optimizer",
                "test_cases",
                "runs",
                "keep_io_types",
                "io_block_list",
                "op_block_list",
                "node_block_list",
                "force_fp16_initializers",
                "auto_mixed_precision",
                "optimized_operators",
                "operators",
                "environment_variables",
                "onnxruntime",
                latency_name,
                "top1_match_rate",
                "onnx_size_in_MB",
                "diff_50_percentile",
                "diff_90_percentile",
                "diff_95_percentile",
                "diff_99_percentile",
                "diff_pass_rate",
                "nan_rate",
                "top1_match_rate_per_run",
            ]
            csv_writer = csv.DictWriter(csv_file, fieldnames=column_names)
            if not csv_file_existed:
                csv_writer.writeheader()
            row = {
                "experiment": experiment_name,
                "run_id": run_id,
                "model_name": args.model_name_or_path,
                "model_class": args.model_class,
                "stage": args.stage,
                "gpu": args.use_gpu,
                "precision": args.precision,
                "optimizer": args.optimize_onnx,
                "test_cases": args.test_cases,
                "runs": args.test_runs,
                "keep_io_types": args.keep_io_types,
                "io_block_list": args.io_block_list,
                "op_block_list": args.op_block_list,
                "node_block_list": args.node_block_list,
                "force_fp16_initializers": args.force_fp16_initializers,
                "auto_mixed_precision": args.auto_mixed_precision,
                "optimized_operators": optimized_ops,
                "operators": all_ops,
                "environment_variables": get_ort_environment_variables(),
                "onnxruntime": ort_version,
                latency_name: f"{latency:.2f}",
                "diff_50_percentile": parity_result["max_diff_percentile_50"],
                "diff_90_percentile": parity_result["max_diff_percentile_90"],
                "diff_95_percentile": parity_result["max_diff_percentile_95"],
                "diff_99_percentile": parity_result["max_diff_percentile_99"],
                "diff_pass_rate": parity_result["diff_pass_rate"],
                "nan_rate": parity_result["nan_rate"],
                "top1_match_rate": parity_result["top1_match_rate"],
                "top1_match_rate_per_run": parity_result["top1_match_rate_per_run"],
                "onnx_size_in_MB": f"{model_size_in_MB}",
            }
            logger.info(f"result: {row}")
            result.update(row)
            csv_writer.writerow(row)

    if args.input_test_file:
        test_inputs = []
        # Each line of test file is a JSON string like:
        # {"input_ids": [[14698, 257, 1310, 13688, 319, 326]]}
        with open(args.input_test_file) as read_f:
            for _, line in enumerate(read_f):
                line = line.rstrip()  # noqa: PLW2901
                data = json.loads(line)
                input_ids = torch.from_numpy(numpy.asarray(data["input_ids"], dtype=numpy.int64)).to(device)

                if use_padding:
                    if "attention_mask" in data:
                        numpy_float = numpy.float16 if is_io_float16 else numpy.float32
                        attention_mask = torch.from_numpy(numpy.asarray(data["attention_mask"], dtype=numpy_float)).to(
                            device
                        )
                    else:
                        padding = -1
                        attention_mask = (input_ids != padding).type(torch.float16 if is_io_float16 else torch.float32)
                        input_ids.masked_fill_(input_ids == padding, 0)

                    if "position_ids" in data:
                        position_ids = torch.from_numpy(numpy.asarray(data["position_ids"], dtype=numpy.int64)).to(
                            device
                        )
                    else:
                        position_ids = attention_mask.long().cumsum(-1) - 1
                        position_ids.masked_fill_(position_ids < 0, 0)

                    inputs = {
                        "input_ids": input_ids.to(int_data_type),
                        "position_ids": position_ids.to(int_data_type),
                        "attention_mask": attention_mask.to(int_data_type),
                    }
                else:
                    inputs = {"input_ids": input_ids.to(int_data_type)}

                test_inputs.append(inputs)

        Gpt2Tester.test_generation(
            session,
            model,
            device,
            test_inputs,
            precision=args.precision,
            model_class=args.model_class,
            top_k=20,
            top_k_no_order=True,
            max_steps=24,
            max_inputs=0,
            verbose=args.verbose,
            save_test_data=3,
            save_test_data_dir=Path(output_path).parent,
        )

    logger.info(f"Done. Output model: {output_path}")
    return result


if __name__ == "__main__":
    main()
