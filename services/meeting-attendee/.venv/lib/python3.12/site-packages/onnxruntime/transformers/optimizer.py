# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

# Convert Bert ONNX model converted from TensorFlow or exported from PyTorch to use Attention, Gelu,
# SkipLayerNormalization and EmbedLayerNormalization ops to optimize
# performance on NVidia GPU and CPU.
#
# For Bert model exported from PyTorch, OnnxRuntime has bert model optimization support internally.
# You can use the option --use_onnxruntime to check optimizations from OnnxRuntime.
# For Bert model file like name.onnx, optimized model for GPU or CPU from OnnxRuntime will output as
# name_ort_gpu.onnx or name_ort_cpu.onnx in the same directory.
#
# This script is retained for experiment purpose. Useful scenarios like the following:
#  (1) Change model from fp32 to fp16 for mixed precision inference in GPU with Tensor Core.
#  (2) Change input data type from int64 to int32.
#  (3) Some model cannot be handled by OnnxRuntime, and you can modify this script to get optimized model.

import argparse
import logging
import os
import tempfile
from pathlib import Path

from fusion_options import FusionOptions
from onnx import ModelProto, load_model
from onnx_model import OnnxModel
from onnx_model_bart import BartOnnxModel
from onnx_model_bert import BertOnnxModel
from onnx_model_bert_keras import BertOnnxModelKeras
from onnx_model_bert_tf import BertOnnxModelTF
from onnx_model_clip import ClipOnnxModel
from onnx_model_conformer import ConformerOnnxModel
from onnx_model_gpt2 import Gpt2OnnxModel
from onnx_model_mmdit import MmditOnnxModel
from onnx_model_phi import PhiOnnxModel
from onnx_model_sam2 import Sam2OnnxModel
from onnx_model_t5 import T5OnnxModel
from onnx_model_tnlr import TnlrOnnxModel
from onnx_model_unet import UnetOnnxModel
from onnx_model_vae import VaeOnnxModel
from onnx_utils import extract_raw_data_from_model, has_external_data

import onnxruntime

logger = logging.getLogger(__name__)

# Map model type to tuple: optimizer class, export tools (pytorch, tf2onnx, keras2onnx), and default opt_level
MODEL_TYPES = {
    "bart": (BartOnnxModel, "pytorch", 1),
    "bert": (BertOnnxModel, "pytorch", 1),
    "bert_tf": (BertOnnxModelTF, "tf2onnx", 0),
    "bert_keras": (BertOnnxModelKeras, "keras2onnx", 0),
    "clip": (ClipOnnxModel, "pytorch", 1),  # Clip in Stable Diffusion
    "conformer": (ConformerOnnxModel, "pytorch", 1),
    "gpt2": (Gpt2OnnxModel, "pytorch", 1),
    "gpt2_tf": (Gpt2OnnxModel, "tf2onnx", 0),  # might add a class for GPT2OnnxModel for TF later.
    "gpt_neox": (BertOnnxModel, "pytorch", 0),  # GPT-NeoX
    "phi": (PhiOnnxModel, "pytorch", 0),
    "qwen3": (Gpt2OnnxModel, "pytorch", 0),  # Qwen3 (decoder-only with RoPE, GQA, RMSNorm)
    "sam2": (Sam2OnnxModel, "pytorch", 1),
    "swin": (BertOnnxModel, "pytorch", 1),
    "tnlr": (TnlrOnnxModel, "pytorch", 1),
    "t5": (T5OnnxModel, "pytorch", 2),
    "unet": (UnetOnnxModel, "pytorch", 1),  # UNet in Stable Diffusion
    "vae": (VaeOnnxModel, "pytorch", 1),  # UAE in Stable Diffusion
    "vit": (BertOnnxModel, "pytorch", 1),
    "mmdit": (MmditOnnxModel, "pytorch", 1),
}


def optimize_by_onnxruntime(
    onnx_model: str | ModelProto | None = None,
    use_gpu: bool = False,
    optimized_model_path: str | None = None,
    opt_level: int | None = 99,
    disabled_optimizers: list[str] = [],  # noqa: B006
    verbose: bool = False,
    save_as_external_data: bool = False,
    external_data_filename: str = "",
    external_data_file_threshold: int = 1024,
    *,
    provider: str | None = None,
    **deprecated_kwargs,
) -> str:
    """
    Use onnxruntime to optimize model.

    Args:
        onnx_model (str | ModelProto): the path of input onnx model or ModelProto.
        use_gpu (bool): whether the optimized model is targeted to run in GPU.
        optimized_model_path (str or None): the path of optimized model.
        opt_level (int): graph optimization level.
        disabled_optimizers (List[str]): a list of names of disabled optimizers
        save_as_external_data (bool): whether to save external data outside of ONNX model
        external_data_filename (str): name of external data file. If not provided, name is automatically created from ONNX model.
        external_data_file_threshold (int): threshold to decide whether to save tensor in ONNX model or in external data file
        provider (str or None): execution provider to use if use_gpu
    Returns:
        optimized_model_path (str): the path of optimized model
    """
    assert opt_level in [1, 2, 99]
    from torch import version as torch_version  # noqa: PLC0415

    if onnx_model is None:
        onnx_model = deprecated_kwargs.pop("onnx_model_path", None)
    assert onnx_model is not None

    if (
        use_gpu
        and provider is None
        and set(onnxruntime.get_available_providers()).isdisjoint(
            ["CUDAExecutionProvider", "MIGraphXExecutionProvider"]
        )
    ):
        logger.error("There is no gpu for onnxruntime to do optimization.")
        return onnx_model

    model = (
        OnnxModel(load_model(onnx_model, load_external_data=False))
        if isinstance(onnx_model, str)
        else OnnxModel(onnx_model)
    )
    if model.use_float16() and not use_gpu:
        logger.warning(
            "This model uses float16 in the graph, use_gpu=False might cause extra Cast nodes. "
            "Most operators have no float16 implementation in CPU, so Cast nodes are added to compute them in float32. "
            "If the model is intended to use in GPU, please set use_gpu=True. "
            "Otherwise, consider exporting onnx in float32 and optional int8 quantization for better performance. "
        )

    sess_options = onnxruntime.SessionOptions()
    if opt_level == 1:
        sess_options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_BASIC
    elif opt_level == 2:
        sess_options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_EXTENDED
    elif opt_level == 3:
        sess_options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_LAYOUT
    else:
        sess_options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_ALL

    if optimized_model_path is None:
        if isinstance(onnx_model, str):
            path_prefix = str(Path(onnx_model).with_suffix(""))  # remove .onnx suffix
        else:
            path_prefix = "optimized_model"
        optimized_model_path = "{}_o{}_{}.onnx".format(path_prefix, opt_level, "gpu" if use_gpu else "cpu")

    sess_options.optimized_model_filepath = optimized_model_path
    if save_as_external_data:
        if len(external_data_filename) == 0:
            # Set external data filename to model_name.onnx.data
            external_data_filename = os.path.basename(optimized_model_path) + ".data"
        sess_options.add_session_config_entry(
            "session.optimized_model_external_initializers_file_name", external_data_filename
        )
        sess_options.add_session_config_entry(
            "session.optimized_model_external_initializers_min_size_in_bytes", str(external_data_file_threshold)
        )

    if verbose:
        print("Using onnxruntime to optimize model - Debug level Set to verbose")
        sess_options.log_severity_level = 0

    kwargs = {}
    if disabled_optimizers:
        kwargs["disabled_optimizers"] = disabled_optimizers

    if not use_gpu:
        providers = ["CPUExecutionProvider"]
    elif provider is not None:
        if provider == "dml":
            providers = ["DmlExecutionProvider"]
        elif provider == "migraphx":
            providers = ["MIGraphXExecutionProvider"]
        elif provider == "cuda":
            providers = ["CUDAExecutionProvider"]
        elif provider == "tensorrt":
            providers = ["TensorrtExecutionProvider", "CUDAExecutionProvider"]
        else:
            providers = ["CUDAExecutionProvider"]

        providers.append("CPUExecutionProvider")
    else:
        providers = []

        if torch_version.hip:
            providers.append("MIGraphXExecutionProvider")
        else:
            providers.append("CUDAExecutionProvider")

    # For large model, extract external data from model and add to session options
    if isinstance(onnx_model, ModelProto):
        if has_external_data(onnx_model):
            raise ValueError(
                "ModelProto has external data not loaded into memory, ORT cannot create session. "
                "Please load external data before calling this function. "
                "See https://onnx.ai/onnx/repo-docs/ExternalData.html for more information."
            )
        external_names, external_values = extract_raw_data_from_model(onnx_model)
        sess_options.add_external_initializers(list(external_names), list(external_values))

    # Inference session is only used to optimize the model.
    onnx_model = onnx_model.SerializeToString() if isinstance(onnx_model, ModelProto) else onnx_model
    onnxruntime.InferenceSession(onnx_model, sess_options, providers=providers, **kwargs)

    assert os.path.exists(optimized_model_path) and os.path.isfile(optimized_model_path)
    logger.debug("Save optimized model by onnxruntime to %s", optimized_model_path)
    return optimized_model_path


def optimize_by_fusion(
    model: ModelProto,
    model_type: str = "bert",
    num_heads: int = 0,
    hidden_size: int = 0,
    optimization_options: FusionOptions | None = None,
) -> OnnxModel:
    """Optimize Model by graph fusion logic.

    Note that ONNXRuntime graph optimizations (like constant folding) will not be applied. So it is better to enable
    constant folding during exporting ONNX model, or run optimize_by_onnxruntime on the model first like optimize_model.

    For BERT model, num_heads and hidden_size are optional. For other model types, you need to specify these parameters.

    Args:
        model (ModelProto): model object
        model_type (str, optional): model type - like bert, bert_tf, bert_keras or gpt2. Defaults to 'bert'.
        num_heads (int, optional): number of attention heads. Defaults to 0.
                                   0 allows detect the parameter from graph automatically.
        hidden_size (int, optional): hidden size. Defaults to 0.
                                     0 allows detect the parameter from graph automatically.
        optimization_options (FusionOptions, optional): optimization options that turn on/off some fusions.
                                                        Defaults to None.

     Returns:
        object of an optimizer class.
    """
    if model_type not in ["bert", "t5", "swin", "unet", "vae", "clip", "sam2", "mmdit"] and (
        num_heads == 0 or hidden_size == 0
    ):
        logger.warning(f"Please specify parameters of num_heads and hidden_size for model_type {model_type}")

    if model_type not in MODEL_TYPES:
        logger.warning(f"Unsupported model type: {model_type} for graph fusion, directly return model.")
        return OnnxModel(model)

    (optimizer_class, producer, _) = MODEL_TYPES[model_type]

    if model.producer_name and producer != model.producer_name:
        logger.warning(
            f'Model producer not matched: Expected "{producer}", Got "{model.producer_name}".'
            "Please specify correct --model_type parameter."
        )

    if optimization_options is None:
        optimization_options = FusionOptions(model_type)

    optimizer = optimizer_class(model, num_heads, hidden_size)

    optimizer.optimize(optimization_options)

    optimizer.topological_sort()

    optimizer.model.producer_name = "onnxruntime.transformers"
    from onnxruntime import __version__ as onnxruntime_version  # noqa: PLC0415

    optimizer.model.producer_version = onnxruntime_version

    return optimizer


def optimize_model(
    input: str | ModelProto,
    model_type: str = "bert",
    num_heads: int = 0,
    hidden_size: int = 0,
    optimization_options: FusionOptions | None = None,
    opt_level: int | None = None,
    use_gpu: bool = False,
    only_onnxruntime: bool = False,
    verbose: bool = False,
    *,
    provider: str | None = None,
) -> OnnxModel:
    """Optimize Model by OnnxRuntime and/or python fusion logic.

    ONNX Runtime has graph optimizations (https://onnxruntime.ai/docs/performance/model-optimizations/graph-optimizations.html).
    However, the coverage is limited. We also have graph fusions that implemented in Python to improve the coverage.
    They can combined: ONNX Runtime will run first when opt_level > 0, then graph fusions in Python will be applied.

    To use ONNX Runtime only and no Python fusion logic, use only_onnxruntime flag and a positive opt_level like
        optimize_model(input, opt_level=1, use_gpu=False, only_onnxruntime=True)

    When opt_level is None, we will choose default optimization level according to model type.

    When opt_level is 0 and only_onnxruntime is False, only python fusion logic is used and onnxruntime is disabled.

    When opt_level > 1, use_gpu shall set properly
    since the optimized graph might contain operators for GPU or CPU only.

    If your model is intended for GPU inference only (especially float16 or mixed precision model), it is recommended to
    set use_gpu to be True, otherwise the model is not optimized for GPU inference.

    For BERT model, num_heads and hidden_size are optional. For other model types, you need specify these parameters.

    Args:
        input (str | ModelProto): input model path or ModelProto.
        model_type (str, optional): model type - like bert, bert_tf, bert_keras or gpt2. Defaults to 'bert'.
        num_heads (int, optional): number of attention heads. Defaults to 0.
            0 allows detect the parameter from graph automatically.
        hidden_size (int, optional): hidden size. Defaults to 0.
            0 allows detect the parameter from graph automatically.
        optimization_options (FusionOptions, optional): optimization options that turn on/off some fusions.
            Defaults to None.
        opt_level (int, optional): onnxruntime graph optimization level (0, 1, 2 or 99) or None. Defaults to None.
            When the value is None, default value (1 for bert and gpt2, 0 for other model types) will be used.
            When the level > 0, onnxruntime will be used to optimize model first.
        use_gpu (bool, optional): use gpu or not for onnxruntime. Defaults to False.
        only_onnxruntime (bool, optional): only use onnxruntime to optimize model, and no python fusion.
            Defaults to False.
        provider (str, optional): execution provider to use if use_gpu. Defaults to None.

     Returns:
        object of an optimizer class.
    """
    assert opt_level is None or opt_level in [0, 1, 2, 99]

    if model_type not in MODEL_TYPES:
        logger.warning(f"Unsupported model type: {model_type} for optimization, directly return model.")
        return OnnxModel(load_model(input)) if isinstance(input, str) else OnnxModel(input)

    (optimizer_class, _, default_opt_level) = MODEL_TYPES[model_type]

    if opt_level is None:
        opt_level = default_opt_level

    # Disable constant sharing to avoid model proto str mismatch in test. Ideally the optimizer should not
    # affect other fusions. We can update the expected model proto once the ConstantSharing optimizer logic becomes
    # stable.
    disabled_optimizers = ["ConstantSharing"]
    temp_model_path = None
    temp_dir = tempfile.TemporaryDirectory()
    optimized_model_name = "model_o{}_{}.onnx".format(opt_level, "gpu" if use_gpu else "cpu")
    optimized_model_path = os.path.join(temp_dir.name, optimized_model_name)

    # Auto detect if input model has external data
    has_external_data_file = False
    original_model = load_model(input, load_external_data=False) if isinstance(input, str) else input
    if has_external_data(original_model):
        has_external_data_file = True
    del original_model

    if opt_level > 1:
        # Disable some optimizers that might cause failure in symbolic shape inference or attention fusion.
        disabled_optimizers += (
            []
            if only_onnxruntime
            else [
                "MatMulScaleFusion",
                "MatMulAddFusion",
                "MatmulTransposeFusion",
                "GemmActivationFusion",
                "BiasSoftmaxFusion",
            ]
        )
        temp_model_path = optimize_by_onnxruntime(
            input,
            use_gpu=use_gpu,
            provider=provider,
            optimized_model_path=optimized_model_path,
            opt_level=opt_level,
            disabled_optimizers=disabled_optimizers,
            verbose=verbose,
            save_as_external_data=has_external_data_file,
        )
    elif opt_level == 1:
        # basic optimizations (like constant folding and cast elimination) are not specified to execution provider.
        # Note that use_gpu=False might cause extra Cast nodes for float16 model since most operators does not support float16 in CPU.
        # Sometime, use_gpu=True might cause extra memory copy nodes when some operators are supported only in CPU.
        # We might need remove GPU memory copy nodes as preprocess of optimize_by_fusion if they cause no matching in fusion.
        temp_model_path = optimize_by_onnxruntime(
            input,
            use_gpu=use_gpu,
            provider=provider,
            optimized_model_path=optimized_model_path,
            opt_level=1,
            disabled_optimizers=disabled_optimizers,
            verbose=verbose,
            save_as_external_data=has_external_data_file,
        )

    if only_onnxruntime and not temp_model_path:
        logger.warning("Please specify a positive value for opt_level when only_onnxruntime is True")

    if temp_model_path is not None:
        model = load_model(temp_model_path)
    elif isinstance(input, str):
        model = load_model(input)
    else:
        model = input

    if only_onnxruntime:
        optimizer = optimizer_class(model, num_heads, hidden_size)
    else:
        optimizer = optimize_by_fusion(model, model_type, num_heads, hidden_size, optimization_options)

    # remove the temporary directory
    temp_dir.cleanup()

    return optimizer


def get_fusion_statistics(optimized_model_path: str) -> dict[str, int]:
    """
    Get counter of fused operators in optimized model.

    Args:
        optimized_model_path (str): the path of onnx model.

    Returns:
        A dictionary with operator type as key, and count as value
    """
    model = load_model(optimized_model_path, format=None, load_external_data=True)
    optimizer = BertOnnxModel(model)
    return optimizer.get_fused_operator_statistics()


def _parse_arguments():
    parser = argparse.ArgumentParser(
        description="Graph optimization tool for ONNX Runtime."
        "It transforms ONNX graph to use optimized operators for Transformer models."
    )
    parser.add_argument("--input", required=True, type=str, help="input onnx model path")

    parser.add_argument("--output", required=True, type=str, help="optimized onnx model path")

    parser.add_argument(
        "--model_type",
        required=False,
        type=str.lower,
        default="bert",
        choices=list(MODEL_TYPES.keys()),
        help="Model type selected in the list: " + ", ".join(MODEL_TYPES.keys()),
    )

    parser.add_argument(
        "--num_heads",
        required=False,
        type=int,
        default=0,
        help="number of attention heads like 12 for bert-base and 16 for bert-large. "
        "Default is 0 to detect automatically for BERT."
        "For other model type, this parameter need specify correctly.",
    )

    parser.add_argument(
        "--hidden_size",
        required=False,
        type=int,
        default=0,
        help="hidden size like 768 for bert-base and 1024 for bert-large. "
        "Default is 0 to detect automatically for BERT. "
        "For other model type, this parameter need specify correctly.",
    )

    parser.add_argument(
        "--input_int32",
        required=False,
        action="store_true",
        help="Use int32 (instead of int64) inputs. "
        "It could avoid unnecessary data cast when EmbedLayerNormalization is fused for BERT.",
    )
    parser.set_defaults(input_int32=False)

    parser.add_argument(
        "--float16",
        required=False,
        action="store_true",
        help="Convert all weights and nodes in float32 to float16. "
        "It has potential loss in precision compared to mixed precision conversion.",
    )
    parser.set_defaults(float16=False)

    FusionOptions.add_arguments(parser)

    parser.add_argument("--verbose", required=False, action="store_true", help="show debug information.")
    parser.set_defaults(verbose=False)

    parser.add_argument(
        "--use_gpu",
        required=False,
        action="store_true",
        help="Use GPU for inference. Set this flag if your model is intended for GPU when opt_level > 1.",
    )
    parser.set_defaults(use_gpu=False)

    parser.add_argument(
        "--provider",
        required=False,
        type=str,
        default=None,
        help="Execution provider to use if use_gpu",
    )

    parser.add_argument(
        "--only_onnxruntime",
        required=False,
        action="store_true",
        help="optimized by onnxruntime only, and no graph fusion in Python",
    )
    parser.set_defaults(only_onnxruntime=False)

    parser.add_argument(
        "--opt_level",
        required=False,
        type=int,
        choices=[0, 1, 2, 3, 99],
        default=None,
        help="onnxruntime optimization level. 0 will disable onnxruntime graph optimization. "
        "The recommended value is 1. When opt_level > 1 is used, optimized model for GPU might not run in CPU. "
        "Level 2, Level 3 and 99 are intended for --only_onnxruntime.",
    )

    parser.add_argument(
        "--use_external_data_format",
        required=False,
        action="store_true",
        help="use external data format to store large model (>2GB)",
    )
    parser.set_defaults(use_external_data_format=False)

    parser.add_argument(
        "--disable_symbolic_shape_infer",
        required=False,
        action="store_true",
        help="disable symbolic shape inference",
    )
    parser.set_defaults(disable_symbolic_shape_infer=False)

    parser.add_argument(
        "--convert_to_packing_mode",
        required=False,
        action="store_true",
        help="convert the model to packing mode. Only available for BERT like model",
    )
    parser.set_defaults(convert_to_packing_mode=False)

    parser.add_argument(
        "--convert_attribute",
        required=False,
        action="store_true",
        help="convert attributes when using a rewritten ONNX model (e.g. Dynamo-exported model from ONNX Script)",
    )
    parser.set_defaults(convert_attribute=False)

    args = parser.parse_args()

    return args


def _setup_logger(verbose):
    if verbose:
        logging.basicConfig(
            format="[%(filename)s:%(lineno)s - %(funcName)20s()] %(message)s", level=logging.DEBUG, force=True
        )
    else:
        logging.basicConfig(format="%(funcName)20s: %(message)s", level=logging.INFO, force=True)


def main():
    args = _parse_arguments()

    _setup_logger(args.verbose)

    logger.debug(f"arguments:{args}")

    if os.path.realpath(args.input) == os.path.realpath(args.output):
        logger.warning("Specified the same input and output path. Note that this may overwrite the original model")

    optimization_options = FusionOptions.parse(args)

    optimizer = optimize_model(
        args.input,
        args.model_type,
        args.num_heads,
        args.hidden_size,
        opt_level=args.opt_level,
        optimization_options=optimization_options,
        use_gpu=args.use_gpu,
        provider=args.provider,
        only_onnxruntime=args.only_onnxruntime,
    )

    if args.float16:
        optimizer.convert_float_to_float16(keep_io_types=True)

    if args.input_int32:
        optimizer.change_graph_inputs_to_int32()

    # Print the operator statistics might help end user.
    optimizer.get_operator_statistics()

    fused_op_count = optimizer.get_fused_operator_statistics()
    if "bert" in args.model_type and optimizer.is_fully_optimized(fused_op_count):
        logger.info("The model has been fully optimized.")
    else:
        logger.info("The model has been optimized.")

    if args.convert_to_packing_mode:
        if args.model_type == "bert":
            optimizer.convert_to_packing_mode(not args.disable_symbolic_shape_infer)
        else:
            logger.warning("Packing mode only supports BERT like models")

    optimizer.save_model_to_file(args.output, args.use_external_data_format, convert_attribute=args.convert_attribute)


if __name__ == "__main__":
    main()
