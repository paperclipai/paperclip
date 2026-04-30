from .direct_q8 import Direct8BitOp, QDQDirect8BitOp


class QMaxPool(Direct8BitOp):
    def __init__(self, onnx_quantizer, onnx_node):
        super().__init__(onnx_quantizer, onnx_node)

    def quantize(self):
        node = self.node
        assert node.op_type == "MaxPool"

        # if version is less than 12, go to normal quantize.
        if self.quantizer.opset_version < 12:
            super(Direct8BitOp, self).quantize()
            return

        # Direct 8bits op
        return super().quantize()


class QDQMaxPool(QDQDirect8BitOp):
    def __init__(self, onnx_quantizer, onnx_node):
        super().__init__(onnx_quantizer, onnx_node)

    def quantize(self):
        node = self.node
        assert node.op_type == "MaxPool"

        # if version is less than 12, just no change
        if self.quantizer.opset_version < 12:
            return

        # Direct 8bits op
        return super().quantize()
