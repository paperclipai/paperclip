import numpy
import onnx
from onnx import onnx_pb as onnx_proto

from ..quant_utils import QuantType, attribute_to_kwarg, ms_domain  # noqa: F401
from .base_operator import QuantOperatorBase

"""
    Quantize LSTM
"""


class LSTMQuant(QuantOperatorBase):
    def __init__(self, onnx_quantizer, onnx_node):
        super().__init__(onnx_quantizer, onnx_node)

    def quantize(self):
        """
        parameter node: LSTM node.
        parameter new_nodes_list: List of new nodes created before processing this node.
        return: a list of nodes in topological order that represents quantized Attention node.
        """
        node = self.node
        assert node.op_type == "LSTM"

        if not self.quantizer.is_valid_quantize_weight(node.input[1]) or not self.quantizer.is_valid_quantize_weight(
            node.input[2]
        ):
            super().quantize()
            return

        model = self.quantizer.model
        W = model.get_initializer(node.input[1])  # noqa: N806
        R = model.get_initializer(node.input[2])  # noqa: N806

        if len(W.dims) != 3 or len(R.dims) != 3:
            super().quantize()
            return

        [W_num_dir, W_4_hidden_size, W_input_size] = W.dims  # noqa: N806
        [R_num_dir, R_4_hidden_size, R_hidden_size] = R.dims  # noqa: N806

        if self.quantizer.is_per_channel():
            del W.dims[0]
            del R.dims[0]
            W.dims[0] = W_num_dir * W_4_hidden_size
            R.dims[0] = R_num_dir * R_4_hidden_size

        quant_input_weight_tuple = self.quantizer.quantize_weight_per_channel(
            node.input[1],
            onnx_proto.TensorProto.INT8,
            0,  # self.quantizer.weight_qType?
        )
        quant_recurrent_weight_tuple = self.quantizer.quantize_weight_per_channel(
            node.input[2],
            onnx_proto.TensorProto.INT8,
            0,  # self.quantizer.weight_qType?
        )

        W_quant_weight = model.get_initializer(quant_input_weight_tuple[0])  # noqa: N806
        R_quant_weight = model.get_initializer(quant_recurrent_weight_tuple[0])  # noqa: N806

        W_quant_array = onnx.numpy_helper.to_array(W_quant_weight)  # noqa: N806
        R_quant_array = onnx.numpy_helper.to_array(R_quant_weight)  # noqa: N806

        W_quant_array = numpy.reshape(W_quant_array, (W_num_dir, W_4_hidden_size, W_input_size))  # noqa: N806
        R_quant_array = numpy.reshape(R_quant_array, (R_num_dir, R_4_hidden_size, R_hidden_size))  # noqa: N806

        W_quant_array = numpy.transpose(W_quant_array, (0, 2, 1))  # noqa: N806
        R_quant_array = numpy.transpose(R_quant_array, (0, 2, 1))  # noqa: N806

        W_quant_tranposed = onnx.numpy_helper.from_array(W_quant_array, quant_input_weight_tuple[0])  # noqa: N806
        R_quant_tranposed = onnx.numpy_helper.from_array(R_quant_array, quant_recurrent_weight_tuple[0])  # noqa: N806

        model.remove_initializers([W_quant_weight, R_quant_weight])
        model.add_initializer(W_quant_tranposed)
        model.add_initializer(R_quant_tranposed)

        W_quant_zp = model.get_initializer(quant_input_weight_tuple[1])  # noqa: N806
        R_quant_zp = model.get_initializer(quant_recurrent_weight_tuple[1])  # noqa: N806
        W_quant_scale = model.get_initializer(quant_input_weight_tuple[2])  # noqa: N806
        R_quant_scale = model.get_initializer(quant_recurrent_weight_tuple[2])  # noqa: N806

        if self.quantizer.is_per_channel():
            W_quant_zp.dims[:] = [W_num_dir, W_4_hidden_size]
            R_quant_zp.dims[:] = [R_num_dir, R_4_hidden_size]
            W_quant_scale.dims[:] = [W_num_dir, W_4_hidden_size]
            R_quant_scale.dims[:] = [R_num_dir, R_4_hidden_size]

        inputs = []
        input_len = len(node.input)
        inputs.extend([node.input[0]])
        inputs.extend([quant_input_weight_tuple[0], quant_recurrent_weight_tuple[0]])
        inputs.extend([node.input[3] if input_len > 3 else ""])
        inputs.extend([node.input[4] if input_len > 4 else ""])
        inputs.extend([node.input[5] if input_len > 5 else ""])
        inputs.extend([node.input[6] if input_len > 6 else ""])
        inputs.extend([node.input[7] if input_len > 7 else ""])
        inputs.extend(
            [
                quant_input_weight_tuple[2],
                quant_input_weight_tuple[1],
                quant_recurrent_weight_tuple[2],
                quant_recurrent_weight_tuple[1],
            ]
        )

        kwargs = {}
        for attribute in node.attribute:
            if attribute.name == "layout":
                continue
            kwargs.update(attribute_to_kwarg(attribute))
        kwargs["domain"] = ms_domain

        quant_lstm_name = "" if not node.name else node.name + "_quant"
        quant_lstm_node = onnx.helper.make_node("DynamicQuantizeLSTM", inputs, node.output, quant_lstm_name, **kwargs)
        self.quantizer.new_nodes.append(quant_lstm_node)

        dequantize_node = self.quantizer._dequantize_value(node.input[0])
        if dequantize_node is not None:
            self.quantizer.new_nodes.append(dequantize_node)
