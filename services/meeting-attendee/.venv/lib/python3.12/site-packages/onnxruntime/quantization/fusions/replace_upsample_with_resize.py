# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------
from __future__ import annotations

import numpy as np
import onnx

from ..onnx_model import ONNXModel
from .fusion import Fusion


class ReplaceUpsampleWithResize(Fusion):
    """Replace Upsample with Resize."""

    def __init__(self, model: ONNXModel, opset):
        """Initialize."""
        super().__init__(model, "Resize", "Upsample")
        self.opset = opset

    def fuse(
        self,
        node: onnx.NodeProto,
        input_name_to_nodes: dict[str, list[onnx.NodeProto]],
        output_name_to_node: dict[str, onnx.NodeProto],
    ):
        """Replace Upsample with Resize."""
        mode = None
        for attr in node.attribute:
            if attr.name == "mode":
                mode = attr.s.decode("utf-8")
                break

        scales_input = None
        if self.opset > 7:
            scales_input = node.input[1] if len(node.input) > 1 else ""
            resize_inputs = [node.input[0], node.name + "_roi", scales_input]
        else:
            if self.opset == 7:
                for attr in node.attribute:
                    if attr.name == "scales":
                        scales_input = attr.floats
                        break

                scales_input = np.array(list(scales_input), np.float32)
            else:
                h_scale = 1
                w_scale = 1
                for attr in node.attribute:
                    if attr.name == "height_scale":
                        h_scale = attr.float
                    elif attr.name == "width_scale":
                        w_scale = attr.float

                scales_input = np.array([1, 1, h_scale, w_scale], np.float32)

            scales_tensor = onnx.helper.make_tensor(
                name=node.name + "_scales",
                data_type=onnx.TensorProto.FLOAT,
                dims=scales_input.shape,
                vals=scales_input.flatten().tolist(),
            )

            scales_node = onnx.helper.make_node(
                "Constant", inputs=[], outputs=[node.name + "_scales"], value=scales_tensor
            )

            self.nodes_to_add.append(scales_node)

            resize_inputs = [node.input[0], node.name + "_roi", node.name + "_scales"]

        roi_tensor = onnx.helper.make_tensor(
            name=node.name + "_roi",
            data_type=onnx.TensorProto.FLOAT,
            dims=(len(scales_input) * 2,),
            vals=[0] * len(scales_input) + [1] * len(scales_input),
        )

        roi_node = onnx.helper.make_node("Constant", inputs=[], outputs=[node.name + "_roi"], value=roi_tensor)

        resize_node = onnx.helper.make_node(
            op_type="Resize", inputs=resize_inputs, outputs=node.output, mode=mode, nearest_mode="floor"
        )

        self.nodes_to_remove.append(node)
        self.nodes_to_add.append(roi_node)
        self.nodes_to_add.append(resize_node)

    def apply(self) -> bool:
        """Apply."""
        if super().apply():
            self.model.topological_sort()
            return True
        return False
