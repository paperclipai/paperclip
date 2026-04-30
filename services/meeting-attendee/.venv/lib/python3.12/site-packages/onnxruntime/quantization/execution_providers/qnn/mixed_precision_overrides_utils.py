# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------
from __future__ import annotations

import logging
from dataclasses import dataclass

import onnx

from ...quant_utils import QuantType
from ...tensor_quant_overrides import QuantTypeInfo, TensorQuantOverridesHelper


@dataclass
class TensorTypeRequest:
    """
    Bundles desired quantization type requests for a tensor. A distinction is made between the
    produced type and the consumed type.
    """

    # The tensor's quant type at the producer end. If None, assumed to be the default activation quant type.
    producer: QuantTypeInfo | None

    # The tensor's quant type received by a set of consumer nodes.
    # If None, assumed to be the default activation quant type for all consumers.
    # consumers[1] is a set of consumer node names.
    consumers: tuple[QuantTypeInfo, set[str]] | None


class MixedPrecisionTensorQuantOverridesFixer:
    """
    Helper that generates tensor quantization overrides for mixed-precision QDQ models.

    Specifically, this helper fixes an initial set of quantization overrides that assign a non-default
    activation quantization type to one or more tensors by doing the following:
     - Inferring which other tensors need to be overridden to the non-default activation quantization type.
     - Inserting quantization data type conversions.

    Example:
    --------

    Float model:

    input_0 --> Op1 --> Op3 --> Op5 --> Op6 --> output_0
                                 ^
                                 |
    input_1 --> Op2 -+-> Op4 ----+
                     |
                     +-> Op7 --> output_1
                     |
                     +-> Op8 --> output_2

    If we'd like to quantize this model to uint8 precision, but would like to make sure tensor "Op4_out"
    is quantized to 16-bit, then we would specify the following initial tensor quantization overrides:

    ```
    init_overrides = {"Op4_out": [{"quant_type": QuantType.QUInt16}]}
    ```

    These initial overrides may not create a valid model because Op4 and Op5 may require both the input and output
    to be the same type (e.g., uint16). This helper fixes the overrides so that input/output data types
    are valid:

    ```
    overrides = TensorQuantOverridesHelper(init_overrides)

    fixer = MixedPrecisionTensorQuantOverridesFixer.create_from_model(overrides, model, QuantType.QUInt8)
    fixer.apply(
        default_activation_qtype=QuantType.QUInt8,
        default_activation_symmetric=False,
    )
    ```

    The above snippet generates the following "fixed" overrides (get via overrides.get_dict()):

    {
      "Op2_out": [{"quant_type": QUInt8, "convert": {"quant_type": QUInt16, "recv_nodes": {"Op4"}}}],
      "Op3_out": [{"quant_type": QUInt8, "convert": {"quant_type": QUInt16, "recv_nodes": {"Op5"}}}],
      "Op4_out": [{"quant_type": QUInt16}],
      "Op5_out": [{"quant_type": QUInt16, "convert": {"quant_type": QUInt8, "recv_nodes": {"Op6"}}}]
    }

    How to interpret the fixed overrides:
    - Op2's output is consumed by Op4, Op7, and Op8. Op4 consumes the converted u16 type,
      but Op7 and Op8 consume the original u8 type.
    - Op3's output is converted from u8 to u16. Op5 consumes the converted u16 type.
    - Op4's output is just u16 (not converted). All consumers of Op4_out get the u16 type.
    - Op5's output is converted from u16 to u8. Op6 consumes the u8 type.
    """

    def __init__(
        self,
        overrides: TensorQuantOverridesHelper,
        producers: dict[str, onnx.NodeProto],
        consumers: dict[str, list[onnx.NodeProto]],
        value_infos: dict[str, onnx.ValueInfoProto],
        initializers: dict[str, onnx.TensorProto],
    ):
        """
        Params:
            overrides: The initial tensor quantization overrides to fix.
            producers: Dictionary that maps a tensor name to the producer node that generates the tensor.
            consumers: Dictionary that maps a tensor name to the consumer nodes that take the tensor as input.
            value_infos: Dictionary that maps a tensor name to its onnx.ValueInfoProto.
            initializers: Dictionary that maps an initializer name to its onnx.TensorProto.
        """
        self.overrides = overrides
        self.consumers = consumers
        self.producers = producers
        self.value_infos = value_infos
        self.initializers = initializers

    @staticmethod
    def create_from_model(
        overrides: TensorQuantOverridesHelper, model: onnx.ModelProto, default_activation_qtype: QuantType
    ) -> MixedPrecisionTensorQuantOverridesFixer:
        """
        Helper function that creates an instance of this class from a loaded ONNX model.

        Params:
            overrides: The initial tensor quantization overrides to fix.
            model: Loaded ONNX model
            default_activation_qtype: The intended default activation quantization type.
                                      Used to validate the initial overrides.

        Returns:
            Initialized MixedPrecisionTensorQuantOverridesFixer object
        """
        model = onnx.shape_inference.infer_shapes(model)  # Need to infer shapes to get value_infos

        # Build dictionaries that enable convenient lookups of initializers and value_infos by name.
        initializers = {initializer.name: initializer for initializer in model.graph.initializer}
        value_infos = {vi.name: vi for vi in model.graph.value_info}
        value_infos.update({ot.name: ot for ot in model.graph.output})
        value_infos.update({it.name: it for it in model.graph.input})

        # Ensure that the user-provided initial overrides are actually valid.
        valid, err = overrides.is_valid(initializers, set(value_infos), default_activation_qtype)
        if not valid:
            pprint_overrides = overrides.pprint_str(indent=4)
            logging.error(f"Provided invalid tensor quantization overrides:\n{pprint_overrides}")
            raise ValueError(err)

        consumers = {}
        producers = {}

        # Build dictionaries that map a tensor name to the consumer or producer nodes.
        for node in model.graph.node:
            for input_name in node.input:
                if input_name:
                    if input_name not in consumers:
                        consumers[input_name] = []

                    consumers[input_name].append(node)

            for output_name in node.output:
                producers[output_name] = node

        return MixedPrecisionTensorQuantOverridesFixer(overrides, producers, consumers, value_infos, initializers)

    def apply(
        self,
        default_activation_qtype: QuantType,
        default_activation_symmetric: bool,
    ):
        """
        Fixes the initial tensor quantization overrides (in-place) for use in mixed-precision QDQ models.

        Params:
            default_activation_qtype: The intended default activation quantization type.
            default_activation_symmetric: The intended default symmetry used to quantize activations.
        """
        type_requests = self.get_desired_tensor_types(default_activation_qtype, default_activation_symmetric)

        # Use type requests to "fix" tensor quantization overrides by adding
        # quantization type conversions where necessary.
        for tensor_name, type_req in type_requests.items():
            all_consumers = {node.name for node in self.consumers.get(tensor_name, [])}
            has_producer_req = type_req.producer is not None
            has_consumer_req = bool(type_req.consumers)

            # Only producer type: Add conversion back to default activation type
            if has_producer_req and not has_consumer_req:
                self._update_converted_tensor(
                    tensor_name, type_req.producer, QuantTypeInfo(default_activation_qtype), all_consumers
                )
            # Only consumers
            elif not has_producer_req and has_consumer_req:
                prod_type_info = self.overrides.get_node_output_qtype_info(tensor_name, default_activation_qtype)
                consumer_type_info = type_req.consumers[0]

                if prod_type_info != consumer_type_info:
                    self._update_converted_tensor(
                        tensor_name, prod_type_info, consumer_type_info, type_req.consumers[1]
                    )
                else:
                    if not self._check_nodes_are_not_convert_consumers(tensor_name, type_req.consumers[1]):
                        raise ValueError(
                            f"Tensor override for '{tensor_name}' converts the type for consumers that need the original type."
                        )
            # Both producer and consumers
            elif has_producer_req and has_consumer_req:
                prod_type_info = type_req.producer
                consumer_type_info = type_req.consumers[0]

                if prod_type_info != consumer_type_info:
                    self._update_converted_tensor(
                        tensor_name, prod_type_info, consumer_type_info, type_req.consumers[1]
                    )
                else:
                    consumers_for_original_type = all_consumers.difference(type_req.consumers[1])

                    if len(consumers_for_original_type) == 0:
                        # All consumers want the overridden type, so no need for convert nodes!
                        # Just add the override to the new new if not already present.
                        if tensor_name not in self.overrides:
                            self.overrides[tensor_name] = [{}]
                            prod_type_info.save_to_dict(self.overrides[tensor_name][0])

                        assert "convert" not in self.overrides[tensor_name][0]
                    else:
                        # Some consumers don't want the overridden type.
                        self._update_converted_tensor(
                            tensor_name,
                            prod_type_info,
                            QuantTypeInfo(default_activation_qtype),
                            consumers_for_original_type,
                        )
            else:
                raise ValueError(f"TypeRequest for tensor {tensor_name} has no producer or consumers.")

        # Done. Check if the overrides are valid.
        valid, err = self.overrides.is_valid(self.initializers, set(self.value_infos), default_activation_qtype)
        if not valid:
            pprint_overrides = self.overrides.pprint_str(indent=4)
            logging.error(
                f"Generated invalid tensor quantization overrides for mixed-precision QDQ model:\n{pprint_overrides}"
            )
            raise ValueError(err)

    def get_desired_tensor_types(
        self,
        default_activation_qtype: QuantType,
        default_activation_symmetric: bool,
    ) -> dict[str, TensorTypeRequest]:
        """
        Iterates through the initial tensor quantization overrides and builds a set of TensorTypeRequests objects
        that describe the quantization types required at each tensor. These TensorTypeRequests objects are ultimately
        used to generated the "fixed" overrides.

        Params:
            default_activation_qtype: The intended default activation quantization type.
            default_activation_symmetric: The intended default symmetry used to quantize activations.

        Returns:
            TensorTypeRequest objects as a dict that maps a tensor name to its requested types.
        """
        type_requests = {}
        default_activation_type_info = QuantTypeInfo(default_activation_qtype, default_activation_symmetric)

        # Scan tensor overrides for type conversion requests.
        for tensor_name, override_list in self.overrides.items():
            if not self.__is_tensor_quantizable(tensor_name):
                continue  # Skip non-quantizable tensors (e.g., not a float)

            if tensor_name in self.initializers:
                continue  # Skip initializers

            if not override_list or len(override_list) > 1:
                continue  # Skip per-channel stuff

            override_dict = override_list[0]
            quant_type_info = QuantTypeInfo.load_from_dict(override_dict, default_activation_type_info.quant_type)
            producer_node = self.producers.get(tensor_name)  # None if this is a model input

            if quant_type_info != default_activation_type_info and "convert" not in override_dict:
                if producer_node is not None:
                    self._add_type_requests_for_node(type_requests, quant_type_info, producer_node)

                # Find all consumer nodes of `tensor_name` and update their inputs/outputs to the new type.
                for consumer_node in self.consumers.get(tensor_name, []):
                    self._add_type_requests_for_node(type_requests, quant_type_info, consumer_node)

        return type_requests

    def _add_type_requests_for_node(
        self,
        type_requests: dict[str, TensorTypeRequest],
        quant_type_info: QuantTypeInfo,
        node: onnx.NodeProto,
    ):
        """
        Adds TensorTypeRequest objects for a given node, assuming that we want all its inputs and outputs
        to have the same quantization type (as specified by the `quant_type_info` parameter).

        Params:
            type_requests: Dictionary of type requests to append to for this node.
            quant_type_info: The quantization type to use for inputs and outputs.
            node: The node for which the TensorTypeRequest objects are created and added to type_requests.
        """
        # Add output side
        for output_name in node.output:
            if not self.__is_tensor_quantizable(output_name):
                continue

            if output_name not in type_requests:
                type_requests[output_name] = TensorTypeRequest(quant_type_info, None)
            else:
                if (
                    type_requests[output_name].producer is not None
                    and type_requests[output_name].producer != quant_type_info
                ):
                    raise ValueError(f"Tensor {output_name} has multiple types.")

                type_requests[output_name].producer = quant_type_info

        # Add the consumer side
        for input_name in node.input:
            if input_name and input_name not in self.initializers and self.__is_tensor_quantizable(input_name):
                if input_name not in type_requests:
                    type_requests[input_name] = TensorTypeRequest(None, None)

                if type_requests[input_name].consumers is None:
                    type_requests[input_name].consumers = (quant_type_info, set())

                if type_requests[input_name].consumers[0] != quant_type_info:
                    raise ValueError(f"Tensor {input_name} has consumers requesting different types.")

                if not node.name:
                    raise ValueError(
                        f"Node of type {node.op_type} with output 0 {node.output[0]} does not have a name!"
                    )

                type_requests[input_name].consumers[1].add(node.name)

    def _update_converted_tensor(
        self,
        tensor_name: str,
        producer_type_info: QuantTypeInfo,
        consumer_type_info: QuantTypeInfo,
        consumer_names: set[str],
    ):
        """
        Updates the tensor quantization overrides for a tensor that is converted from one type to another.

        Params:
            tensor_name: The name of the tensor for which to update overrides.
            producer_type_info: Info for the tensor's produced type.
            consumer_type_info: Info for the tensor's consumed (i.e., converted) type.
            consumer_names: Nodes names of consumers that consume the converted type.
        """
        if tensor_name not in self.overrides or not self.overrides[tensor_name]:
            self.overrides[tensor_name] = [{}]
            producer_type_info.save_to_dict(self.overrides[tensor_name][0])

        overrides = self.overrides[tensor_name][0]
        if producer_type_info != QuantTypeInfo.load_from_dict(overrides):
            raise ValueError(f"Desired producer quant_type for {tensor_name} doesn't match existing type.")

        if consumer_names:
            if "convert" not in overrides:
                overrides["convert"] = {}
                consumer_type_info.save_to_dict(overrides["convert"])

            convert_dict = overrides["convert"]
            if consumer_type_info != QuantTypeInfo.load_from_dict(convert_dict):
                raise ValueError(f"Desired consumer quant_type for {tensor_name} doesn't match existing type.")

            if "recv_nodes" not in convert_dict:
                convert_dict["recv_nodes"] = set()

            convert_dict["recv_nodes"].update(consumer_names)

    def _check_nodes_are_not_convert_consumers(self, tensor_name: str, node_names: set[str]):
        """
        Returns true if the given nodes do not consume/receive a converted quantization type.

        Params:
            tensor_name: The name of the tensor to check.
            node_names: Set of node names that should not be consumers of the converted type.
        """
        if tensor_name not in self.overrides or not self.overrides[tensor_name]:
            return True

        overrides = self.overrides[tensor_name][0]

        if "convert" not in overrides:
            return True

        convert_dict = overrides["convert"]

        if "recv_nodes" not in convert_dict:
            return False

        return not convert_dict["recv_nodes"].intersection(node_names)

    def __is_tensor_quantizable(self, tensor_name):
        weight = self.initializers.get(tensor_name)
        if weight is not None:
            if weight.data_type in (onnx.TensorProto.FLOAT, onnx.TensorProto.FLOAT16):
                return True
        elif tensor_name in self.value_infos:
            vi = self.value_infos[tensor_name]
            if vi.type.HasField("tensor_type") and vi.type.tensor_type.elem_type in (
                onnx.TensorProto.FLOAT,
                onnx.TensorProto.FLOAT16,
            ):
                return True

        return False
