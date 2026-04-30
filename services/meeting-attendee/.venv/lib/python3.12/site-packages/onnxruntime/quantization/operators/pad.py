# --------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
from __future__ import annotations

from typing import Any

import numpy as np
import onnx

from ..quant_utils import (
    TENSOR_NAME_QUANT_SUFFIX,
    QuantizedValue,
    QuantizedValueType,
    attribute_to_kwarg,
    quantize_nparray,
)
from .base_operator import QuantOperatorBase
from .qdq_base_operator import QDQOperatorBase


class QPad(QuantOperatorBase):
    def __init__(self, onnx_quantizer, onnx_node):
        super().__init__(onnx_quantizer, onnx_node)

    def quantize(self):
        node = self.node
        assert node.op_type == "Pad"

        # Only after version 11, it has the optional constant_value
        # If input[0] is not quantized, do not quanitize this node
        if (self.quantizer.opset_version < 11) or (node.input[0] not in self.quantizer.quantized_value_map):
            super().quantize()
            return
        quantized_input_value = self.quantizer.quantized_value_map[node.input[0]]

        kwargs = {}
        for attribute in node.attribute:
            kv = attribute_to_kwarg(attribute)
            kwargs.update(kv)

        if "mode" not in kwargs or kwargs["mode"] == b"constant":
            if len(node.input) > 2 and node.input[2] != "":  # There is 3rd input 'constant_value'
                zp_tensor = self.quantizer.model.get_initializer(quantized_input_value.zp_name)
                scale_tensor = self.quantizer.model.get_initializer(quantized_input_value.scale_name)
                if zp_tensor is None or scale_tensor is None:
                    super().quantize()
                    return

                padding_constant_initializer = self.quantizer.model.get_initializer(node.input[2])
                if padding_constant_initializer is not None:
                    zp_array = onnx.numpy_helper.to_array(zp_tensor)
                    zp_value = zp_array.item() if zp_array.ndim == 0 else zp_array[0]
                    scale_array = onnx.numpy_helper.to_array(scale_tensor)
                    scale_value = scale_array.item() if scale_array.ndim == 0 else scale_array[0]
                    padding_constant_array = onnx.numpy_helper.to_array(padding_constant_initializer)
                    quantized_padding_constant_array = quantize_nparray(
                        self.quantizer.activation_qType,
                        padding_constant_array,
                        scale_value,
                        zp_value,
                    )
                    quantized_padding_constant_name = node.input[2] + TENSOR_NAME_QUANT_SUFFIX
                    quantized_padding_constant_initializer = onnx.numpy_helper.from_array(
                        quantized_padding_constant_array,
                        quantized_padding_constant_name,
                    )
                    # Suppose this padding constant initializer only used by the node
                    self.quantizer.model.remove_initializer(padding_constant_initializer)
                    self.quantizer.model.add_initializer(quantized_padding_constant_initializer)
                    node.input[2] = quantized_padding_constant_name
                else:
                    # TODO: check quantize_inputs after sub graph is supported
                    pad_value_qnodes = self.quantizer._get_quantize_input_nodes(
                        node,
                        2,
                        self.quantizer.activation_qType,
                        quantized_input_value.scale_name,
                        quantized_input_value.zp_name,
                        initial_type=scale_tensor.data_type,
                    )
                    self.quantizer.new_nodes.extend(pad_value_qnodes)
                    node.input[2] = pad_value_qnodes[0].output[0]
            else:
                # In quantized format, the `zero` before quantization is mapped
                # to quantized_input_value.zp_name. Thus, padding 0 to
                # original tensor should become padding zero point to quantized
                # tensor.
                if len(node.input) == 2:
                    # Feed quantization's zero point to padding node.
                    node.input.append(quantized_input_value.zp_name)
                else:
                    # Assign quantization's zero point to padding node.
                    assert node.input[2] == ""
                    node.input[2] = quantized_input_value.zp_name

        # Create an entry for output quantized value
        quantized_output_value = QuantizedValue(
            node.output[0],
            node.output[0] + TENSOR_NAME_QUANT_SUFFIX,
            quantized_input_value.scale_name,
            quantized_input_value.zp_name,
            QuantizedValueType.Input,
        )
        self.quantizer.quantized_value_map[node.output[0]] = quantized_output_value

        node.input[0] = quantized_input_value.q_name
        node.output[0] = quantized_output_value.q_name
        self.quantizer.new_nodes += [node]


class QDQPad(QDQOperatorBase):
    def __init__(self, onnx_quantizer, onnx_node):
        super().__init__(onnx_quantizer, onnx_node)

    def _get_pad_const_val(self, attrs_dict: dict[str, Any]) -> np.ndarray | None:
        """
        Returns the Pad's constant padding value. Returns `None` if the padding value is
        not constant (i.e., comes from a dynamic input).
        """
        const_val = None
        onnx_tensor_type = self.quantizer.model.get_tensor_type(self.node.input[0])
        if onnx_tensor_type is None:
            return None

        np_dtype = onnx.helper.tensor_dtype_to_np_dtype(onnx_tensor_type.elem_type)
        if self.quantizer.opset_version < 11:
            const_val = np.array(attrs_dict.get("value", 0), dtype=np_dtype)
        elif len(self.node.input) >= 3 and self.node.input[2]:
            const_val = self.quantizer.model.get_constant_value(self.node.input[2])
        else:
            const_val = np.array(0, dtype=np_dtype)

        return const_val

    def _should_quantize_output_same_as_input(self) -> bool:
        """
        Returns true if Pad's output should use the same quantization parameters as input[0]
        """
        attrs_dict = {}
        for attribute in self.node.attribute:
            kv = attribute_to_kwarg(attribute)
            attrs_dict.update(kv)

        pad_mode = attrs_dict.get("mode", b"constant")
        if pad_mode in (b"reflect", b"edge", b"wrap"):
            # These modes pad the output with a value that already exists in the input.
            # So, we can quantize the output the same as the input.
            return True

        # For 'constant' mode, if padding with 0, we can also quantize the output the same as the input
        # because our quantization floating-point range always includes 0.
        if pad_mode == b"constant":
            pad_val = self._get_pad_const_val(attrs_dict)
            if pad_val is not None and pad_val.dtype in (np.float32, np.float16):
                return float(pad_val.item()) == 0

        return False

    def quantize(self):
        assert self.node.op_type == "Pad"

        for input_name in self.node.input:
            if input_name:
                self.quantizer.quantize_activation_tensor(input_name)

        if not self.disable_qdq_for_node_output:
            if self._should_quantize_output_same_as_input():
                self.quantizer.quantize_output_same_as_input(self.node.output[0], self.node.input[0], self.node.name)
            else:
                self.quantizer.quantize_activation_tensor(self.node.output[0])
