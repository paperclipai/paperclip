from .operators.activation import QDQRemovableActivation, QLinearActivation
from .operators.argmax import QArgMax
from .operators.attention import AttentionQuant
from .operators.base_operator import QuantOperatorBase
from .operators.binary_op import QLinearBinaryOp
from .operators.concat import QLinearConcat
from .operators.conv import ConvInteger, QDQConv, QLinearConv
from .operators.direct_q8 import Direct8BitOp, QDQDirect8BitOp
from .operators.embed_layernorm import EmbedLayerNormalizationQuant
from .operators.gather import GatherQuant, QDQGather
from .operators.gavgpool import QGlobalAveragePool
from .operators.gemm import QDQGemm, QLinearGemm
from .operators.lstm import LSTMQuant
from .operators.matmul import MatMulInteger, QDQMatMul, QLinearMatMul
from .operators.maxpool import QDQMaxPool, QMaxPool
from .operators.norm import QDQNormalization
from .operators.pad import QDQPad, QPad
from .operators.pooling import QLinearPool
from .operators.qdq_base_operator import QDQOperatorBase
from .operators.resize import QDQResize, QResize
from .operators.softmax import QLinearSoftmax
from .operators.split import QDQSplit, QSplit
from .operators.where import QDQWhere, QLinearWhere
from .quant_utils import QuantizationMode

CommonOpsRegistry = {
    "Gather": GatherQuant,
    "Transpose": Direct8BitOp,
    "EmbedLayerNormalization": EmbedLayerNormalizationQuant,
}

IntegerOpsRegistry = {
    "Conv": ConvInteger,
    "MatMul": MatMulInteger,
    "Attention": AttentionQuant,
    "LSTM": LSTMQuant,
}
IntegerOpsRegistry.update(CommonOpsRegistry)

QLinearOpsRegistry = {
    "ArgMax": QArgMax,
    "Conv": QLinearConv,
    "Gemm": QLinearGemm,
    "MatMul": QLinearMatMul,
    "Add": QLinearBinaryOp,
    "Mul": QLinearBinaryOp,
    "Relu": QLinearActivation,
    "Clip": QLinearActivation,
    "LeakyRelu": QLinearActivation,
    "Sigmoid": QLinearActivation,
    "MaxPool": QMaxPool,
    "GlobalAveragePool": QGlobalAveragePool,
    "Split": QSplit,
    "Pad": QPad,
    "Reshape": Direct8BitOp,
    "Squeeze": Direct8BitOp,
    "Unsqueeze": Direct8BitOp,
    "Resize": QResize,
    "AveragePool": QLinearPool,
    "Concat": QLinearConcat,
    "Softmax": QLinearSoftmax,
    "Where": QLinearWhere,
}
QLinearOpsRegistry.update(CommonOpsRegistry)

QDQRegistry = {
    "Conv": QDQConv,
    "ConvTranspose": QDQConv,
    "Gemm": QDQGemm,
    "Clip": QDQRemovableActivation,
    "Relu": QDQRemovableActivation,
    "Reshape": QDQDirect8BitOp,
    "Transpose": QDQDirect8BitOp,
    "Squeeze": QDQDirect8BitOp,
    "Unsqueeze": QDQDirect8BitOp,
    "Resize": QDQResize,
    "MaxPool": QDQMaxPool,
    "AveragePool": QDQDirect8BitOp,
    "Slice": QDQDirect8BitOp,
    "Pad": QDQPad,
    "MatMul": QDQMatMul,
    "Split": QDQSplit,
    "Gather": QDQGather,
    "GatherElements": QDQGather,
    "Where": QDQWhere,
    "InstanceNormalization": QDQNormalization,
    "LayerNormalization": QDQNormalization,
    "BatchNormalization": QDQNormalization,
    "TopK": QDQDirect8BitOp,
    "CumSum": QDQOperatorBase,
}


def CreateDefaultOpQuantizer(onnx_quantizer, node):  # noqa: N802
    return QuantOperatorBase(onnx_quantizer, node)


def CreateOpQuantizer(onnx_quantizer, node):  # noqa: N802
    registry = IntegerOpsRegistry if onnx_quantizer.mode == QuantizationMode.IntegerOps else QLinearOpsRegistry
    if node.op_type in registry:
        op_quantizer = registry[node.op_type](onnx_quantizer, node)
        if op_quantizer.should_quantize():
            return op_quantizer
    return QuantOperatorBase(onnx_quantizer, node)


def CreateQDQQuantizer(onnx_quantizer, node):  # noqa: N802
    if node.op_type in QDQRegistry:
        return QDQRegistry[node.op_type](onnx_quantizer, node)
    return QDQOperatorBase(onnx_quantizer, node)
