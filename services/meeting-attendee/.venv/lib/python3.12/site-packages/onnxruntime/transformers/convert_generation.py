# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
# -------------------------------------------------------------------------
"""
This converts GPT2 or T5 model to onnx with beam search operator.

Example 1: convert gpt2 model with beam search:
    python convert_generation.py -m gpt2 --output gpt2_beam_search.onnx

Example 2: convert gpt2 model with beam search containing specific cuda optimizations:
    python convert_generation.py -m gpt2 --output gpt2_beam_search.onnx --use_gpu               \
        --past_present_share_buffer --use_decoder_masked_attention

Example 3: convert gpt2 model with beam search with mixed precision and enable SkipLayerNorm strict mode:
    python convert_generation.py -m gpt2 --output gpt2_beam_search.onnx --use_gpu -p fp16 --use_sln_strict_mode

Example 4: convert T5 model with beam search in two steps:
    python -m models.t5.convert_to_onnx -m t5-small
    python convert_generation.py -m t5-small --model_type t5             \
        --decoder_onnx ./onnx_models/t5-small_decoder.onnx               \
        --encoder_decoder_init_onnx ./onnx_models/t5-small_encoder.onnx  \
        --output ./onnx_models/t5_small_beam_search.onnx

Example 5: convert T5 model with beam search. All in one step:
    python convert_generation.py -m t5-small --model_type t5 --output t5_small_beam_search.onnx

Example 6: convert T5 model with beam search containing specific cuda optimizations. All in one step:
    python convert_generation.py -m t5-small --model_type t5 --output t5_small_beam_search.onnx   \
        --use_gpu --past_present_share_buffer --use_decoder_masked_attention

Example 7: convert MT5 model with external data file like mt5-base-beamsearch.onnx.data in below example.
    python convert_generation.py -m google/mt5-base --model_type mt5 --output mt5-base-beamsearch.onnx -e

Example 8: convert gpt2 model with greedy search:
    python convert_generation.py -m gpt2 --output gpt2_greedy_search.onnx --num_beams 1 --num_return_sequences 1

Example 9: convert gpt2 model with sampling:
    python convert_generation.py -m gpt2 --output gpt2_sampling.onnx --num_beams 1 --num_return_sequences 1 --top_p 0.6
"""

import argparse
import logging
import math
import os
import time
from enum import Enum
from pathlib import Path
from typing import Any

import numpy as np
import onnx
import torch
from benchmark_helper import Precision, setup_logger
from fusion_utils import NumpyHelper
from onnx import GraphProto, ModelProto, TensorProto
from onnx_model import OnnxModel
from transformers import (
    GPT2Config,
    GPT2LMHeadModel,
    GPT2Tokenizer,
    MT5Config,
    MT5ForConditionalGeneration,
    T5Config,
    T5ForConditionalGeneration,
    T5Tokenizer,
)

from onnxruntime import (
    GraphOptimizationLevel,
    InferenceSession,
    SessionOptions,
    get_available_providers,
)
from onnxruntime.transformers.models.gpt2.convert_to_onnx import (
    main as convert_gpt2_to_onnx,
)
from onnxruntime.transformers.models.gpt2.gpt2_helper import PRETRAINED_GPT2_MODELS
from onnxruntime.transformers.models.t5.convert_to_onnx import (
    export_onnx_models as export_t5_onnx_models,
)
from onnxruntime.transformers.models.t5.t5_helper import (
    PRETRAINED_MT5_MODELS,
    PRETRAINED_T5_MODELS,
)

logger = logging.getLogger("")


class GenerationType(Enum):
    BEAMSEARCH = "beam_search"
    GREEDYSEARCH = "greedy_search"
    SAMPLING = "sampling"

    def __str__(self):
        return self.value


def parse_arguments(argv: list[str] | None = None) -> argparse.Namespace:
    """Parse arguments

    Args:
        argv (Optional[List[str]], optional): _description_. Defaults to None.

    Returns:
        argparse.Namespace: Parsed arguments.
    """
    parser = argparse.ArgumentParser()

    input_group = parser.add_argument_group("Input options")

    input_group.add_argument(
        "-m",
        "--model_name_or_path",
        required=True,
        type=str,
        help="Pytorch model checkpoint path, or pretrained model name in the list: "
        + ", ".join(PRETRAINED_GPT2_MODELS + PRETRAINED_T5_MODELS + PRETRAINED_MT5_MODELS),
    )

    input_group.add_argument(
        "--model_type",
        required=False,
        type=str,
        default="gpt2",
        choices=["gpt2", "t5", "mt5"],
        help="Model type (default is gpt2) in the list: " + ", ".join(["gpt2", "t5", "mt5"]),
    )

    input_group.add_argument(
        "--cache_dir",
        required=False,
        type=str,
        default=os.path.join(".", "cache_models"),
        help="Directory to cache pre-trained models",
    )

    input_group.add_argument(
        "--decoder_onnx",
        required=False,
        type=str,
        default="",
        help="Path of onnx model for decoder. Specify it when you have exported the model.",
    )

    input_group.add_argument(
        "--encoder_decoder_init_onnx",
        required=False,
        type=str,
        default="",
        help="Path of ONNX model for encoder and decoder initialization. Specify it when you have exported the model.",
    )

    parser.add_argument(
        "--verbose",
        required=False,
        action="store_true",
        help="Print more information",
    )
    parser.set_defaults(verbose=False)

    output_group = parser.add_argument_group("Output options")

    output_group.add_argument(
        "--output",
        required=True,
        type=str,
        help="Output path for onnx model with beam search.",
    )

    output_group.add_argument(
        "-p",
        "--precision",
        required=False,
        type=str,
        default=Precision.FLOAT32.value,
        choices=[Precision.FLOAT32.value, Precision.FLOAT16.value],
        help="Precision of model to run. fp32 for full precision, fp16 for half or mixed precision",
    )

    output_group.add_argument(
        "-b",
        "--op_block_list",
        required=False,
        nargs="*",
        default=["auto"],
        help="Disable certain onnx operators when exporting model to onnx format. When using default"
        'value for gpt2 type of model fp16 precision, it will be set to ["Add", "LayerNormalization",'
        ' "SkipLayerNormalization", "FastGelu"]. Other situation, it will be set to []',
    )

    output_group.add_argument(
        "-e",
        "--use_external_data_format",
        required=False,
        action="store_true",
        help="save external data for model > 2G",
    )
    output_group.set_defaults(use_external_data_format=False)

    output_group.add_argument(
        "-s",
        "--run_shape_inference",
        required=False,
        action="store_true",
        help="run shape inference",
    )
    output_group.set_defaults(run_shape_inference=False)

    output_group.add_argument(
        "-dpvs",
        "--disable_pad_vocab_size",
        required=False,
        action="store_true",
        help="Do not pad logits MatMul weight to be a multiple of 8 along the dimension where dim value is"
        " the vocab size. The logits MatMul may hence be of poor performance for fp16 precision.",
    )
    output_group.set_defaults(disable_pad_vocab_size=False)

    output_group.add_argument(
        "-dsgd",
        "--disable_separate_gpt2_decoder_for_init_run",
        required=False,
        action="store_true",
        help="Do not create separate decoder subgraphs for initial and remaining runs. This does not allow "
        "for optimizations based on sequence lengths in each subgraph",
    )
    output_group.set_defaults(disable_separate_gpt2_decoder_for_init_run=False)

    output_group.add_argument(
        "-i",
        "--disable_shared_initializers",
        required=False,
        action="store_true",
        help="do not share initializers in encoder and decoder for T5 or in the init decoder and decoder for "
        "GPT2. It will increase memory usage of t5/mt5/gpt2 models.",
    )
    output_group.set_defaults(disable_shared_initializers=False)

    output_group.add_argument(
        "--encoder_decoder_init",
        required=False,
        action="store_true",
        help="Add decoder initialization to encoder for T5 model. This is legacy format that will be deprecated.",
    )
    output_group.set_defaults(encoder_decoder_init=False)

    model_group = parser.add_argument_group("Beam search parameters that stored in the output model")

    model_group.add_argument(
        "--output_sequences_scores",
        required=False,
        action="store_true",
        help="output sequences scores",
    )
    model_group.set_defaults(output_sequences_scores=False)

    model_group.add_argument(
        "--output_token_scores",
        required=False,
        action="store_true",
        help="output token scores",
    )
    model_group.set_defaults(output_token_scores=False)

    model_group.add_argument("--early_stopping", required=False, action="store_true")
    model_group.set_defaults(early_stopping=False)

    model_group.add_argument(
        "--no_repeat_ngram_size",
        type=int,
        required=False,
        default=0,
        help="No repeat ngram size",
    )

    model_group.add_argument(
        "--vocab_mask",
        required=False,
        action="store_true",
        help="Enable vocab_mask. This mask applies only to every generated token to filter some bad words.",
    )
    model_group.set_defaults(vocab_mask=False)

    model_group.add_argument(
        "--past_present_share_buffer",
        required=False,
        action="store_true",
        help="Use shared buffer for past and present, currently work for gpt2 greedy/sampling search.",
    )
    model_group.set_defaults(past_present_share_buffer=False)

    model_group.add_argument(
        "--use_decoder_masked_attention",
        required=False,
        action="store_true",
        help="Uses `DecoderMaskedSelfAttention` or `DecoderMaskedMultiHeadAttention` to optimize the decoding Attention computation. "
        "Must be used with `past_present_share_buffer`. Currently, only Attention head sizes of 32, 64 and 128 are supported.",
    )
    model_group.set_defaults(use_decoder_masked_attention=False)

    model_group.add_argument(
        "--prefix_vocab_mask",
        required=False,
        action="store_true",
        help="Enable prefix_vocab_mask. This mask can be used to filter bad words in the first generated token only",
    )
    model_group.set_defaults(prefix_vocab_mask=False)

    model_group.add_argument(
        "--custom_attention_mask",
        required=False,
        action="store_true",
        help="Enable custom_attention_mask. This mask can be used to replace default encoder attention mask",
    )
    model_group.set_defaults(custom_attention_mask=False)

    model_group.add_argument(
        "--presence_mask",
        required=False,
        action="store_true",
        help="Presence mask for custom sampling",
    )
    model_group.set_defaults(presence_mask=False)

    model_group.add_argument(
        "--seed",
        required=False,
        action="store_true",
        help="Random seed for sampling op",
    )
    model_group.set_defaults(seed=False)

    beam_parameters_group = parser.add_argument_group(
        "Beam search parameters not stored in the output model, for testing parity and performance"
    )

    beam_parameters_group.add_argument("--min_length", type=int, required=False, default=1, help="Min sequence length")

    beam_parameters_group.add_argument("--max_length", type=int, required=False, default=50, help="Max sequence length")

    beam_parameters_group.add_argument("--num_beams", type=int, required=False, default=4, help="Beam size")

    beam_parameters_group.add_argument(
        "--num_return_sequences",
        type=int,
        required=False,
        default=1,
        help="Number of return sequence <= num_beams",
    )

    beam_parameters_group.add_argument(
        "--length_penalty",
        type=float,
        required=False,
        default=1,
        help="Positive. >1 to penalize and <1 to encourage short sentence.",
    )

    beam_parameters_group.add_argument(
        "--repetition_penalty",
        type=float,
        required=False,
        default=1,
        help="Positive. >1 to penalize and <1 to encourage.",
    )

    beam_parameters_group.add_argument(
        "--temperature",
        type=float,
        required=False,
        default=1.0,
        help="The value used to module the next token probabilities.",
    )

    beam_parameters_group.add_argument(
        "--top_p",
        type=float,
        required=False,
        default=1.0,
        help="Top P for sampling",
    )

    beam_parameters_group.add_argument(
        "--filter_value",
        type=float,
        required=False,
        default=-float("Inf"),
        help="Filter value for Top P sampling",
    )

    beam_parameters_group.add_argument(
        "--min_tokens_to_keep",
        type=int,
        required=False,
        default=1,
        help="Minimum number of tokens we keep per batch example in the output.",
    )

    beam_parameters_group.add_argument(
        "--presence_penalty",
        type=float,
        required=False,
        default=0.0,
        help="presence penalty for custom sampling.",
    )

    beam_parameters_group.add_argument(
        "--custom",
        type=int,
        required=False,
        default=0,
        help="If 1 customized top P logic is applied",
    )

    beam_parameters_group.add_argument(
        "--vocab_size",
        type=int,
        required=False,
        default=-1,
        help="Vocab_size of the underlying model used to decide the shape of vocab mask",
    )

    beam_parameters_group.add_argument(
        "--eos_token_id",
        type=int,
        required=False,
        default=-1,
        help="custom eos_token_id for generating model with existing onnx encoder/decoder",
    )

    beam_parameters_group.add_argument(
        "--pad_token_id",
        type=int,
        required=False,
        default=-1,
        help="custom pad_token_id for generating model with existing onnx encoder/decoder",
    )

    test_group = parser.add_argument_group("Other options for testing parity and performance")

    test_group.add_argument(
        "--use_sln_strict_mode",
        required=False,
        action="store_true",
        help="Enable strict mode for SLN in CUDA provider. This ensures a better accuracy but will be slower.",
    )
    test_group.set_defaults(use_sln_strict_mode=False)

    test_group.add_argument(
        "--use_gpu",
        required=False,
        action="store_true",
        help="use GPU for inference. Required for fp16.",
    )
    test_group.set_defaults(use_gpu=False)

    test_group.add_argument(
        "--disable_parity",
        required=False,
        action="store_true",
        help="do not run parity test",
    )
    test_group.set_defaults(disable_parity=False)

    test_group.add_argument(
        "--disable_perf_test",
        required=False,
        action="store_true",
        help="do not run perf test",
    )
    test_group.set_defaults(disable_perf_test=False)

    test_group.add_argument(
        "--torch_performance",
        required=False,
        action="store_true",
        help="test PyTorch performance",
    )
    test_group.set_defaults(torch_performance=False)

    test_group.add_argument(
        "--total_runs",
        required=False,
        type=int,
        default=1,
        help="Number of times of inference for latency measurement",
    )

    test_group.add_argument(
        "--save_test_data",
        required=False,
        action="store_true",
        help="save test data for onnxruntime_perf_test tool",
    )
    test_group.set_defaults(save_test_data=False)

    args = parser.parse_args(argv)

    return args


def gpt2_to_onnx(args: argparse.Namespace):
    """Convert GPT-2 model to onnx

    Args:
        args (argparse.Namespace): arguments parsed from command line
    """
    model_name = args.model_name_or_path

    arguments = [
        "--model_name_or_path",
        model_name,
        "--output",
        args.decoder_onnx,
        "--optimize_onnx",
        "--precision",
        args.precision,
        "--test_runs",
        "1",
        "--test_cases",
        "10",
        "--overwrite",  # Overwrite onnx file if existed
    ]
    if args.cache_dir:
        arguments.extend(["--cache_dir", args.cache_dir])
    if args.use_gpu:
        arguments.append("--use_gpu")
    if args.use_external_data_format:
        arguments.append("--use_external_data_format")

    if len(args.op_block_list):
        arguments.extend(["--op_block_list"])
        arguments.extend(args.op_block_list)

    if args.precision == Precision.FLOAT16.value:
        assert args.use_gpu, "fp16 or mixed precision model cannot run in CPU. Please add --use_gpu"
        # TODO(tianleiwu): Use auto mixed precision for fp16 conversion: arguments.append('--auto_mixed_precision')
        #       Need change cuda kernel to support a combination of fp32 logits and fp16 past state.
        #       Currently logits and past state shall be same data type.

    if args.verbose:
        logger.info(f"arguments for convert_to_onnx:{arguments}")

    convert_gpt2_to_onnx(argv=arguments)


def t5_to_onnx(args: argparse.Namespace):
    """Convert T5 model to onnx

    Args:
        args (argparse.Namespace): arguments parsed from command line
    """
    paths = export_t5_onnx_models(
        model_name_or_path=args.model_name_or_path,
        cache_dir=args.cache_dir,
        output_dir=Path(args.output).parent,
        use_gpu=args.use_gpu,
        use_external_data_format=args.use_external_data_format,
        optimize_onnx=(args.precision != Precision.FLOAT16.value),
        precision=args.precision,
        verbose=False,
        use_decoder_start_token=False,
        overwrite=True,
        disable_auto_mixed_precision=False,
        use_int32_inputs=True,
        model_type=args.model_type,
        encoder_decoder_init=args.encoder_decoder_init,
        force_fp16_io=(args.precision == Precision.FLOAT16.value),  # required by BeamSearch op implementation.
    )

    logger.debug(f"onnx model for encoder: {paths[0]}")
    logger.debug(f"onnx model for decoder: {paths[1]}")
    args.encoder_decoder_init_onnx = paths[0]
    args.decoder_onnx = paths[1]


def shape_inference(onnx_path: str, use_external_data_format: bool = True):
    """Shape inference on an onnx file, which will be overwritten.

    Args:
        onnx_path (str): Path of onnx model
        use_external_data_format(bool): output tensors to external data or not.
    """
    # Run symbolic shape inference to walk around ORT shape inference issue for subgraph.
    from onnxruntime.tools.symbolic_shape_infer import SymbolicShapeInference  # noqa: PLC0415

    model = onnx.load_model(onnx_path, load_external_data=True)
    out = SymbolicShapeInference.infer_shapes(model, auto_merge=True, guess_output_rank=False)
    if out:
        OnnxModel.save(out, onnx_path, save_as_external_data=use_external_data_format)
    else:
        logger.warning("Failed to run symbolic shape inference on the model.")


def pad_weights_of_logits_matmul(onnx_path: str, use_external_data_format: bool = True) -> bool:
    """Pad the logits MatMul weight in the provided decoder model, which will be overwritten.

    Args:
        onnx_path (str): Path of onnx model
        use_external_data_format(bool): output tensors to external data or not.
    """
    decoder_model_proto = onnx.load_model(onnx_path, load_external_data=True)

    logits_output_name = decoder_model_proto.graph.output[0].name

    decoder_model = OnnxModel(decoder_model_proto)

    output_name_to_node = decoder_model.output_name_to_node()
    assert logits_output_name in output_name_to_node

    matmul_node = output_name_to_node[logits_output_name]
    # Sanity check - the logits need to be produced by a MatMul node
    if matmul_node.op_type != "MatMul":
        return False

    # The logits MatMul weight MUST be an initializer (or)
    # it MUST be flowing through a Transpose whose input is
    # an initializer
    pad_along_axis_1 = True
    logits_weight = decoder_model.get_initializer(matmul_node.input[1])
    if logits_weight is None:
        transpose_before_matmul = decoder_model.match_parent(matmul_node, "Transpose", 1)

        if transpose_before_matmul is None:
            return False

        logits_weight = decoder_model.get_initializer(transpose_before_matmul.input[0])

        if logits_weight is None:
            return False

        pad_along_axis_1 = False

    # The logits MatMul weight MUST be fp16
    if logits_weight.data_type != TensorProto.DataType.FLOAT16:
        return False

    # The logits MatMul weight MUST be 2-dimensional
    if len(logits_weight.dims) != 2:
        return False

    # Pad and over-write the initializer (if needed)
    actual_vocab_size = logits_weight.dims[1]

    if (actual_vocab_size % 8) == 0:
        # Already "padded"
        return True

    padded_vocab_size = math.ceil(actual_vocab_size / 8) * 8
    padding = padded_vocab_size - actual_vocab_size

    # TODO(hasesh): Handle cases where the fp16 data is stored in the
    # non-raw data field
    if logits_weight.raw_data:
        if pad_along_axis_1:
            padding_data = np.zeros((logits_weight.dims[0], padding), dtype=np.float16)
            weight_with_padding = np.concatenate((NumpyHelper.to_array(logits_weight), padding_data), axis=1)
            logits_weight.dims[1] = padded_vocab_size
        else:
            padding_data = np.zeros((padding, logits_weight.dims[1]), dtype=np.float16)
            weight_with_padding = np.concatenate((NumpyHelper.to_array(logits_weight), padding_data), axis=0)
            logits_weight.dims[0] = padded_vocab_size

        logits_weight.raw_data = weight_with_padding.tobytes()
    else:
        return False

    # Save the model
    OnnxModel.save(decoder_model_proto, onnx_path, save_as_external_data=use_external_data_format)
    return True


def create_ort_session(model_path: str, use_gpu: bool, use_sln_strict_mode: bool) -> InferenceSession:
    """Create OnnxRuntime session.

    Args:
        model_path (str): onnx model path
        use_gpu (bool): use GPU or not
        use_sln_strict_mode (bool): use strict mode for skip layer normalization or not

    Raises:
        RuntimeError: CUDAExecutionProvider is not available when --use_gpu is specified.

    Returns:
        onnxruntime.InferenceSession: The created session.
    """
    sess_options = SessionOptions()
    sess_options.graph_optimization_level = GraphOptimizationLevel.ORT_DISABLE_ALL
    execution_providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if use_gpu else ["CPUExecutionProvider"]
    if use_gpu:
        if "CUDAExecutionProvider" not in get_available_providers():
            raise RuntimeError("CUDAExecutionProvider is not available for --use_gpu!")
        else:
            logger.info("use CUDAExecutionProvider")
        if use_sln_strict_mode:
            cuda_provider_options = {"enable_skip_layer_norm_strict_mode": True}
            provider_options = {"CUDAExecutionProvider": cuda_provider_options}
            execution_providers = [
                (name, provider_options[name]) if name in provider_options else name for name in execution_providers
            ]

    ort_session = InferenceSession(model_path, sess_options, providers=execution_providers)
    return ort_session


def verify_gpt2_subgraph(graph: onnx.GraphProto, precision: Precision):
    """Verify GPT-2 subgraph

    Args:
        graph (onnx.GraphProto): onnx graph of GPT-2
        precision (Precision): Precision (FLOAT16 or FLOAT32) of the model.

    Raises:
        ValueError: Number of inputs not expected.
        ValueError: Input name is not expected.
        ValueError: Input data type is not expected.
        ValueError: Number of outputs not expected.
        ValueError: Output name is not expected.
        ValueError: Output data type is not expected.
    """
    is_float16 = precision == Precision.FLOAT16.value

    input_count = len(graph.input)
    layer_count = input_count - 3
    assert layer_count >= 1

    expected_inputs = ["input_ids", "position_ids", "attention_mask"] + [f"past_{i}" for i in range(layer_count)]
    if len(graph.input) != len(expected_inputs):
        raise ValueError(f"Number of inputs expected to be {len(expected_inputs)}. Got {len(graph.input)}")

    for i, expected_input in enumerate(expected_inputs):
        if graph.input[i].name != expected_input:
            raise ValueError(f"Input {i} is expected to be {expected_input}. Got {graph.input[i].name}")

        expected_type = TensorProto.INT32
        if i >= 3:
            expected_type = TensorProto.FLOAT16 if is_float16 else TensorProto.FLOAT

        input_type = graph.input[i].type.tensor_type.elem_type
        if input_type != expected_type:
            raise ValueError(f"Input {i} is expected to have onnx data type {expected_type}. Got {input_type}")
    logger.info("Verifying GPT-2 graph inputs: name and data type are good.")

    expected_outputs = ["logits"] + [f"present_{i}" for i in range(layer_count)]
    if len(graph.output) != len(expected_outputs):
        raise ValueError(f"Number of outputs expected to be {len(expected_outputs)}. Got {len(graph.output)}")

    for i, expected_output in enumerate(expected_outputs):
        if graph.output[i].name != expected_output:
            raise ValueError(f"Output {i} is expected to be {expected_output}. Got {graph.output[i].name}")

        expected_type = TensorProto.FLOAT16 if is_float16 else TensorProto.FLOAT
        output_type = graph.output[i].type.tensor_type.elem_type
        if output_type != expected_type:
            raise ValueError(f"Input {i} is expected to have onnx data type {expected_type}. Got {output_type}")
    logger.info("Verifying GPT-2 graph outputs: name and data type are good.")

    # TODO(tianleiwu): verify shapes of inputs and outputs.
    return


def verify_t5_decoder_subgraph(graph: onnx.GraphProto, precision: Precision):
    """Verify T5 decoder subgraph

    Args:
        graph (onnx.GraphProto): onnx graph of T5 decoder
        precision (Precision): Precision (FLOAT16 or FLOAT32) of the model.

    Raises:
        ValueError: Number of inputs not expected.
        ValueError: Input name is not expected.
        ValueError: Input data type is not expected.
        ValueError: Number of outputs not expected.
        ValueError: Output name is not expected.
        ValueError: Output data type is not expected.
    """
    is_float16 = precision == Precision.FLOAT16.value
    float_type = TensorProto.FLOAT16 if is_float16 else TensorProto.FLOAT

    input_count = len(graph.input)
    layer_count = (input_count - 2) // 4
    assert layer_count >= 1

    # Expect inputs:
    #   input_ids: int32 (B, 1)
    #   encoder_attention_mask: int32 (B, encode_sequence_length)

    #   past_key_self_0: (B, num_heads, past_decode_sequence_length, head_size)
    #   past_value_self_0: (B, num_heads, past_decode_sequence_length, head_size)
    #   ... (for each self attention layer)

    #   past_key_cross_0: (B, num_heads, encode_sequence_length, head_size)
    #   past_value_cross_0: (B, num_heads, encode_sequence_length, head_size)
    #   ... (for each cross attention layer)

    # TODO: encoder_hidden_states is optional
    expected_inputs = ["input_ids", "encoder_attention_mask"]
    for i in range(layer_count):
        expected_inputs.append(f"past_key_self_{i}")
        expected_inputs.append(f"past_value_self_{i}")
    for i in range(layer_count):
        expected_inputs.append(f"past_key_cross_{i}")
        expected_inputs.append(f"past_value_cross_{i}")

    if len(graph.input) != len(expected_inputs):
        raise ValueError(f"Number of inputs expected to be {len(expected_inputs)}. Got {len(graph.input)}")

    for i, expected_input in enumerate(expected_inputs):
        if graph.input[i].name != expected_input:
            raise ValueError(f"Input {i} is expected to be {expected_input}. Got {graph.input[i].name}")

        expected_type = TensorProto.INT32 if i < 2 else float_type
        input_type = graph.input[i].type.tensor_type.elem_type
        if input_type != expected_type:
            raise ValueError(f"Input {i} is expected to have onnx data type {expected_type}. Got {input_type}")

    # Expect outputs:
    #   logits:               (B, 1, vocab_size)
    #   present_key_self_0:   (B, num_heads, past_decode_sequence_length + 1, head_size)
    #   present_value_self_0: (B, num_heads, past_decode_sequence_length + 1, head_size)
    #                     ... (for each self attention layer)
    expected_outputs = ["logits"]
    for i in range(layer_count):
        expected_outputs.append(f"present_key_self_{i}")
        expected_outputs.append(f"present_value_self_{i}")

    if len(graph.output) != len(expected_outputs):
        raise ValueError(f"Number of outputs expected to be {len(expected_outputs)}. Got {len(graph.output)}")

    for i, expected_output in enumerate(expected_outputs):
        if graph.output[i].name != expected_output:
            raise ValueError(f"Output {i} is expected to be {expected_output}. Got {graph.output[i].name}")
        output_type = graph.output[i].type.tensor_type.elem_type
        if output_type != float_type:
            raise ValueError(f"Output {i} is expected to have onnx data type {float_type}. Got {output_type}")


def verify_t5_encoder_decoder_init_subgraph(graph: onnx.GraphProto, precision: Precision):
    """Verify T5 decoder subgraph

    Args:
        graph (onnx.GraphProto): onnx graph of T5 decoder
        precision (Precision): Precision (FLOAT16 or FLOAT32) of the model.

    Raises:
        ValueError: Number of inputs not expected.
        ValueError: Input name is not expected.
        ValueError: Input data type is not expected.
        ValueError: Number of outputs not expected.
        ValueError: Output name is not expected.
        ValueError: Output data type is not expected.
    """
    is_float16 = precision == Precision.FLOAT16.value
    new_format = "cross" in graph.output[0].name

    # Expect 3 inputs:
    #   encoder_input_ids:      int32 (B, encode_sequence_length)
    #   encoder_attention_mask: int32 (B, encode_sequence_length)
    #   decoder_input_ids:      int32 (B, 1)
    expected_inputs = [
        "encoder_input_ids",
        "encoder_attention_mask",
        "decoder_input_ids",
    ]
    if new_format:
        expected_inputs = expected_inputs[:2]
    if len(graph.input) != len(expected_inputs):
        raise ValueError(f"Number of inputs expected to be {len(expected_inputs)}. Got {len(graph.input)}")

    for i, expected_input in enumerate(expected_inputs):
        if graph.input[i].name != expected_input:
            raise ValueError(f"Input {i} is expected to be {expected_input}. Got {graph.input[i].name}")

        expected_type = TensorProto.INT32
        input_type = graph.input[i].type.tensor_type.elem_type
        if input_type != expected_type:
            raise ValueError(f"Input {i} is expected to have onnx data type {expected_type}. Got {input_type}")

    if new_format:
        assert len(graph.output) % 2 == 0
        layer_count = len(graph.output) // 2
        assert layer_count >= 1

        # Expected outputs:
        #   present_key_cross_0:   (B, num_heads, encode_sequence_length, head_size)
        #   present_value_cross_0: (B, num_heads, encode_sequence_length, head_size)
        #                      ... (for each cross attention layer)
        expected_outputs = []
        for i in range(layer_count):
            expected_outputs.append(f"present_key_cross_{i}")
            expected_outputs.append(f"present_value_cross_{i}")
    else:
        logger.warning("This format is deprecated. Please export T5 encoder in new format with only cross outputs.")
        assert (len(graph.output) - 2) % 4 == 0
        layer_count = (len(graph.output) - 2) // 4
        assert layer_count >= 1

        # Expected outputs:
        #   logits:                (B, 1, vocab_size)
        #   encoder_hidden_states: (B, encode_sequence_length, encoder_hidden_size)
        #   present_key_self_0:    (B, num_heads, 1, head_size)
        #   present_value_self_0:  (B, num_heads, 1, head_size)
        #                      ... (for each self attention layer)
        #   present_key_cross_0:   (B, num_heads, encode_sequence_length, head_size)
        #   present_value_cross_0: (B, num_heads, encode_sequence_length, head_size)
        #                      ... (for each cross attention layer)
        expected_outputs = ["logits", "encoder_hidden_states"]
        for i in range(layer_count):
            expected_outputs.append(f"present_key_self_{i}")
            expected_outputs.append(f"present_value_self_{i}")
        for i in range(layer_count):
            expected_outputs.append(f"present_key_cross_{i}")
            expected_outputs.append(f"present_value_cross_{i}")

    if len(graph.output) != len(expected_outputs):
        raise ValueError(f"Number of outputs expected to be {len(expected_outputs)}. Got {len(graph.output)}")

    for i, expected_output in enumerate(expected_outputs):
        if graph.output[i].name != expected_output:
            raise ValueError(f"Output {i} is expected to be {expected_output}. Got {graph.output[i].name}")

        expected_type = TensorProto.FLOAT16 if is_float16 else TensorProto.FLOAT
        output_type = graph.output[i].type.tensor_type.elem_type
        if output_type != expected_type:
            raise ValueError(f"Output {i} is expected to have onnx data type {expected_type}. Got {output_type}")

    logger.info("T5 encoder graph verified: name and data type of inputs and outputs are good.")


def remove_shared_initializers(
    graph1: GraphProto,
    graph2: GraphProto,
    shared_prefix: str = "shared_",
    min_elements: int = 1024,
    signature_cache1: dict | None = None,
    signature_cache2: dict | None = None,
):
    """Remove initializers with same value from two graphs.

    Args:
        graph1 (GraphProto): the first graph to process
        graph2 (GraphProto): the second graph to process
        shared_prefix (str): add prefix to the shared initializers among two graphs
        min_elements (int, optional): minimal number of elements for initializers to be considered. Defaults to 1024.
        signature_cache1 (dict): Optional dictionary to store data signatures of tensors in graph1 in order to speed up comparison
        signature_cache2 (dict): Optional dictionary to store data signatures of tensors in graph2 in order to speed up comparison
    """

    mapping_initializers_1 = {}
    mapping_initializers_2 = {}
    shared_initializers_1 = []
    shared_initializers_2 = []
    shared_initializers_names = []

    for initializer1 in graph1.initializer:
        if not (initializer1.dims and sum(initializer1.dims) >= min_elements):
            continue

        for initializer2 in graph2.initializer:
            if not (initializer2.dims and sum(initializer2.dims) >= min_elements):
                continue

            if OnnxModel.has_same_value(initializer1, initializer2, signature_cache1, signature_cache2):
                mapping_initializers_1[initializer1.name] = shared_prefix + initializer2.name
                shared_initializers_1.append(initializer1)

                if initializer2.name not in mapping_initializers_2:
                    shared_name = shared_prefix + initializer2.name
                    mapping_initializers_2[initializer2.name] = shared_name
                    shared_initializers_2.append(initializer2)
                    shared_initializers_names.append(shared_name)
                break

    logger.debug(f"shared initializers:{shared_initializers_names}")

    # Make sure new name does not exist in graph 1
    for node in graph1.node:
        for j in range(len(node.input)):
            if node.input[j] in shared_initializers_names:
                raise RuntimeError(f"name is found in graph 1: {node.input[j]}")

    # Make sure new name does not exist in graph 2
    for node in graph2.node:
        for j in range(len(node.input)):
            if node.input[j] in shared_initializers_names:
                raise RuntimeError(f"name is found in graph 2: {node.input[j]}")

    # Remove shared initializers from graph 2
    for initializer in shared_initializers_2:
        graph2.initializer.remove(initializer)

    # Rename value info for old names in graph 2
    for value_info in graph2.value_info:
        if value_info.name in mapping_initializers_2:
            value_info.name = mapping_initializers_2[value_info.name]

    # Rename nodes inputs in graph 2:
    for node in graph2.node:
        for j in range(len(node.input)):
            if node.input[j] in mapping_initializers_2:
                new_name = mapping_initializers_2[node.input[j]]
                logger.debug(f"graph 2 rename node {node.name} input {j} from {node.input[j]} to {new_name}")
                node.input[j] = new_name

    #  Remove shared initializers from graph 1
    for initializer in shared_initializers_1:
        graph1.initializer.remove(initializer)

    # Rename value info for old names in graph 1
    for value_info in graph1.value_info:
        if value_info.name in mapping_initializers_1:
            value_info.name = mapping_initializers_1[value_info.name]

    # Rename nodes inputs in graph 1:
    for node in graph1.node:
        for j in range(len(node.input)):
            if node.input[j] in mapping_initializers_1:
                new_name = mapping_initializers_1[node.input[j]]
                logger.debug(f"graph 1 rename node {node.name} input {j} from {node.input[j]} to {new_name}")
                node.input[j] = new_name

    # Rename shared initializers in graph 2
    for initializer in shared_initializers_2:
        initializer.name = mapping_initializers_2[initializer.name]

    for initializer in shared_initializers_2:
        shape = onnx.numpy_helper.to_array(initializer).shape
        value_info = onnx.helper.make_tensor_value_info(initializer.name, initializer.data_type, shape)
        # Need add value_info for initializers moved to parent graph. Otherwise, ORT will fail.
        graph1.value_info.append(value_info)
        graph2.value_info.append(value_info)

    return shared_initializers_2


def get_shared_initializers(encoder_model: ModelProto, decoder_model: ModelProto):
    encoder = OnnxModel(encoder_model)
    decoder = OnnxModel(decoder_model)
    encoder.add_prefix_to_names("e_")
    decoder.add_prefix_to_names("d_")
    signature_cache1, signature_cache2 = {}, {}
    encoder.remove_duplicated_initializer(signature_cache1)
    decoder.remove_duplicated_initializer(signature_cache2)
    initializers = remove_shared_initializers(
        decoder.model.graph,
        encoder.model.graph,
        shared_prefix="s_",
        signature_cache1=signature_cache1,
        signature_cache2=signature_cache2,
    )
    return initializers


def move_initializers(
    graph: GraphProto,
    min_elements: int = 1024,
) -> list[TensorProto]:
    """Remove initializers of a graph, when they have number of elements larger than a threshold.

    Args:
        graph (GraphProto): the graph.
        min_elements (int, optional): minimal number of elements for initializers to be considered. Defaults to 1024.

    Returns:
        List[TensorProto]: initializers that are removed from the graph.
    """
    moved_initializers = []
    for tensor in graph.initializer:
        if not (tensor.dims and sum(tensor.dims) >= min_elements):
            continue
        moved_initializers.append(tensor)

    for initializer in moved_initializers:
        graph.initializer.remove(initializer)

    # Add type info, otherwise ORT will raise error: "input arg (*) does not have type information set by parent node."
    for initializer in moved_initializers:
        shape = onnx.numpy_helper.to_array(initializer).shape
        value_info = onnx.helper.make_tensor_value_info(initializer.name, initializer.data_type, shape)
        graph.value_info.append(value_info)

    return moved_initializers


def _attribute_to_pair(attribute):
    """
    Convert attribute to kwarg format for use with onnx.helper.make_node.
        :parameter attribute: attribute in AttributeProto format.
        :return: attribute in {key: value} format.
    """
    if attribute.type == 0:
        raise ValueError(f"attribute {attribute.name} does not have type specified.")

    # Based on attribute type definitions from AttributeProto
    # definition in https://github.com/onnx/onnx/blob/master/onnx/onnx.proto
    if attribute.type == 1:
        value = attribute.f
    elif attribute.type == 2:
        value = attribute.i
    elif attribute.type == 3:
        value = attribute.s
    elif attribute.type == 4:
        value = attribute.t
    elif attribute.type == 5:
        value = attribute.g
    elif attribute.type == 6:
        value = attribute.floats
    elif attribute.type == 7:
        value = attribute.ints
    elif attribute.type == 8:
        value = attribute.strings
    elif attribute.type == 9:
        value = attribute.tensors
    elif attribute.type == 10:
        value = attribute.graphs
    else:
        raise ValueError(f"attribute {attribute.name} has unsupported type {attribute.type}.")

    return (attribute.name, value)


def kwargs_of(node):
    kwargs = {}
    for attr in node.attribute:
        (key, value) = _attribute_to_pair(attr)
        kwargs.update({key: value})
    if node.domain:
        kwargs.update({"domain": node.domain})
    return kwargs


def shape_of(vi):
    return tuple([d.dim_param if (d.dim_param) else d.dim_value for d in vi.type.tensor_type.shape.dim])


def update_decoder_subgraph_past_present_share_buffer(subg: GraphProto):
    input_past_0 = 3
    output_past_0 = 1
    new_inputs = []
    for i, vi in enumerate(subg.input):
        if i >= input_past_0:
            shape = shape_of(vi)
            vi = onnx.helper.make_tensor_value_info(  # noqa: PLW2901
                vi.name,
                elem_type=vi.type.tensor_type.elem_type,
                shape=[shape[0], shape[1], shape[2], "max_seq_len", shape[4]],
            )
        new_inputs.extend([vi])
    new_inputs.extend([onnx.helper.make_tensor_value_info("past_sequence_length", onnx.TensorProto.INT32, shape=[1])])
    subg.ClearField("input")
    subg.input.extend(new_inputs)

    new_outputs = []
    for i, vi in enumerate(subg.output):
        if i >= output_past_0:
            shape = shape_of(vi)
            vi = onnx.helper.make_tensor_value_info(  # noqa: PLW2901
                vi.name,
                elem_type=vi.type.tensor_type.elem_type,
                shape=[shape[0], shape[1], shape[2], "max_seq_len", shape[4]],
            )
        new_outputs.extend([vi])
    subg.ClearField("output")
    subg.output.extend(new_outputs)

    new_nodes = []
    for node in subg.node:
        new_node = node
        if node.op_type == "Attention":
            kwargs = kwargs_of(node)
            kwargs.update({"past_present_share_buffer": 1})
            nis = []
            nis.extend(node.input)
            while len(nis) < 6:
                nis.extend([""])
            if len(nis) < 7:
                nis.extend(["past_sequence_length"])
            new_node = onnx.helper.make_node("Attention", nis, node.output, name=node.name, **kwargs)
        new_nodes.extend([new_node])
    subg.ClearField("node")
    subg.node.extend(new_nodes)
    return subg


def update_decoder_subgraph_use_decoder_masked_attention(
    subg: GraphProto, is_beam_search: bool, switch_attention: bool
) -> bool:
    """Update the Attention nodes to DecoderMaskedSelfAttention.

    Args:
        subg (GraphProto): GraphProto of the decoder subgraph
        is_beam_search (bool): Boolean specifying if the sampling algo is BeamSearch
        switch_attention (bool): Boolean specifying if `Attention` is to be switched with `DecoderMaskedSelfAttention`
    """
    if is_beam_search:
        new_inputs = []
        for _i, vi in enumerate(subg.input):
            new_inputs.extend([vi])

        # Add 2 BeamSearch specific inputs
        new_inputs.extend([onnx.helper.make_tensor_value_info("beam_width", onnx.TensorProto.INT32, shape=[1])])
        new_inputs.extend(
            [
                onnx.helper.make_tensor_value_info(
                    "cache_indirection",
                    onnx.TensorProto.INT32,
                    shape=["batch_size", "beam_width", "max_seq_len"],
                )
            ]
        )
        subg.ClearField("input")
        subg.input.extend(new_inputs)

    if switch_attention:
        decoder_masked_attention_supported_attr = [
            "past_present_share_buffer",
            "num_heads",
            "scale",
            "mask_filter_value",
            "domain",
        ]

        new_nodes = []
        for node in subg.node:
            if node.op_type == "Attention":
                kwargs = kwargs_of(node)
                for k in kwargs.copy():
                    # The Attention operator does not support different qkv hidden sizes when past/present
                    # input/output exists (GPT2 model). Hence, we should never run into this.
                    # But, if we do, do not go ahead with the optimization.
                    if k == "qkv_hidden_sizes":
                        return False

                    if k not in decoder_masked_attention_supported_attr:
                        # Log the fact that we are removing certain attributes from the node
                        # We don't need to log it for "unidirectional" as we are aware that
                        # decoding attention kernels are unidirectional by definition.
                        if k != "unidirectional":
                            logger.warning(
                                f"Removing attribute: {k} from Attention node while switching to DecoderMaskedSelfAttention"
                            )

                        del kwargs[k]

                nis = []
                nis.extend(node.input)

                # Add 2 BeamSearch specific inputs
                if is_beam_search:
                    while len(nis) < 7:
                        nis.extend([""])
                    if len(nis) < 8:
                        nis.extend(["beam_width"])
                    if len(nis) < 9:
                        nis.extend(["cache_indirection"])

                node = onnx.helper.make_node(  # noqa: PLW2901
                    "DecoderMaskedSelfAttention",
                    nis,
                    node.output,
                    name=node.name,
                    **kwargs,
                )
            new_nodes.extend([node])
        subg.ClearField("node")
        subg.node.extend(new_nodes)

    return True


def find_past_seq_len_usage(subg: GraphProto):
    """Correct graph which originally use dim of past_seq_len from input_ids's shape which is fixed to max_seq_len after
       shared past/present buffer

    Args:
        subg (GraphProto): GraphProto of the decoder subgraph
    return:
        tensor_names_to_rename : set of tensor names which is equal to past_sequence_length
        nodes_to_remove : list of node to remove
    """
    tensor_names_to_rename = set()
    nodes_to_remove = []

    graph_input_names = {inp.name: index for index, inp in enumerate(subg.input)}

    input_name_to_nodes = {}
    output_name_to_node = {}
    for node in subg.node:
        for input_name in node.input:
            if input_name:
                if input_name not in input_name_to_nodes:
                    input_name_to_nodes[input_name] = [node]
                else:
                    input_name_to_nodes[input_name].append(node)
        for output_name in node.output:
            if output_name:
                output_name_to_node[output_name] = node

    for node in subg.node:
        # find "past_key_self_0 --> [Transpose(past_key_self_0) --> Reshape(past_key_self_0)] --> Shape(past_key_self_0) --> Gather(*, 2)"
        # where [Transpose(past_key_self_0) --> Reshape(past_key_self_0)] may or may not exist
        if node.op_type == "Gather":
            if not node.input[1] or not node.input[0]:
                continue

            # Find Gather node's index value
            shape_tensor_name, shape_index_name = (node.input[0], node.input[1])
            ini_gather_indices = None
            if "Constant_" in shape_index_name:
                # If shape_index_name refers to a Constant node
                for const_node in subg.node:
                    if const_node.op_type == "Constant" and const_node.output[0] == shape_index_name:
                        ini_gather_indices = const_node.attribute[0].t
                        break
            else:
                # If shape_index_name refers to an initializer
                for tensor in subg.initializer:
                    if tensor.name == shape_index_name:
                        ini_gather_indices = tensor
                        break
            if ini_gather_indices is None:
                continue
            gather_indices_arr = onnx.numpy_helper.to_array(ini_gather_indices)

            if (
                gather_indices_arr.size == 1
                and gather_indices_arr.item() in {1, 2}
                and node.input[0] in output_name_to_node
            ):
                shape_node = output_name_to_node[shape_tensor_name]
                if not (shape_node.op_type == "Shape" and shape_node.input[0]):
                    continue

                if (
                    shape_node.input[0] in graph_input_names
                    and (
                        shape_node.input[0].startswith("past_key_self_")
                        or shape_node.input[0].startswith("past_value_self_")
                    )
                    and gather_indices_arr.item() == 2
                ):
                    # "past_key_self_0 --> Shape(past_key_self_0) --> Gather(*, 2)"
                    tensor_names_to_rename.add(node.output[0])
                    nodes_to_remove.append(node)
                    if len(input_name_to_nodes[shape_node.output[0]]) == 1:
                        nodes_to_remove.append(shape_node)
                        continue

                if shape_node.input[0] not in output_name_to_node:
                    continue
                reshape_node = output_name_to_node[shape_node.input[0]]
                if not (reshape_node.op_type == "Reshape" and reshape_node.input[0]):
                    continue
                transpose_node = output_name_to_node[reshape_node.input[0]]
                if not (transpose_node.op_type == "Transpose" and transpose_node.input[0]):
                    continue

                if (
                    transpose_node.input[0] in graph_input_names
                    and (
                        transpose_node.input[0].startswith("past_key_self_")
                        or transpose_node.input[0].startswith("past_value_self_")
                    )
                    and gather_indices_arr.item() == 1
                ):
                    # "past_key_self_0 --> Transpose(past_key_self_0) --> Reshape(past_key_self_0) --> Shape(past_key_self_0) --> Gather(*, 2)"
                    tensor_names_to_rename.add(node.output[0])
                    nodes_to_remove.extend([node, shape_node, reshape_node])
                    if len(input_name_to_nodes[transpose_node.output[0]]) == 1:
                        nodes_to_remove.append(transpose_node)
                        continue

    return tensor_names_to_rename, nodes_to_remove


def add_cache_indirection_to_mha(model: OnnxModel, past_seq_len_name: str):
    # Add past_sequence_length and cache_indirection as inputs to all MultiHeadAttention ops and as inputs to model
    cache_indirection_name = "cache_indirection"
    mha_nodes = list(filter(lambda node: node.op_type == "MultiHeadAttention", model.model.graph.node))
    for node in mha_nodes:
        # MHA op takes the following potential inputs:
        # query, key, value, bias, key_padding_mask, add_qk, past_key, past_value
        while len(node.input) < 8:
            node.input.append("")
        node.input.append(past_seq_len_name)
        node.input.append(cache_indirection_name)

    model.model.graph.input.append(
        onnx.helper.make_tensor_value_info(
            cache_indirection_name, TensorProto.INT32, shape=["batch_size", "beam_width", "max_sequence_length"]
        ),
    )
    model.topological_sort()
    return model


def add_output_qk_to_mha(model: OnnxModel, dtype: int = 0, skip_node_idxs: list[int] = []):  # noqa: B006
    # Add output_qk as output to MultiHeadAttention ops and as outputs to model
    output_qk_basename = "output_cross_qk"
    output_qks = []
    mha_nodes = list(filter(lambda node: node.op_type == "MultiHeadAttention", model.model.graph.node))
    for idx, node in enumerate(mha_nodes):
        # Skip MHA nodes where output_qk does not need to be added
        if idx in skip_node_idxs:
            continue

        # Get `num_heads` attribute from MHA
        num_heads = 0
        for att in node.attribute:
            if att.name == "num_heads":
                num_heads = att.i
                break

        # Get dtype for `output_qk` based on MHA bias if not provided
        output_qk_dtype = dtype
        if output_qk_dtype == 0:
            for i in model.model.graph.initializer:
                if i.name == node.input[3]:
                    output_qk_dtype = i.data_type
                    break

        # Get `target_sequence_length` attribute from 4D input for key if it's a constant
        target_sequence_length = "target_sequence_length"
        for i in model.model.graph.input:
            if i.name == node.input[1]:
                target_sequence_length = i.type.tensor_type.shape.dim[2].dim_value
                break

        # MHA op takes the following potential outputs:
        # output, present_key, present_value
        while len(node.output) < 3:
            node.output.append("")

        output_qk_name = f"{output_qk_basename}_{idx // 2}"
        node.output.append(output_qk_name)
        output_qks.append(
            onnx.helper.make_tensor_value_info(
                output_qk_name,
                output_qk_dtype,
                shape=["batch_size", num_heads, "sequence_length", target_sequence_length],
            ),
        )

    model.model.graph.output.extend(output_qks)
    model.topological_sort()
    return model


def fix_past_sequence_length(model: OnnxModel):
    # Modify total_sequence_length = past_sequence_length + curr_sequence_length subgraph to calculate
    # past_sequence_length from the new `past_sequence_length` input of size 1D and type int32 instead of
    # from `past_key_self_0` since DecoderMaskedMultiHeadAttention (DMMHA) uses buffer sharing and
    # `past_key_self_0.shape[2] = max_sequence_length` instead of `past_key_self_0.shape[2] = past_sequence_length`
    # when buffer sharing is enabled
    #
    # Before:
    #
    #   input_ids      past_key_self_0
    #       |                 |
    #     Shape             Shape
    #       |                 |
    #     Gather            Gather
    #     (idx=1)           (idx=2)
    #       |                 |    \
    #       +--------+--------+    Unsqueeze
    #                |
    #               Add
    #
    # After:
    #
    #   input_ids    past_sequence_length (1D)
    #       |                 |
    #     Shape            Squeeze
    #       |                 |
    #     Gather             Cast
    #     (idx=1)           (int64)
    #       |                 |    \
    #       +--------+--------+    Unsqueeze
    #                |
    #               Add

    # Constant names to be used
    past_seq_len_name = "past_sequence_length"
    past_seq_len_int32 = "past_seq_len_int32"
    past_seq_len_int64 = "past_seq_len_int64"

    node = list(filter(lambda n: n.op_type == "LayerNormalization", model.model.graph.node))[0]  # noqa: RUF015

    base_path_hf = model.match_parent_path(
        node,
        ["Add", "Gather", "Tile", "Expand", "Unsqueeze", "Range"],
        [0, 1, 1, 0, 0, 0],
    )
    base_path_oai = model.match_parent_path(
        node,
        ["Add", "Slice"],
        [0, 1],
    )
    if base_path_hf is not None:
        base_path = base_path_hf
    elif base_path_oai is not None:
        base_path = base_path_oai
    else:
        logger.info("Cannot identify base path for fixing past_sequence_length subgraph")
        return
    base_node = base_path[-1]

    if base_node.op_type == "Range":
        # Hugging Face implementation
        range_node = base_path[-1]

        gather_path = model.match_parent_path(
            range_node,
            ["Gather", "Shape"],
            [0, 0],
        )
        if gather_path is None:
            logger.info("Cannot identify gather path for fixing past_sequence_length subgraph")
            return

        add_path = model.match_parent_path(
            range_node,
            ["Add", "Gather", "Shape"],
            [1, 0, 0],
        )
        if add_path is None:
            logger.info("Cannot identify add path for fixing past_sequence_length subgraph")
            return
        add_node = add_path[0]

        if gather_path != add_path[1:]:
            logger.info("Gather path and add path do not share the same nodes for calculating the past_sequence_length")
            return

        # Remove `past_key_self_0 --> Shape --> Gather` connection
        constant_in_gather = list(filter(lambda n: n.output[0] == gather_path[0].input[1], model.model.graph.node))[0]  # noqa: RUF015
        model.model.graph.node.remove(constant_in_gather)
        model.model.graph.node.remove(gather_path[0])
        model.model.graph.node.remove(gather_path[1])

        # Add `past_seq_len_int64` as an input name to existing nodes
        range_node.input[0] = past_seq_len_int64
        add_node.input[0] = past_seq_len_int64

    else:
        # OpenAI implementation
        input_ids_path = model.match_parent_path(
            base_node,
            ["Unsqueeze", "Add", "Gather", "Shape", "Reshape", "Transpose"],
            [2, 0, 0, 0, 0, 0],
        )
        if input_ids_path is None:
            logger.info("Cannot identify input_ids path for fixing past_sequence_length subgraph")
            return
        add_node = input_ids_path[1]

        past_key_path = model.match_parent_path(
            base_node,
            ["Unsqueeze", "Gather", "Shape", "Reshape", "Transpose"],
            [1, 0, 0, 0, 0],
        )
        if past_key_path is None:
            logger.info("Cannot identify past_key path for fixing past_sequence_length subgraph")
            return
        unsqueeze_node = past_key_path[0]

        if input_ids_path[2:] != past_key_path[1:]:
            logger.info(
                "The input_ids path and past_key path do not share the same nodes for calculating the past_sequence_length"
            )
            return

        # Remove `past_key_self_0 --> Transpose --> Reshape --> Shape --> Gather` connection
        constant_in_gather = list(filter(lambda n: n.output[0] == past_key_path[1].input[1], model.model.graph.node))[0]  # noqa: RUF015
        model.model.graph.node.remove(constant_in_gather)
        constant_in_reshape = list(filter(lambda n: n.output[0] == past_key_path[-2].input[1], model.model.graph.node))[  # noqa: RUF015
            0
        ]
        model.model.graph.node.remove(constant_in_reshape)
        model.model.graph.node.remove(past_key_path[1])
        model.model.graph.node.remove(past_key_path[2])
        model.model.graph.node.remove(past_key_path[3])
        model.model.graph.node.remove(past_key_path[4])

        # Add `past_seq_len_int64` as an input name to existing nodes
        unsqueeze_node.input[0] = past_seq_len_int64
        add_node.input[0] = past_seq_len_int64

    # Add `past_sequence_length` as model input
    model.model.graph.input.append(
        onnx.helper.make_tensor_value_info(past_seq_len_name, TensorProto.INT32, shape=[1]),
    )

    # Add `past_sequence_length --> Squeeze --> Cast` connection
    squeeze_node = onnx.helper.make_node(
        "Squeeze",
        inputs=[past_seq_len_name],
        outputs=[past_seq_len_int32],
        name=model.create_node_name("Squeeze"),
    )
    squeeze_output = onnx.helper.make_tensor_value_info(past_seq_len_int32, TensorProto.INT32, shape=[])
    cast_node = onnx.helper.make_node(
        "Cast",
        inputs=[past_seq_len_int32],
        outputs=[past_seq_len_int64],
        name=model.create_node_name("Cast"),
        to=TensorProto.INT64,
    )
    cast_output = onnx.helper.make_tensor_value_info(past_seq_len_int64, TensorProto.INT64, shape=[])

    # Add new nodes to graph
    model.model.graph.node.extend([squeeze_node, cast_node])
    model.model.graph.value_info.extend([squeeze_output, cast_output])
    model.topological_sort()
    return model, past_seq_len_name


def replace_mha_with_dmmha(model: OnnxModel, past_seq_len_name: str):
    # Add `beam_width` and `cache_indirection` as model inputs
    beam_width = "beam_width"
    cache_indirection = "cache_indirection"

    model.model.graph.input.extend(
        [
            onnx.helper.make_tensor_value_info(beam_width, TensorProto.INT32, shape=[1]),
            onnx.helper.make_tensor_value_info(
                cache_indirection, TensorProto.INT32, shape=["batch_size", "beam_width", "max_sequence_length"]
            ),
        ]
    )

    # Replace all `MultiHeadAttention` nodes with `DecoderMaskedMultiHeadAttention` nodes
    mha_nodes = list(filter(lambda node: node.op_type == "MultiHeadAttention", model.model.graph.node))
    for idx, node in enumerate(mha_nodes):
        # Get `num_heads` attribute from MHA
        num_heads = 0
        for att in node.attribute:
            if att.name == "num_heads":
                num_heads = att.i
                break

        # Make Q*K outputs for cross-attention layers, which happen every alternative layer
        qk_output_name = f"output_cross_qk_{idx // 2}"
        qk_output = onnx.helper.make_tensor_value_info(
            qk_output_name, TensorProto.FLOAT, shape=["batch_size", num_heads, 1, "encode_sequence_length / 2"]
        )
        if idx % 2 == 1:
            model.model.graph.output.append(qk_output)

        # Make DMMHA node
        dmmha_node = onnx.helper.make_node(
            "DecoderMaskedMultiHeadAttention",
            inputs=[
                node.input[0],  # query
                node.input[1],  # key
                node.input[2],  # value
                "",  # mask_index
                "",  # relative_position_bias
                node.input[6] if len(node.input) > 4 else "",  # past_key
                node.input[7] if len(node.input) > 4 else "",  # past_value
                past_seq_len_name,  # past_sequence_length
                beam_width,  # beam_width
                cache_indirection,  # cache_indirection
                node.input[3],  # bias
            ],
            outputs=[
                node.output[0],  # output
                node.output[1] if len(node.input) > 4 else "",  # present_key
                node.output[2] if len(node.input) > 4 else "",  # present_value
                qk_output_name if idx % 2 == 1 else "",  # output_cross_qk
            ],
            name=node.name.replace("MultiHeadAttention", "DecoderMaskedMultiHeadAttention"),
            domain="com.microsoft",
            num_heads=num_heads,
            output_qk=(idx % 2),
            past_present_share_buffer=1,
        )
        if idx % 2 == 0:
            # Remove empty string for output_cross_qk, which happens every alternative layer
            dmmha_node.output.remove("")

        model.model.graph.node.remove(node)
        model.model.graph.node.extend([dmmha_node])

    model.topological_sort()
    return model


def replace_mha_with_gqa(
    model: OnnxModel,
    attn_mask: str,
    kv_num_heads: int = 0,
    world_size: int = 1,
    window_size: int = -1,
):
    # Insert attention_mask subgraph to calculate shared inputs for all GroupQueryAttention nodes
    #
    #                attention_mask
    #               /              \
    #          ReduceSum          Shape
    #              |                |
    #             Sub             Gather
    #              |                |
    #          seqlens_k   total_sequence_length
    #              |                |
    #        Cast to int32    Cast to int32

    model.add_initializer(
        onnx.helper.make_tensor(
            name="one",
            data_type=TensorProto.INT64,
            dims=[1],
            vals=[1],
        )
    )
    reduce_sum_node = onnx.helper.make_node(
        "ReduceSum",
        inputs=[attn_mask, "one"],
        outputs=[attn_mask + "_row_sums"],
        name=model.create_node_name("ReduceSum"),
    )
    sub_node = onnx.helper.make_node(
        "Sub",
        inputs=[attn_mask + "_row_sums", "one"],
        outputs=["seqlens_k_int64"],
        name=model.create_node_name("Sub"),
    )
    seqlen_k_cast_node = onnx.helper.make_node(
        "Cast",
        inputs=["seqlens_k_int64"],
        outputs=["seqlens_k"],
        name=model.create_node_name("Cast"),
        to=TensorProto.INT32,
    )
    shape_node = onnx.helper.make_node(
        "Shape",
        inputs=[attn_mask],
        outputs=[attn_mask + "_shape"],
        name=model.create_node_name("Shape"),
    )
    gather_node = onnx.helper.make_node(
        "Gather",
        inputs=[attn_mask + "_shape", "one"],
        outputs=["total_seq_len_int64"],
        name=model.create_node_name("Gather"),
        axis=0,
    )
    total_seqlen_cast_node = onnx.helper.make_node(
        "Cast",
        inputs=["total_seq_len_int64"],
        outputs=["total_seq_len"],
        name=model.create_node_name("Cast"),
        to=TensorProto.INT32,
    )
    model.model.graph.node.extend(
        [
            reduce_sum_node,
            sub_node,
            seqlen_k_cast_node,
            shape_node,
            gather_node,
            total_seqlen_cast_node,
        ]
    )

    # Replace MultiHeadAttention with GroupQueryAttention
    #
    # When replacing, fuse the following subgraph:
    #
    #                 root_input
    #               /     |      \
    #         MatMul    MatMul    MatMul
    #           |         |         |
    #          Add       Add       Add      (optional Adds)
    #           |         |         |
    #         RotEmb    RotEmb      |
    #            \        |        /
    #             MultiHeadAttention
    #
    # to this new subgraph:
    #
    #                 root_input
    #                     |
    #                PackedMatMul           (if possible)
    #                     |
    #                 PackedAdd             (if possible)
    #                     |
    #             GroupQueryAttention
    #

    mha_nodes = list(filter(lambda node: node.op_type == "MultiHeadAttention", model.model.graph.node))
    for idx, node in enumerate(mha_nodes):
        # Detect Q path to MHA
        q_path_1 = model.match_parent_path(node, ["RotaryEmbedding", "Add", "MatMul"], [0, 0, 0])
        q_path_2 = model.match_parent_path(node, ["RotaryEmbedding", "MatMul"], [0, 0])

        q_rotary, q_add, q_matmul = None, None, None
        if q_path_1 is not None:
            q_rotary, q_add, q_matmul = q_path_1
        elif q_path_2 is not None:
            q_rotary, q_matmul = q_path_2

        # Detect K path to MHA
        k_path_1 = model.match_parent_path(node, ["RotaryEmbedding", "Add", "MatMul"], [1, 0, 0])
        k_path_2 = model.match_parent_path(node, ["RotaryEmbedding", "MatMul"], [1, 0])

        k_rotary, k_add, k_matmul = None, None, None
        if k_path_1 is not None:
            k_rotary, k_add, k_matmul = k_path_1
        elif k_path_2 is not None:
            k_rotary, k_matmul = k_path_2

        # Detect V path to MHA
        v_path_1 = model.match_parent_path(node, ["Add", "MatMul"], [2, 0])
        v_path_2 = model.match_parent_path(node, ["MatMul"], [2])

        v_add, v_matmul = None, None
        if v_path_1 is not None:
            v_add, v_matmul = v_path_1
        elif v_path_2 is not None:
            v_matmul = v_path_2[0]

        # Get `interleaved` attribute from RotaryEmbedding
        interleaved = 0
        if q_rotary is not None and k_rotary is not None:
            for att in q_rotary.attribute:
                if att.name == "interleaved":
                    interleaved = att.i

        # Get `num_heads` attribute from MHA
        num_heads = 0
        for att in node.attribute:
            if att.name == "num_heads":
                num_heads = att.i

        # Check if root_input to Q/K/V paths is the same
        root_input_is_same = q_matmul.input[0] == k_matmul.input[0] and k_matmul.input[0] == v_matmul.input[0]

        # Check if Q/K/V paths all have bias or all don't have bias
        all_paths_have_bias = q_add is not None and k_add is not None and v_add is not None
        all_paths_have_no_bias = q_add is None and k_add is None and v_add is None

        # Make PackedMatMul node if possible
        q_input_to_attention, k_input_to_attention, v_input_to_attention = "", "", ""
        if root_input_is_same and (all_paths_have_bias or all_paths_have_no_bias):
            qw = NumpyHelper.to_array(model.get_initializer(q_matmul.input[1]))
            kw = NumpyHelper.to_array(model.get_initializer(k_matmul.input[1]))
            vw = NumpyHelper.to_array(model.get_initializer(v_matmul.input[1]))

            dim = qw.shape[-1]
            qkv_weight = np.stack((qw, kw, vw), axis=1).reshape(dim, 3 * dim)
            qkv_weight = onnx.numpy_helper.from_array(qkv_weight, name=f"QKV_Weight_{idx}")
            model.add_initializer(qkv_weight)

            packed_matmul_node = onnx.helper.make_node(
                "MatMul",
                inputs=[q_matmul.input[0], qkv_weight.name],
                outputs=[f"{qkv_weight.name}_output"],
                name=model.create_node_name("MatMul"),
            )
            model.model.graph.node.extend([packed_matmul_node])
            model.model.graph.node.remove(q_matmul)
            model.model.graph.node.remove(k_matmul)
            model.model.graph.node.remove(v_matmul)
            q_input_to_attention = packed_matmul_node.output[0]

            # Make PackedAdd node if possible
            if all_paths_have_bias:
                qb = NumpyHelper.to_array(model.get_initializer(q_add.input[1]))
                kb = NumpyHelper.to_array(model.get_initializer(k_add.input[1]))
                vb = NumpyHelper.to_array(model.get_initializer(v_add.input[1]))

                dim = qb.shape[-1]
                qkv_bias = np.stack((qb, kb, vb), axis=0).reshape(3 * dim)
                qkv_bias = onnx.numpy_helper.from_array(qkv_bias, name=f"QKV_Bias_{idx}")
                model.add_initializer(qkv_bias)
                packed_add_node = onnx.helper.make_node(
                    "Add",
                    inputs=[packed_matmul_node.output[0], qkv_bias.name],
                    outputs=[f"{qkv_bias.name}_output"],
                )
                model.model.graph.node.extend([packed_add_node])
                model.model.graph.node.remove(q_add)
                model.model.graph.node.remove(k_add)
                model.model.graph.node.remove(v_add)
                q_input_to_attention = packed_add_node.output[0]

        else:
            q_input_to_attention = q_matmul.output[0]
            k_input_to_attention = k_matmul.output[0]
            v_input_to_attention = v_matmul.output[0]

        # Make GQA node
        gqa_node = onnx.helper.make_node(
            "GroupQueryAttention",
            inputs=[
                q_input_to_attention,  # query
                k_input_to_attention,  # key
                v_input_to_attention,  # value
                node.input[6],  # past_key
                node.input[7],  # past_value
                seqlen_k_cast_node.output[0],  # seqlens_k (for attention mask)
                total_seqlen_cast_node.output[0],  # total_seq_len (for attention mask)
                (q_rotary.input[2] if q_rotary is not None else ""),  # cos_cache (for rotary embeddings)
                (q_rotary.input[3] if q_rotary is not None else ""),  # sin_cache (for rotary embeddings)
            ],
            outputs=node.output,
            name=node.name.replace("MultiHeadAttention", "GroupQueryAttention"),
            domain="com.microsoft",
            num_heads=num_heads // world_size,
            kv_num_heads=(num_heads // world_size if kv_num_heads == 0 else kv_num_heads // world_size),
            local_window_size=window_size,
            do_rotary=int(q_rotary is not None and k_rotary is not None),
            rotary_interleaved=interleaved,
        )
        model.model.graph.node.remove(node)
        model.model.graph.node.extend([gqa_node])

        if q_rotary is not None:
            model.model.graph.node.remove(q_rotary)
        if k_rotary is not None:
            model.model.graph.node.remove(k_rotary)

    return model


def update_decoder_subgraph_output_cross_attention(subg: GraphProto):
    input_self_past_0 = 1
    # w/wo attention mask, w/wo hidden_state
    graph_input_names = [gi.name for gi in subg.input]
    while input_self_past_0 < 3 and not graph_input_names[input_self_past_0].startswith("past"):
        input_self_past_0 += 1
    output_self_present_0 = 1

    num_layers = (len(subg.output) - output_self_present_0) // 2
    input_cross_past_0 = 2 * num_layers + input_self_past_0
    past_key_cross_inputs = {subg.input[layer * 2 + input_cross_past_0].name: layer for layer in range(num_layers)}
    print(f"    -- past_key_cross_inputs = {past_key_cross_inputs}")

    input_past_key_cross_0_shape = shape_of(subg.input[input_cross_past_0])
    print(f"past_key_cross_0_shape is {input_past_key_cross_0_shape}")
    batch_size_dim = input_past_key_cross_0_shape[0]
    num_heads_dim = input_past_key_cross_0_shape[1]
    cross_seq_len_dim = input_past_key_cross_0_shape[2]

    num_layer_output_qk = 0
    for node in subg.node:
        if (node.op_type == "DecoderMaskedMultiHeadAttention") and (node.input[1] in past_key_cross_inputs):
            print(f"    -- add cross QK output from: node: {node.name} with output: {node.output}")
            num_layer_output_qk += 1
            layer = past_key_cross_inputs[node.input[1]]
            cross_attention_out_name = f"output_cross_qk_{layer}"
            appended_names = [""] * (3 - len(node.output))
            appended_names.append(cross_attention_out_name)
            node.output.extend(appended_names)
            node.attribute.extend([onnx.helper.make_attribute("output_qk", 1)])

            cross_attention = onnx.helper.make_tensor_value_info(
                cross_attention_out_name,
                TensorProto.FLOAT,
                [batch_size_dim, num_heads_dim, 1, cross_seq_len_dim],
            )
            subg.output.extend([cross_attention])
    if num_layer_output_qk != num_layers:
        raise ValueError(f"Did not add cross QK for all layers{num_layers} vs {num_layer_output_qk}")


def update_decoder_subgraph_share_buffer_and_use_decoder_masked_mha(subg: ModelProto):
    input_self_past_0 = 1
    # w/wo attention mask, w/wo hidden_state
    graph_input_names = [gi.name for gi in subg.input]
    while input_self_past_0 < 3 and not graph_input_names[input_self_past_0].startswith("past"):
        input_self_past_0 += 1
    output_self_past_0 = 1

    num_layers = int((len(subg.input) - input_self_past_0) / 4)
    input_cross_past_0 = 2 * num_layers + input_self_past_0

    new_nodes = []
    old_nodes = []
    for node in subg.node:
        if node.op_type == "MultiHeadAttention":
            old_nodes.extend([node])

    # If not all the MultiHeadAttention nodes are fused, this optimization is not applicable
    if len(old_nodes) < num_layers:
        return False

    # Redirect the RelativePositionBias node's input from past_key_self_0.shape[2] to past_sequence_length.
    # There is only one RelativePositionBias node in T5 decoder subgraph.
    rel_pos_bias_node = None
    for node in subg.node:
        if node.op_type == "RelativePositionBias":
            rel_pos_bias_node = node
            break

    decoder_masked_attention_supported_attr = [
        "past_present_share_buffer",
        "num_heads",
        "scale",
        "mask_filter_value",
        "domain",
    ]

    target_squeezed_past_seq_name = "past_sequence_length_squeezed_int64"
    tensor_names_to_rename, nodes_to_remove = find_past_seq_len_usage(subg)
    if len(tensor_names_to_rename) > 0:
        for name_to_rename in tensor_names_to_rename:
            print(f"Found tensor name `{name_to_rename}` to be renamed to `{target_squeezed_past_seq_name}`")
        for nr in nodes_to_remove:
            print(f"Found node to remove: type = {nr.op_type}, name = {nr.name}")

        squeeze_node = onnx.helper.make_node(
            "Squeeze",
            ["past_sequence_length"],
            ["past_sequence_length_squeezed"],
            name="node_past_sequence_length_squeeze",
        )
        cast_node = onnx.helper.make_node(
            "Cast",
            ["past_sequence_length_squeezed"],
            [target_squeezed_past_seq_name],
            name="node_past_sequence_length_squeeze_cast",
            to=TensorProto.INT64,
        )
        new_nodes.extend([squeeze_node, cast_node])

    for node in subg.node:
        if len(node.output) > 0 and rel_pos_bias_node is not None and node.output[0] == rel_pos_bias_node.input[1]:
            cast_node = onnx.helper.make_node(
                "Cast",
                ["past_sequence_length"],
                ["past_sequence_length_int64"],
                name="past_sequence_length_cast",
                to=TensorProto.INT64,
            )
            node.input[1] = cast_node.output[0]
            new_nodes.extend([cast_node])

        if node.op_type == "MultiHeadAttention":
            kwargs = kwargs_of(node)
            for k in kwargs.copy():
                if k not in decoder_masked_attention_supported_attr:
                    del kwargs[k]

            # note: This logic only apply to T5 model where there is no bias in Attention node.
            nis = [
                node.input[0],  # query
                node.input[1],  # key
                node.input[2],  # value
            ]

            nis.extend([node.input[4] if len(node.input) > 4 else ""])  # 2D mask
            nis.extend([node.input[5] if len(node.input) > 5 else ""])  # attention_bias
            nis.extend([node.input[6] if len(node.input) > 6 else ""])  # past_key
            nis.extend([node.input[7] if len(node.input) > 7 else ""])  # past_value
            nis.extend(["past_sequence_length"])  # past_sequence_length
            nis.extend(["beam_width"])  # beam_width
            nis.extend(["cache_indirection"])  # cache_indirection
            nis.extend([node.input[3] if len(node.input) > 3 else ""])  # bias

            kwargs["past_present_share_buffer"] = 1

            node = onnx.helper.make_node(  # noqa: PLW2901
                "DecoderMaskedMultiHeadAttention",
                nis,
                node.output,
                name=node.name,
                **kwargs,
            )

        if node not in nodes_to_remove:
            for index, name in enumerate(node.input):
                if name in tensor_names_to_rename:
                    node.input[index] = target_squeezed_past_seq_name
            new_nodes.extend([node])

    subg.ClearField("node")
    subg.node.extend(new_nodes)
    orig_input_names = [inp.name for inp in subg.input]

    new_inputs = []
    for i, vi in enumerate(subg.input):
        if i >= input_self_past_0 and i < input_cross_past_0:
            shape = shape_of(vi)
            vi = onnx.helper.make_tensor_value_info(  # noqa: PLW2901
                vi.name,
                elem_type=vi.type.tensor_type.elem_type,
                shape=[shape[0], shape[1], "max_seq_len", shape[3]],
            )
        new_inputs.extend([vi])
    if "past_sequence_length" not in orig_input_names:
        new_inputs.extend(
            [onnx.helper.make_tensor_value_info("past_sequence_length", onnx.TensorProto.INT32, shape=[1])]
        )
    if "beam_width" not in orig_input_names:
        new_inputs.extend([onnx.helper.make_tensor_value_info("beam_width", onnx.TensorProto.INT32, shape=[1])])
    if "cache_indirection" not in orig_input_names:
        new_inputs.extend(
            [
                onnx.helper.make_tensor_value_info(
                    "cache_indirection",
                    onnx.TensorProto.INT32,
                    shape=["batch_size", "beam_width", "max_seq_len"],
                )
            ]
        )
    subg.ClearField("input")
    subg.input.extend(new_inputs)

    new_outputs = []
    for i, vi in enumerate(subg.output):
        if i >= output_self_past_0:
            shape = shape_of(vi)
            vi = onnx.helper.make_tensor_value_info(  # noqa: PLW2901
                vi.name,
                elem_type=vi.type.tensor_type.elem_type,
                shape=[shape[0], shape[1], "max_seq_len", shape[3]],
            )
        new_outputs.extend([vi])
    subg.ClearField("output")
    subg.output.extend(new_outputs)

    return True


def pack_qkv_for_decoder_masked_mha(model_proto: ModelProto):
    onnx_model = OnnxModel(model_proto)
    output_name_to_node = onnx_model.output_name_to_node()

    nodes_to_add = []
    nodes_to_remove = []
    for node in onnx_model.nodes():
        if node.op_type == "DecoderMaskedMultiHeadAttention":
            if "past_key_cross" in node.input[1] and "past_value_cross" in node.input[2]:
                continue
            q_matmul = output_name_to_node[node.input[0]]
            k_matmul = output_name_to_node[node.input[1]]
            v_matmul = output_name_to_node[node.input[2]]

            q_weight = onnx_model.get_initializer(q_matmul.input[1])
            k_weight = onnx_model.get_initializer(k_matmul.input[1])
            v_weight = onnx_model.get_initializer(v_matmul.input[1])
            if not (q_weight and k_weight and v_weight):
                return False

            qw = NumpyHelper.to_array(q_weight)
            kw = NumpyHelper.to_array(k_weight)
            vw = NumpyHelper.to_array(v_weight)

            qkv_weight = np.concatenate([qw, kw, vw], axis=1)

            matmul_node_name = onnx_model.create_node_name("MatMul", name_prefix="MatMul_QKV")
            weight = onnx.helper.make_tensor(
                name=matmul_node_name + "_weight",
                data_type=(TensorProto.FLOAT if q_weight.data_type == 1 else TensorProto.FLOAT16),
                dims=[qkv_weight.shape[0], qkv_weight.shape[1]],
                vals=qkv_weight.flatten().tolist(),
            )

            model_proto.graph.initializer.extend([weight])

            matmul_node = onnx.helper.make_node(
                "MatMul",
                inputs=[q_matmul.input[0], matmul_node_name + "_weight"],
                outputs=[matmul_node_name + "_out"],
                name=matmul_node_name,
            )

            node.input[0] = matmul_node.output[0]
            node.input[1] = ""
            node.input[2] = ""

            nodes_to_add.extend([matmul_node])
            nodes_to_remove.extend([q_matmul, k_matmul, v_matmul])

    onnx_model.add_nodes(nodes_to_add)
    onnx_model.remove_nodes(nodes_to_remove)
    onnx_model.update_graph()

    onnx_model.topological_sort()

    return True


def update_input_shapes_for_gpt2_decoder_model(decoder_onnx_path: str, use_external_data_format: bool = True):
    """Update the input shapes for the inputs "input_ids" and "position_ids" and make the sequence length dim value 1 for each of them.
       The decoder model will be over-written.

    Args:
        decoder_onnx_path (str): Path of GPT-2 decoder onnx model
        use_external_data_format(bool): output tensors to external data or not.
    """

    decoder_model_proto = onnx.load_model(decoder_onnx_path, load_external_data=True)
    for i in range(len(decoder_model_proto.graph.input)):
        if (
            decoder_model_proto.graph.input[i].name == "input_ids"
            or decoder_model_proto.graph.input[i].name == "position_ids"
        ):
            shape_dim_proto = decoder_model_proto.graph.input[i].type.tensor_type.shape.dim[1]

            # Clear any existing dim_param first
            if shape_dim_proto.HasField("dim_param"):
                shape_dim_proto.Clear()

            # Update dim_value to be 1
            shape_dim_proto.dim_value = 1

    OnnxModel.save(
        decoder_model_proto,
        decoder_onnx_path,
        save_as_external_data=use_external_data_format,
    )
    return True


def generate_gpt2_init_decoder(
    decoder_onnx_path: str,
    init_decoder_onnx_path: str,
    use_external_data_format: bool = True,
) -> bool:
    """Generates the initial decoder GPT2 subgraph and saves it for downstream use.
       The initial decoder model will be saved to init_decoder_onnx_path.

    Args:
        decoder_onnx_path (str): Path of GPT-2 decoder onnx model
        init_decoder_onnx_path (str): Path of GPT-2 init decoder onnx model
        use_external_data_format(bool): output tensors to external data or not.
    """
    init_decoder_model_proto = onnx.load_model(decoder_onnx_path, load_external_data=True)

    logits_output_name = init_decoder_model_proto.graph.output[0].name

    gpt2_init_decoder_model = OnnxModel(init_decoder_model_proto)

    output_name_to_node = gpt2_init_decoder_model.output_name_to_node()
    assert logits_output_name in output_name_to_node

    logits_matmul_node = output_name_to_node[logits_output_name]

    # Sanity check - the logits need to be produced by a MatMul node
    if logits_matmul_node.op_type != "MatMul":
        return False

    # Try to find the last residual Add
    # For fp16, there are Casts along the way

    # Normalization Node is : LayerNormalization
    logits_matmul_to_residual_add_path = gpt2_init_decoder_model.match_parent_path(
        logits_matmul_node,
        [
            "Cast",
            "LayerNormalization",
            "Add",
            "Add",
            "Cast",
            "MatMul",
            "Cast",
            "FastGelu",
            "Cast",
            "MatMul",
            "Cast",
            "LayerNormalization",
            "Add",
        ],
        [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    )

    # Normalization Node is : SkipLayerNormalization
    if logits_matmul_to_residual_add_path is None:
        logits_matmul_to_residual_add_path = gpt2_init_decoder_model.match_parent_path(
            logits_matmul_node,
            [
                "Cast",
                "SkipLayerNormalization",
                "Cast",
                "MatMul",
                "Cast",
                "FastGelu",
                "Cast",
                "MatMul",
                "Cast",
                "SkipLayerNormalization",
            ],
            [0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
        )

    # Try without the Casts before and after the MatMuls
    if logits_matmul_to_residual_add_path is None:
        # Normalization Node is : LayerNormalization
        logits_matmul_to_residual_add_path = gpt2_init_decoder_model.match_parent_path(
            logits_matmul_node,
            [
                "LayerNormalization",
                "Add",
                "Add",
                "MatMul",
                "FastGelu",
                "MatMul",
                "LayerNormalization",
                "Add",
            ],
            [0, 0, 1, 0, 0, 0, 0, 0],
        )

        # Normalization Node is : SkipLayerNormalization
        if logits_matmul_to_residual_add_path is None:
            logits_matmul_to_residual_add_path = gpt2_init_decoder_model.match_parent_path(
                logits_matmul_node,
                [
                    "SkipLayerNormalization",
                    "MatMul",
                    "FastGelu",
                    "MatMul",
                    "SkipLayerNormalization",
                ],
                [0, 1, 0, 0, 0],
            )

    # TODO(hasesh): Are there more permutations to try before returning ?
    if logits_matmul_to_residual_add_path is None:
        return False

    residual_add_node = logits_matmul_to_residual_add_path[-1]

    # If the last node in the pattern is SkipLayerNormalization, we need to adjust our pattern searches accordingly
    is_skiplayernorm_path = residual_add_node.op_type == "SkipLayerNormalization"

    # Regular LayerNormalization path
    if not is_skiplayernorm_path:
        residual_add_to_attention_parent_index = 0
        residual_add_to_attention_path = gpt2_init_decoder_model.match_parent_path(
            residual_add_node,
            ["Add", "Cast", "MatMul", "Attention"],
            [residual_add_to_attention_parent_index, 0, 0, 0],
        )

        # Try other parent index of the residual Add node
        if residual_add_to_attention_path is None:
            residual_add_to_attention_parent_index = 1
            residual_add_to_attention_path = gpt2_init_decoder_model.match_parent_path(
                residual_add_node,
                ["Add", "Cast", "MatMul", "Attention"],
                [residual_add_to_attention_parent_index, 0, 0, 0],
            )

        # Try without the Casts before and after the MatMuls
        if residual_add_to_attention_path is None:
            residual_add_to_attention_parent_index = 0
            residual_add_to_attention_path = gpt2_init_decoder_model.match_parent_path(
                residual_add_node,
                ["Add", "MatMul", "Attention"],
                [residual_add_to_attention_parent_index, 0, 0],
            )

        # Try without the Casts before and after the MatMuls and other parent index of the residual Add node
        if residual_add_to_attention_path is None:
            residual_add_to_attention_parent_index = 1
            residual_add_to_attention_path = gpt2_init_decoder_model.match_parent_path(
                residual_add_node,
                ["Add", "MatMul", "Attention"],
                [residual_add_to_attention_parent_index, 0, 0],
            )

    # SkipLayerNormalization path
    else:
        residual_add_to_attention_parent_index = 0
        residual_add_to_attention_path = gpt2_init_decoder_model.match_parent_path(
            residual_add_node,
            ["Cast", "MatMul", "Attention"],
            [residual_add_to_attention_parent_index, 0, 0],
        )

        # Try other parent index of the residual Add node
        if residual_add_to_attention_path is None:
            residual_add_to_attention_parent_index = 1
            residual_add_to_attention_path = gpt2_init_decoder_model.match_parent_path(
                residual_add_node,
                ["Cast", "MatMul", "Attention"],
                [residual_add_to_attention_parent_index, 0, 0],
            )

        # Try without the Casts before and after the MatMuls
        if residual_add_to_attention_path is None:
            residual_add_to_attention_parent_index = 0
            residual_add_to_attention_path = gpt2_init_decoder_model.match_parent_path(
                residual_add_node,
                ["MatMul", "Attention"],
                [residual_add_to_attention_parent_index, 0],
            )

        # Try without the Casts before and after the MatMuls and other parent index of the residual Add node
        if residual_add_to_attention_path is None:
            residual_add_to_attention_parent_index = 1
            residual_add_to_attention_path = gpt2_init_decoder_model.match_parent_path(
                residual_add_node,
                ["MatMul", "Attention"],
                [residual_add_to_attention_parent_index, 0],
            )

    # TODO(hasesh): Are there more permutations to try before returning ?
    if residual_add_to_attention_path is None:
        return False

    residual_add_to_add_parent_index = 0 if residual_add_to_attention_parent_index == 1 else 1

    # Regular LayerNormalization path
    if not is_skiplayernorm_path:
        add_before_residual_add = gpt2_init_decoder_model.match_parent(
            residual_add_node, "Add", residual_add_to_add_parent_index
        )

    # SkipLayerNormalization path
    else:
        add_before_residual_add = gpt2_init_decoder_model.match_parent(
            residual_add_node,
            "SkipLayerNormalization",
            residual_add_to_add_parent_index,
        )

    if add_before_residual_add is None:
        return False

    attention = residual_add_to_attention_path[-1]
    matmul_after_attention = residual_add_to_attention_path[-2]

    slice_starts = onnx.helper.make_tensor(
        name="SliceLastTokenStarts",
        data_type=TensorProto.INT32,
        dims=[1],
        vals=[-1],
    )

    slice_ends = onnx.helper.make_tensor(
        name="SliceLastTokenEnds",
        data_type=TensorProto.INT32,
        dims=[1],
        vals=[-2],
    )

    slice_axes = onnx.helper.make_tensor(
        name="SliceLastTokenAxes",
        data_type=TensorProto.INT32,
        dims=[1],
        vals=[1],
    )

    slice_steps = onnx.helper.make_tensor(
        name="SliceLastTokenSteps",
        data_type=TensorProto.INT32,
        dims=[1],
        vals=[-1],
    )

    gpt2_init_decoder_model.add_initializer(slice_starts)
    gpt2_init_decoder_model.add_initializer(slice_ends)
    gpt2_init_decoder_model.add_initializer(slice_axes)
    gpt2_init_decoder_model.add_initializer(slice_steps)

    # Add Slice node to the graph such that it consumes the output of Attention
    slice_0_output_name = "edge_modified_" + attention.output[0]
    slice_node_0 = onnx.helper.make_node(
        "Slice",
        inputs=[
            attention.output[0],
            "SliceLastTokenStarts",
            "SliceLastTokenEnds",
            "SliceLastTokenAxes",
            "SliceLastTokenSteps",
        ],
        outputs=[slice_0_output_name],
        name=gpt2_init_decoder_model.create_node_name("Slice", "GatherLastToken_0_"),
    )

    # Add Slice node to the graph such that it consumes the output of Add before the residual Add
    # If the 'Add' output is produced by a SkipLayerNormalization node, then adjust its output
    # index appropriately
    add_before_residual_add_output = (
        add_before_residual_add.output[0] if not is_skiplayernorm_path else add_before_residual_add.output[3]
    )

    slice_1_output_name = "edge_modified_" + add_before_residual_add.output[0]
    slice_node_1 = onnx.helper.make_node(
        "Slice",
        inputs=[
            add_before_residual_add_output,
            "SliceLastTokenStarts",
            "SliceLastTokenEnds",
            "SliceLastTokenAxes",
            "SliceLastTokenSteps",
        ],
        outputs=[slice_1_output_name],
        name=gpt2_init_decoder_model.create_node_name("Slice", "GatherLastToken_1_"),
    )

    # Add the 2 Slice nodes
    gpt2_init_decoder_model.add_node(slice_node_0)
    gpt2_init_decoder_model.add_node(slice_node_1)

    # Adjust the input(s) to the nodes consuming the outputs of the added Slice nodes
    gpt2_init_decoder_model.replace_node_input(matmul_after_attention, attention.output[0], slice_0_output_name)
    gpt2_init_decoder_model.replace_node_input(residual_add_node, add_before_residual_add_output, slice_1_output_name)

    # Topologically sort the updated graph
    gpt2_init_decoder_model.topological_sort()

    # Save the init decoder model
    OnnxModel.save(
        init_decoder_model_proto,
        init_decoder_onnx_path,
        save_as_external_data=use_external_data_format,
    )
    return True


def make_dim_proto_numeric_t5(model, config):
    """Make dim_proto numeric.

    Args:
        model: T5 encoder and decoder model.
        config: T5 config.
    """
    sequence_length = str(1)
    num_heads = str(config.num_heads)
    hidden_size = str(config.d_model)
    head_size = str(config.d_kv)

    for tensor in model.graph.output:
        for dim_proto in tensor.type.tensor_type.shape.dim:
            if dim_proto.HasField("dim_param") and dim_proto.dim_param in [
                sequence_length,
                num_heads,
                hidden_size,
                head_size,
            ]:
                dim_value = int(dim_proto.dim_param)
                dim_proto.Clear()
                dim_proto.dim_value = dim_value

    for tensor in model.graph.input:
        for dim_proto in tensor.type.tensor_type.shape.dim:
            if dim_proto.HasField("dim_param") and dim_proto.dim_param in [
                sequence_length,
                num_heads,
                hidden_size,
                head_size,
            ]:
                dim_value = int(dim_proto.dim_param)
                dim_proto.Clear()
                dim_proto.dim_value = dim_value


def convert_generation_model(
    args: argparse.Namespace,
    generation_type: GenerationType = GenerationType.BEAMSEARCH,
):
    """Convert model according to command line arguments.

    Args:
        args (argparse.Namespace): arguments parsed from command line
    """
    is_gpt2: bool = args.model_type == "gpt2"
    is_beamsearch: bool = generation_type == GenerationType.BEAMSEARCH
    is_greedysearch: bool = generation_type == GenerationType.GREEDYSEARCH
    is_sampling: bool = generation_type == GenerationType.SAMPLING
    past_present_share_buffer: bool = args.past_present_share_buffer

    logger.info(f"**** past_present_share_buffer={past_present_share_buffer}")
    if len(args.op_block_list) == 1 and args.op_block_list[0] == "auto":
        if is_gpt2 and args.precision == Precision.FLOAT16.value:
            args.op_block_list = [
                "Add",
                "LayerNormalization",
                "SkipLayerNormalization",
                "FastGelu",
            ]
            logger.info(f"**** Setting op_block_list to {args.op_block_list}")
            logger.info("**** use --op_block_list if you want to override the block operator list.")
        else:
            args.op_block_list = []

    if is_greedysearch or is_sampling:
        if not is_gpt2:
            raise NotImplementedError("Currently only gpt2 with greedy search/sampling is supported")
        if args.output_sequences_scores:
            raise NotImplementedError("output_sequences_scores currently is not supported in greedy search/sampling")
        if args.output_token_scores:
            raise NotImplementedError("output_token_scores currently is not supported in greedy search/sampling")

    # For BeamSearch, sharing buffers for past and present states is only supported
    # when using `use_decoder_masked_attention`
    if past_present_share_buffer and is_beamsearch and not args.use_decoder_masked_attention:
        raise ValueError(
            "`use_decoder_masked_attention` MUST be turned on to use `past_present_share_buffer` in case of BeamSearch"
        )

    # For any kind of sampling, using decoder masked multihead attention is only supported
    # when using `past_present_share_buffer`
    if args.use_decoder_masked_attention and not past_present_share_buffer:
        raise ValueError("`past_present_share_buffer` MUST be turned on to use `use_decoder_masked_attention`")

    # For any kind of sampling, using decoder masked multihead attention is only supported
    # on GPUs
    if args.use_decoder_masked_attention and not args.use_gpu:
        raise ValueError("`use_decoder_masked_attention` option is only supported on GPUs")

    if is_gpt2:
        if args.decoder_onnx and os.path.exists(args.decoder_onnx):
            logger.info(f"skip convert_to_onnx since path existed: {args.decoder_onnx}")
        else:
            if not args.decoder_onnx:
                onnx_filename = f"{args.model_name_or_path}_past_{args.precision}.onnx"
                args.decoder_onnx = Path(Path(args.output).parent, onnx_filename).as_posix()

            logger.info(f"Convert GPT model {args.model_name_or_path} to onnx {args.decoder_onnx} ...")
            gpt2_to_onnx(args)
    else:  # t5 or mt5
        if args.decoder_onnx and args.encoder_decoder_init_onnx:
            logger.info(
                f"skip convert_to_onnx since paths specified: {args.decoder_onnx} and {args.encoder_decoder_init_onnx}"
            )
        else:
            logger.info(f"Convert model {args.model_name_or_path} to onnx ...")
            t5_to_onnx(args)

    # We only want to pad the logits MatMul weight in the decoder for fp16 models.
    # The inherent assumption is that fp16 models run on GPU for which all
    # dims need to be a multiple of 8 to leverage tensor cores.
    # NOTE: We currently only support padding the MatMul logits weight for GPT2 GreedySearch/BeamSearch.
    # This can be expanded to other models/decoding strategies later
    logits_matmul_weight_padded = False
    if (
        not args.disable_pad_vocab_size
        and args.precision == Precision.FLOAT16.value
        and is_gpt2
        and (is_beamsearch or is_greedysearch or is_sampling)
    ):
        logger.info(
            f"Pad logits MatMul weights for optimal MatMul perf in fp16 on {args.decoder_onnx}. "
            "The file will be overwritten."
        )
        logits_matmul_weight_padded = pad_weights_of_logits_matmul(args.decoder_onnx, args.use_external_data_format)
        if not logits_matmul_weight_padded:
            logger.warning(
                "Tried and failed to pad logits MatMul weights. Performance may be sub-optimal for this MatMul"
            )

    gpt2_init_decoder_generated = False
    gpt2_init_decoder_onnx_path = None
    if (
        not args.disable_separate_gpt2_decoder_for_init_run
        and is_gpt2
        and (is_beamsearch or is_greedysearch or is_sampling)
    ):
        logger.info(f"Creating an initial run GPT2 decoder from {args.decoder_onnx}. ")

        gpt2_init_decoder_onnx_filename = f"gpt2_init_past_{args.precision}.onnx"

        gpt2_init_decoder_onnx_path = Path(Path(args.output).parent, gpt2_init_decoder_onnx_filename).as_posix()

        gpt2_init_decoder_generated = generate_gpt2_init_decoder(
            args.decoder_onnx,
            gpt2_init_decoder_onnx_path,
            args.use_external_data_format,
        )

        if not gpt2_init_decoder_generated:
            logger.warning(
                "Tried and failed to generate the init decoder GPT2 model. "
                "Performance may be sub-optimal for the initial decoding run"
            )

        # Update the graph input shapes for the non-initial decoder model to account
        # for the fact that the sequence length will always be 1
        if gpt2_init_decoder_generated and not update_input_shapes_for_gpt2_decoder_model(
            args.decoder_onnx, args.use_external_data_format
        ):
            # Can't proceed further - better to raise an exception
            raise ValueError("Could not update the input shapes for the non-initial decoder subgraph.")

    # If the user explicitly requests running shape inference or if we padded/mutated
    # weight(s)/input shape(s) in the decoder, we want to run shape inference to capture the new
    # shapes
    if logits_matmul_weight_padded or args.run_shape_inference or gpt2_init_decoder_generated:
        logger.info(f"Run symbolic shape inference on {args.decoder_onnx}. The file will be overwritten.")
        shape_inference(args.decoder_onnx, args.use_external_data_format)
        if gpt2_init_decoder_generated:
            logger.info(f"Run symbolic shape inference on {gpt2_init_decoder_onnx_path}. The file will be overwritten.")
            shape_inference(gpt2_init_decoder_onnx_path, args.use_external_data_format)

    if is_gpt2:
        config = GPT2Config.from_pretrained(args.model_name_or_path, cache_dir=args.cache_dir)
    elif args.model_type == "t5":
        config = T5Config.from_pretrained(args.model_name_or_path, cache_dir=args.cache_dir)
    else:
        config = MT5Config.from_pretrained(args.model_name_or_path, cache_dir=args.cache_dir)

    if args.verbose:
        logger.info(f"Config={config}")

    eos_token_id = config.eos_token_id
    pad_token_id = config.eos_token_id if is_gpt2 else config.pad_token_id
    vocab_size = config.vocab_size

    # if vocab_size is given in parameters use that.
    if args.vocab_size != -1:
        vocab_size = args.vocab_size

    if args.eos_token_id != -1:
        eos_token_id = args.eos_token_id
    if args.pad_token_id != -1:
        pad_token_id = args.pad_token_id

    decoder_model = onnx.load_model(args.decoder_onnx, load_external_data=True)
    decoder_model.graph.name = f"{args.model_type} decoder"

    gpt2_init_decoder_model = None
    if args.model_type == "gpt2":
        verify_gpt2_subgraph(decoder_model.graph, args.precision)

        # If we generated the init decoder model, verify that as well
        if gpt2_init_decoder_generated:
            gpt2_init_decoder_model = onnx.load_model(gpt2_init_decoder_onnx_path, load_external_data=True)
            gpt2_init_decoder_model.graph.name = f"{args.model_type} init decoder"
            verify_gpt2_subgraph(gpt2_init_decoder_model.graph, args.precision)
    else:
        verify_t5_decoder_subgraph(decoder_model.graph, args.precision)

    inputs = None
    if is_beamsearch:
        inputs = [
            "input_ids",
            "max_length",
            "min_length",
            "num_beams",
            "num_return_sequences",
            "length_penalty",
            "repetition_penalty",
        ]
    elif is_greedysearch or is_sampling:
        inputs = [
            "input_ids",
            "max_length",
            "min_length",
            "repetition_penalty",
        ]

    if args.vocab_mask:
        inputs.append("vocab_mask")
    else:
        inputs.append("")

    if args.prefix_vocab_mask:
        inputs.append("prefix_vocab_mask")
    else:
        inputs.append("")

    if args.custom_attention_mask:
        inputs.append("attention_mask")
    else:
        inputs.append("")

    if is_sampling:
        if args.custom and args.presence_mask:
            inputs.append("presence_mask")
        else:
            inputs.append("")

        if args.seed:
            inputs.append("seed")

    outputs = ["sequences"]
    if args.output_sequences_scores:
        outputs.append("sequences_scores")

    if args.output_token_scores:
        assert args.output_sequences_scores, "--output_token_scores requires --output_sequences_scores"
        outputs.append("scores")

    node = None
    if is_beamsearch:
        node = onnx.helper.make_node(
            "BeamSearch",
            inputs=inputs,
            outputs=outputs,
            name=f"BeamSearch_{args.model_type}",
        )
    elif is_greedysearch:
        node = onnx.helper.make_node(
            "GreedySearch",
            inputs=inputs,
            outputs=outputs,
            name=f"GreedySearch_{args.model_type}",
        )
    elif is_sampling:
        node = onnx.helper.make_node(
            "Sampling",
            inputs=inputs,
            outputs=outputs,
            name=f"Sampling_{args.model_type}",
        )

    node.domain = "com.microsoft"

    attr_to_extend = None
    if is_beamsearch:
        attr_to_extend = [
            onnx.helper.make_attribute("eos_token_id", eos_token_id),
            onnx.helper.make_attribute("pad_token_id", pad_token_id),
            onnx.helper.make_attribute("no_repeat_ngram_size", args.no_repeat_ngram_size),
            onnx.helper.make_attribute("early_stopping", 1 if args.early_stopping else 0),
            onnx.helper.make_attribute("model_type", 0 if args.model_type == "gpt2" else 1),
        ]
    elif is_greedysearch:
        attr_to_extend = [
            onnx.helper.make_attribute("eos_token_id", eos_token_id),
            onnx.helper.make_attribute("pad_token_id", pad_token_id),
            onnx.helper.make_attribute("model_type", 0 if args.model_type == "gpt2" else 1),
            onnx.helper.make_attribute("no_repeat_ngram_size", args.no_repeat_ngram_size),
        ]
    elif is_sampling:
        attr_to_extend = [
            onnx.helper.make_attribute("eos_token_id", eos_token_id),
            onnx.helper.make_attribute("pad_token_id", pad_token_id),
            onnx.helper.make_attribute("model_type", 0 if args.model_type == "gpt2" else 1),
            onnx.helper.make_attribute("no_repeat_ngram_size", args.no_repeat_ngram_size),
            onnx.helper.make_attribute("temperature", args.temperature),
            onnx.helper.make_attribute("top_p", args.top_p),
            onnx.helper.make_attribute("filter_value", args.filter_value),
            onnx.helper.make_attribute("min_tokens_to_keep", args.min_tokens_to_keep),
            onnx.helper.make_attribute("custom", args.custom),
            onnx.helper.make_attribute("presence_penalty", args.presence_penalty),
        ]

    # Explicitly pass in the vocab size via an attribute
    if logits_matmul_weight_padded:
        attr_to_extend.extend([onnx.helper.make_attribute("vocab_size", vocab_size)])

    node.attribute.extend(attr_to_extend)

    initializers = []

    if args.model_type in ["t5", "mt5"]:
        if args.run_shape_inference:
            logger.info(f"Symbolic shape inference on {args.encoder_decoder_init_onnx}. The file will be overwritten.")
            shape_inference(args.encoder_decoder_init_onnx, args.use_external_data_format)
        encoder_model = onnx.load_model(args.encoder_decoder_init_onnx, load_external_data=True)
        suffix = "encoder" if len(encoder_model.graph.input) == 2 else "encoder and decoder init"
        encoder_model.graph.name = f"{args.model_type} {suffix}"
        verify_t5_encoder_decoder_init_subgraph(encoder_model.graph, args.precision)

        make_dim_proto_numeric_t5(encoder_model, config)
        make_dim_proto_numeric_t5(decoder_model, config)

        # Update decoder subgraph in preparation to use past present share buffer
        if past_present_share_buffer:
            if not args.use_decoder_masked_attention:
                raise ValueError("past_present_share_buffer is only supported with use_decoder_masked_attention")

            logger.info(
                "*****update t5 decoder subgraph to share past/present buffer and use decoder_masked_multihead_attention*****"
            )
            if update_decoder_subgraph_share_buffer_and_use_decoder_masked_mha(decoder_model.graph):
                logger.info("*****update t5 decoder subgraph successfully!!!*****")
            else:
                logger.info("*****DecoderMaskedMultiHeadAttention is not applied to T5 decoder*****")

            if pack_qkv_for_decoder_masked_mha(decoder_model):
                logger.info("*****pack qkv for decoder masked mha successfully!!!*****")
            else:
                logger.info("*****pack qkv for decoder masked mha failed!!!*****")

        if not args.disable_shared_initializers:
            # Unique shared initializers from the decoder and decoder_init could reduce memory usage in inference.
            initializers = get_shared_initializers(encoder_model, decoder_model)
            logger.info(
                f"{len(initializers)} shared initializers ({[i.name for i in initializers]}) in encoder and decoder subgraphs are moved to the main graph"
            )

            # TODO(tianleiwu): investigate the following which causes error in inference
            # Move initializer from subgraph to main graph could reduce memory usage in inference.
            # moved_initializers = move_initializers(encoder_model.graph)
            # logger.info(
            #     f"{len(moved_initializers)} initializers ({[i.name for i in moved_initializers]}) from the encoder are moved to the main graph"
            # )
            # initializers.extend(moved_initializers)

        assert config.decoder_start_token_id >= 0, "decoder_start_token_id should be >= 0"

        node.attribute.extend(
            [
                onnx.helper.make_attribute("encoder", encoder_model.graph),
                onnx.helper.make_attribute("decoder", decoder_model.graph),
                onnx.helper.make_attribute("decoder_start_token_id", config.decoder_start_token_id),
            ]
        )
    else:
        if gpt2_init_decoder_generated:
            # Move shared initializers (shared between init decoder and decoder models) to the main
            # graph and remove them from these models
            if not args.disable_shared_initializers:
                # Unique shared initializers from the decoder and decoder_init could reduce memory usage in inference.
                initializers = get_shared_initializers(gpt2_init_decoder_model, decoder_model)
                logger.info(
                    f"{len(initializers)} shared initializers ({[i.name for i in initializers]}) in decoder and init decoder subgraphs are moved to the main graph"
                )

            # Update init decoder subgraph in preparation to use past present share buffer
            if past_present_share_buffer:
                logger.info("*****update init decoder subgraph to make past and present share buffer******************")
                update_decoder_subgraph_past_present_share_buffer(gpt2_init_decoder_model.graph)

            # Update init decoder subgraph in preparation to use DecoderMaskedSelfAttention
            # NOTE: Even if we will not use DecoderMaskedSelfAttention in the init decoder subgraph
            # it makes the runtime changes cleaner if we keep both the init decoder and decoder subgraphs
            # same in terms of the subgraph inputs.
            if args.use_decoder_masked_attention and not update_decoder_subgraph_use_decoder_masked_attention(
                gpt2_init_decoder_model.graph, is_beamsearch, False
            ):
                raise ValueError("Could not update the init decoder subgraph to use DecoderMaskedSelfAttention")

            node.attribute.append(onnx.helper.make_attribute("init_decoder", gpt2_init_decoder_model.graph))
        else:
            # Move initializer from subgraph to main graph could reduce memory usage in inference.
            initializers = move_initializers(decoder_model.graph)
            logger.info(f"{len(initializers)} initializers from the decoder are moved to the main graph")

        # Update decoder subgraph in preparation to use past present share buffer
        if past_present_share_buffer:
            logger.info("*****update decoder subgraph to make past and present share buffer******************")
            update_decoder_subgraph_past_present_share_buffer(decoder_model.graph)

        # Update decoder subgraph in preparation to use DecoderMaskedSelfAttention
        if args.use_decoder_masked_attention and not update_decoder_subgraph_use_decoder_masked_attention(
            decoder_model.graph, is_beamsearch, True
        ):
            raise ValueError("Could not update the decoder subgraph to use DecoderMaskedSelfAttention")

        node.attribute.append(onnx.helper.make_attribute("decoder", decoder_model.graph))

    # graph inputs
    input_ids = onnx.helper.make_tensor_value_info("input_ids", TensorProto.INT32, ["batch_size", "sequence_length"])
    max_length = onnx.helper.make_tensor_value_info("max_length", TensorProto.INT32, [1])
    min_length = onnx.helper.make_tensor_value_info("min_length", TensorProto.INT32, [1])
    num_beams = onnx.helper.make_tensor_value_info("num_beams", TensorProto.INT32, [1])
    num_return_sequences = onnx.helper.make_tensor_value_info("num_return_sequences", TensorProto.INT32, [1])
    length_penalty = onnx.helper.make_tensor_value_info("length_penalty", TensorProto.FLOAT, [1])
    repetition_penalty = onnx.helper.make_tensor_value_info("repetition_penalty", TensorProto.FLOAT, [1])

    graph_inputs = None
    if is_beamsearch:
        graph_inputs = [
            input_ids,
            max_length,
            min_length,
            num_beams,
            num_return_sequences,
            length_penalty,
            repetition_penalty,
        ]
    elif is_greedysearch or is_sampling:
        graph_inputs = [
            input_ids,
            max_length,
            min_length,
            repetition_penalty,
        ]

    if args.vocab_mask:
        vocab_mask = onnx.helper.make_tensor_value_info("vocab_mask", TensorProto.INT32, [vocab_size])
        graph_inputs.append(vocab_mask)

    if args.prefix_vocab_mask:
        prefix_vocab_mask = onnx.helper.make_tensor_value_info(
            "prefix_vocab_mask", TensorProto.INT32, ["batch_size", vocab_size]
        )
        graph_inputs.append(prefix_vocab_mask)

    if args.custom_attention_mask:
        attention_mask = onnx.helper.make_tensor_value_info(
            "attention_mask", TensorProto.INT32, ["batch_size", "sequence_length"]
        )
        graph_inputs.append(attention_mask)

    if args.custom and args.presence_mask:
        presence_mask = onnx.helper.make_tensor_value_info(
            "presence_mask", TensorProto.INT32, ["batch_size", vocab_size]
        )
        graph_inputs.append(presence_mask)

    if is_sampling and args.seed:
        seed = onnx.helper.make_tensor_value_info("seed", TensorProto.INT32, [1])
        graph_inputs.append(seed)

    # graph outputs
    sequences = None
    if is_beamsearch:
        sequences = onnx.helper.make_tensor_value_info(
            "sequences",
            TensorProto.INT32,
            ["batch_size", "num_return_sequences", "max_length"],
        )
    elif is_greedysearch or is_sampling:
        sequences = onnx.helper.make_tensor_value_info(
            "sequences",
            TensorProto.INT32,
            ["batch_size", "max_length"],
        )

    graph_outputs = [sequences]

    if args.output_sequences_scores:
        sequences_scores = onnx.helper.make_tensor_value_info(
            "sequences_scores",
            TensorProto.FLOAT,
            ["batch_size", "num_return_sequences"],
        )
        graph_outputs.append(sequences_scores)

    if args.output_token_scores:
        scores = onnx.helper.make_tensor_value_info(
            "scores",
            TensorProto.FLOAT,
            ["max_length - sequence_length", "batch_size", "num_beams", vocab_size],
        )
        graph_outputs.append(scores)

    new_graph = onnx.helper.make_graph(
        [node],
        (f"{args.model_type} beam search" if not is_greedysearch else f"{args.model_type} greedy search"),
        graph_inputs,
        graph_outputs,
        initializers,
    )

    # Create the model
    new_model = onnx.helper.make_model(
        new_graph,
        producer_name="onnxruntime.transformers",
        opset_imports=decoder_model.opset_import,
    )

    # TODO(tianleiwu): move shared initializers from T5 encoder and decoder subgraphs to parent graph to save memory.
    if args.use_external_data_format:
        from packaging import version  # noqa: PLC0415

        if version.parse(onnx.__version__) < version.parse("1.12.0"):
            logger.warning("Require onnx >= 1.12 to save large (>2GB) model!")

        OnnxModel.save(
            new_model,
            args.output,
            save_as_external_data=True,
            all_tensors_to_one_file=True,
        )
    else:
        onnx.save(new_model, args.output)
    logger.info(f"model save to {args.output}")


def test_torch_performance(
    args: argparse.Namespace,
    model: GPT2LMHeadModel | T5ForConditionalGeneration,
    input_ids: torch.Tensor,
    attention_mask: torch.Tensor,
    eos_token_id: int,
    pad_token_id: int,
    bad_words_ids: list[list[int]],
) -> dict[str, Any]:
    """Test PyTorch performance of text generation.

    Args:
        args (argparse.Namespace): arguments parsed from command line
        model (Union[GPT2LMHeadModel, T5ForConditionalGeneration]): PyTorch model
        input_ids (torch.Tensor): input_ids
        attention_mask (torch.Tensor): Attention mask
        eos_token_id (int): EOS token ID
        pad_token_id (int): Padding token ID
        bad_words_ids (List[List[int]]): Words shall not be generated.

    Raises:
        RuntimeError: PyTorch with CUDA is not available for --use_gpu

    Returns:
        Dict[str, Any]: A dictionary with string with metric name, and value can be integer or string.
    """
    if args.use_gpu and not torch.cuda.is_available():
        raise RuntimeError("Please install PyTorch with Cuda for testing gpu performance.")

    if args.precision == Precision.FLOAT16.value:
        model.half()

    device = torch.device("cuda:0" if args.use_gpu else "cpu")
    model.to(device)

    torch.set_grad_enabled(False)
    input_ids = input_ids.to(device)
    attention_mask = attention_mask.to(device)

    torch_latency = []
    for _ in range(args.total_runs):
        start = time.time()
        _ = model.generate(
            input_ids=input_ids,
            attention_mask=attention_mask,
            max_length=args.max_length,
            min_length=args.min_length,
            num_beams=args.num_beams,
            early_stopping=args.early_stopping,
            no_repeat_ngram_size=args.no_repeat_ngram_size,
            eos_token_id=eos_token_id,
            pad_token_id=pad_token_id,
            num_return_sequences=args.num_return_sequences,
            length_penalty=args.length_penalty,
            repetition_penalty=args.repetition_penalty,
            bad_words_ids=bad_words_ids if bad_words_ids else None,
            return_dict_in_generate=True,
            output_scores=args.output_sequences_scores or args.output_token_scores,
        )
        torch_latency.append(time.time() - start)
    batch_size = input_ids.shape[0]
    from benchmark_helper import get_latency_result  # noqa: PLC0415

    return get_latency_result(torch_latency, batch_size)


def create_attention_mask(input_ids, pad_token_id):
    attention_mask = np.ones(input_ids.shape, dtype=np.int32)
    for i in range(input_ids.shape[0]):
        abs_pos = 0
        for j in range(input_ids.shape[1]):
            if input_ids[i][j] == pad_token_id and abs_pos == 0:
                attention_mask[i][j] = 0
            else:
                abs_pos += 1
    return attention_mask


def test_gpt_model(
    args: argparse.Namespace,
    sentences: list[str] | None = None,
    is_greedy: bool = False,
):
    """Test GPT-2 model

    Args:
        args (argparse.Namespace): arguments parsed from command line
        sentences (Optional[List[str]], optional): input text. Defaults to None.

    Returns:
        Union[Dict[str, Any], None]: A dictionary with string with metric name, and value can be integer or string.
    """
    assert args.model_type == "gpt2"

    tokenizer = GPT2Tokenizer.from_pretrained(args.model_name_or_path, cache_dir=args.cache_dir)
    tokenizer.padding_side = "left"
    tokenizer.pad_token = tokenizer.eos_token

    model = GPT2LMHeadModel.from_pretrained(
        args.model_name_or_path,
        cache_dir=args.cache_dir,
        pad_token_id=tokenizer.eos_token_id,
    )

    # Use different length sentences to test batching
    if sentences is None:
        sentences = [
            "The product is released",
            "I enjoy walking in the park",
            "Test best way to invest",
        ]

    inputs = tokenizer(sentences, return_tensors="pt", padding=True)
    input_ids = inputs["input_ids"]
    attention_mask = inputs["attention_mask"]

    bad_words = "walk in park"
    bad_words_ids = tokenizer.encode(bad_words, add_prefix_space=True)
    bad_words_ids = [[word_id] for word_id in bad_words_ids]  # Convert to list of list
    if args.vocab_mask:
        logger.debug("bad_words_ids", bad_words_ids)  # noqa: PLE1205
    else:
        bad_words_ids = []

    config = model.config
    eos_token_id = config.eos_token_id
    pad_token_id = config.eos_token_id
    vocab_size = config.vocab_size

    torch_decoded_sequences = []
    beam_outputs = None
    if not args.disable_parity:
        print("-" * 50)
        print("Test PyTorch model and beam search with huggingface transformers...")
        beam_outputs = model.generate(
            input_ids=input_ids,
            attention_mask=attention_mask,
            max_length=args.max_length,
            min_length=args.min_length,
            num_beams=args.num_beams,
            early_stopping=args.early_stopping,
            no_repeat_ngram_size=args.no_repeat_ngram_size,
            eos_token_id=eos_token_id,
            pad_token_id=pad_token_id,
            num_return_sequences=args.num_return_sequences,
            length_penalty=args.length_penalty,
            repetition_penalty=args.repetition_penalty,
            bad_words_ids=bad_words_ids if bad_words_ids else None,
            return_dict_in_generate=True,
            output_scores=args.output_sequences_scores or args.output_token_scores,
        )
        print("input_ids", input_ids)
        print("huggingface transformers outputs:")
        print("sequences", beam_outputs.sequences)
        if args.output_sequences_scores:
            print("sequences_scores", beam_outputs.sequences_scores)
        if args.output_token_scores:
            print("scores", beam_outputs.scores)
        for i, sequence in enumerate(beam_outputs.sequences):
            decoded_sequence = tokenizer.decode(sequence, skip_special_tokens=True)
            torch_decoded_sequences.append(decoded_sequence)
            print(f"{i}: {decoded_sequence}")

    print("-" * 50)
    print("Testing beam search with onnxruntime...")

    if is_greedy:
        inputs = {
            "input_ids": input_ids.cpu().numpy().astype(np.int32),
            "max_length": np.array([args.max_length], dtype=np.int32),
            "min_length": np.array([args.min_length], dtype=np.int32),
            "repetition_penalty": np.array([args.repetition_penalty], dtype=np.float32),
        }
    else:
        inputs = {
            "input_ids": input_ids.cpu().numpy().astype(np.int32),
            "max_length": np.array([args.max_length], dtype=np.int32),
            "min_length": np.array([args.min_length], dtype=np.int32),
            "num_beams": np.array([args.num_beams], dtype=np.int32),
            "num_return_sequences": np.array([args.num_return_sequences], dtype=np.int32),
            "length_penalty": np.array([args.length_penalty], dtype=np.float32),
            "repetition_penalty": np.array([args.repetition_penalty], dtype=np.float32),
        }

    if args.vocab_mask:
        vocab_mask = np.ones((vocab_size), dtype=np.int32)
        if args.vocab_mask:
            for bad_word_id in bad_words_ids:
                vocab_mask[bad_word_id] = 0
        inputs["vocab_mask"] = vocab_mask

    if args.custom_attention_mask:
        inputs["attention_mask"] = create_attention_mask(input_ids, pad_token_id)

    batch_size = input_ids.shape[0]
    if args.prefix_vocab_mask:
        logger.info("Use prefix vocab mask with all ones in ORT, but no corresponding setting for Torch model.")
        prefix_vocab_mask = np.ones((batch_size, vocab_size), dtype=np.int32)
        inputs["prefix_vocab_mask"] = prefix_vocab_mask

    if args.save_test_data:
        test_data_dir = Path(args.output).parent.as_posix()
        logger.debug("test_data_dir", test_data_dir)  # noqa: PLE1205
        from bert_test_data import output_test_data  # noqa: PLC0415

        logger.info(f"Saving test_data to {test_data_dir}/test_data_set_* ...")

        all_inputs = [inputs]
        for i, inputs in enumerate(all_inputs):
            dir = os.path.join(test_data_dir, "test_data_set_" + str(i))
            output_test_data(dir, inputs)

    logger.debug("ORT inputs", inputs)  # noqa: PLE1205

    if args.disable_perf_test:
        return

    logger.debug("Creating ort session......")
    ort_session = create_ort_session(args.output, args.use_gpu, args.use_sln_strict_mode)

    logger.debug("Run ort session......")
    result = ort_session.run(None, inputs)

    # Test performance
    latency = []
    for _ in range(args.total_runs):
        start = time.time()
        _ = ort_session.run(None, inputs)
        latency.append(time.time() - start)

    from benchmark_helper import get_latency_result  # noqa: PLC0415

    batch_size = input_ids.shape[0]
    output = get_latency_result(latency, batch_size)

    print("ORT outputs:")
    sequences = result[0]
    print("sequences", sequences)
    if args.output_sequences_scores:
        print("sequences_scores", result[1])
    if args.output_token_scores:
        print("scores", result[2])

    if is_greedy:
        (batch_size, max_length) = sequences.shape
        ort_decoded_sequences = []
        for i in range(batch_size):
            decoded_sequence = tokenizer.decode(sequences[i], skip_special_tokens=True)
            ort_decoded_sequences.append(decoded_sequence)
            print(f"batch {i} sequence: {decoded_sequence}")
    else:
        (batch_size, num_sequences, max_length) = sequences.shape
        ort_decoded_sequences = []
        for i in range(batch_size):
            for j in range(num_sequences):
                decoded_sequence = tokenizer.decode(sequences[i][j], skip_special_tokens=True)
                ort_decoded_sequences.append(decoded_sequence)
                print(f"batch {i} sequence {j}: {decoded_sequence}")

    if beam_outputs:
        torch_sequences = beam_outputs.sequences.reshape(batch_size, args.num_return_sequences, -1)
        ort_sequences = torch.LongTensor(sequences)
        print("-" * 50)
        print("Torch Sequences:")
        print(torch_sequences)
        print(torch_decoded_sequences)
        print("-" * 50)
        print("ORT Sequences:")
        print(ort_sequences)
        print(ort_decoded_sequences)
        print("-" * 50)
        # Compare the generated text instead of word IDs since ORT pads to max sequence length but Torch not.
        is_same = torch_decoded_sequences == ort_decoded_sequences
        print("Torch and ORT result is", "same" if is_same else "different")
        output["parity"] = is_same

    if args.torch_performance:
        torch_latency_output = test_torch_performance(
            args,
            model,
            input_ids,
            attention_mask,
            eos_token_id,
            pad_token_id,
            bad_words_ids,
        )
        print("Torch Latency", torch_latency_output)

    print("ORT", output)

    return output


def test_t5_model(args: argparse.Namespace, sentences: list[str] | None = None):
    """Test T5 or MT5 model

    Args:
        args (argparse.Namespace): arguments parsed from command line
        sentences (Optional[List[str]], optional): input text. Defaults to None.

    Returns:
        Union[Dict[str, Any], None]: A dictionary with string with metric name, and value can be integer or string.
    """
    assert args.model_type in ["t5", "mt5"]

    if args.prefix_vocab_mask:
        logger.debug("Skipping parity test as prefix vocab mask is not implemented by Hugging Face")
        return None

    tokenizer = T5Tokenizer.from_pretrained(args.model_name_or_path, cache_dir=args.cache_dir)
    tokenizer.padding_side = "left"

    if args.model_type == "t5":
        model = T5ForConditionalGeneration.from_pretrained(
            args.model_name_or_path,
            cache_dir=args.cache_dir,
        )
    else:
        model = MT5ForConditionalGeneration.from_pretrained(
            args.model_name_or_path,
            cache_dir=args.cache_dir,
        )

    # Use different length sentences to test batching
    if sentences is None:
        sentences = [
            "translate English to French: The product is released",
            "summarize: research continues to show that pets bring real health benefits to their owners. Having a dog around can lead to lower levels of stress for both adults and kids.",
            # "summarize: I enjoy walking in the park. It makes my mind feel calm and refreshed. "
            # + "I enjoy looking at the trees, flowers, and wildlife around me, and listening to sound from natural.",
        ]

    inputs = tokenizer(sentences, return_tensors="pt", padding=True)
    input_ids = inputs["input_ids"]
    attention_mask = inputs["attention_mask"]

    bad_words = "walk in park"
    bad_words_ids = tokenizer.encode(bad_words)[:-1]  # exclude the last token (EOS)
    bad_words_ids = [[word_id] for word_id in bad_words_ids]  # Convert to list of list
    if args.vocab_mask:
        logger.debug("bad_words_ids", bad_words_ids)  # noqa: PLE1205
    else:
        bad_words_ids = []

    config = model.config
    eos_token_id = config.eos_token_id
    pad_token_id = config.pad_token_id
    vocab_size = config.vocab_size
    logger.debug(f"eos_token_id:{eos_token_id}, pad_token_id:{pad_token_id}, vocab_size:{vocab_size}")

    torch_decoded_sequences = []
    if not args.disable_parity:
        print("-" * 50)
        print("Test PyTorch model and beam search with huggingface transformers...")
        beam_outputs = model.generate(
            input_ids=input_ids,
            attention_mask=attention_mask,
            max_length=args.max_length,
            min_length=args.min_length,
            num_beams=args.num_beams,
            early_stopping=args.early_stopping,
            no_repeat_ngram_size=args.no_repeat_ngram_size,
            eos_token_id=eos_token_id,
            pad_token_id=pad_token_id,
            num_return_sequences=args.num_return_sequences,
            length_penalty=args.length_penalty,
            repetition_penalty=args.repetition_penalty,
            bad_words_ids=bad_words_ids if bad_words_ids else None,
            return_dict_in_generate=True,
            output_scores=args.output_sequences_scores or args.output_token_scores,
        )

        print("input_ids", input_ids)
        print("huggingface transformers outputs:")
        print("sequences", beam_outputs.sequences)
        if args.output_sequences_scores:
            print("sequences_scores", beam_outputs.sequences_scores)
        if args.output_token_scores:
            print("scores", beam_outputs.scores)
        for i, sequence in enumerate(beam_outputs.sequences):
            decoded_sequence = tokenizer.decode(sequence, skip_special_tokens=True)
            torch_decoded_sequences.append(decoded_sequence)
            print(f"{i}: {decoded_sequence}")

    print("-" * 50)
    print("Testing beam search with onnxruntime...")

    vocab_mask = np.ones((vocab_size), dtype=np.int32)
    if args.vocab_mask:
        for bad_word_id in bad_words_ids:
            vocab_mask[bad_word_id] = 0

    inputs = {
        "input_ids": input_ids.cpu().numpy().astype(np.int32),
        "max_length": np.array([args.max_length], dtype=np.int32),
        "min_length": np.array([args.min_length], dtype=np.int32),
        "num_beams": np.array([args.num_beams], dtype=np.int32),
        "num_return_sequences": np.array([args.num_return_sequences], dtype=np.int32),
        "length_penalty": np.array([args.length_penalty], dtype=np.float32),
        "repetition_penalty": np.array([args.repetition_penalty], dtype=np.float32),
    }

    if args.vocab_mask:
        inputs["vocab_mask"] = vocab_mask

    if args.custom_attention_mask:
        inputs["attention_mask"] = create_attention_mask(input_ids, pad_token_id)

    if args.save_test_data:
        test_data_dir = Path(args.output).parent.as_posix()
        logger.debug("test_data_dir", test_data_dir)  # noqa: PLE1205
        from bert_test_data import output_test_data  # noqa: PLC0415

        all_inputs = [inputs]
        for i, inputs in enumerate(all_inputs):
            dir = os.path.join(test_data_dir, "test_data_set_" + str(i))
            output_test_data(dir, inputs)

    logger.debug("ORT inputs", inputs)  # noqa: PLE1205

    ort_session = create_ort_session(args.output, args.use_gpu, args.use_sln_strict_mode)

    # Test performance
    latency = []
    for _ in range(args.total_runs):
        start = time.time()
        result = ort_session.run(None, inputs)
        latency.append(time.time() - start)
    batch_size = input_ids.shape[0]
    from benchmark_helper import get_latency_result  # noqa: PLC0415

    output = get_latency_result(latency, batch_size)

    print("ORT outputs:")
    sequences = result[0]
    print("sequences", sequences)
    if args.output_sequences_scores:
        print("sequences_scores", result[1])
    if args.output_token_scores:
        print("scores", result[2])

    (batch_size, num_sequences, max_length) = sequences.shape
    ort_decoded_sequences = []
    for i in range(batch_size):
        for j in range(num_sequences):
            decoded_sequence = tokenizer.decode(sequences[i][j], skip_special_tokens=True)
            ort_decoded_sequences.append(decoded_sequence)
            print(f"batch {i} sequence {j}: {decoded_sequence}")

    if not args.disable_parity:
        torch_sequences = beam_outputs.sequences.reshape(batch_size, args.num_return_sequences, -1)
        ort_sequences = torch.LongTensor(sequences)
        print("-" * 50)
        print("Torch Sequences:")
        print(torch_sequences)
        print(torch_decoded_sequences)
        print("-" * 50)
        print("ORT Sequences:")
        print(ort_sequences)
        print(ort_decoded_sequences)
        print("-" * 50)
        # Compare the generated text instead of word IDs since ORT pads to max sequence length but Torch not.
        is_same = torch_decoded_sequences == ort_decoded_sequences
        print("Torch and ORT result is ", "same" if is_same else "different")
        output["parity"] = is_same

    if args.torch_performance:
        torch_latency_output = test_torch_performance(
            args,
            model,
            input_ids,
            attention_mask,
            eos_token_id,
            pad_token_id,
            bad_words_ids,
        )
        print("Torch Latency", torch_latency_output)

    print("ORT", output)
    return output


def main(argv: list[str] | None = None, sentences: list[str] | None = None):
    """Main entry function

    Args:
        argv (Optional[List[str]], optional): _description_. Defaults to None.
        sentences (Optional[List[str]], optional): input text. Defaults to None.

    Raises:
        ValueError: Path does not exist: --encoder_decoder_init_onnx
        ValueError: Path does not exist: --decoder_onnx
        ValueError: --decoder_onnx and --encoder_decoder_init_onnx are not used together for T5

    Returns:
        Union[Dict[str, Any], None]: A dictionary with string with metric name, and value can be integer or string.
    """

    args = parse_arguments(argv)
    setup_logger(args.verbose)

    if args.model_type in ["t5", "mt5"]:
        if args.encoder_decoder_init_onnx and not os.path.exists(args.encoder_decoder_init_onnx):
            raise ValueError(f"Path does not exist: --encoder_decoder_init_onnx {args.encoder_decoder_init_onnx}")
        if args.decoder_onnx and not os.path.exists(args.decoder_onnx):
            raise ValueError(f"Path does not exist: --decoder_onnx {args.decoder_onnx}")
        if (args.encoder_decoder_init_onnx and not args.decoder_onnx) or (
            args.decoder_onnx and not args.encoder_decoder_init_onnx
        ):
            raise ValueError("--decoder_onnx shall use together with --encoder_decoder_init_onnx")

    is_greedy = args.num_beams == 1 and args.num_return_sequences == 1

    if args.model_type == "gpt2" and is_greedy:
        if args.top_p > 0.0 and args.top_p < 1.0:
            convert_generation_model(args, GenerationType.SAMPLING)
            logger.info(
                "The test for gpt2_sampling onnx model is limited to non-custom model with small top_p(e.g <=0.01) value. The result should be the same as gpt2 greedy search."
            )
            if args.top_p > 0.01 or args.custom or args.seed:
                return
        else:
            convert_generation_model(args, GenerationType.GREEDYSEARCH)
    else:
        convert_generation_model(args)

    logger.info("start testing model...")
    if args.model_type in ["t5", "mt5"]:
        result = test_t5_model(args, sentences=sentences)
    else:
        result = test_gpt_model(args, sentences=sentences, is_greedy=is_greedy)

    if result:
        if args.use_external_data_format:
            logger.info(f"Output files: {args.output}, {args.output}.data")
        else:
            logger.info(f"Output file: {args.output}")

    return result


if __name__ == "__main__":
    main()
