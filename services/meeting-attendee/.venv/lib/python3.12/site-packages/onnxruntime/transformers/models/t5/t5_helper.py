# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
# -------------------------------------------------------------------------

import logging
import os
from pathlib import Path

import torch
from float16 import float_to_float16_max_diff
from onnx_model import OnnxModel
from optimizer import optimize_model
from t5_decoder import T5Decoder, T5DecoderHelper
from t5_encoder_decoder_init import T5EncoderDecoderInit, T5EncoderDecoderInitHelper
from transformers import MT5ForConditionalGeneration, T5ForConditionalGeneration

from onnxruntime import InferenceSession

logger = logging.getLogger(__name__)

PRETRAINED_T5_MODELS = ["t5-small", "t5-base", "t5-large", "t5-3b", "t5-11b"]
PRETRAINED_MT5_MODELS = [
    "google/mt5-small",
    "google/mt5-base",
    "google/mt5-large",
    "google/mt5-xl",
    "google/mt5-xxl",
]


class T5Helper:
    @staticmethod
    def get_onnx_path(
        output_dir: str,
        model_name_or_path: str,
        suffix: str = "",
        new_folder: bool = False,
    ) -> str:
        """Build onnx path

        Args:
            output_dir (str): output directory
            model_name_or_path (str): pretrained model name, or path to the model checkpoint
            suffix (str, optional): suffix like "_encoder" or "_decoder_fp16" will be appended to file name. Defaults to None.
            new_folder (bool, optional): create a new directory for the model. Defaults to False.

        Returns:
            str: path of onnx model
        """
        model_name = model_name_or_path
        if os.path.isdir(model_name_or_path):
            model_name = Path(model_name_or_path).parts[-1]
        else:
            model_name.split("/")[-1]

        model_name += suffix

        directory = os.path.join(output_dir, model_name) if new_folder else output_dir
        return os.path.join(directory, model_name + ".onnx")

    @staticmethod
    def load_model(
        model_name_or_path: str,
        cache_dir: str,
        device: torch.device,
        model_type: str = "t5",
        state_dict_path: str = "",
        encoder_decoder_init: bool = False,
    ) -> dict[str, T5EncoderDecoderInit | T5Decoder]:
        """Load model given a pretrained name or path, then build models for ONNX conversion.

        Args:
            model_name_or_path (str): pretrained model name or path
            cache_dir (str): cache directory
            device (torch.device): device to run the model
            model_type (str, optional): model type "t5" or "mt5"
            state_dict_path(str, optional): state dictionary path
            encoder_decoder_init (bool, optional): combine encoder and decoder kv cache initialization into one model.
        Returns:
            Dict[str, torch.nn.Module]: mapping from name to modules for ONNX conversion.
        """
        if model_type == "t5":
            model = T5ForConditionalGeneration.from_pretrained(model_name_or_path, cache_dir=cache_dir)
        elif model_type == "mt5":
            model = MT5ForConditionalGeneration.from_pretrained(model_name_or_path, cache_dir=cache_dir)
        else:
            raise ValueError("only support mode_type=t5 or mt5")

        if state_dict_path:
            model.load_state_dict(torch.load(state_dict_path))

        decoder = T5Decoder(model.decoder, model.lm_head, model.config)
        decoder.eval().to(device)

        encoder = T5EncoderDecoderInit(
            model.encoder,
            model.decoder,
            model.lm_head,
            model.config,
            decoder_start_token_id=None,
            output_cross_only=not encoder_decoder_init,
        )

        encoder_name = "encoder_decoder_init" if encoder_decoder_init else "encoder"
        return {encoder_name: encoder, "decoder": decoder}

    @staticmethod
    def export_onnx(
        model: T5Decoder | T5EncoderDecoderInit,
        device: torch.device,
        onnx_model_path: str,
        verbose: bool = True,
        use_external_data_format: bool = False,
        use_decoder_input_ids: bool = True,
        use_int32_inputs: bool = False,
    ):
        if isinstance(model, T5EncoderDecoderInit):
            T5EncoderDecoderInitHelper.export_onnx(
                model,
                device,
                onnx_model_path,
                use_decoder_input_ids,
                verbose,
                use_external_data_format,
                use_int32_inputs,
            )
        else:
            T5DecoderHelper.export_onnx(
                model,
                device,
                onnx_model_path,
                verbose,
                use_external_data_format,
                use_int32_inputs,
            )

    @staticmethod
    def auto_mixed_precision(
        onnx_model: OnnxModel,
        op_block_list: list[str] | None = None,
        force_fp16_logits: bool = False,
        use_symbolic_shape_infer: bool = True,
    ):
        """Convert model to mixed precision.
           It detects whether original model has fp16 precision weights, and set parameters for float16 conversion automatically.
        Args:
            onnx_model (OnnxModel): optimized ONNX model
            op_block_list (List[str], optional): operators need to run in fp32.
            force_fp16_logits (bool, optional): force logits and last MatMul node to be in float16. Defaults to False.
            use_symbolic_shape_infer (bool, optional): use symbolic shape inference to convert float to float16. Defaults to True.
        Returns:
            parameters(dict): a dictionary of parameters used in float16 conversion
        """
        if op_block_list is None:
            op_block_list = [
                "SimplifiedLayerNormalization",
                "SkipSimplifiedLayerNormalization",
                "Relu",
                "Add",
            ]

        op_full_set = {node.op_type for node in onnx_model.nodes()}
        fp32_op_set = set(op_block_list)
        fp16_op_set = op_full_set.difference(fp32_op_set)
        logger.info(f"fp32 op: {fp32_op_set} fp16 op: {fp16_op_set}")

        # logits is the first output
        logits_output_name = onnx_model.graph().output[0].name

        # We use the weight in last MatMul node to detect whether the model is stored with float16 weights from training.
        is_weight_fp16_precision = False
        output_name_to_node = onnx_model.output_name_to_node()
        assert logits_output_name in output_name_to_node
        node = output_name_to_node[logits_output_name]
        last_matmul_node = None
        if node.op_type == "MatMul":
            last_matmul_node = node
            logger.info(f"Found last MatMul node for logits: {node.name}")
            initializer = None
            for input in node.input:
                initializer = onnx_model.get_initializer(input)
                if initializer is not None:
                    break

            # when the max difference of value after converting float to float16 is lower than a threshold (1e-6),
            # we can deduce that the weights are stored in float16 precision.
            max_diff = float_to_float16_max_diff(initializer)
            logger.debug(f"max diff of converting weights in last MatMul node {node.name}: {max_diff}")
            is_weight_fp16_precision = max_diff < 1e-6
        else:
            logger.warning(f"Failed to find MatMul node for logits. Found {node.op_type} of node {node.name}")

        keep_io_types = []
        node_block_list = []
        if (not is_weight_fp16_precision) and (last_matmul_node is not None) and not force_fp16_logits:
            # When original weight is float32 precision, keep logits and last MatMul in float32 could get better precision.
            keep_io_types = [logits_output_name]
            node_block_list = [last_matmul_node.name]

        if "Add" not in op_block_list:
            input_name_to_nodes = onnx_model.input_name_to_nodes()
            fp32_add = 0
            changed = True
            add_nodes = onnx_model.get_nodes_by_op_type("Add")
            while changed:
                changed = False
                for node in add_nodes:
                    if node.name not in node_block_list:
                        parents = onnx_model.get_parents(node, output_name_to_node)
                        children = onnx_model.get_children(node, input_name_to_nodes)
                        blocked_children = [
                            child for child in children if child.op_type in op_block_list or child in node_block_list
                        ]
                        blocked_parents = [
                            parent for parent in parents if parent.op_type in op_block_list or parent in node_block_list
                        ]
                        # If any child or parent is in fp32, we place the Add node to fp32.
                        if (len(blocked_children) + len(blocked_parents)) > 0:
                            node_block_list.append(node.name)
                            fp32_add += 1
                            changed = True
            fp16_add = len(add_nodes) - fp32_add
            logger.info(f"node counter of Add operator: fp32={fp32_add} fp16={fp16_add}")

        logger.info(f"node_block_list: {node_block_list}")

        parameters = {
            "keep_io_types": keep_io_types,
            "op_block_list": op_block_list,
            "node_block_list": node_block_list,
            "force_fp16_initializers": is_weight_fp16_precision,
        }

        logger.info(f"auto_mixed_precision parameters: {parameters}")
        if use_symbolic_shape_infer:
            onnx_model.convert_float_to_float16(use_symbolic_shape_infer=True, **parameters)
        else:
            # Workaround when symbolic shape inference fails.
            # Need enable shape_infer_before_optimization in convert_to_onnx.py as well.
            from float16 import convert_float_to_float16  # noqa: PLC0415

            convert_float_to_float16(
                onnx_model.model,
                disable_shape_infer=True,
                **parameters,
            )

        return parameters

    @staticmethod
    def optimize_onnx(
        onnx_model_path: str,
        optimized_model_path: str,
        is_float16: bool,
        num_attention_heads: int,
        hidden_size: int,
        use_external_data_format: bool = False,
        auto_mixed_precision: bool = True,
        use_gpu: bool = False,
        force_fp16_io: bool = False,
    ):
        """Optimize ONNX model with an option to convert it to use mixed precision."""

        from fusion_options import FusionOptions  # noqa: PLC0415

        optimization_options = None
        if is_float16:
            optimization_options = FusionOptions("t5")
            # SkipLayerNormalization is faster but might bring accuracy drop since it uses fp16 accumulation.
            optimization_options.enable_skip_layer_norm = not auto_mixed_precision

        m = optimize_model(
            onnx_model_path,
            model_type="t5",
            num_heads=num_attention_heads,
            hidden_size=hidden_size,
            opt_level=0,
            optimization_options=optimization_options,
            use_gpu=use_gpu,
        )

        if is_float16:
            if auto_mixed_precision:
                T5Helper.auto_mixed_precision(m, force_fp16_logits=force_fp16_io)
            else:
                m.convert_model_float32_to_float16(cast_input_output=force_fp16_io)

        m.save_model_to_file(optimized_model_path, use_external_data_format, all_tensors_to_one_file=True)

    @staticmethod
    def verify_onnx(
        model: T5Decoder | T5EncoderDecoderInit,
        ort_session: InferenceSession,
        device: torch.device,
        use_int32_inputs: bool,
    ):
        """Compare the result from PyTorch and OnnxRuntime to verify the ONNX model is good."""
        if isinstance(model, T5EncoderDecoderInit):
            return T5EncoderDecoderInitHelper.verify_onnx(model, ort_session, device, use_int32_inputs)

        return T5DecoderHelper.verify_onnx(model, ort_session, device, use_int32_inputs)
