# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
from logging import getLogger

import numpy
from numpy import array_equal, ndarray
from onnx import NodeProto, TensorProto, helper, numpy_helper
from onnx_model import OnnxModel

logger = getLogger(__name__)


class FusionUtils:
    def __init__(self, model: OnnxModel):
        self.model: OnnxModel = model

    def cast_graph_input_to_int32(self, input_name: str) -> tuple[bool, str]:
        graph_input = self.model.find_graph_input(input_name)
        if graph_input is not None and graph_input.type.tensor_type.elem_type != TensorProto.INT32:
            cast_output, cast_node = self.cast_input_to_int32(input_name)
            logger.debug(f"Casted graph input {input_name} to int32")
            return True, cast_output

        logger.debug(f"Did not cast graph input {input_name} to int32: found {graph_input is not None}")
        return False, input_name

    def cast_input(self, input_name: str, target_type="int32"):
        output_name = input_name + "_" + target_type

        if target_type == "int32":
            to_type = int(TensorProto.INT32)
        elif target_type == "float32":
            to_type = int(TensorProto.FLOAT)
        elif target_type == "float16":
            to_type = int(TensorProto.FLOAT16)
        else:
            raise ValueError("Invalid target_type: {target_type}")

        cast_node = self.add_cast_node(input_name, to_type, output_name)

        return output_name, cast_node

    def add_cast_node(
        self,
        input_name: str,
        to_type: int,
        output_name: str | None = None,
        output_name_to_node=None,
        graph_name: str | None = None,
    ):
        if output_name is None:
            output_name = input_name + f"_cast_to_{to_type}"

        # Avoid consequent Cast nodes.
        inputs = [input_name]
        if output_name_to_node is None:
            output_name_to_node = self.model.output_name_to_node()
        if input_name in output_name_to_node:
            parent_node = output_name_to_node[input_name]
            if parent_node and parent_node.op_type == "Cast":
                inputs = [parent_node.input[0]]

        cast_node = helper.make_node("Cast", inputs=inputs, outputs=[output_name])

        cast_node.attribute.extend([helper.make_attribute("to", to_type)])
        self.model.add_node(cast_node, graph_name=graph_name)

        return cast_node

    def cast_input_to_int32(self, input_name: str):
        return self.cast_input(input_name, "int32")

    def remove_cast_int32(self, input_name: str):
        input_name_to_nodes = self.model.input_name_to_nodes()
        nodes = input_name_to_nodes[input_name]
        for node in nodes:
            if node.op_type == "Cast":
                is_int32 = False
                for att in node.attribute:
                    if att.name == "to" and att.i == int(TensorProto.INT32):
                        is_int32 = True
                        break
                if is_int32:
                    output_name = node.output[0]
                    self.model.remove_node(node)
                    self.model.replace_input_of_all_nodes(output_name, input_name)

    @staticmethod
    def update_node_input(node, i, new_input_name, input_name_to_nodes):
        old_input_reference = 0
        if (node.input[i] in input_name_to_nodes) and node in input_name_to_nodes[node.input[i]]:
            input_name_to_nodes[node.input[i]].remove(node)
            old_input_reference = len(input_name_to_nodes[node.input[i]])

        node.input[i] = new_input_name

        if new_input_name in input_name_to_nodes:
            input_name_to_nodes[new_input_name].append(node)
        else:
            input_name_to_nodes[new_input_name] = [node]

        return old_input_reference

    @staticmethod
    def skip_parent(model: OnnxModel, node, parent_node, input_name_to_nodes, node_input_index=0, parent_input_index=0):
        """
        Before:
              (input)-->parent-->node-->(output)
        After:
              (input)-->parent-->
                |
                +----->node-->(output)

        This function returns a flag whether the parent node can be removed.
        """

        old_input_name = node.input[node_input_index]
        new_input_name = parent_node.input[parent_input_index]
        old_input_reference = FusionUtils.update_node_input(node, node_input_index, new_input_name, input_name_to_nodes)

        # We can remove the first Transpose if its output is not used (linked to graph output or other nodes) anymore.
        parent_can_be_removed = (old_input_reference == 0) and not model.find_graph_output(old_input_name)

        return parent_can_be_removed

    def get_squeeze_or_unsqueeze_axes(self, node: NodeProto) -> ndarray | None:
        assert node.op_type in ["Squeeze", "Unsqueeze"]

        # For opset >= 13, axes is an input instead of an attribute.
        if len(node.input) > 1:
            return self.model.get_constant_value(node.input[1])

        axes = None
        for attr in node.attribute:
            if attr.name == "axes":
                axes = helper.get_attribute_value(attr)
        return axes

    @staticmethod
    def check_node_attribute(node, attribute_name: str, expected_value, default_value=None):
        """Verify that a node has expected value for an attribute.

        Args:
            node (NodeProto): a node to check
            attribute_name (str): name of attribute
            expected_value (Any): expected value of the attribute
            default_value (Any, optional): default value if the attribute does not exist. Defaults to None.

        Returns:
            bool: whether the check is passed or not
        """
        value = default_value
        for attr in node.attribute:
            if attr.name == attribute_name:
                value = helper.get_attribute_value(attr)

        if isinstance(expected_value, list):
            return (isinstance(value, (ndarray, list))) and array_equal(expected_value, value, equal_nan=False)
        else:
            return value == expected_value

    @staticmethod
    def transpose_2d_int8_tensor(tensor: TensorProto):
        """Transpose a 2-D INT8 TensorProto
        Args:
            tensor (TensorProto): tensor to be transposed
        Returns:
            tensor (TensorProto): transposed tensor
        """
        if not isinstance(tensor, TensorProto):
            raise TypeError(f"Expected input type is an ONNX TensorProto but got {type(tensor)}")

        if len(tensor.dims) != 2 or tensor.data_type != TensorProto.INT8:
            raise ValueError("Only INT8 2-D tensors can be transposed")

        if tensor.raw_data:
            int32_data = numpy.reshape(numpy.frombuffer(tensor.raw_data, dtype="int8"), tensor.dims)
            int32_transposed_data = numpy.transpose(int32_data, [1, 0])
            tensor.raw_data = int32_transposed_data.tobytes()

        else:
            raise ValueError("only raw buffer supported")

        return tensor

    @staticmethod
    def check_qdq_node_for_fusion(node: NodeProto, model: OnnxModel, allow_per_tensor_quantization_only=True):
        """Verify if a provided QuantizeLinear (Q) / DequantizeLinear (DQ) node is a good candidate for fusion.
           It is a good candidate for fusion if:
           (1) The Q/DQ node is for per-tensor quantization if allow_per_tensor_quantization_only is `True`
           (2) The Q/DQ node should have constant scale
           (3) The Q/DQ node should have a zero point of 0
        Args:
            node (NodeProto): a Q/DQ node to check
        Returns:
            bool: whether the check is passed or not
        """
        if node.op_type not in {"QuantizeLinear", "DequantizeLinear"}:
            logger.debug(f"Provided node is not a Q/DQ node. Op Type: {node.op_type}")

        scale = model.get_constant_value(node.input[1])

        # Scale is not constant
        if scale is None:
            return False

        # Not per-tensor quantization
        scale_has_single_element = scale.ndim == 0 or (scale.ndim == 1 and scale.shape[0] == 1)
        if allow_per_tensor_quantization_only and not scale_has_single_element:
            return False

        # If the Q/DQ node has no zero point input, it is assumed to be 0 (per ONNX spec)
        if len(node.input) == 2:
            return True

        # Zero point should be constant and should have a value of 0
        zero_point = model.get_constant_value(node.input[2])

        # Zero point and scale should have same number of dims
        if scale.ndim != zero_point.ndim:
            return False

        # Zero point is not constant or zero point is not zero
        if zero_point is None:
            return False

        return numpy.all(zero_point == 0)

    def check_node_input_value(self, node, input_index: int, expected_value):
        """Verify that a node has expected input value

        Args:
            node (NodeProto): a node to check
            input_index (int): index of its input to be verified
            expected_value (Any): expected value of the input

        Returns:
            bool: whether the check is passed or not
        """
        assert len(node.input) > input_index

        value = self.model.get_constant_value(node.input[input_index])

        if isinstance(expected_value, list):
            return (isinstance(value, (ndarray, list))) and array_equal(expected_value, value, equal_nan=False)
        else:
            return value == expected_value

    def remove_identity_nodes(self):
        """Remove Identity nodes, except those right before graph output."""
        nodes_to_remove = []
        graph_output_names = self.model.get_graphs_output_names()
        for node in self.model.nodes():
            if node.op_type == "Identity":
                if node.output[0] not in graph_output_names:
                    self.model.replace_input_of_all_nodes(node.output[0], node.input[0])
                    nodes_to_remove.append(node)

        if nodes_to_remove:
            self.model.remove_nodes(nodes_to_remove)
            logger.info(f"Removed {len(nodes_to_remove)} Identity nodes")

    def remove_cascaded_cast_nodes(self):
        self.model.remove_cascaded_cast_nodes()

    def remove_useless_cast_nodes(self):
        self.model.remove_useless_cast_nodes()

    def remove_useless_reshape_nodes(self):
        """Remove reshape node that is not needed based on symbolic shape inference: input and output has same shape"""
        shape_infer = self.model.infer_runtime_shape(update=True)
        if shape_infer is None:
            return

        nodes_to_remove = []
        for node in self.model.nodes():
            if node.op_type == "Reshape":
                input_shape = shape_infer.get_edge_shape(node.input[0])
                output_shape = shape_infer.get_edge_shape(node.output[0])
                if input_shape and output_shape and input_shape == output_shape:
                    logger.info(
                        f"Remove reshape node {node.name} since its input shape is same as output: {input_shape}"
                    )
                    nodes_to_remove.append(node)

        if nodes_to_remove:
            graph_input_names = set(self.model.get_graphs_input_names())
            graph_output_names = set(self.model.get_graphs_output_names())
            for node in nodes_to_remove:
                if bool(set(node.output) & graph_output_names):
                    if (
                        not bool(set(node.input) & graph_input_names)
                        and len(self.model.input_name_to_nodes()[node.input[0]]) == 1  # parent has only one child
                    ):
                        self.model.replace_output_of_all_nodes(node.input[0], node.output[0])
                    else:
                        continue
                else:
                    self.model.replace_input_of_all_nodes(node.output[0], node.input[0])
                self.model.remove_node(node)


class NumpyHelper:
    @staticmethod
    def to_array(tensor: TensorProto, fill_zeros: bool = False) -> ndarray:
        # When weights are in external data format but not presented, we can still test the optimizer with two changes:
        # (1) set fill_zeros = True  (2) change load_external_data=False in optimizer.py
        if fill_zeros:
            return ndarray(
                shape=tensor.dims,
                dtype=helper.tensor_dtype_to_np_dtype(tensor.data_type),
            )

        if tensor.data_type == TensorProto.BFLOAT16:
            import onnx_ir as ir  # noqa: PLC0415

            # Use onnx_ir to correctly handle bfloat16 tensors
            return ir.from_proto(tensor).numpy()
        return numpy_helper.to_array(tensor)
