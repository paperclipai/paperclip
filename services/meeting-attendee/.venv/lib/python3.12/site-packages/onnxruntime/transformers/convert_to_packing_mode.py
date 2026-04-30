# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

import argparse
import logging
import os

from constants import (
    AttentionInputIDs,
    AttentionOutputIDs,
    MultiHeadAttentionInputIDs,
    MultiHeadAttentionOutputIDs,
    Operators,
)
from onnx import helper, load_model
from onnx_model import NodeProto, OnnxModel
from shape_infer_helper import SymbolicShapeInferenceHelper

logger = logging.getLogger(__name__)


class PackingAttentionBase:
    def __init__(self, model: OnnxModel, attention_op_type: str):
        self.model: OnnxModel = model
        self.nodes_to_remove: list = []
        self.nodes_to_add: list = []
        self.prune_graph: bool = False
        self.node_name_to_graph_name: dict = {}
        self.this_graph_name: str = self.model.model.graph.name
        self.attention_op_type = attention_op_type
        self.attention_nodes = self.model.get_nodes_by_op_type(attention_op_type)

    def _try_getting_attention_mask(self) -> str | None:
        mask_index = (
            AttentionInputIDs.MASK_INDEX
            if self.attention_op_type == Operators.ATTENTION
            else MultiHeadAttentionInputIDs.KEY_PADDING_MASK
        )
        first_attention_node = self._try_getting_first_attention()
        # check if attention has mask
        if not first_attention_node or len(first_attention_node.input) <= mask_index:
            return None

        attention_mask = first_attention_node.input[mask_index]

        # check if all attention nodes have same mask
        for node in self.attention_nodes:
            if len(node.input) <= mask_index or node.input[mask_index] != attention_mask:
                return None

        return attention_mask

    def _try_getting_first_attention(self) -> NodeProto | None:
        if len(self.attention_nodes) <= 0:
            return None

        return self.attention_nodes[0]

    def _try_getting_last_layernorm(self) -> NodeProto | None:
        last_layernorm_node = None
        for node in self.model.nodes():
            if node.op_type == Operators.LAYERNORM or node.op_type == Operators.SKIPLAYERNORM:
                last_layernorm_node = node
        return last_layernorm_node

    def _are_attentions_supported(self) -> bool:
        raise NotImplementedError()

    def _insert_removepadding_node(self, inputs: list[str], outputs: list[str]) -> None:
        new_node = helper.make_node(
            Operators.REMOVEPADDING,
            inputs=inputs,
            outputs=outputs,
            name=self.model.create_node_name(Operators.REMOVEPADDING),
        )

        new_node.domain = "com.microsoft"
        self.nodes_to_add.append(new_node)
        self.node_name_to_graph_name[new_node.name] = self.this_graph_name

    def _insert_restorepadding_node(self, inputs: list[str], outputs: list[str]) -> None:
        new_node = helper.make_node(
            Operators.RESTOREPADDING,
            inputs=inputs,
            outputs=outputs,
            name=self.model.create_node_name(Operators.RESTOREPADDING),
        )

        new_node.domain = "com.microsoft"
        self.nodes_to_add.append(new_node)
        self.node_name_to_graph_name[new_node.name] = self.this_graph_name

    def _replace_attention_with_packing_attention(self, token_offset: str, cumulative_sequence_length: str) -> None:
        raise NotImplementedError()

    def _get_input_to_remove_padding(self, first_attention_node) -> str | None:
        if self.attention_op_type == Operators.ATTENTION:
            return first_attention_node.input[AttentionInputIDs.INPUT]
        return None

    def convert(self, use_symbolic_shape_infer: bool = True) -> None:
        logger.debug("start converting to packing model...")

        if not self._are_attentions_supported():
            return

        attention_mask = self._try_getting_attention_mask()
        if not attention_mask:
            return

        first_attention_node = self._try_getting_first_attention()
        last_layernorm_node = self._try_getting_last_layernorm()
        if not last_layernorm_node:
            return

        # insert RemovePadding
        input_to_remove_padding = self._get_input_to_remove_padding(first_attention_node)
        if not input_to_remove_padding:
            return

        output_without_padding = input_to_remove_padding + "_no_padding"
        token_offset = input_to_remove_padding + "_token_offset"
        cumulated_seq_len = input_to_remove_padding + "_cumulated_seq_len"
        max_seq_len = input_to_remove_padding + "_max_seq_len"
        self._insert_removepadding_node(
            [input_to_remove_padding, attention_mask],
            [output_without_padding, token_offset, cumulated_seq_len, max_seq_len],
        )
        self.model.replace_input_of_all_nodes(input_to_remove_padding, output_without_padding)
        logger.debug("inserted RemovePadding before Attention")

        # insert RestorePadding
        restorepadding_input = last_layernorm_node.output[0] + "_restore_input"
        self._insert_restorepadding_node([restorepadding_input, token_offset], [last_layernorm_node.output[0]])
        self.model.replace_output_of_all_nodes(last_layernorm_node.output[0], restorepadding_input)
        logger.debug(f"inserted RestorePadding after last {last_layernorm_node.op_type} layer")

        # insert PackedAttention
        self._replace_attention_with_packing_attention(token_offset, cumulated_seq_len)
        logger.debug(f"replaced {self.attention_op_type} with Packed{self.attention_op_type}")

        self.model.remove_nodes(self.nodes_to_remove)
        self.model.add_nodes(self.nodes_to_add, self.node_name_to_graph_name)

        if self.prune_graph:
            self.model.prune_graph()
        elif self.nodes_to_remove or self.nodes_to_add:
            self.model.update_graph()
        self.model.clean_shape_infer()
        if use_symbolic_shape_infer:
            # Use symbolic shape inference since custom operators (like Gelu, SkipLayerNormalization etc)
            # are not recognized by onnx shape inference.
            shape_infer_helper = SymbolicShapeInferenceHelper(self.model.model, verbose=0)
            inferred_model = shape_infer_helper.infer_shapes(self.model.model, auto_merge=True, guess_output_rank=False)
            if inferred_model:
                self.model.model = inferred_model


class PackingAttention(PackingAttentionBase):
    def __init__(self, model: OnnxModel):
        super().__init__(model, Operators.ATTENTION)

    def _are_attentions_supported(self) -> bool:
        for node in self.attention_nodes:
            if OnnxModel.get_node_attribute(node, "past_present_share_buffer") is not None:
                return False
            if OnnxModel.get_node_attribute(node, "do_rotary") is not None:
                return False
            unidirection_attr = OnnxModel.get_node_attribute(node, "unidirectional")
            if unidirection_attr is not None and unidirection_attr != 0:
                return False
            if len(node.input) > AttentionInputIDs.PAST and not node.input[AttentionInputIDs.PAST]:
                return False
            if (
                len(node.input) > AttentionInputIDs.PAST_SEQUENCE_LENGTH
                and not node.input[AttentionInputIDs.PAST_SEQUENCE_LENGTH]
            ):
                return False
        return True

    def _replace_attention_with_packing_attention(self, token_offset: str, cumulative_sequence_length: str) -> None:
        for attention in self.attention_nodes:
            attention_bias = (
                attention.input[AttentionInputIDs.ATTENTION_BIAS]
                if len(attention.input) > AttentionInputIDs.ATTENTION_BIAS
                else ""
            )
            packed_attention = helper.make_node(
                Operators.PACKEDATTENTION,
                inputs=[
                    attention.input[AttentionInputIDs.INPUT],
                    attention.input[AttentionInputIDs.WEIGHTS],
                    attention.input[AttentionInputIDs.BIAS],
                    token_offset,
                    cumulative_sequence_length,
                    attention_bias,
                ],
                outputs=[attention.output[AttentionOutputIDs.OUTPUT]],
                name=self.model.create_node_name(Operators.PACKEDATTENTION),
            )

            attributes = []
            for attr in attention.attribute:
                if attr.name in ["num_heads", "qkv_hidden_sizes", "scale"]:
                    attributes.append(attr)

            packed_attention.attribute.extend(attributes)
            packed_attention.domain = "com.microsoft"
            self.nodes_to_add.append(packed_attention)
            self.nodes_to_remove.append(attention)
            self.node_name_to_graph_name[packed_attention.name] = self.this_graph_name

        logger.info("Converted %d Attention nodes to PackedAttention.", len(self.attention_nodes))


class PackingMultiHeadAttention(PackingAttentionBase):
    def __init__(self, model: OnnxModel):
        super().__init__(model, Operators.MULTI_HEAD_ATTENTION)

    def _check_empty_input(self, node, index: int, name: str):
        """Check a node does not have given input."""
        if len(node.input) > index:
            if len(node.input[index]) > 0:
                logger.error(f"node input {index} ({name}) is not supported in PackedMultiHeadAttention: {node}")
                return False
        return True

    def _check_empty_output(self, node, index: int, name: str):
        """Check a node does not have given input."""
        if len(node.output) > index:
            if len(node.output[index]) > 0:
                logger.error(f"node output {index} ({name}) is not supported in PackedMultiHeadAttention: {node}")
                return False
        return True

    def _are_attentions_supported(self) -> bool:
        for node in self.attention_nodes:
            for attr in node.attribute:
                if attr.name not in ["num_heads", "mask_filter_value", "scale"]:
                    logger.error(f"node attribute {attr.name} is not supported in PackedMultiHeadAttention: {node}")
                    return False

            if node.input[MultiHeadAttentionInputIDs.KEY] and not node.input[MultiHeadAttentionInputIDs.VALUE]:
                logger.error("packed kv format is not supported in PackedMultiHeadAttention")
                return False

            if not (
                self._check_empty_input(node, MultiHeadAttentionInputIDs.PAST_KEY, "past_key")
                and self._check_empty_input(node, MultiHeadAttentionInputIDs.PAST_VALUE, "past_key")
                and self._check_empty_output(node, MultiHeadAttentionOutputIDs.PRESENT_KEY, "present_key")
                and self._check_empty_output(node, MultiHeadAttentionOutputIDs.PRESENT_VALUE, "present_key")
            ):
                return False

        return True

    def _replace_attention_with_packing_attention(self, token_offset: str, cumulative_sequence_length: str) -> None:
        gated_relative_pos_bias_count = 0
        for mha in self.attention_nodes:
            attention_bias = (
                mha.input[MultiHeadAttentionInputIDs.ATTENTION_BIAS]
                if len(mha.input) > MultiHeadAttentionInputIDs.ATTENTION_BIAS
                else ""
            )
            packed_mha = helper.make_node(
                Operators.PACKED_MULTI_HEAD_ATTENTION,
                inputs=[
                    mha.input[MultiHeadAttentionInputIDs.QUERY],
                    mha.input[MultiHeadAttentionInputIDs.KEY],
                    mha.input[MultiHeadAttentionInputIDs.VALUE],
                    mha.input[MultiHeadAttentionInputIDs.BIAS],
                    token_offset,
                    cumulative_sequence_length,
                    attention_bias,
                ],
                outputs=[mha.output[MultiHeadAttentionOutputIDs.OUTPUT]],
                name=self.model.create_node_name(Operators.PACKED_MULTI_HEAD_ATTENTION),
            )

            attributes = []
            for attr in mha.attribute:
                if attr.name in ["num_heads", "mask_filter_value", "scale"]:
                    attributes.append(attr)

            packed_mha.attribute.extend(attributes)
            packed_mha.domain = "com.microsoft"
            self.nodes_to_add.append(packed_mha)
            self.nodes_to_remove.append(mha)
            self.node_name_to_graph_name[packed_mha.name] = self.this_graph_name

            # Append token_offset input to GatedRelativePositionBias
            if attention_bias:
                rel_pos_bias_node = self.model.get_parent(mha, MultiHeadAttentionInputIDs.ATTENTION_BIAS)
                if (
                    rel_pos_bias_node
                    and rel_pos_bias_node.op_type == "GatedRelativePositionBias"
                    and len(rel_pos_bias_node.input) == 6
                ):
                    rel_pos_bias_node.input.append(token_offset)
                    gated_relative_pos_bias_count += 1

        logger.info("Converted %d MultiHeadAttention nodes to PackedMultiHeadAttention.", len(self.attention_nodes))
        logger.info("Converted %d GatedRelativePositionBias nodes to packing mode.", gated_relative_pos_bias_count)

    def _get_input_to_remove_padding(self, first_attention_node) -> str | None:
        # When there are query, key and value inputs, we need to find the first input of the parent MatMul node.
        matmul = self.model.get_parent(first_attention_node, 0)
        if matmul and matmul.op_type == "MatMul":
            return matmul.input[0]
        return None


class PackingMode:
    def __init__(self, model: OnnxModel):
        self.model = model

    def convert(self, use_symbolic_shape_infer: bool = True) -> None:
        if self.model.get_nodes_by_op_type(Operators.ATTENTION):
            if self.model.get_nodes_by_op_type(Operators.MULTI_HEAD_ATTENTION):
                logger.error("Packing mode does not support both Attention and MultiHeadAttention in same graph.")
                return None
            packing = PackingAttention(self.model)
            return packing.convert(use_symbolic_shape_infer)
        elif self.model.get_nodes_by_op_type(Operators.MULTI_HEAD_ATTENTION):
            packing = PackingMultiHeadAttention(self.model)
            return packing.convert(use_symbolic_shape_infer)
        else:
            logger.error("Packing mode requires either Attention or MultiHeadAttention node in onnx graph.")
            return None


def _parse_arguments():
    parser = argparse.ArgumentParser(
        description="Convert to packing mode tool for ONNX Runtime. It converts BERT like model to use packing mode."
    )
    parser.add_argument("--input", required=True, type=str, help="input onnx model path")

    parser.add_argument("--output", required=True, type=str, help="optimized onnx model path")

    parser.add_argument("--verbose", required=False, action="store_true", help="show debug information.")
    parser.set_defaults(verbose=False)

    parser.add_argument(
        "--use_external_data_format",
        required=False,
        action="store_true",
        help="use external data format to store large model (>2GB)",
    )
    parser.set_defaults(use_external_data_format=False)

    args = parser.parse_args()

    return args


def _setup_logger(verbose):
    if verbose:
        logging.basicConfig(
            format="[%(filename)s:%(lineno)s - %(funcName)20s()] %(message)s",
            level=logging.DEBUG,
        )
    else:
        logging.basicConfig(format="%(funcName)20s: %(message)s", level=logging.INFO)


def main():
    args = _parse_arguments()

    _setup_logger(args.verbose)

    logger.debug(f"arguments:{args}")

    if os.path.realpath(args.input) == os.path.realpath(args.output):
        logger.warning("Specified the same input and output path. Note that this may overwrite the original model")

    model = load_model(args.input)
    packing_mode = PackingMode(OnnxModel(model))
    packing_mode.convert()
    packing_mode.model.save_model_to_file(args.output, use_external_data_format=args.use_external_data_format)


if __name__ == "__main__":
    main()
