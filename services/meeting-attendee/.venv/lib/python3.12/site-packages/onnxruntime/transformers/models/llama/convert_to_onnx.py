# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.  See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------
from __future__ import annotations

import argparse
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import warnings
from itertools import chain

import onnx
import torch
from benchmark_helper import Precision, prepare_environment, setup_logger
from convert_generation import replace_mha_with_gqa
from dist_settings import barrier, get_rank, get_size, init_dist
from llama_inputs import get_merged_sample_with_past_kv_inputs, get_sample_inputs, get_sample_with_past_kv_inputs
from llama_parity import main as parity_check
from llama_torch import setup_torch_model

# to patch transformers before exporting for transformers >= 4.45
from models.torch_export_patches import bypass_export_some_errors
from models.torch_export_patches.patch_inputs import convert_dynamic_axes_into_dynamic_shapes
from onnx_model import OnnxModel
from optimizer import optimize_model
from packaging import version
from transformers import AutoConfig, AutoModelForCausalLM

from onnxruntime import __version__ as ort_version
from onnxruntime import quantization as ort_quantization

if version.parse(ort_version) < version.parse("1.22.0"):
    from onnxruntime.quantization.matmul_4bits_quantizer import MatMul4BitsQuantizer as MatMulNBitsQuantizer
else:
    from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer

torch_export_onnx_opset_version = 14
logger = logging.getLogger("")
init_dist()


def get_model_dynamic_axes(input_names: list[str], output_names: list[str]):
    dynamic_axes = {}
    for name in input_names + output_names:
        if name in input_names:
            # shape is (batch_size, sequence_length)
            dynamic_axes[name] = {0: "batch_size", 1: "sequence_length"}
        elif name == "logits":
            # shape is (batch_size, sequence_length, vocab_size)
            dynamic_axes[name] = {0: "batch_size", 1: "sequence_length"}
        elif "present" in name:
            # shape is (batch_size, num_heads, sequence_length, head_size)
            dynamic_axes[name] = {0: "batch_size", 2: "sequence_length"}
        else:
            raise Exception("Unknown input or output name found")
    return dynamic_axes


def get_model_with_past_kv_dynamic_axes(input_names: list[str], output_names: list[str]):
    dynamic_axes = {}
    for name in input_names + output_names:
        if name in {"input_ids", "position_ids"}:
            # shape is (batch_size, 1)
            dynamic_axes[name] = {0: "batch_size"}
        elif name == "attention_mask":
            # shape is (batch_size, past_sequence_length + 1)
            dynamic_axes[name] = {0: "batch_size", 1: "past_sequence_length + 1"}
        elif "past" in name:
            # shape is (batch_size, num_heads, past_sequence_length, head_size)
            dynamic_axes[name] = {0: "batch_size", 2: "past_sequence_length"}
        elif name == "logits":
            # shape is (batch_size, 1, vocab_size)
            dynamic_axes[name] = {0: "batch_size"}
        elif "present" in name:
            # shape is (batch_size, num_heads, past_sequence_length + 1, head_size)
            dynamic_axes[name] = {0: "batch_size", 2: "past_sequence_length + 1"}
        else:
            raise Exception("Unknown input or output name found")
    return dynamic_axes


def get_merged_model_dynamic_axes(input_names: list[str], output_names: list[str]):
    dynamic_axes = {}
    for name in input_names + output_names:
        if name in {"input_ids", "position_ids"}:
            # shape is (batch_size, sequence_length)
            dynamic_axes[name] = {0: "batch_size", 1: "sequence_length"}
        elif name == "attention_mask":
            # shape is (batch_size, past_sequence_length + sequence_length) = (batch_size, total_sequence_length)
            # for prompt generation, past_sequence_length = 0
            # for token generation, sequence_length = 1
            dynamic_axes[name] = {0: "batch_size", 1: "total_sequence_length"}
        elif "past" in name:
            # shape is (batch_size, num_heads, past_sequence_length, head_size)
            dynamic_axes[name] = {0: "batch_size", 2: "past_sequence_length"}
        elif name == "logits":
            # shape is (batch_size, sequence_length, vocab_size)
            dynamic_axes[name] = {0: "batch_size", 1: "sequence_length"}
        elif "present" in name:
            # shape is (batch_size, num_heads, past_sequence_length + sequence_length, head_size) = (batch_size, num_heads, total_sequence_length, head_size)
            # for prompt generation, past_sequence_length = 0
            # for token generation, sequence_length = 1
            dynamic_axes[name] = {0: "batch_size", 2: "total_sequence_length"}
        else:
            raise Exception("Unknown input or output name found")
    return dynamic_axes


def save_onnx_model(onnx_model: onnx.ModelProto, output_path: str, data_path: str):
    onnx.save(
        onnx_model,
        output_path,
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=data_path,
        size_threshold=1024,
        convert_attribute=False,
    )


def run_dynamo_export(
    args: argparse.Namespace, l_config: AutoConfig, llama: AutoModelForCausalLM, rank: int = 0, world_size: int = 1
):
    from torch._dynamo import config  # noqa: PLC0415

    config.capture_scalar_outputs = True

    # Dummy values for export
    batch_size, sequence_length, past_sequence_length = 2, 8, 3
    device = llama.device if args.model_name == "Llama-2-70b-hf" else torch.device("cpu")

    temp_name = args.model_name.lower().replace("-", "").replace("_", "")
    max_sequence_length = 16384 if "codellama" in temp_name else 4096 if "llama2" in temp_name else 2048

    # Export decoder_with_past_model.onnx
    input_ids, attn_mask, pos_ids, past_kv = get_merged_sample_with_past_kv_inputs(
        l_config,
        device,
        batch_size,
        sequence_length,
        past_sequence_length,
        max_seq_len=max_sequence_length,
        use_fp16=False,
        world_size=world_size,
    )
    temp_dir = tempfile.TemporaryDirectory()
    temp_path = os.path.join(temp_dir.name, "temp.onnx")

    input_names = ["input_ids", "attention_mask", "position_ids"]
    output_names = [
        "logits",
        *list(
            chain.from_iterable((f"present.{i}.key", f"present.{i}.value") for i in range(l_config.num_hidden_layers))
        ),
    ]
    dynamic_axes = get_model_dynamic_axes(input_names, output_names)

    model_args = (input_ids, attn_mask, pos_ids, past_kv)
    model_args, model_kwargs, dynamic_shapes = convert_dynamic_axes_into_dynamic_shapes(
        llama, args=model_args, dynamic_axes=dynamic_axes, prefix_mapping={"present": "past_key_values"}
    )

    with bypass_export_some_errors(patch_transformers=True):
        torch.onnx.export(
            llama,
            (),
            temp_path,
            kwargs=model_kwargs,
            dynamic_shapes=dynamic_shapes,
            dynamo=True,
            verbose=args.verbose,
            optimize=True,
        )

    # Check decoder_with_past_model.onnx and save all external data to one file
    onnx.checker.check_model(temp_path)
    onnx.shape_inference.infer_shapes_path(temp_path)

    output_path = os.path.join(args.output, f"rank_{rank}_{args.model_name}_decoder_with_past_model_fp32.onnx")
    onnx_model = onnx.load_model(temp_path, load_external_data=True)
    save_onnx_model(onnx_model, output_path, f"rank_{rank}_{args.model_name}_decoder_with_past_model_fp32.onnx.data")
    del onnx_model
    temp_dir.cleanup()

    logger.info(f"The {args.model_name} ONNX model has been successfully created with the Dynamo exporter!")


def _prepare_dir(dir_path):
    if not os.path.exists(dir_path):
        os.makedirs(dir_path)


def run_torchscript_separate_export(
    args: argparse.Namespace, l_config: AutoConfig, llama: AutoModelForCausalLM, rank: int = 0, world_size: int = 1
):
    # Dummy values for export
    batch_size, sequence_length = 2, 8

    # set device used to export model
    # for llama-2-70b we will use current gpus to speed up export process
    # for other models, we will use CPU to make sure we have enough memory to do export
    device = llama.device if args.model_name == "Llama-2-70b-hf" else torch.device("cpu")

    # Export decoder_model.onnx
    decoder_inputs = get_sample_inputs(l_config, device, batch_size, sequence_length)

    input_names = ["input_ids", "attention_mask", "position_ids"]
    output_names = [
        "logits",
        *list(
            chain.from_iterable((f"present.{i}.key", f"present.{i}.value") for i in range(l_config.num_hidden_layers))
        ),
    ]
    dynamic_axes = get_model_dynamic_axes(input_names, output_names)

    # Avoid using system temp dir to avoid overflood on hard disk as 70b model is very large.
    # Use temp folder per rank to avoid race condition here.
    temp_dir = f"./temp_{rank}"
    _prepare_dir(temp_dir)
    temp_path = os.path.join(temp_dir, "temp.onnx")
    torch.onnx.export(
        llama,
        args=decoder_inputs,
        f=temp_path,
        export_params=True,
        input_names=input_names,
        output_names=output_names,
        dynamic_axes=dynamic_axes,
        opset_version=torch_export_onnx_opset_version,
        do_constant_folding=True,
        verbose=args.verbose,
        dynamo=False,
    )

    # Check decoder_model.onnx and save all external data to one file
    onnx.checker.check_model(temp_path)
    onnx.shape_inference.infer_shapes_path(temp_path)

    output_path = os.path.join(args.output, f"rank_{rank}_{args.model_name}_decoder_model_fp32.onnx")
    onnx_model = onnx.load_model(temp_path, load_external_data=True)
    save_onnx_model(
        onnx_model,
        output_path,
        f"rank_{rank}_{args.model_name}_decoder_model_fp32.onnx.data",
    )
    del onnx_model
    shutil.rmtree(temp_dir)

    # Export decoder_with_past_model.onnx
    decoder_with_past_inputs = get_sample_with_past_kv_inputs(
        l_config,
        device,
        batch_size,
        sequence_length,
        use_fp16=False,
        world_size=world_size,
    )
    input_names = [
        "input_ids",
        "attention_mask",
        "position_ids",
        *list(
            chain.from_iterable(
                (f"past_key_values.{i}.key", f"past_key_values.{i}.value") for i in range(l_config.num_hidden_layers)
            )
        ),
    ]
    output_names = [
        "logits",
        *list(
            chain.from_iterable((f"present.{i}.key", f"present.{i}.value") for i in range(l_config.num_hidden_layers))
        ),
    ]
    dynamic_axes = get_model_with_past_kv_dynamic_axes(input_names, output_names)

    # Avoid using system temp dir to avoid overflood on hard disk as 70b model is very large.
    # Use temp folder per rank to avoid race condition here.
    temp_dir = f"./temp_past_{rank}"
    _prepare_dir(temp_dir)
    temp_path = os.path.join(temp_dir, "temp.onnx")
    torch.onnx.export(
        llama,
        args=decoder_with_past_inputs,
        f=temp_path,
        export_params=True,
        input_names=input_names,
        output_names=output_names,
        dynamic_axes=dynamic_axes,
        opset_version=torch_export_onnx_opset_version,
        do_constant_folding=True,
        verbose=args.verbose,
        dynamo=False,
    )

    # Check decoder_with_past_model.onnx and save all external data to one file
    onnx.checker.check_model(temp_path)
    onnx.shape_inference.infer_shapes_path(temp_path)

    output_path = os.path.join(args.output, f"rank_{rank}_{args.model_name}_decoder_with_past_model_fp32.onnx")
    onnx_model = onnx.load_model(temp_path, load_external_data=True)
    save_onnx_model(
        onnx_model,
        output_path,
        f"rank_{rank}_{args.model_name}_decoder_with_past_model_fp32.onnx.data",
    )
    del onnx_model
    shutil.rmtree(temp_dir)

    logger.info(
        f"The {args.model_name} separate ONNX model has been successfully created with the TorchScript exporter!"
    )


def run_torchscript_merged_export(
    args: argparse.Namespace, l_config: AutoConfig, llama: AutoModelForCausalLM, rank: int = 0, world_size: int = 1
):
    # Dummy values for export
    batch_size, sequence_length, past_sequence_length = 2, 8, 0

    # set device used to export model
    # for llama-2-70b we will use current gpus to speed up export process
    # for other models, we will use CPU to make sure we have enough memory to do export
    device = llama.device if args.model_name == "Llama-2-70b-hf" else torch.device("cpu")

    temp_name = args.model_name.lower().replace("-", "").replace("_", "")
    max_sequence_length = 16384 if "codellama" in temp_name else 4096 if "llama2" in temp_name else 2048

    # Export decoder_merged_model.onnx
    decoder_merged_inputs = get_merged_sample_with_past_kv_inputs(
        l_config,
        device,
        batch_size,
        sequence_length,
        past_sequence_length,
        max_seq_len=max_sequence_length,
        use_fp16=False,
        world_size=world_size,
    )
    input_names = [
        "input_ids",
        "attention_mask",
        "position_ids",
        *list(
            chain.from_iterable(
                (f"past_key_values.{i}.key", f"past_key_values.{i}.value") for i in range(l_config.num_hidden_layers)
            )
        ),
    ]
    output_names = [
        "logits",
        *list(
            chain.from_iterable((f"present.{i}.key", f"present.{i}.value") for i in range(l_config.num_hidden_layers))
        ),
    ]
    dynamic_axes = get_merged_model_dynamic_axes(input_names, output_names)

    # Avoid using system temp dir to avoid overflood on hard disk as 70b model is very large.
    # Use temp folder per rank to avoid race condition here.
    temp_dir = f"./temp_{rank}"
    _prepare_dir(temp_dir)
    temp_path = os.path.join(temp_dir, "temp.onnx")

    torch.onnx.export(
        llama,
        args=decoder_merged_inputs,
        f=temp_path,
        export_params=True,
        input_names=input_names,
        output_names=output_names,
        dynamic_axes=dynamic_axes,
        opset_version=torch_export_onnx_opset_version,
        do_constant_folding=True,
        verbose=args.verbose,
        dynamo=False,
    )

    # Check decoder_merged_model.onnx and save all external data to one file
    onnx.checker.check_model(temp_path)
    onnx.shape_inference.infer_shapes_path(temp_path)

    output_path = os.path.join(args.output, f"rank_{rank}_{args.model_name}_decoder_merged_model_fp32.onnx")
    onnx_model = onnx.load_model(temp_path, load_external_data=True)
    save_onnx_model(
        onnx_model,
        output_path,
        f"rank_{rank}_{args.model_name}_decoder_merged_model_fp32.onnx.data",
    )
    del onnx_model
    shutil.rmtree(temp_dir)

    logger.info(f"The {args.model_name} merged ONNX model has been successfully created with the TorchScript exporter!")


# Optimize the model as FP32
def optimize_export(
    args: argparse.Namespace,
    config: AutoConfig,
    input_path: str,
    output_path: str,
    remove_model: bool = True,
    world_size: int = 1,
    window_size: int = -1,
):
    from fusion_options import FusionOptions  # noqa: PLC0415

    optimization_options = FusionOptions("gpt2")

    model_opt = optimize_model(
        input_path,
        model_type="gpt2",
        num_heads=config.num_attention_heads,
        hidden_size=config.hidden_size,
        opt_level=0,
        optimization_options=optimization_options,
        only_onnxruntime=False,
    )
    if args.use_gqa:
        model_opt = use_group_query_attention(config, model_opt, world_size, window_size)
    model_opt.save_model_to_file(output_path, use_external_data_format=True)

    # Run symbolic shape inference on optimized model to avoid shape errors during runtime
    # Ex: Before attention fusion, RotaryEmbedding assumes a 4D input and produces a 4D output.
    # After attention fusion, RotaryEmbedding expects a 3D input and produces a 3D output.
    wheel_cmd = [sys.executable, "-m", "onnxruntime.tools.symbolic_shape_infer"]
    source_cmd = [sys.executable, "../symbolic_shape_infer.py"]
    symbolic_shape_infer_args = [
        "--input",
        output_path,
        "--output",
        output_path,
        "--auto_merge",
        "--save_as_external_data",
        "--all_tensors_to_one_file",
        "--external_data_location",
        os.path.basename(output_path) + ".data",
    ]

    file_path = os.path.dirname(__file__)
    if os.path.exists(os.path.join(file_path, "../../../tools/symbolic_shape_infer.py")):
        main_cmd = wheel_cmd
    else:
        main_cmd = source_cmd
    subprocess.run(main_cmd + symbolic_shape_infer_args)  # noqa: PLW1510

    logger.info(f"The ONNX model at {input_path} has been successfully optimized and saved at {output_path}!")
    if remove_model:
        remove_existing_model(input_path)


def convert_to_float16(args: argparse.Namespace, old_paths: list[str], rank: int = 0):
    decoder_model_fp16_path = os.path.join(args.output, f"rank_{rank}_{args.model_name}_decoder_model_fp16.onnx")
    decoder_with_past_model_fp16_path = os.path.join(
        args.output, f"rank_{rank}_{args.model_name}_decoder_with_past_model_fp16.onnx"
    )
    decoder_merged_model_fp16_path = os.path.join(
        args.output, f"rank_{rank}_{args.model_name}_decoder_merged_model_fp16.onnx"
    )
    new_paths = [decoder_model_fp16_path, decoder_with_past_model_fp16_path, decoder_merged_model_fp16_path]

    logger.info("Converting to float16...")
    for fp32_path, fp16_path in zip(old_paths, new_paths, strict=False):
        if os.path.exists(fp32_path):
            model = OnnxModel(onnx.load_model(fp32_path, load_external_data=True))
            model.convert_float_to_float16(keep_io_types=False)
            model.save_model_to_file(fp16_path, use_external_data_format=True)
            del model
            logger.info(f"The ONNX model at {fp32_path} has been converted to float16 and saved at {fp16_path}!")
            remove_existing_model(fp32_path)

    logger.info(f"The {args.model_name} ONNX model has been successfully converted to float16!")
    return new_paths


def use_group_query_attention(config: AutoConfig, model_opt: OnnxModel, world_size: int = 1, window_size: int = -1):
    # Replace MultiHeadAttention with GroupQueryAttention
    model_opt = replace_mha_with_gqa(model_opt, "attention_mask", config.num_key_value_heads, world_size, window_size)
    model_opt.prune_graph()
    model_opt.update_graph(allow_remove_graph_inputs=True)
    return model_opt


def smooth_quant(
    args: argparse.Namespace,
    decoder_model_fp32_path: str,
    decoder_with_past_model_fp32_path: str,
    decoder_model_int8_path: str,
    decoder_with_past_model_int8_path: str,
):
    from neural_compressor import PostTrainingQuantConfig, set_workspace  # noqa: PLC0415
    from neural_compressor import quantization as intel_quantization  # noqa: PLC0415
    from onnx.external_data_helper import load_external_data_for_model  # noqa: PLC0415
    from quant_kv_dataloader import QuantKVDataLoader  # noqa: PLC0415

    set_workspace(args.nc_workspace)
    quantization_config = PostTrainingQuantConfig(
        calibration_sampling_size=[args.calibration_sampling_size],
        recipes={
            "optypes_to_exclude_output_quant": ["MatMul"],
            "smooth_quant": True,
            "smooth_quant_args": {"alpha": args.smooth_quant_alpha},
        },
        op_type_dict={
            "^((?!(MatMul|Gather|Conv)).)*$": {
                "weight": {"dtype": ["fp32"]},
                "activation": {"dtype": ["fp32"]},
            }
        },
    )

    # Convert decoder_model.onnx to INT8
    decoder_model_int8 = intel_quantization.fit(
        decoder_model_fp32_path,
        quantization_config,
        calib_dataloader=QuantKVDataLoader(args),
    )
    load_external_data_for_model(
        decoder_model_int8._model,
        os.path.split(decoder_model_int8._model_path)[0],
    )
    save_onnx_model(
        decoder_model_int8._model,
        decoder_model_int8_path,
        f"{args.model_name}_decoder_model_int8.onnx.data",
    )
    del decoder_model_int8
    logger.info(
        f"The ONNX model at {decoder_model_fp32_path} has been quantized to int8 and saved at {decoder_model_int8_path}!"
    )
    remove_existing_model(decoder_model_fp32_path)

    # Convert decoder_with_past_model.onnx to INT8
    decoder_with_past_model_int8 = intel_quantization.fit(
        decoder_with_past_model_fp32_path,
        quantization_config,
        calib_dataloader=QuantKVDataLoader(args, onnx_model_path=decoder_model_fp32_path),
    )
    load_external_data_for_model(
        decoder_with_past_model_int8._model,
        os.path.split(decoder_with_past_model_int8._model_path)[0],
    )
    save_onnx_model(
        decoder_with_past_model_int8._model,
        decoder_with_past_model_int8_path,
        f"{args.model_name}_decoder_with_past_model_int8.onnx.data",
    )
    del decoder_with_past_model_int8
    logger.info(
        f"The ONNX model at {decoder_with_past_model_fp32_path} has been quantized to int8 and saved at {decoder_with_past_model_int8_path}!"
    )
    remove_existing_model(decoder_with_past_model_fp32_path)

    logger.info(f"The {args.model_name} ONNX model has been successfully quantized to int8!")

    logger.warning(f"Removing {args.nc_workspace}")
    shutil.rmtree(args.nc_workspace)


def remove_existing_model(model_path: str):
    # Remove ONNX model and its external data
    data_path = os.path.join(model_path + ".data")
    os.remove(model_path)
    os.remove(data_path)
    logger.warning(f"Removed {model_path} and {data_path}")


def remove_existing_files(output_path: str):
    for filename in os.listdir(output_path):
        filepath = os.path.join(output_path, filename)
        if ".onnx" in filename or ".onnx.data" in filename:
            os.remove(filepath)
            logger.warning(f"Removed {filepath}")


def optimize_optimum(config: AutoConfig, args: argparse.Namespace):
    tmp_file = os.path.join(args.output, args.model_name + ".tmp.onnx")
    output_file = os.path.join(args.output, args.model_name + ".onnx")
    window_size = -1 if not hasattr(config, "sliding_window") else config.sliding_window
    optimize_export(args, config, args.input, tmp_file, remove_model=False, window_size=window_size)
    logger.info(f"Model successfully optimized to {tmp_file}")
    opt_model = OnnxModel(onnx.load_model(tmp_file, load_external_data=True))
    if args.precision == Precision.FLOAT16:
        opt_model.convert_float_to_float16(keep_io_types=False)
        logger.info("Model successfully fused and quantized to FP16!")
    opt_model.save_model_to_file(output_file, use_external_data_format=True)
    logger.info(f"Output model successfully saved to {output_file}")
    logger.info(f"Removing {tmp_file}")
    remove_existing_model(tmp_file)


def get_args():
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "-m",
        "--model_name",
        required=True,
        help="Model name in Hugging Face",
    )

    parser.add_argument(
        "-i",
        "--input",
        required=False,
        default=os.path.join("."),
        help="Directory path to PyTorch model and associated files if saved on disk, or ONNX model file location if optimize_optimum is passed.",
    )

    parser.add_argument(
        "-o",
        "--output",
        required=False,
        default=os.path.join(".", "llama_onnx_models"),
        help="Directory path to save exported model files in",
    )

    parser.add_argument(
        "-p",
        "--precision",
        required=False,
        type=Precision,
        default=Precision.FLOAT32,
        choices=[Precision.FLOAT32, Precision.FLOAT16, Precision.INT8, Precision.INT4],
        help="Precision to export model in",
    )

    parser.add_argument(
        "-e",
        "--execution_provider",
        required=False,
        default="cpu",
        choices=["cpu", "cuda"],
        help="Execution provider to verify parity with",
    )

    parser.add_argument(
        "-r",
        "--reexport",
        required=False,
        action="store_true",
        help="Re-export models and overwrite existing models in output folder",
    )
    parser.set_defaults(reexport=False)

    parser.add_argument(
        "--use_gqa",
        required=False,
        action="store_true",
        help="Use GroupQueryAttention instead of MultiHeadAttention",
    )
    parser.set_defaults(use_gqa=False)

    parser.add_argument(
        "--no_merged",
        required=False,
        action="store_true",
        help="Export models into 2 ONNX files instead of 1. Deprecated in favor of exporting into 1 ONNX file.",
    )
    parser.set_defaults(no_merged=False)

    parser.add_argument(
        "-q",
        "--quantization_method",
        default="",
        choices=["blockwise", "smooth_quant", "quantize_dynamic"],
        help="Run a specific quantization algorithm (blockwise for int4, smooth_quant for int8, quantize_dynamic for int8). Blockwise is recommended. Need to install extra packages in `requirements-quant.txt` for SmoothQuant.",
    )

    blockwise_group = parser.add_argument_group("blockwise (4-bit quantization)")

    parser.add_argument("--bits", default=4, type=int, help="the target bits to represent weight")

    blockwise_group.add_argument(
        "--block_size",
        required=False,
        default=32,
        type=int,
        help="Block size to quantize with. See https://github.com/microsoft/onnxruntime/blob/main/onnxruntime/python/tools/quantization/matmul_nbits_quantizer.py for details.",
    )

    blockwise_group.add_argument(
        "--int4_accuracy_level",
        required=False,
        type=int,
        help="Accuracy level of the 4-bit quantized MatMul computation. "
        "Refer to the MatMulNBits contrib op's 'accuracy_level' attribute for details "
        "(https://github.com/microsoft/onnxruntime/blob/main/docs/ContribOperators.md#commicrosoftmatmulnbits).",
    )

    smooth_quant_group = parser.add_argument_group("smooth_quant (8-bit quantization)")

    smooth_quant_group.add_argument(
        "--smooth_quant_alpha",
        required=False,
        default=0.8,
        type=float,
        help="Strength to control migration difficulty from activation to weights. Default is 0.8 to match value \
              used in original paper for LLaMA. Paper recommends using values in [0.4, 0.6] range. \
              Link to paper: https://arxiv.org/pdf/2211.10438.pdf",
    )

    smooth_quant_group.add_argument(
        "--smooth_quant_dataset",
        required=False,
        default="NeelNanda/pile-10k",
        help="Path to dataset for calibration during quantization",
    )

    smooth_quant_group.add_argument(
        "--pad_max",
        required=False,
        default=196,
        type=int,
        help="Max padding size",
    )

    smooth_quant_group.add_argument(
        "--calibration_sampling_size",
        required=False,
        type=int,
        default=8,
        help="Calibration sampling size for quantization config",
    )

    smooth_quant_group.add_argument(
        "--nc_workspace",
        required=False,
        type=str,
        default=os.path.join(".", "nc_workspace"),
        help="Workspace to save intermediate files generated by Intel's Neural Compressor package.",
    )

    quantize_dynamic_group = parser.add_argument_group("quantize_dynamic (8-bit quantization)")

    quantize_dynamic_group.add_argument(
        "--quantize_embedding_layer",
        required=False,
        action="store_true",
        help="Quantize MatMul, GEMM, and Gather.",
    )
    quantize_dynamic_group.set_defaults(quantize_embedding_layer=False)

    quantize_dynamic_group.add_argument(
        "--quantize_per_channel",
        required=False,
        action="store_true",
        help="Quantize weights per each channel.",
    )
    quantize_dynamic_group.set_defaults(quantize_per_channel=False)

    quantize_dynamic_group.add_argument(
        "--quantize_reduce_range",
        required=False,
        action="store_true",
        help="Quantize weights with 7 bits.",
    )
    quantize_dynamic_group.set_defaults(quantize_reduce_range=False)

    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Print verbose logs",
    )
    parser.set_defaults(verbose=False)

    parser.add_argument(
        "-d",
        "--use_dynamo_export",
        action="store_true",
        help="Use the new Dynamo exporter instead of the old TorchScript exporter",
    )
    parser.set_defaults(use_dynamo_export=False)

    parser.add_argument(
        "--cache_dir",
        required=False,
        type=str,
        default="./model_cache",
        help="model cache dir to override default HF cache dir to avoid overflood the /home dir",
    )

    parser.add_argument(
        "--optimize_optimum",
        action="store_true",
        help="Avoid exporting model, only apply quantizations and optimizations to existing model exported from optimum.",
    )

    parser.add_argument(
        "--small_gpu",
        action="store_true",
        help="Load the llama in GPU every time for parity_check if it's running in a machine which GPU memory < 36GB.",
    )

    parser.set_defaults(optimize_optimum=False)

    args = parser.parse_args()
    return args


def main():
    warnings.warn(
        "This example is deprecated. Use the Olive recipe instead: "
        "https://github.com/microsoft/olive-recipes/tree/main",
        DeprecationWarning,
        stacklevel=2,
    )
    if version.parse(torch.__version__) < version.parse("2.2.0"):
        logger.error(f"Detected PyTorch version {torch.__version__}. Please upgrade and use v2.2.0 or newer.")
        return

    args = get_args()
    setup_logger(args.verbose)
    prepare_environment(args.input, args.output, args.execution_provider != "cpu")
    if args.reexport:
        remove_existing_files(args.output)
    logger.info(f"Arguments: {args}")

    world_size = get_size()
    rank = get_rank()
    args.world_size = world_size

    # Load model and config
    use_auth_token = args.input == os.path.join(".")
    setattr(args, "use_auth_token", use_auth_token)  # noqa: B010

    original_model_name = args.model_name
    setattr(args, "original_model_name", original_model_name)  # noqa: B010
    args.model_name = args.model_name.split("/")[-1]

    setattr(args, "device_name", "cpu" if args.execution_provider == "cpu" else f"cuda:{rank}")  # noqa: B010
    setattr(args, "device", torch.device(args.device_name))  # noqa: B010

    location = args.original_model_name if use_auth_token else args.input

    if args.optimize_optimum:
        config = AutoConfig.from_pretrained(args.original_model_name, cache_dir=args.cache_dir)
        optimize_optimum(config, args)
        return

    # Use CUDA for LLaMA-2-70B to speed up export and CPU for other models
    l_config, llama = setup_torch_model(
        args, location, use_auth_token, device=args.device if args.model_name == "Llama-2-70b-hf" else None
    )

    assert l_config.num_attention_heads % world_size == 0 and l_config.num_key_value_heads % world_size == 0

    barrier()
    for i in range(world_size):
        if i == rank:
            # Set model paths for FP32 model
            decoder_model_fp32_path = os.path.join(
                args.output, f"rank_{rank}_{args.model_name}_decoder_model_fp32.onnx"
            )
            decoder_with_past_model_fp32_path = os.path.join(
                args.output, f"rank_{rank}_{args.model_name}_decoder_with_past_model_fp32.onnx"
            )
            decoder_merged_model_fp32_path = os.path.join(
                args.output, f"rank_{rank}_{args.model_name}_decoder_merged_model_fp32.onnx"
            )
            old_paths = [decoder_model_fp32_path, decoder_with_past_model_fp32_path, decoder_merged_model_fp32_path]

            missing_separate_exports = (
                args.no_merged
                and not os.path.exists(decoder_model_fp32_path)
                and not os.path.exists(decoder_with_past_model_fp32_path)
            )
            missing_merged_export = not args.no_merged and not os.path.exists(decoder_merged_model_fp32_path)

            # Export to ONNX
            if missing_separate_exports or missing_merged_export:
                if args.use_dynamo_export:
                    logger.warning("Please ensure you have installed PyTorch, ONNX, and ONNX Script as follows.")
                    logger.warning("Step 1 - PyTorch nightly: https://pytorch.org/get-started/locally/")
                    logger.warning("Step 2 - ONNX weekly: https://pypi.org/project/onnx-weekly/")
                    logger.warning(
                        "Step 3 - ONNX Script from source: https://github.com/microsoft/onnxscript#installing-onnx-script"
                    )
                    logger.warning(
                        "Note: After you install ONNX weekly, omit `onnx` when running the first line for installing ONNX Script. This is because you already installed `onnx-weekly` in the previous step."
                    )
                    run_dynamo_export(args, l_config, llama)
                elif args.no_merged:
                    run_torchscript_separate_export(args, l_config, llama, rank, world_size)
                else:
                    run_torchscript_merged_export(args, l_config, llama, rank, world_size)
            del llama  # Delete LLaMA model from memory since it will be loaded again during parity check

            # Set model paths to store FP32 optimized model
            decoder_model_fp32_opt_path = os.path.join(
                args.output, f"rank_{rank}_{args.model_name}_decoder_model_fp32_opt.onnx"
            )
            decoder_with_past_model_fp32_opt_path = os.path.join(
                args.output, f"rank_{rank}_{args.model_name}_decoder_with_past_model_fp32_opt.onnx"
            )
            decoder_merged_model_fp32_opt_path = os.path.join(
                args.output, f"rank_{rank}_{args.model_name}_decoder_merged_model_fp32_opt.onnx"
            )
            new_paths = [
                decoder_model_fp32_opt_path,
                decoder_with_past_model_fp32_opt_path,
                decoder_merged_model_fp32_opt_path,
            ]

            # Run the optimizer script.
            logger.info("Optimizing models...")
            for orig_path, opt_path in zip(old_paths, new_paths, strict=False):
                if os.path.exists(orig_path):
                    optimize_export(args, l_config, input_path=orig_path, output_path=opt_path, world_size=world_size)

            # Re-assign default FP32 model paths as their optimized versions
            decoder_model_fp32_path = decoder_model_fp32_opt_path
            decoder_with_past_model_fp32_path = decoder_with_past_model_fp32_opt_path
            decoder_merged_model_fp32_path = decoder_merged_model_fp32_opt_path
            old_paths = [decoder_model_fp32_path, decoder_with_past_model_fp32_path, decoder_merged_model_fp32_path]

            logger.info(
                f"The {args.model_name} ONNX model has been successfully optimized with the ORT transformer optimizer script!"
            )

            # Change precision of exported models from FP32
            if args.precision == Precision.FLOAT16:
                new_paths = convert_to_float16(args, old_paths, rank)

            elif args.precision == Precision.INT8:
                decoder_model_int8_path = os.path.join(
                    args.output, f"rank_{rank}_{args.model_name}_decoder_model_int8.onnx"
                )
                decoder_with_past_model_int8_path = os.path.join(
                    args.output, f"rank_{rank}_{args.model_name}_decoder_with_past_model_int8.onnx"
                )
                decoder_merged_model_int8_path = os.path.join(
                    args.output, f"rank_{rank}_{args.model_name}_decoder_merged_model_int8.onnx"
                )
                new_paths = [decoder_model_int8_path, decoder_with_past_model_int8_path, decoder_merged_model_int8_path]

                if args.quantization_method == "smooth_quant":
                    if not args.no_merged:
                        logger.error("SmoothQuant must be used on separately exported models")
                    else:
                        logger.info(
                            f"Quantizing {decoder_model_fp32_path} and {decoder_with_past_model_fp32_path} to int8"
                        )
                        smooth_quant(args, old_paths[0], old_paths[1], new_paths[0], new_paths[1])

                elif args.quantization_method == "quantize_dynamic":
                    logger.warning(
                        "The `quantize_dynamic` method is deprecated in favor of `smooth_quant` instead. Precision loss may be high with `quantize_dynamic`."
                    )

                    logger.info("Quantizing to int8...")
                    for fp32_path, int8_path in zip(old_paths, new_paths, strict=False):
                        if os.path.exists(fp32_path):
                            ort_quantization.quantize_dynamic(
                                fp32_path,
                                int8_path,
                                op_types_to_quantize=(
                                    ["MatMul", "Gemm", "Gather"]
                                    if args.quantize_embedding_layer
                                    else ["MatMul", "Gemm"]
                                ),
                                per_channel=args.quantize_per_channel,
                                reduce_range=args.quantize_reduce_range,
                                use_external_data_format=True,
                                extra_options={"MatMulConstBOnly": True},
                            )
                            logger.info(
                                f"The ONNX model at {fp32_path} has been quantized to int8 and saved at {int8_path}!"
                            )
                            remove_existing_model(decoder_model_fp32_path)

                    logger.info(f"The {args.model_name} ONNX model has been successfully quantized to int8!")

                else:
                    raise Exception(f"Could not recognize {args.quantization_method} as a quantization method")

            elif args.precision == Precision.INT4:
                if args.execution_provider != "cpu":
                    old_paths = convert_to_float16(args, old_paths, rank)

                decoder_model_int4_path = os.path.join(
                    args.output, f"rank_{rank}_{args.model_name}_decoder_model_int4.onnx"
                )
                decoder_with_past_model_int4_path = os.path.join(
                    args.output, f"rank_{rank}_{args.model_name}_decoder_with_past_model_int4.onnx"
                )
                decoder_merged_model_int4_path = os.path.join(
                    args.output, f"rank_{rank}_{args.model_name}_decoder_merged_model_int4.onnx"
                )
                new_paths = [decoder_model_int4_path, decoder_with_past_model_int4_path, decoder_merged_model_int4_path]

                for fp_path, int4_path in zip(old_paths, new_paths, strict=False):
                    if os.path.exists(fp_path):
                        model = onnx.load_model(fp_path, load_external_data=True)
                        quant = MatMulNBitsQuantizer(
                            model=model,
                            bits=args.bits,
                            block_size=args.block_size,
                            is_symmetric=True,
                            accuracy_level=args.int4_accuracy_level,
                            nodes_to_exclude=[],
                        )
                        quant.process()
                        quant.model.save_model_to_file(int4_path, use_external_data_format=True)
                        del model
                        del quant
                        logger.info(f"The ONNX model at {fp_path} has been quantized to int4 and saved at {int4_path}!")
                        remove_existing_model(fp_path)
        barrier()

    logger.info("Verifying parity on all ONNX models created")

    # Use FP32 precision for FP32, INT8, INT4 CPU models, use FP16 precision for FP16 and INT4 GPU models
    args.precision = (
        "fp32"
        if args.precision in {Precision.INT8, Precision.FLOAT32}
        or (args.precision == Precision.INT4 and args.execution_provider == "cpu")
        else "fp16"
    )

    # Verify parity on all saved ONNX models
    for filename in os.listdir(args.output):
        if (
            ".data" in filename
            or ".onnx" not in filename
            or args.precision not in filename
            or f"rank_{rank}" not in filename
        ):
            continue

        parity_cmd = [
            "-m",
            original_model_name,
            "-o",
            os.path.join(args.output, filename),
            "-ep",
            args.execution_provider,
            "--precision",
            args.precision,
            "--cache_dir",
            args.cache_dir,
            "--torch_model_directory",
            args.input,
        ]
        if args.small_gpu:
            parity_cmd.append("--small_gpu")
        if "with_past" in filename:
            parity_cmd.append("--use_past_kv")
        if "merged" in filename:
            parity_cmd.append("--merged")

        try:
            logger.info(f"check parity with cmd: {parity_cmd}")
            parity_check(parity_cmd)
        except Exception as e:
            logger.exception(f"An error occurred while verifying parity: {e}")
            sys.exit(-1)


if __name__ == "__main__":
    main()
