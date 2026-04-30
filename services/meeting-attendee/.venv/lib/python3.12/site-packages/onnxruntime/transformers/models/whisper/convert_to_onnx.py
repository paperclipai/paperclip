# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.  See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------

import argparse
import logging
import os
import warnings

import onnx
import torch
from benchmark_helper import Precision, create_onnxruntime_session, prepare_environment, setup_logger
from whisper_chain import chain_model
from whisper_encoder import WhisperEncoder
from whisper_helper import PRETRAINED_WHISPER_MODELS, WhisperHelper

from onnxruntime.quantization.matmul_nbits_quantizer import (
    KQuantWeightOnlyQuantConfig,
    MatMulNBitsQuantizer,
    QuantFormat,
)

logger = logging.getLogger("")

PROVIDERS = {
    "cpu": "CPUExecutionProvider",
    "cuda": "CUDAExecutionProvider",
}


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser()

    conversion_args = parser.add_argument_group("Conversion Process Args")
    optional_inputs = parser.add_argument_group("Optional Inputs (for WhisperBeamSearch op)")
    optional_outputs = parser.add_argument_group("Optional Outputs (for WhisperBeamSearch op)")
    quant_args = parser.add_argument_group("INT8 Quantization Args")

    #################################
    # Conversion options for Whisper
    #################################

    conversion_args.add_argument(
        "-m",
        "--model_name_or_path",
        required=False,
        default=PRETRAINED_WHISPER_MODELS[0],
        type=str,
        help="Model path, or pretrained model name in the list: " + ", ".join(PRETRAINED_WHISPER_MODELS),
    )

    conversion_args.add_argument(
        "--model_impl",
        required=False,
        default="hf",
        choices=["hf", "openai"],
        type=str,
        help="Select implementation for export of encoder and decoder subgraphs",
    )

    conversion_args.add_argument(
        "--cache_dir",
        required=False,
        type=str,
        default=os.path.join(".", "cache_models"),
        help="Directory to cache pre-trained models",
    )

    conversion_args.add_argument(
        "--output",
        required=False,
        type=str,
        default=os.path.join(".", "onnx_models"),
        help="Output directory",
    )

    conversion_args.add_argument(
        "-o",
        "--optimize_onnx",
        required=False,
        action="store_true",
        help="Use optimizer.py to optimize onnx model",
    )
    conversion_args.set_defaults(optimize_onnx=False)

    conversion_args.add_argument(
        "--use_gpu",
        required=False,
        action="store_true",
        help="Use GPU for model inference",
    )
    conversion_args.set_defaults(use_gpu=False)

    conversion_args.add_argument(
        "-p",
        "--precision",
        required=False,
        type=Precision,
        default=Precision.FLOAT32,
        choices=[Precision.FLOAT32, Precision.FLOAT16, Precision.INT8, Precision.INT4],
        help="Precision of model to run. fp32 for full precision, fp16 for half precision, int8/int4 for quantization",
    )

    conversion_args.add_argument(
        "--use_int64_inputs",
        required=False,
        action="store_true",
        help="Use int64 instead of int32 for input_ids and attention_mask.",
    )
    conversion_args.set_defaults(use_int64_inputs=False)

    conversion_args.add_argument(
        "-r",
        "--provider",
        required=False,
        type=str,
        default="cpu",
        choices=list(PROVIDERS.keys()),
        help="Provider to benchmark. Default is CPUExecutionProvider.",
    )

    conversion_args.add_argument(
        "--verbose",
        required=False,
        action="store_true",
        help="Enable verbose logging",
    )
    conversion_args.set_defaults(verbose=False)

    conversion_args.add_argument(
        "-e",
        "--use_external_data_format",
        required=False,
        action="store_true",
        help="Save weights in external file. Necessary for 'small', 'medium', and 'large' models. Optional for 'tiny' and 'base' models.",
    )
    conversion_args.set_defaults(use_external_data_format=False)

    conversion_args.add_argument(
        "-w",
        "--overwrite",
        required=False,
        action="store_true",
        help="Overwrite existing ONNX model",
    )
    conversion_args.set_defaults(overwrite=False)

    conversion_args.add_argument(
        "--separate_encoder_and_decoder_init",
        required=False,
        action="store_true",
        help="Do not merge encoder and decoder init to initialize past KV caches. Output 3 instead of 2 ONNX models.",
    )
    conversion_args.set_defaults(separate_encoder_and_decoder_init=False)

    conversion_args.add_argument(
        "--no_beam_search_op",
        required=False,
        action="store_true",
        help="Do not produce model with WhisperBeamSearch op, which chains encdecinit and decoder models into one op.",
    )
    conversion_args.set_defaults(no_beam_search_op=False)

    conversion_args.add_argument(
        "--use_decoder_masked_mha",
        required=False,
        action="store_true",
        help="Use DecoderMaskedMultiHeadAttention kernel for improved performance. This is currently an experimental feature.",
    )
    conversion_args.set_defaults(use_decoder_masked_mha=False)

    #############################################################
    # Optional inputs for Whisper
    # (listed below in the order that WhisperBeamSearch expects)
    #############################################################

    optional_inputs.add_argument(
        "-v",
        "--use_vocab_mask",
        required=False,
        action="store_true",
        help="Use vocab_mask as an extra graph input to enable specific logits processing",
    )
    optional_inputs.set_defaults(use_vocab_mask=False)

    optional_inputs.add_argument(
        "-u",
        "--use_prefix_vocab_mask",
        required=False,
        action="store_true",
        help="Use prefix_vocab_mask as an extra graph input to enable specific logits processing",
    )
    optional_inputs.set_defaults(use_prefix_vocab_mask=False)

    optional_inputs.add_argument(
        "-f",
        "--use_forced_decoder_ids",
        required=False,
        action="store_true",
        help="Use decoder_input_ids as an extra graph input to the beam search op",
    )
    optional_inputs.set_defaults(use_forced_decoder_ids=False)

    optional_inputs.add_argument(
        "-l",
        "--use_logits_processor",
        required=False,
        action="store_true",
        help="Use logits_processor as an extra graph input to enable specific logits processing",
    )
    optional_inputs.set_defaults(use_specific_logits_processor=False)

    optional_inputs.add_argument(
        "--collect_cross_qk",
        required=False,
        action="store_true",
        help="Beam search model collect stacked cross QK.",
    )
    optional_inputs.set_defaults(collect_cross_qk=False)

    optional_inputs.add_argument(
        "--extra_decoding_ids",
        required=False,
        action="store_true",
        help="Need extra starting decoding ids for some feature like cross qk. Default if false.",
    )
    optional_inputs.set_defaults(extra_decoding_ids=False)

    optional_inputs.add_argument(
        "-t",
        "--use_temperature",
        required=False,
        action="store_true",
        help="Use temperature as an extra graph input for the WhisperBeamSearch op",
    )
    optional_inputs.set_defaults(use_temperature=False)

    optional_inputs.add_argument(
        "--no_repeat_ngram_size",
        type=int,
        default=0,
        help="default to 0",
    )

    #############################################################
    # Optional outputs for Whisper
    # (listed below in the order that WhisperBeamSearch expects)
    #############################################################

    optional_outputs.add_argument(
        "--output_sequence_scores",
        required=False,
        action="store_true",
        help="Beam search model output scores for each generated sequence.",
    )
    optional_outputs.set_defaults(output_sequence_scores=False)

    optional_outputs.add_argument(
        "--output_scores",
        required=False,
        action="store_true",
        help="Beam search model output scores over vocab per generated token.",
    )
    optional_outputs.set_defaults(output_scores=False)

    optional_outputs.add_argument(
        "--output_cross_qk",
        required=False,
        action="store_true",
        help="Beam search model output collected qk as output. Also hint collect_cross_qk",
    )
    optional_outputs.set_defaults(output_cross_qk=False)

    optional_outputs.add_argument(
        "--cross_qk_onnx_model",
        required=False,
        type=str,
        default=None,
        help="The model which consumes cross_qk outputs.",
    )

    optional_outputs.add_argument(
        "--output_no_speech_probs",
        required=False,
        action="store_true",
        help="Beam search model output no speech probs which is computed from the encoder/context-decoder graph.",
    )
    optional_outputs.set_defaults(output_no_speech_probs=False)

    ###################################
    # Quantization options for Whisper
    ###################################

    quant_args.add_argument(
        "--accuracy_level",
        default=0,
        required=False,
        type=int,
        help="Accuracy level of the 4-bit quantized MatMul computation.",
    )

    quant_args.add_argument(
        "--quantize_symmetric",
        required=False,
        action="store_true",
        help="Quantize weights symmetrically",
    )
    quant_args.set_defaults(quantize_symmetric=False)

    args = parser.parse_args(argv)

    # Collect cross QKs if either flag is enabled
    args.collect_cross_qk = args.collect_cross_qk or args.output_cross_qk

    # FP32 CPU can be supported here once the DMMHA CPU kernel bugs are fixed
    args.use_decoder_masked_mha = args.use_decoder_masked_mha and args.provider == "cuda"

    return args


# quant_method is reserved for mixed precision in future
def make_quant_algo_config(precision, quant_method: str, matmul_nodes=None):
    customized_weight_config = {}
    quant_algo_config = None

    # need to use k_quant for int8
    if precision == Precision.INT8:
        for node_name in matmul_nodes:
            customized_weight_config[node_name] = {"bits": 8}
        quant_algo_config = KQuantWeightOnlyQuantConfig(customized_weight_config=customized_weight_config)
    else:
        quant_algo_config = KQuantWeightOnlyQuantConfig(customized_weight_config=customized_weight_config)

    return quant_algo_config


def export_onnx_models(
    model_name_or_path,
    model_impl,
    cache_dir,
    output_dir,
    use_gpu,
    use_external_data_format,
    optimize_onnx,
    precision,
    verbose,
    use_forced_decoder_ids: bool = False,
    merge_encoder_and_decoder_init: bool = True,
    no_beam_search_op: bool = False,
    use_decoder_masked_mha: bool = False,
    output_qk: bool = False,
    overwrite: bool = False,
    use_int32_inputs: bool = True,
    accuracy_level: int = 0,
    quantize_symmetric: bool = False,
    provider: str = "cpu",
):
    device = torch.device("cuda" if use_gpu else "cpu")
    if not use_gpu:
        accuracy_level = 4  # change to 4 for CPU EP
    use_fp16_inputs = precision == Precision.FLOAT16 or (precision in (Precision.INT8, Precision.INT4) and use_gpu)

    models = WhisperHelper.load_model(
        model_name_or_path,
        model_impl,
        cache_dir,
        device,
        torch.float16 if use_fp16_inputs else torch.float32,
        merge_encoder_and_decoder_init,
        no_beam_search_op,
        output_qk,
    )
    config = models["decoder"].config

    if (not use_external_data_format) and (config.num_hidden_layers > 24):
        logger.warning("You MUST pass `--use_external_data_format` because model size > 2GB")
        raise Exception("Please pass `--use_external_data_format` for this model.")

    output_paths = []
    for name, model in models.items():
        print(f"========> Handling {name} model......")
        filename_suffix = "_" + name

        onnx_path = WhisperHelper.get_onnx_path(
            output_dir,
            model_name_or_path,
            suffix=filename_suffix,
            new_folder=False,
        )

        # Export to ONNX
        if overwrite or not os.path.exists(onnx_path):
            logger.info(f"Exporting ONNX model to {onnx_path}")
            WhisperHelper.export_onnx(
                model,
                onnx_path,
                PROVIDERS[provider],
                verbose,
                use_external_data_format,
                use_fp16_inputs=use_fp16_inputs,
                use_int32_inputs=use_int32_inputs,
                use_encoder_hidden_states=(name == "decoder_init"),
                use_kv_cache_inputs=(name == "decoder"),
            )
        else:
            logger.info(f"Skip exporting: existing ONNX model {onnx_path}")

        # Optimize ONNX model
        if optimize_onnx or precision != Precision.FLOAT32:
            output_path = WhisperHelper.get_onnx_path(
                output_dir,
                model_name_or_path,
                suffix=filename_suffix + "_" + str(precision),
                new_folder=False,
            )

            if overwrite or not os.path.exists(output_path):
                if optimize_onnx:
                    logger.info(f"Optimizing model to {output_path}")
                    WhisperHelper.optimize_onnx(
                        onnx_path,
                        output_path,
                        precision == Precision.FLOAT16,
                        model.config.encoder_attention_heads,
                        model.config.d_model,
                        model.config.decoder_layers,
                        use_external_data_format,
                        use_gpu=use_gpu,
                        provider=provider,
                        is_decoder=(name == "decoder"),
                        no_beam_search_op=no_beam_search_op,
                        use_decoder_masked_mha=use_decoder_masked_mha,
                        output_qk=output_qk,
                    )
                    # Remove old ONNX model and old data file
                    if os.path.exists(onnx_path):
                        os.remove(onnx_path)
                    if os.path.exists(onnx_path + ".data"):
                        os.remove(onnx_path + ".data")
                    onnx_path = output_path

                    if isinstance(model, WhisperEncoder):
                        model.verify_onnx(
                            onnx_path,
                            PROVIDERS[provider],
                            use_fp16_inputs=use_fp16_inputs,
                        )
                    else:
                        model.verify_onnx(
                            onnx_path,
                            PROVIDERS[provider],
                            use_fp16_inputs=use_fp16_inputs,
                            use_int32_inputs=use_int32_inputs,
                        )

                if precision in (Precision.INT8, Precision.INT4):
                    onnx_model = onnx.load(onnx_path, load_external_data=True)
                    matmul_nodes = [node.name for node in onnx_model.graph.node if node.op_type == "MatMul"]
                    quant_algo_config = make_quant_algo_config(precision, "k_quant", matmul_nodes)

                    quant = MatMulNBitsQuantizer(
                        model=onnx_model,
                        block_size=32,
                        is_symmetric=quantize_symmetric,
                        accuracy_level=accuracy_level,
                        quant_format=QuantFormat.QOperator,
                        op_types_to_quantize=("MatMul",),
                        algo_config=quant_algo_config,
                    )
                    quant.process()
                    if os.path.exists(output_path):
                        os.remove(output_path)
                    if os.path.exists(output_path + ".data"):
                        os.remove(output_path + ".data")
                    onnx.save_model(
                        quant.model.model,
                        output_path,
                        save_as_external_data=True,
                        all_tensors_to_one_file=True,
                        location=os.path.basename(output_path) + ".data",
                        size_threshold=0,
                        convert_attribute=False,
                    )
            else:
                logger.info(f"Skip optimizing: existing ONNX model {onnx_path}")
        else:
            output_path = onnx_path

        output_paths.append(output_path)

    return output_paths


def main(argv=None):
    warnings.warn(
        "This example is deprecated. Use the Olive recipe instead: "
        "https://github.com/microsoft/olive-recipes/tree/main",
        DeprecationWarning,
        stacklevel=2,
    )
    args = parse_arguments(argv)

    setup_logger(args.verbose)

    logger.info(f"Arguments:{args}")

    cache_dir = args.cache_dir
    output_dir = args.output if not args.output.endswith(".onnx") else os.path.dirname(args.output)
    prepare_environment(cache_dir, output_dir, args.use_gpu)

    if args.precision == Precision.FLOAT16:
        assert args.use_gpu, "fp16 requires --use_gpu"

    output_paths = export_onnx_models(
        args.model_name_or_path,
        args.model_impl,
        cache_dir,
        output_dir,
        args.use_gpu,
        args.use_external_data_format,
        args.optimize_onnx,
        args.precision,
        args.verbose,
        args.use_forced_decoder_ids,
        not args.separate_encoder_and_decoder_init,
        args.no_beam_search_op,
        args.use_decoder_masked_mha,
        args.output_cross_qk,
        args.overwrite,
        not args.use_int64_inputs,
        args.accuracy_level,
        args.quantize_symmetric,
        args.provider,
    )

    max_diff = 0
    if not args.no_beam_search_op:
        logger.info("Chaining model ... :")
        args.beam_model_output_dir = WhisperHelper.get_onnx_path(
            output_dir,
            args.model_name_or_path,
            suffix="_beamsearch",
            new_folder=False,
        )
        for path in output_paths:
            if "encoder_decoder" in path or "encoder" in path:
                args.encoder_path = path
            elif "decoder" in path:
                args.decoder_path = path
        chain_model(args)
        output_paths.append(args.beam_model_output_dir)

        # Check chained model
        ort_session = create_onnxruntime_session(
            args.beam_model_output_dir,
            use_gpu=args.use_gpu,
            provider=args.provider,
        )
        device = torch.device("cuda" if args.use_gpu else "cpu")

        # Wrap parity check in try-except to allow export to continue in case this produces an error
        try:
            with torch.no_grad():
                # Verify batched decoding with prompts for OpenAI implementation
                if args.model_impl == "openai" and args.use_forced_decoder_ids:
                    max_diff = WhisperHelper.verify_onnx(
                        args.model_name_or_path, cache_dir, ort_session, device, batch_size=2, prompt_mode=True
                    )
                else:
                    max_diff = WhisperHelper.verify_onnx(args.model_name_or_path, cache_dir, ort_session, device)
            if max_diff > 1e-4:
                logger.warning("PyTorch and ONNX Runtime results are NOT close")
            else:
                logger.info("PyTorch and ONNX Runtime results are close")
        except Exception as e:
            logger.warning(
                f"An error occurred while trying to verify parity between PyTorch and ONNX Runtime: {e}", exc_info=True
            )

        # Remove extra ONNX models saved in output directory
        for _file in os.listdir(output_dir):
            if "_beamsearch" not in _file and "_jump_times" not in _file:
                path = os.path.join(output_dir, _file)
                os.remove(path)
                if path in output_paths:
                    output_paths.remove(path)

    else:
        # Create ancillary JSON files for ONNX Runtime GenAI and/or Hugging Face's Optimum
        WhisperHelper.save_processing(
            args.model_name_or_path,
            args.provider,
            args.separate_encoder_and_decoder_init,
            args.use_decoder_masked_mha,
            args.output_cross_qk,
            next(iter(filter(lambda path: "encoder" in path, output_paths))),
            next(iter(filter(lambda path: "decoder" in path, output_paths))),
            output_dir,
            cache_dir,
        )

    logger.info(f"Done! Outputs: {output_paths}")
    return max_diff


if __name__ == "__main__":
    main()
