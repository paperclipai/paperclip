# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
#
# This script converts stable diffusion onnx models from float to half (mixed) precision for GPU inference.
#
# Before running this script, follow README.md to setup python environment and convert stable diffusion checkpoint
# to float32 onnx models.
#
# For example, the float32 ONNX pipeline is saved to ./sd-v1-5 directory, you can optimize and convert it to float16
# like the following:
#    python optimize_pipeline.py -i ./sd-v1-5 -o ./sd-v1-5-fp16 --float16
#
# Note that the optimizations are carried out for CUDA Execution Provider at first, other EPs may not have the support
# for the fused operators. The users could disable the operator fusion manually to workaround.

import argparse
import logging
import os
import shutil
import tempfile
import warnings
from pathlib import Path

import onnx
from fusion_options import FusionOptions
from onnx_model_clip import ClipOnnxModel
from onnx_model_mmdit import MmditOnnxModel
from onnx_model_t5 import T5OnnxModel
from onnx_model_unet import UnetOnnxModel
from onnx_model_vae import VaeOnnxModel
from optimizer import optimize_by_onnxruntime, optimize_model
from packaging import version

import onnxruntime

logger = logging.getLogger(__name__)


def has_external_data(onnx_model_path):
    original_model = onnx.load_model(str(onnx_model_path), load_external_data=False)
    for initializer in original_model.graph.initializer:
        if initializer.HasField("data_location") and initializer.data_location == onnx.TensorProto.EXTERNAL:
            return True
    return False


def is_sd_3(source_dir: Path):
    return (source_dir / "text_encoder_3").exists()


def is_sdxl(source_dir: Path):
    return (
        (source_dir / "text_encoder_2").exists()
        and not (source_dir / "text_encoder_3").exists()
        and not (source_dir / "transformer").exists()
    )


def is_flux(source_dir: Path):
    return (
        (source_dir / "text_encoder_2").exists()
        and not (source_dir / "text_encoder_3").exists()
        and (source_dir / "transformer").exists()
    )


def _classify_pipeline_type(source_dir: Path):
    # May also check _class_name in model_index.json like `StableDiffusion3Pipeline` or `FluxPipeline` etc to classify.
    if is_sd_3(source_dir):
        return "sd3"

    if is_flux(source_dir):
        return "flux"

    if is_sdxl(source_dir):
        return "sdxl"

    # sd 1.x and 2.x
    return "sd"


def _get_model_list(pipeline_type: str):
    if pipeline_type == "sd3":
        return ["text_encoder", "text_encoder_2", "text_encoder_3", "transformer", "vae_encoder", "vae_decoder"]

    if pipeline_type == "flux":
        return ["text_encoder", "text_encoder_2", "transformer", "vae_encoder", "vae_decoder"]

    if pipeline_type == "sdxl":
        return ["text_encoder", "text_encoder_2", "unet", "vae_encoder", "vae_decoder"]

    assert pipeline_type == "sd"
    return ["text_encoder", "unet", "vae_encoder", "vae_decoder"]


def _optimize_sd_pipeline(
    source_dir: Path,
    target_dir: Path,
    pipeline_type: str,
    model_list: list[str],
    use_external_data_format: bool | None,
    float16: bool,
    bfloat16: bool,
    force_fp32_ops: list[str],
    enable_runtime_optimization: bool,
    args,
):
    """Optimize onnx models used in stable diffusion onnx pipeline and optionally convert to float16.

    Args:
        source_dir (Path): Root of input directory of stable diffusion onnx pipeline with float32 models.
        target_dir (Path): Root of output directory of stable diffusion onnx pipeline with optimized models.
        model_list (List[str]): list of directory names with onnx model.
        use_external_data_format (Optional[bool]): use external data format.
        float16 (bool): use half precision
        bfloat16 (bool): use bfloat16 as fallback if float16 is also provided.
        force_fp32_ops(List[str]): operators that are forced to run in float32.
        enable_runtime_optimization(bool): run graph optimization using Onnx Runtime.

    Raises:
        RuntimeError: input onnx model does not exist
        RuntimeError: output onnx model path existed
    """
    is_flux_pipeline = pipeline_type == "flux"
    model_type_mapping = {
        "transformer": "mmdit",
        "unet": "unet",
        "vae_encoder": "vae",
        "vae_decoder": "vae",
        "text_encoder": "clip",
        "text_encoder_2": "t5" if is_flux_pipeline else "clip",
        "text_encoder_3": "t5",  # t5-v1_1-xxl is used in SD 3.x text_encoder_3 and Flux text_encoder_2.
        "safety_checker": "unet",
    }

    model_type_class_mapping = {
        "unet": UnetOnnxModel,
        "vae": VaeOnnxModel,
        "clip": ClipOnnxModel,
        "t5": T5OnnxModel,
        "mmdit": MmditOnnxModel,
    }

    force_fp32_operators = {
        "unet": [],
        "vae_encoder": [],
        "vae_decoder": [],
        "text_encoder": [],
        "text_encoder_2": [],
        "safety_checker": [],
        "text_encoder_3": [],
        "transformer": [],
    }

    # The node block list is generated by running the fp32 model and get statistics of node inputs and outputs.
    # Nodes with any input or output of float or double data type, but value ouf of range of float16 are candidates.
    #   python optimize_pipeline.py -i ./flux1_schnell_onnx/fp32 -o ./flux1_schnell_onnx/fp32_opt
    #   export ORT_DEBUG_NODE_IO_DUMP_STATISTICS_DATA=1
    #   export ORT_DEBUG_NODE_IO_DUMP_INPUT_DATA=1
    #   export ORT_DEBUG_NODE_IO_DUMP_OUTPUT_DATA=1
    #   python benchmark.py --height 1024 --width 1024 --steps 4 -b 1 -v Flux.1S -p flux1_schnell_onnx/fp32_opt -e optimum >stdout.txt 2>stderr.txt
    # Warning: The node name might change in different export settings. See benchmark_flux.sh for the settings.
    flux_node_block_list = {
        "text_encoder_2": [
            "/encoder/block.10/layer.1/DenseReluDense/wo/MatMul",
            "SkipLayerNorm_20",
            "SkipLayerNorm_21",
            "SkipLayerNorm_22",
            "SkipLayerNorm_23",
            "SkipLayerNorm_24",
            "SkipLayerNorm_25",
            "SkipLayerNorm_26",
            "SkipLayerNorm_27",
            "SkipLayerNorm_28",
            "SkipLayerNorm_29",
            "SkipLayerNorm_30",
            "SkipLayerNorm_31",
            "SkipLayerNorm_32",
            "SkipLayerNorm_33",
            "SkipLayerNorm_34",
            "SkipLayerNorm_35",
            "SkipLayerNorm_36",
            "SkipLayerNorm_37",
            "SkipLayerNorm_38",
            "SkipLayerNorm_39",
            "SkipLayerNorm_40",
            "SkipLayerNorm_41",
            "SkipLayerNorm_42",
            "SkipLayerNorm_43",
            "SkipLayerNorm_44",
            "SkipLayerNorm_45",
            "/encoder/block.23/layer.1/DenseReluDense/wo/MatMul",
            "SkipLayerNorm_46",
        ],
        "vae_decoder": [
            "/decoder/mid_block/attentions.0/MatMul",
            "/decoder/mid_block/attentions.0/Softmax",
        ],
        "transformer": [
            "/transformer_blocks.18/Mul_5",
            "/transformer_blocks.18/Add_7",
            "/Concat_1",
            "LayerNorm_76",
            "/single_transformer_blocks.0/Add",
            "LayerNorm_77",
            "/single_transformer_blocks.1/Add",
            "LayerNorm_78",
            "/single_transformer_blocks.2/Add",
            "LayerNorm_79",
            "/single_transformer_blocks.3/Add",
            "LayerNorm_80",
            "/single_transformer_blocks.4/Add",
            "LayerNorm_81",
            "/single_transformer_blocks.5/Add",
            "LayerNorm_82",
            "/single_transformer_blocks.6/Add",
            "LayerNorm_83",
            "/single_transformer_blocks.7/Add",
            "LayerNorm_84",
            "/single_transformer_blocks.8/Add",
            "LayerNorm_85",
            "/single_transformer_blocks.9/Add",
            "LayerNorm_86",
            "/single_transformer_blocks.10/Add",
            "LayerNorm_87",
            "/single_transformer_blocks.11/Add",
            "LayerNorm_88",
            "/single_transformer_blocks.12/Add",
            "LayerNorm_89",
            "/single_transformer_blocks.13/Add",
            "LayerNorm_90",
            "/single_transformer_blocks.14/Add",
            "LayerNorm_91",
            "/single_transformer_blocks.15/Add",
            "LayerNorm_92",
            "/single_transformer_blocks.16/Add",
            "LayerNorm_93",
            "/single_transformer_blocks.17/Add",
            "LayerNorm_94",
            "/single_transformer_blocks.18/Add",
            "LayerNorm_95",
            "/single_transformer_blocks.19/Add",
            "LayerNorm_96",
            "/single_transformer_blocks.20/Add",
            "LayerNorm_97",
            "/single_transformer_blocks.21/Add",
            "LayerNorm_98",
            "/single_transformer_blocks.22/Add",
            "LayerNorm_99",
            "/single_transformer_blocks.23/Add",
            "LayerNorm_100",
            "/single_transformer_blocks.24/Add",
            "LayerNorm_101",
            "/single_transformer_blocks.25/Add",
            "LayerNorm_102",
            "/single_transformer_blocks.26/Add",
            "LayerNorm_103",
            "/single_transformer_blocks.27/Add",
            "LayerNorm_104",
            "/single_transformer_blocks.28/Add",
            "LayerNorm_105",
            "/single_transformer_blocks.29/Add",
            "LayerNorm_106",
            "/single_transformer_blocks.30/Add",
            "LayerNorm_107",
            "/single_transformer_blocks.31/Add",
            "LayerNorm_108",
            "/single_transformer_blocks.32/Add",
            "LayerNorm_109",
            "/single_transformer_blocks.33/Add",
            "LayerNorm_110",
            "/single_transformer_blocks.34/Add",
            "LayerNorm_111",
            "/single_transformer_blocks.35/Add",
            "LayerNorm_112",
            "/single_transformer_blocks.36/Add",
            "LayerNorm_113",
            "/single_transformer_blocks.37/Add",
            "/Shape",
            "/Slice",
        ],
    }

    sd3_node_block_list = {"text_encoder_3": flux_node_block_list["text_encoder_2"]}

    if force_fp32_ops:
        for fp32_operator in force_fp32_ops:
            parts = fp32_operator.split(":")
            if len(parts) == 2 and parts[0] in force_fp32_operators and (parts[1] and parts[1][0].isupper()):
                force_fp32_operators[parts[0]].append(parts[1])
            else:
                raise ValueError(
                    f"--force_fp32_ops shall be in the format of module:operator like unet:Attention, got {fp32_operator}"
                )

    op_counters = {}
    for name, model_type in model_type_mapping.items():
        onnx_model_path = source_dir / name / "model.onnx"
        if not os.path.exists(onnx_model_path):
            if name != "safety_checker" and name in model_list:
                logger.warning("input onnx model does not exist: %s", onnx_model_path)
            # some model are optional so we do not raise error here.
            continue

        # Prepare output directory
        optimized_model_path = target_dir / name / "model.onnx"
        if os.path.exists(optimized_model_path):
            if not args.overwrite:
                logger.warning("Skipped optimization since the target file existed: %s", optimized_model_path)
            continue
        output_dir = optimized_model_path.parent
        output_dir.mkdir(parents=True, exist_ok=True)

        if use_external_data_format is None:
            use_external_data_format = has_external_data(onnx_model_path)

        # Graph fusion before fp16 conversion, otherwise they cannot be fused later.
        logger.info("Optimize %s ...", onnx_model_path)

        args.model_type = model_type
        fusion_options = FusionOptions.parse(args)

        if model_type in ["unet"]:
            # Some optimizations are not available in v1.14 or older version: packed QKV and BiasAdd
            has_all_optimizations = version.parse(onnxruntime.__version__) >= version.parse("1.15.0")
            fusion_options.enable_packed_kv = float16 and fusion_options.enable_packed_kv
            fusion_options.enable_packed_qkv = float16 and has_all_optimizations and fusion_options.enable_packed_qkv
            fusion_options.enable_bias_add = has_all_optimizations and fusion_options.enable_bias_add

        m = optimize_model(
            str(onnx_model_path),
            model_type=model_type,
            num_heads=0,  # will be deduced from graph
            hidden_size=0,  # will be deduced from graph
            opt_level=0,
            optimization_options=fusion_options,
            use_gpu=True,
            provider=args.provider,
        )

        if float16:
            model_node_block_list = (
                flux_node_block_list if is_flux_pipeline else sd3_node_block_list if pipeline_type == "sd3" else {}
            )
            if name in model_node_block_list:
                # Opset 12 does not support bfloat16.
                # By default, optimum exports T5 model with opset 12. So we need to check the opset version.
                use_bfloat16 = bfloat16
                if use_bfloat16:
                    for opset in m.model.opset_import:
                        if opset.domain in ["", "ai.onnx"] and opset.version < 13:
                            logger.warning(
                                "onnx model requires opset 13 or higher to use bfloat16. Fall back to float32."
                            )
                            use_bfloat16 = False

                m.convert_float_to_float16(
                    keep_io_types=False,
                    node_block_list=model_node_block_list[name],
                    use_bfloat16_as_blocked_nodes_dtype=use_bfloat16,
                )
            # For SD-XL, use FP16 in VAE decoder will cause NaN and black image so we keep it in FP32.
            elif pipeline_type in ["sdxl"] and name in ["vae_decoder"]:
                logger.info("Skip converting %s to float16 to avoid NaN", name)
            else:
                logger.info("Convert %s to float16 ...", name)
                m.convert_float_to_float16(
                    keep_io_types=False,
                    op_block_list=force_fp32_operators[name],
                )

        if enable_runtime_optimization:
            # Use this step to see the final graph that executed by Onnx Runtime.
            with tempfile.TemporaryDirectory() as tmp_dir:
                # Save to a temporary file so that we can load it with Onnx Runtime.
                logger.info("Saving a temporary model to run OnnxRuntime graph optimizations...")
                tmp_model_path = Path(tmp_dir) / "model.onnx"
                m.save_model_to_file(str(tmp_model_path), use_external_data_format=use_external_data_format)
                ort_optimized_model_path = Path(tmp_dir) / "optimized.onnx"
                optimize_by_onnxruntime(
                    str(tmp_model_path),
                    use_gpu=True,
                    provider=args.provider,
                    optimized_model_path=str(ort_optimized_model_path),
                    save_as_external_data=use_external_data_format,
                )
                model = onnx.load(str(ort_optimized_model_path), load_external_data=True)
                m = model_type_class_mapping[model_type](model)

        m.get_operator_statistics()
        op_counters[name] = m.get_fused_operator_statistics()
        m.save_model_to_file(str(optimized_model_path), use_external_data_format=use_external_data_format)
        logger.info("%s is optimized", name)
        logger.info("*" * 20)

    return op_counters


def _copy_extra_directory(source_dir: Path, target_dir: Path, model_list: list[str]):
    """Copy extra directory that does not have onnx model

    Args:
        source_dir (Path): source directory
        target_dir (Path): target directory
        model_list (List[str]): list of directory names with onnx model.

    Raises:
        RuntimeError: source path does not exist
    """
    extra_dirs = ["scheduler", "tokenizer", "tokenizer_2", "tokenizer_3", "feature_extractor"]

    for name in extra_dirs:
        source_path = source_dir / name
        if not os.path.exists(source_path):
            continue

        target_path = target_dir / name
        if target_path.exists():
            shutil.rmtree(target_path)
        shutil.copytree(source_path, target_path)
        logger.info("%s => %s", source_path, target_path)

    extra_files = ["model_index.json"]
    for name in extra_files:
        source_path = source_dir / name
        if not os.path.exists(source_path):
            raise RuntimeError(f"source path does not exist: {source_path}")

        target_path = target_dir / name
        shutil.copyfile(source_path, target_path)
        logger.info("%s => %s", source_path, target_path)

    # Some directory are optional
    for onnx_model_dir in model_list:
        source_path = source_dir / onnx_model_dir / "config.json"
        target_path = target_dir / onnx_model_dir / "config.json"
        if source_path.exists():
            target_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source_path, target_path)
            logger.info("%s => %s", source_path, target_path)


def optimize_stable_diffusion_pipeline(
    input_dir: str,
    output_dir: str,
    overwrite: bool,
    use_external_data_format: bool | None,
    float16: bool,
    enable_runtime_optimization: bool,
    args,
):
    if os.path.exists(output_dir):
        if overwrite:
            shutil.rmtree(output_dir, ignore_errors=True)

    source_dir = Path(input_dir)
    target_dir = Path(output_dir)
    target_dir.mkdir(parents=True, exist_ok=True)

    pipeline_type = _classify_pipeline_type(source_dir)
    model_list = _get_model_list(pipeline_type)

    _copy_extra_directory(source_dir, target_dir, model_list)

    return _optimize_sd_pipeline(
        source_dir,
        target_dir,
        pipeline_type,
        model_list,
        use_external_data_format,
        float16,
        args.bfloat16,
        args.force_fp32_ops,
        enable_runtime_optimization,
        args,
    )


def parse_arguments(argv: list[str] | None = None):
    """Parse arguments

    Returns:
        Namespace: arguments
    """
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "-i",
        "--input",
        required=True,
        type=str,
        help="Root of input directory of stable diffusion onnx pipeline with float32 models.",
    )

    parser.add_argument(
        "-o",
        "--output",
        required=True,
        type=str,
        help="Root of output directory of stable diffusion onnx pipeline with optimized models.",
    )

    parser.add_argument(
        "--float16",
        required=False,
        action="store_true",
        help="Output models of float16, except some nodes falls back to float32 or bfloat16 to avoid overflow.",
    )
    parser.set_defaults(float16=False)

    parser.add_argument(
        "--bfloat16",
        required=False,
        action="store_true",
        help="Allow bfloat16 as fallback if --float16 is also provided.",
    )
    parser.set_defaults(bfloat16=False)

    parser.add_argument(
        "--force_fp32_ops",
        required=False,
        nargs="+",
        type=str,
        help="Force given operators (like unet:Attention) to run in float32. It is case sensitive!",
    )

    parser.add_argument(
        "--inspect",
        required=False,
        action="store_true",
        help="Save the optimized graph from Onnx Runtime. "
        "This option has no impact on inference performance except it might reduce session creation time.",
    )
    parser.set_defaults(inspect=False)

    parser.add_argument(
        "--overwrite",
        required=False,
        action="store_true",
        help="Overwrite exists files.",
    )
    parser.set_defaults(overwrite=False)

    parser.add_argument(
        "-e",
        "--use_external_data_format",
        required=False,
        action="store_true",
        help="Onnx model larger than 2GB need to use external data format. "
        "If specified, save each onnx model to two files: one for onnx graph, another for weights. "
        "If not specified, use same format as original model by default. ",
    )
    parser.set_defaults(use_external_data_format=None)

    parser.add_argument(
        "--provider",
        required=False,
        type=str,
        default=None,
        help="Execution provider to use.",
    )

    FusionOptions.add_arguments(parser)

    args = parser.parse_args(argv)
    return args


def main(argv: list[str] | None = None):
    warnings.warn(
        "This example is deprecated. Use the Olive recipe instead: "
        "https://github.com/microsoft/olive-recipes/tree/main",
        DeprecationWarning,
        stacklevel=2,
    )
    args = parse_arguments(argv)

    logger.info("Arguments: %s", str(args))

    # Return op counters for testing purpose.
    return optimize_stable_diffusion_pipeline(
        args.input, args.output, args.overwrite, args.use_external_data_format, args.float16, args.inspect, args
    )


if __name__ == "__main__":
    logging.basicConfig(format="%(funcName)20s: %(message)s", level=logging.INFO)
    main()
