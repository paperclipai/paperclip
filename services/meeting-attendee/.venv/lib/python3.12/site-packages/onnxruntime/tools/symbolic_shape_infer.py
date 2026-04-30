# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

# -*- coding: UTF-8 -*-
import argparse
import logging

import numpy as np
import onnx

try:
    import sympy
except ImportError:
    raise ImportError("sympy is required for symbolic shape inference. Install with: pip install sympy") from None

from onnx import helper, numpy_helper, shape_inference
from packaging import version

assert version.parse(onnx.__version__) >= version.parse("1.8.0")

logger = logging.getLogger(__name__)


def get_attribute(node, attr_name, default_value=None):
    found = [attr for attr in node.attribute if attr.name == attr_name]
    if found:
        return helper.get_attribute_value(found[0])
    return default_value


def get_dim_from_proto(dim):
    return getattr(dim, dim.WhichOneof("value")) if type(dim.WhichOneof("value")) is str else None


def is_sequence(type_proto):
    cls_type = type_proto.WhichOneof("value")
    assert cls_type in ["tensor_type", "sequence_type"]
    return cls_type == "sequence_type"


def get_shape_from_type_proto(type_proto):
    assert not is_sequence(type_proto)
    if type_proto.tensor_type.HasField("shape"):
        return [get_dim_from_proto(d) for d in type_proto.tensor_type.shape.dim]
    else:
        return None  # note no shape is different from shape without dim (scalar)


def get_elem_type_from_type_proto(type_proto):
    if is_sequence(type_proto):
        return type_proto.sequence_type.elem_type.tensor_type.elem_type
    else:
        return type_proto.tensor_type.elem_type


def get_shape_from_value_info(vi):
    cls_type = vi.type.WhichOneof("value")
    if cls_type is None:
        return None
    if is_sequence(vi.type):
        if vi.type.sequence_type.elem_type.WhichOneof("value") == "tensor_type":
            return get_shape_from_type_proto(vi.type.sequence_type.elem_type)
        else:
            return None
    else:
        return get_shape_from_type_proto(vi.type)


def make_named_value_info(name):
    vi = onnx.ValueInfoProto()
    vi.name = name
    return vi


def get_shape_from_sympy_shape(sympy_shape):
    return [None if i is None else (int(i) if is_literal(i) else str(i)) for i in sympy_shape]


def is_literal(dim):
    return type(dim) in [int, np.int64, np.int32, sympy.Integer] or (hasattr(dim, "is_number") and dim.is_number)


def handle_negative_axis(axis, rank):
    assert axis < rank and axis >= -rank
    return axis if axis >= 0 else rank + axis


def get_opset(mp, domain=None):
    domain = domain or ["", "onnx", "ai.onnx"]
    if type(domain) != list:  # noqa: E721
        domain = [domain]
    for opset in mp.opset_import:
        if opset.domain in domain:
            return opset.version

    return None


def as_scalar(x):
    if type(x) is list:
        assert len(x) == 1
        return x[0]
    elif type(x) is np.ndarray:
        return x.item()
    else:
        return x


def as_list(x, keep_none):
    if type(x) is list:
        return x
    elif type(x) is np.ndarray:
        return list(x)
    elif keep_none and x is None:
        return None
    else:
        return [x]


def sympy_reduce_product(x):
    if type(x) is list:
        value = sympy.Integer(1)
        for v in x:
            value = value * v
    else:
        value = x
    return value


class SymbolicShapeInference:
    def __init__(self, int_max, auto_merge, guess_output_rank, verbose, prefix=""):
        self.dispatcher_ = {
            "Add": self._infer_symbolic_compute_ops,
            "AllReduce": self._pass_on_shape_and_type,
            "ArrayFeatureExtractor": self._infer_ArrayFeatureExtractor,
            "AveragePool": self._infer_Pool,
            "BatchNormalization": self._infer_BatchNormalization,
            "Cast": self._infer_Cast,
            "CategoryMapper": self._infer_CategoryMapper,
            "Compress": self._infer_Compress,
            "Concat": self._infer_Concat,
            "ConcatFromSequence": self._infer_ConcatFromSequence,
            "Constant": self._infer_Constant,
            "ConstantOfShape": self._infer_ConstantOfShape,
            "Conv": self._infer_Conv,
            "CumSum": self._pass_on_shape_and_type,
            "Div": self._infer_symbolic_compute_ops,
            "Einsum": self._infer_Einsum,
            "Expand": self._infer_Expand,
            "Equal": self._infer_symbolic_compute_ops,
            "Floor": self._infer_symbolic_compute_ops,
            "Gather": self._infer_Gather,
            "GatherElements": self._infer_GatherElements,
            "GatherND": self._infer_GatherND,
            "Identity": self._pass_on_shape_and_type,
            "If": self._infer_If,
            "Loop": self._infer_Loop,
            "MatMul": self._infer_MatMul,
            "MatMulInteger16": self._infer_MatMulInteger,
            "MaxPool": self._infer_Pool,
            "Max": self._infer_symbolic_compute_ops,
            "MemcpyFromHost": self._pass_on_shape_and_type,
            "MemcpyToHost": self._pass_on_shape_and_type,
            "Min": self._infer_symbolic_compute_ops,
            "MoE": self._pass_on_shape_and_type,
            "Mul": self._infer_symbolic_compute_ops,
            "NonMaxSuppression": self._infer_NonMaxSuppression,
            "NonZero": self._infer_NonZero,
            "OneHot": self._infer_OneHot,
            "Pad": self._infer_Pad,
            "Range": self._infer_Range,
            "Reciprocal": self._pass_on_shape_and_type,
            "ReduceSum": self._infer_ReduceSum,
            "ReduceMean": self._infer_ReduceMean,
            "ReduceProd": self._infer_ReduceProd,
            "Reshape": self._infer_Reshape,
            "Resize": self._infer_Resize,
            "Round": self._pass_on_shape_and_type,
            "Scan": self._infer_Scan,
            "ScatterElements": self._infer_ScatterElements,
            "SequenceAt": self._infer_SequenceAt,
            "SequenceInsert": self._infer_SequenceInsert,
            "Shape": self._infer_Shape,
            "Size": self._infer_Size,
            "Slice": self._infer_Slice,
            "SoftmaxCrossEntropyLoss": self._infer_SoftmaxCrossEntropyLoss,
            "SoftmaxCrossEntropyLossInternal": self._infer_SoftmaxCrossEntropyLoss,
            "NegativeLogLikelihoodLossInternal": self._infer_SoftmaxCrossEntropyLoss,
            "Split": self._infer_Split,
            "SplitToSequence": self._infer_SplitToSequence,
            "Squeeze": self._infer_Squeeze,
            "Sub": self._infer_symbolic_compute_ops,
            "Tile": self._infer_Tile,
            "TopK": self._infer_TopK,
            "Transpose": self._infer_Transpose,
            "Unsqueeze": self._infer_Unsqueeze,
            "Where": self._infer_symbolic_compute_ops,
            "ZipMap": self._infer_ZipMap,
            "Neg": self._infer_symbolic_compute_ops,
            # contrib ops:
            "Attention": self._infer_Attention,
            "BiasAdd": self._infer_BiasAdd,
            "BiasGelu": self._infer_BiasGelu,
            "BiasSplitGelu": self._infer_BiasSplitGelu,
            "DecoderMaskedMultiHeadAttention": self._infer_DecoderMaskedMultiHeadAttention,
            "DequantizeLinear": self._infer_DequantizeLinear,
            "DynamicTimeWarping": self._infer_DynamicTimeWarping,
            "EmbedLayerNormalization": self._infer_EmbedLayerNormalization,
            "FastGelu": self._infer_FastGelu,
            "GatedRelativePositionBias": self._infer_GatedRelativePositionBias,
            "GatherBlockQuantized": self._infer_Gather,
            "Gelu": self._infer_Gelu,
            "GemmFastGelu": self._infer_GemmFastGelu,
            "GemmFloat8": self._infer_GemmFloat8,
            "GroupNorm": self._infer_GroupNorm,
            "GroupNormalization": self._infer_GroupNorm,
            "GroupQueryAttention": self._infer_GroupQueryAttention,
            "LayerNormalization": self._infer_LayerNormalization,
            "LongformerAttention": self._infer_LongformerAttention,
            "MatMulNBits": self._infer_MatMulNBits,
            "MultiHeadAttention": self._infer_MultiHeadAttention,
            "NhwcConv": self._infer_NhwcConv,
            "PackedAttention": self._infer_PackedAttention,
            "PackedMultiHeadAttention": self._infer_PackedMultiHeadAttention,
            "PagedAttention": self._infer_PagedAttention,
            "PythonOp": self._infer_PythonOp,
            "QLinearAdd": self._infer_QLinearBinary,
            "QLinearMul": self._infer_QLinearBinary,
            "QuantizeLinear": self._infer_QuantizeLinear,
            "QuickGelu": self._infer_FastGelu,
            "RelativePositionBias": self._infer_RelativePositionBias,
            "RemovePadding": self._infer_RemovePadding,
            "RestorePadding": self._infer_RestorePadding,
            "RotaryEmbedding": self._infer_RotaryEmbedding,
            "SimplifiedLayerNormalization": self._infer_LayerNormalization,
            "SkipGroupNorm": self._infer_SkipGroupNorm,
            "SkipLayerNormalization": self._infer_SkipLayerNormalization,
            "SkipSimplifiedLayerNormalization": self._infer_SkipLayerNormalization,
            "SparseAttention": self._infer_SparseAttention,
            "UnfoldTensor": self._infer_UnfoldTensor,
        }
        self.aten_op_dispatcher_ = {
            "embedding": self._infer_Gather,
            "bitwise_or": self._infer_aten_bitwise_or,
            "diagonal": self._infer_aten_diagonal,
            "max_pool2d_with_indices": self._infer_aten_pool2d,
            "max": self._infer_aten_minmax,
            "min": self._infer_aten_minmax,
            "multinomial": self._infer_aten_multinomial,
            "unfold": self._infer_aten_unfold,
            "argmax": self._infer_aten_argmax,
            "avg_pool2d": self._infer_aten_pool2d,
            "_adaptive_avg_pool2d": self._infer_aten_pool2d,
            "numpy_T": self._infer_Transpose,
            "native_group_norm": self._infer_aten_group_norm,
            "upsample_nearest1d": self._infer_aten_upsample,
            "upsample_nearest2d": self._infer_aten_upsample,
            "upsample_nearest3d": self._infer_aten_upsample,
            "upsample_bicubic2d": self._infer_aten_upsample,
        }
        self.run_ = True
        self.suggested_merge_ = {}
        self.symbolic_dims_ = {}
        self.input_symbols_ = {}
        self.auto_merge_ = auto_merge
        self.guess_output_rank_ = guess_output_rank
        self.verbose_ = verbose
        self.int_max_ = int_max
        self.subgraph_id_ = 0
        self.prefix_ = prefix

    def _add_suggested_merge(self, symbols, apply=False):
        assert all((type(s) is str and s in self.symbolic_dims_) or is_literal(s) for s in symbols)
        symbols = set(symbols)
        for k, v in self.suggested_merge_.items():
            if k in symbols:
                symbols.remove(k)
                symbols.add(v)
        map_to = None
        # if there is literal, map to it first
        for s in symbols:
            if is_literal(s):
                map_to = s
                break
        # when no literals, map to input symbolic dims, then existing symbolic dims
        if map_to is None:
            for s in symbols:
                if s in self.input_symbols_:
                    map_to = s
                    break
        if map_to is None:
            for s in symbols:
                if type(self.symbolic_dims_[s]) is sympy.Symbol:
                    map_to = s
                    break
        # when nothing to map to, use the shorter one
        if map_to is None:
            if self.verbose_ > 0:
                logger.warning("Potential unsafe merge between symbolic expressions: (%s)", ",".join(symbols))
            symbols_list = list(symbols)
            lens = [len(s) for s in symbols_list]
            map_to = symbols_list[lens.index(min(lens))]
            symbols.remove(map_to)

        for s in symbols:
            if s == map_to:
                continue
            if is_literal(map_to) and is_literal(s):
                assert int(map_to) == int(s)
            self.suggested_merge_[s] = int(map_to) if is_literal(map_to) else map_to
            for k, v in self.suggested_merge_.items():
                if v == s:
                    self.suggested_merge_[k] = map_to
        if apply and self.auto_merge_:
            self._apply_suggested_merge()

    def _apply_suggested_merge(self, graph_input_only=False):
        if not self.suggested_merge_:
            return
        for i in list(self.out_mp_.graph.input) + ([] if graph_input_only else list(self.out_mp_.graph.value_info)):
            for d in i.type.tensor_type.shape.dim:
                if d.dim_param in self.suggested_merge_:
                    v = self.suggested_merge_[d.dim_param]
                    if is_literal(v):
                        d.dim_value = int(v)
                    else:
                        d.dim_param = v

    def _preprocess(self, in_mp):
        self.out_mp_ = onnx.ModelProto()
        self.out_mp_.CopyFrom(in_mp)
        self.graph_inputs_ = {i.name: i for i in list(self.out_mp_.graph.input)}
        self.initializers_ = {i.name: i for i in self.out_mp_.graph.initializer}
        self.known_vi_ = {i.name: i for i in list(self.out_mp_.graph.input)}
        self.known_vi_.update(
            {
                i.name: helper.make_tensor_value_info(i.name, i.data_type, list(i.dims))
                for i in self.out_mp_.graph.initializer
            }
        )

    def _merge_symbols(self, dims):
        if not all(type(d) is str for d in dims):
            if self.auto_merge_:
                unique_dims = list(set(dims))
                is_int = [is_literal(d) for d in unique_dims]
                assert sum(is_int) <= 1  # if there are more than 1 unique ints, something is wrong
                if sum(is_int) == 1:
                    int_dim = is_int.index(1)
                    if self.verbose_ > 0:
                        logger.debug(
                            f"dim {unique_dims[:int_dim] + unique_dims[int_dim + 1 :]} has been merged with value {unique_dims[int_dim]}"
                        )
                    self._check_merged_dims(unique_dims, allow_broadcast=False)
                    return unique_dims[int_dim]
                else:
                    if self.verbose_ > 0:
                        logger.debug(f"dim {unique_dims[1:]} has been merged with dim {unique_dims[0]}")
                    return dims[0]
            else:
                return None
        if all(d == dims[0] for d in dims):
            return dims[0]
        merged = [self.suggested_merge_.get(d, d) for d in dims]
        if all(d == merged[0] for d in merged):
            assert merged[0] in self.symbolic_dims_
            return merged[0]
        else:
            return None

    # broadcast from right to left, and merge symbolic dims if needed
    def _broadcast_shapes(self, shape1, shape2):
        new_shape = []
        rank1 = len(shape1)
        rank2 = len(shape2)
        new_rank = max(rank1, rank2)
        for i in range(new_rank):
            dim1 = shape1[rank1 - 1 - i] if i < rank1 else 1
            dim2 = shape2[rank2 - 1 - i] if i < rank2 else 1
            if dim1 == 1 or dim1 == dim2:
                new_dim = dim2
            elif dim2 == 1:
                new_dim = dim1
            else:
                new_dim = self._merge_symbols([dim1, dim2])
                if not new_dim:
                    # warning about unsupported broadcast when not auto merge
                    # note that auto merge has the risk of incorrectly merge symbols while one of them being 1
                    # for example, 'a' = 1, 'b' = 5 at runtime is valid broadcasting, but with auto merge 'a' == 'b'
                    if self.auto_merge_:
                        self._add_suggested_merge([dim1, dim2], apply=True)
                    else:
                        logger.warning("unsupported broadcast between " + str(dim1) + " " + str(dim2))  # noqa: G003
            new_shape = [new_dim, *new_shape]
        return new_shape

    def _get_shape(self, node, idx):
        name = node.input[idx]
        if name in self.known_vi_:
            vi = self.known_vi_[name]
            return get_shape_from_value_info(vi)
        else:
            assert name in self.initializers_
            return list(self.initializers_[name].dims)

    def _try_get_shape(self, node, idx):
        if idx > len(node.input) - 1:
            return None
        name = node.input[idx]
        if name in self.known_vi_:
            vi = self.known_vi_[name]
            return get_shape_from_value_info(vi)
        if name in self.initializers_:
            return list(self.initializers_[name].dims)
        return None

    def _get_shape_rank(self, node, idx):
        return len(self._get_shape(node, idx))

    def _get_sympy_shape(self, node, idx):
        sympy_shape = []
        for d in self._get_shape(node, idx):
            if type(d) is str:
                sympy_shape.append(
                    self.symbolic_dims_[d]
                    if d in self.symbolic_dims_
                    else sympy.Symbol(d, integer=True, nonnegative=True)
                )
            else:
                assert None is not d
                sympy_shape.append(d)
        return sympy_shape

    def _get_value(self, node, idx):
        name = node.input[idx]
        assert name in self.sympy_data_ or name in self.initializers_
        return self.sympy_data_[name] if name in self.sympy_data_ else numpy_helper.to_array(self.initializers_[name])

    def _try_get_value(self, node, idx):
        if idx >= len(node.input):
            return None
        name = node.input[idx]
        if name in self.sympy_data_ or name in self.initializers_:
            return self._get_value(node, idx)
        return None

    def _update_computed_dims(self, new_sympy_shape):
        for i, new_dim in enumerate(new_sympy_shape):
            if not is_literal(new_dim) and type(new_dim) != str:  # noqa: E721
                str_dim = str(new_dim)
                if str_dim in self.suggested_merge_:
                    if is_literal(self.suggested_merge_[str_dim]):
                        continue  # no need to create dim for literals
                    new_sympy_shape[i] = self.symbolic_dims_[self.suggested_merge_[str_dim]]
                else:
                    # add new_dim if it's a computational expression
                    if str(new_dim) not in self.symbolic_dims_:
                        self.symbolic_dims_[str(new_dim)] = new_dim

    def _onnx_infer_single_node(self, node):
        # skip onnx shape inference for some ops, as they are handled in _infer_*
        skip_infer = node.op_type in [
            "If",
            "Loop",
            "Scan",
            "SplitToSequence",
            "ZipMap",  # contrib ops
            "Attention",
            "BiasAdd",
            "BiasGelu",
            "BiasSplitGelu",
            "DequantizeLinear",
            "DynamicTimeWarping",
            "EmbedLayerNormalization",
            "FastGelu",
            "GatherBlockQuantized",
            "Gelu",
            "GemmFastGelu",
            "GroupNorm",
            "GroupNormalization",
            "GroupQueryAttention",
            "LayerNormalization",
            "LongformerAttention",
            "MultiHeadAttention",
            "NhwcConv",
            "PackedAttention",
            "PagedAttention",
            "PythonOp",
            "QuantizeLinear",
            "QuickGelu",
            "RelativePositionBias",
            "RemovePadding",
            "RestorePadding",
            "RotaryEmbedding",
            "SimplifiedLayerNormalization",
            "SkipLayerNormalization",
            "SkipSimplifiedLayerNormalization",
            "SparseAttention",
            "SkipGroupNorm",
            "QLinearAdd",
            "QLinearMul",
        ]

        if not skip_infer:
            # Only pass initializers that satisfy the following condition:
            # (1) Operator need value of some input for shape inference.
            #     For example, Unsqueeze in opset 13 uses the axes input to calculate shape of output.
            # (2) opset version >= 9. In older version, initializer is required in graph input by onnx spec.
            # (3) The initializer is not in graph input. The means the node input is "constant" in inference.
            initializers = []
            if (get_opset(self.out_mp_) >= 9) and node.op_type in ["Unsqueeze"]:
                initializers = [
                    self.initializers_[name]
                    for name in node.input
                    if (name in self.initializers_ and name not in self.graph_inputs_)
                ]

            if node.op_type in [
                "Add",
                "Sub",
                "Mul",
                "Div",
                "MatMul",
                "MatMulInteger",
                "MatMulInteger16",
                "Where",
                "Sum",
            ]:
                if node.output[0] in self.known_vi_:
                    vi = self.known_vi_[node.output[0]]
                    out_rank = len(get_shape_from_type_proto(vi.type))
                    in_shapes = [self._get_shape(node, i) for i in range(len(node.input))]
                    for d in range(
                        out_rank - (2 if node.op_type in ["MatMul", "MatMulInteger", "MatMulInteger16"] else 0)
                    ):
                        in_dims = [s[len(s) - out_rank + d] for s in in_shapes if len(s) + d >= out_rank]
                        if len(in_dims) > 1:
                            self._check_merged_dims(in_dims, allow_broadcast=True)

            # run single node inference with self.known_vi_ shapes
            tmp_graph = helper.make_graph(
                [node],
                "tmp",
                [self.known_vi_[i] for i in node.input if i],
                [make_named_value_info(i) for i in node.output],
                initializers,
            )

            self.tmp_mp_.graph.CopyFrom(tmp_graph)

            self.tmp_mp_ = shape_inference.infer_shapes(self.tmp_mp_)

        for i_o in range(len(node.output)):
            o = node.output[i_o]
            if o:  # skip optional output
                vi = self.out_mp_.graph.value_info.add()
                if not skip_infer:
                    vi.CopyFrom(self.tmp_mp_.graph.output[i_o])
                else:
                    vi.name = o
                self.known_vi_[o] = vi

    def _onnx_infer_subgraph(self, node, subgraph, use_node_input=True, inc_subgraph_id=True):
        if self.verbose_ > 2:
            logger.debug(f"Inferencing subgraph of node {node.name} with output({node.output[0]}...): {node.op_type}")
        # node inputs are not passed directly to the subgraph
        # it's up to the node dispatcher to prepare subgraph input
        # for example, with Scan/Loop, subgraph input shape would be trimmed from node input shape
        # besides, inputs in subgraph could shadow implicit inputs
        subgraph_inputs = {i.name for i in list(subgraph.initializer) + list(subgraph.input)}
        subgraph_implicit_input = {name for name in self.known_vi_ if name not in subgraph_inputs}
        tmp_graph = helper.make_graph(
            list(subgraph.node),
            "tmp",
            list(subgraph.input) + [self.known_vi_[i] for i in subgraph_implicit_input],
            [make_named_value_info(i.name) for i in subgraph.output],
        )
        tmp_graph.initializer.extend([i for i in self.out_mp_.graph.initializer if i.name in subgraph_implicit_input])
        tmp_graph.initializer.extend(subgraph.initializer)
        self.tmp_mp_.graph.CopyFrom(tmp_graph)

        symbolic_shape_inference = SymbolicShapeInference(
            self.int_max_,
            self.auto_merge_,
            self.guess_output_rank_,
            self.verbose_,
            prefix=self.prefix_ + "_" + str(self.subgraph_id_),
        )
        if inc_subgraph_id:
            self.subgraph_id_ += 1

        symbolic_shape_inference._preprocess(self.tmp_mp_)
        symbolic_shape_inference.suggested_merge_ = self.suggested_merge_.copy()
        while symbolic_shape_inference.run_:
            symbolic_shape_inference._infer_impl(self.sympy_data_.copy())
        symbolic_shape_inference._update_output_from_vi()
        if use_node_input:
            # if subgraph uses node input, it needs to update to merged dims
            subgraph.ClearField("input")
            subgraph.input.extend(symbolic_shape_inference.out_mp_.graph.input[: len(node.input)])
        subgraph.ClearField("output")
        subgraph.output.extend(symbolic_shape_inference.out_mp_.graph.output)
        subgraph.ClearField("value_info")
        subgraph.value_info.extend(symbolic_shape_inference.out_mp_.graph.value_info)
        subgraph.ClearField("node")
        subgraph.node.extend(symbolic_shape_inference.out_mp_.graph.node)
        # for new symbolic dims from subgraph output, add to main graph symbolic dims
        subgraph_shapes = [get_shape_from_value_info(o) for o in symbolic_shape_inference.out_mp_.graph.output]
        subgraph_new_symbolic_dims = {
            d for s in subgraph_shapes if s for d in s if type(d) is str and d not in self.symbolic_dims_
        }
        new_dims = {}
        for d in subgraph_new_symbolic_dims:
            assert d in symbolic_shape_inference.symbolic_dims_
            new_dims[d] = symbolic_shape_inference.symbolic_dims_[d]
        self.symbolic_dims_.update(new_dims)
        return symbolic_shape_inference

    def _get_int_or_float_values(self, node, broadcast=False, allow_float_values=False):
        def int_or_float(value, allow_float_values):
            # If casting into int has precision loss: keep float output
            if allow_float_values and value % 1 != 0:
                return value
            return int(value)

        values = [self._try_get_value(node, i) for i in range(len(node.input))]
        if all(v is not None for v in values):
            # some shape compute is in floating point, cast to int for sympy
            for i, v in enumerate(values):
                if type(v) is not np.ndarray:
                    continue
                if len(v.shape) > 1:
                    new_v = None  # ignore value for rank > 1
                elif len(v.shape) == 0:
                    new_v = int_or_float(v.item(), allow_float_values)
                else:
                    assert len(v.shape) == 1
                    new_v = [int_or_float(vv, allow_float_values) for vv in v]
                values[i] = new_v
        values_len = [len(v) if isinstance(v, list) else 0 for v in values]
        max_len = max(values_len)
        if max_len >= 1 and broadcast:
            # broadcast
            for i, v in enumerate(values):
                if v is None:
                    continue  # don't broadcast if value is unknown
                if isinstance(v, list):
                    if len(v) < max_len:
                        values[i] = v * max_len
                    else:
                        assert len(v) == max_len
                else:
                    values[i] = [v] * max_len
        return values

    def _compute_on_sympy_data(self, node, op_func):
        assert len(node.output) == 1

        # Before mul & div operations
        # cast inputs into interger might lose decimal part and reduce precision
        # keep them as float, finish the operation, then cast the result into integer
        if node.op_type in ["Mul", "Div"]:
            values = self._get_int_or_float_values(node, broadcast=True, allow_float_values=True)
        else:
            values = self._get_int_or_float_values(node, broadcast=True)

        if all(v is not None for v in values):
            is_list = [isinstance(v, list) for v in values]
            as_list = any(is_list)
            if as_list:
                self.sympy_data_[node.output[0]] = [op_func(vs) for vs in zip(*values, strict=False)]
            else:
                self.sympy_data_[node.output[0]] = op_func(values)

    def _pass_on_sympy_data(self, node):
        assert len(node.input) == 1 or node.op_type in [
            "Reshape",
            "Unsqueeze",
            "Squeeze",
        ]
        self._compute_on_sympy_data(node, lambda x: x[0])

    def _pass_on_shape_and_type(self, node):
        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(
            helper.make_tensor_value_info(
                node.output[0],
                get_elem_type_from_type_proto(self.known_vi_[node.input[0]].type),
                self._get_shape(node, 0),
            )
        )

    def _new_symbolic_dim(self, prefix, dim):
        new_dim = f"{prefix}_d{dim}"
        if new_dim in self.suggested_merge_:
            v = self.suggested_merge_[new_dim]
            new_symbolic_dim = sympy.Integer(int(v)) if is_literal(v) else v
        else:
            new_symbolic_dim = sympy.Symbol(new_dim, integer=True, nonnegative=True)
            self.symbolic_dims_[new_dim] = new_symbolic_dim
        return new_symbolic_dim

    def _new_symbolic_dim_from_output(self, node, out_idx=0, dim=0):
        return self._new_symbolic_dim(
            f"{node.op_type}{self.prefix_}_{list(self.out_mp_.graph.node).index(node)}_o{out_idx}_",
            dim,
        )

    def _new_symbolic_shape(self, rank, node, out_idx=0):
        return [self._new_symbolic_dim_from_output(node, out_idx, i) for i in range(rank)]

    def _compute_conv_pool_shape(self, node, channels_last=False):
        sympy_shape = self._get_sympy_shape(node, 0)
        if len(node.input) > 1:
            W_shape = self._get_sympy_shape(node, 1)  # noqa: N806
            rank = len(W_shape) - 2  # number of spatial axes
            kernel_shape = W_shape[-rank - 1 : -1] if channels_last else W_shape[-rank:]
            sympy_shape[3 if channels_last else 1] = W_shape[0]
        else:
            W_shape = None  # noqa: N806
            kernel_shape = get_attribute(node, "kernel_shape")
            rank = len(kernel_shape)

        assert len(sympy_shape) == rank + 2

        # only need to symbolic shape inference if input has symbolic dims in spatial axes
        spatial_shape = sympy_shape[-rank - 1 : -1] if channels_last else sympy_shape[-rank:]
        is_symbolic_dims = [not is_literal(i) for i in spatial_shape]

        if not any(is_symbolic_dims):
            shape = get_shape_from_value_info(self.known_vi_[node.output[0]])
            if len(shape) > 0:
                assert len(sympy_shape) == len(shape)
                if channels_last:
                    sympy_shape[-rank - 1 : -1] = [sympy.Integer(d) for d in shape[-rank - 1 : -1]]
                else:
                    sympy_shape[-rank:] = [sympy.Integer(d) for d in shape[-rank:]]
                return sympy_shape

        dilations = get_attribute(node, "dilations", [1] * rank)
        strides = get_attribute(node, "strides", [1] * rank)
        effective_kernel_shape = [(k - 1) * d + 1 for k, d in zip(kernel_shape, dilations, strict=False)]
        pads = get_attribute(node, "pads")
        if pads is None:
            pads = [0] * (2 * rank)
            auto_pad = get_attribute(node, "auto_pad", b"NOTSET").decode("utf-8")
            if auto_pad != "VALID" and auto_pad != "NOTSET":
                try:
                    residual = [sympy.Mod(d, s) for d, s in zip(sympy_shape[-rank:], strides, strict=False)]
                    total_pads = [
                        max(0, (k - s) if r == 0 else (k - r))
                        for k, s, r in zip(effective_kernel_shape, strides, residual, strict=False)
                    ]
                except TypeError:  # sympy may throw TypeError: cannot determine truth value of Relational
                    total_pads = [
                        max(0, (k - s)) for k, s in zip(effective_kernel_shape, strides, strict=False)
                    ]  # assuming no residual if sympy throws error
            elif auto_pad == "VALID":
                total_pads = []
            else:
                total_pads = [0] * rank
        else:
            assert len(pads) == 2 * rank
            total_pads = [p1 + p2 for p1, p2 in zip(pads[:rank], pads[rank:], strict=False)]

        ceil_mode = get_attribute(node, "ceil_mode", 0)
        for i in range(rank):
            effective_input_size = sympy_shape[-rank + i + (-1 if channels_last else 0)]
            if len(total_pads) > 0:
                effective_input_size = effective_input_size + total_pads[i]
            if ceil_mode:
                strided_kernel_positions = sympy.ceiling(
                    (effective_input_size - effective_kernel_shape[i]) / strides[i]
                )
            else:
                strided_kernel_positions = (effective_input_size - effective_kernel_shape[i]) // strides[i]
            sympy_shape[-rank + i + (-1 if channels_last else 0)] = strided_kernel_positions + 1
        return sympy_shape

    def _check_merged_dims(self, dims, allow_broadcast=True):
        if allow_broadcast:
            dims = [d for d in dims if not (is_literal(d) and int(d) <= 1)]
        if not all(d == dims[0] for d in dims):
            self._add_suggested_merge(dims, apply=True)

    def _compute_matmul_shape(self, node, output_dtype=None):
        lhs_shape = self._get_shape(node, 0)
        rhs_shape = self._get_shape(node, 1)
        lhs_rank = len(lhs_shape)
        rhs_rank = len(rhs_shape)
        lhs_reduce_dim = 0
        rhs_reduce_dim = 0
        assert lhs_rank > 0 and rhs_rank > 0
        if lhs_rank == 1 and rhs_rank == 1:
            new_shape = []
        elif lhs_rank == 1:
            rhs_reduce_dim = -2
            new_shape = [*rhs_shape[:rhs_reduce_dim], rhs_shape[-1]]
        elif rhs_rank == 1:
            lhs_reduce_dim = -1
            new_shape = lhs_shape[:lhs_reduce_dim]
        else:
            lhs_reduce_dim = -1
            rhs_reduce_dim = -2
            new_shape = [*self._broadcast_shapes(lhs_shape[:-2], rhs_shape[:-2]), lhs_shape[-2], rhs_shape[-1]]
        # merge reduce dim
        self._check_merged_dims(
            [lhs_shape[lhs_reduce_dim], rhs_shape[rhs_reduce_dim]],
            allow_broadcast=False,
        )
        if output_dtype is None:
            # infer output_dtype from input type when not specified
            output_dtype = self.known_vi_[node.input[0]].type.tensor_type.elem_type
        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(helper.make_tensor_value_info(node.output[0], output_dtype, new_shape))

    def _fuse_tensor_type(self, node, out_idx, dst_type, src_type):
        """
        update dst_tensor_type to be compatible with src_tensor_type when dimension mismatches
        """
        dst_tensor_type = (
            dst_type.sequence_type.elem_type.tensor_type if is_sequence(dst_type) else dst_type.tensor_type
        )
        src_tensor_type = (
            src_type.sequence_type.elem_type.tensor_type if is_sequence(src_type) else src_type.tensor_type
        )
        if dst_tensor_type.elem_type != src_tensor_type.elem_type:
            node_id = node.name if node.name else node.op_type
            raise ValueError(
                f"For node {node_id}, dst_tensor_type.elem_type != src_tensor_type.elem_type: "
                f"{onnx.onnx_pb.TensorProto.DataType.Name(dst_tensor_type.elem_type)} vs "
                f"{onnx.onnx_pb.TensorProto.DataType.Name(src_tensor_type.elem_type)}"
            )
        if dst_tensor_type.HasField("shape"):
            for di, ds in enumerate(zip(dst_tensor_type.shape.dim, src_tensor_type.shape.dim, strict=False)):
                if ds[0] != ds[1]:
                    # create a new symbolic dimension for node/out_idx/mismatch dim id in dst_tensor_type for tensor_type
                    # for sequence_type, clear the dimension
                    new_dim = onnx.TensorShapeProto.Dimension()
                    if not is_sequence(dst_type):
                        new_dim.dim_param = str(self._new_symbolic_dim_from_output(node, out_idx, di))
                    dst_tensor_type.shape.dim[di].CopyFrom(new_dim)
        else:
            dst_tensor_type.CopyFrom(src_tensor_type)

    def _infer_ArrayFeatureExtractor(self, node):  # noqa: N802
        data_shape = self._get_shape(node, 0)
        indices_shape = self._get_shape(node, 1)
        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(
            helper.make_tensor_value_info(
                node.output[0],
                self.known_vi_[node.input[0]].type.tensor_type.elem_type,
                data_shape[:-1] + indices_shape,
            )
        )

    def _infer_symbolic_compute_ops(self, node):
        funcs = {
            "Add": lambda l: l[0] + l[1],  # noqa: E741
            "Div": lambda l: (  # noqa: E741
                int(l[0] // l[1]) if isinstance(l[0] // l[1], float) else l[0] // l[1]
            ),  # integer div in sympy
            "Equal": lambda l: l[0] == l[1],  # noqa: E741
            "Floor": lambda l: sympy.floor(l[0]),  # noqa: E741
            "Max": lambda l: (  # noqa: E741
                l[1]
                if is_literal(l[0]) and int(l[0]) < -self.int_max_
                else (l[0] if is_literal(l[1]) and int(l[1]) < -self.int_max_ else sympy.Max(l[0], l[1]))
            ),
            "Min": lambda l: (  # noqa: E741
                l[1]
                if is_literal(l[0]) and int(l[0]) > self.int_max_
                else (l[0] if is_literal(l[1]) and int(l[1]) > self.int_max_ else sympy.Min(l[0], l[1]))
            ),
            "Mul": lambda l: int(l[0] * l[1]) if isinstance(l[0] * l[1], float) else l[0] * l[1],  # noqa: E741
            "Sub": lambda l: l[0] - l[1],  # noqa: E741
            "Where": lambda l: l[1] if l[0] else l[2],  # noqa: E741
            "Neg": lambda l: -l[0],  # noqa: E741
        }
        assert node.op_type in funcs
        self._compute_on_sympy_data(node, funcs[node.op_type])

    def _infer_Cast(self, node):  # noqa: N802
        self._pass_on_sympy_data(node)

    def _infer_CategoryMapper(self, node):  # noqa: N802
        input_type = self.known_vi_[node.input[0]].type.tensor_type.elem_type
        if input_type == onnx.TensorProto.STRING:
            output_type = onnx.TensorProto.INT64
        else:
            output_type = onnx.TensorProto.STRING
        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(helper.make_tensor_value_info(node.output[0], output_type, self._get_shape(node, 0)))

    def _infer_Compress(self, node):  # noqa: N802
        input_shape = self._get_shape(node, 0)
        # create a new symbolic dimension for Compress output
        compress_len = str(self._new_symbolic_dim_from_output(node))
        axis = get_attribute(node, "axis")
        if axis is None:
            # when axis is not specified, input is flattened before compress so output is 1D
            output_shape = [compress_len]
        else:
            output_shape = input_shape
            output_shape[handle_negative_axis(axis, len(input_shape))] = compress_len
        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(
            helper.make_tensor_value_info(
                node.output[0],
                self.known_vi_[node.input[0]].type.tensor_type.elem_type,
                output_shape,
            )
        )

    def _infer_Concat(self, node):  # noqa: N802
        if any(i in self.sympy_data_ or i in self.initializers_ for i in node.input):
            values = self._get_int_or_float_values(node)
            if all(v is not None for v in values):
                assert get_attribute(node, "axis") == 0
                self.sympy_data_[node.output[0]] = []
                for i in range(len(node.input)):
                    value = values[i]
                    if isinstance(value, list):
                        self.sympy_data_[node.output[0]].extend(value)
                    else:
                        self.sympy_data_[node.output[0]].append(value)

        sympy_shape = self._get_sympy_shape(node, 0)
        axis = handle_negative_axis(get_attribute(node, "axis"), len(sympy_shape))
        for i_idx in range(1, len(node.input)):
            input_shape = self._get_sympy_shape(node, i_idx)
            if input_shape:
                sympy_shape[axis] = sympy_shape[axis] + input_shape[axis]
        self._update_computed_dims(sympy_shape)
        # merge symbolic dims for non-concat axes
        for d in range(len(sympy_shape)):
            if d == axis:
                continue
            dims = [self._get_shape(node, i_idx)[d] for i_idx in range(len(node.input)) if self._get_shape(node, i_idx)]
            if all(d == dims[0] for d in dims):
                continue
            merged = self._merge_symbols(dims)
            if type(merged) is str:
                sympy_shape[d] = self.symbolic_dims_[merged] if merged else None
            else:
                sympy_shape[d] = merged
        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(
            helper.make_tensor_value_info(
                node.output[0],
                self.known_vi_[node.input[0]].type.tensor_type.elem_type,
                get_shape_from_sympy_shape(sympy_shape),
            )
        )

    def _infer_ConcatFromSequence(self, node):  # noqa: N802
        seq_shape = self._get_shape(node, 0)
        new_axis = 1 if get_attribute(node, "new_axis") else 0
        axis = handle_negative_axis(get_attribute(node, "axis"), len(seq_shape) + new_axis)
        concat_dim = str(self._new_symbolic_dim_from_output(node, 0, axis))
        new_shape = seq_shape
        if new_axis:
            new_shape = [*seq_shape[:axis], concat_dim, *seq_shape[axis:]]
        else:
            new_shape[axis] = concat_dim
        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(
            helper.make_tensor_value_info(
                node.output[0],
                self.known_vi_[node.input[0]].type.sequence_type.elem_type.tensor_type.elem_type,
                new_shape,
            )
        )

    def _infer_Constant(self, node):  # noqa: N802
        t = get_attribute(node, "value")
        self.sympy_data_[node.output[0]] = numpy_helper.to_array(t)

    def _infer_ConstantOfShape(self, node):  # noqa: N802
        sympy_shape = self._get_int_or_float_values(node)[0]
        vi = self.known_vi_[node.output[0]]
        if sympy_shape is not None:
            if type(sympy_shape) != list:  # noqa: E721
                sympy_shape = [sympy_shape]
            self._update_computed_dims(sympy_shape)
            # update sympy data if output type is int, and shape is known
            if vi.type.tensor_type.elem_type == onnx.TensorProto.INT64 and all(is_literal(x) for x in sympy_shape):
                self.sympy_data_[node.output[0]] = np.ones(
                    [int(x) for x in sympy_shape], dtype=np.int64
                ) * numpy_helper.to_array(get_attribute(node, "value", 0))
        else:
            # create new dynamic shape
            # note input0 is a 1D vector of shape, the new symbolic shape has the rank of the shape vector length
            sympy_shape = self._new_symbolic_shape(self._get_shape(node, 0)[0], node)

        vi.CopyFrom(
            helper.make_tensor_value_info(
                node.output[0],
                vi.type.tensor_type.elem_type,
                get_shape_from_sympy_shape(sympy_shape),
            )
        )

    def _infer_Conv(self, node):  # noqa: N802
        sympy_shape = self._compute_conv_pool_shape(node)
        self._update_computed_dims(sympy_shape)
        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(
            helper.make_tensor_value_info(
                node.output[0],
                vi.type.tensor_type.elem_type,
                get_shape_from_sympy_shape(sympy_shape),
            )
        )

    def _infer_NhwcConv(self, node):  # noqa: N802
        sympy_shape = self._compute_conv_pool_shape(node, channels_last=True)
        self._update_computed_dims(sympy_shape)
        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(
            helper.make_tensor_value_info(
                node.output[0],
                self.known_vi_[node.input[0]].type.tensor_type.elem_type,
                get_shape_from_sympy_shape(sympy_shape),
            )
        )

    def _infer_DequantizeLinear(self, node):  # noqa: N802
        # Get the output data type from the scale input (index 1, required).
        output_dtype = self.known_vi_[node.input[1]].type.tensor_type.elem_type

        # Get the output shape from the first input.
        output_shape = self._get_shape(node, 0)

        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(helper.make_tensor_value_info(node.output[0], output_dtype, output_shape))

    def _infer_QuantizeLinear(self, node):  # noqa: N802
        # Get the output data type from the zero-point input (index 2, optional).
        # Otherwise, default to uint8
        output_dtype = onnx.TensorProto.UINT8
        if len(node.input) > 2 and node.input[2]:
            output_dtype = self.known_vi_[node.input[2]].type.tensor_type.elem_type

        # Get the output shape from the first input.
        output_shape = self._get_shape(node, 0)

        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(helper.make_tensor_value_info(node.output[0], output_dtype, output_shape))

    def _infer_QLinearBinary(self, node):  # noqa: N802
        # Get the output data type from the first input to QLinearAdd / QLinearMul.
        output_dtype = self.known_vi_[node.input[0]].type.tensor_type.elem_type

        # The inputs are first and fourth operands respectively.
        input_1_shape = self._get_shape(node, 0)
        input_2_shape = self._get_shape(node, 3)

        # Compute the broadcasted shape
        new_shape = self._broadcast_shapes(input_1_shape, input_2_shape)

        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(helper.make_tensor_value_info(node.output[0], output_dtype, new_shape))

    def _infer_Einsum(self, node):  # noqa: N802
        # ref:https://github.com/onnx/onnx/blob/623dfaa0151b2e4ce49779c3ec31cbd78c592b80/onnx/defs/math/defs.cc#L3275
        equation = get_attribute(node, "equation")
        equation = equation.replace(b" ", b"")
        mid_index = equation.find(b"->")
        left_equation = equation[:mid_index] if mid_index != -1 else equation

        num_operands = 0
        num_ellipsis = 0
        num_ellipsis_indices = 0

        letter_to_dim = {}

        terms = left_equation.split(b",")
        for term in terms:
            ellipsis_index = term.find(b"...")
            shape = self._get_shape(node, num_operands)
            rank = len(shape)
            if ellipsis_index != -1:
                if num_ellipsis == 0:
                    num_ellipsis_indices = rank - len(term) + 3
                num_ellipsis = num_ellipsis + 1
            for i in range(1, rank + 1):
                letter = term[-i]
                if letter != 46:  # letter != b'.'
                    dim = shape[-i]
                    if letter not in letter_to_dim:
                        letter_to_dim[letter] = dim
                    elif type(dim) is not sympy.Symbol:
                        letter_to_dim[letter] = dim
            num_operands = num_operands + 1

        new_sympy_shape = []
        from collections import OrderedDict  # noqa: PLC0415

        num_letter_occurrences = OrderedDict()
        if mid_index != -1:
            right_equation = equation[mid_index + 2 :]
            right_ellipsis_index = right_equation.find(b"...")
            if right_ellipsis_index != -1:
                for i in range(num_ellipsis_indices):
                    new_sympy_shape.append(shape[i])
            for c in right_equation:
                if c != 46:  # c != b'.'
                    new_sympy_shape.append(letter_to_dim[c])
        else:
            for i in range(num_ellipsis_indices):
                new_sympy_shape.append(shape[i])
            for c in left_equation:
                if c != 44 and c != 46:  # c != b',' and c != b'.':
                    if c in num_letter_occurrences:
                        num_letter_occurrences[c] = num_letter_occurrences[c] + 1
                    else:
                        num_letter_occurrences[c] = 1
            for key, value in num_letter_occurrences.items():
                if value == 1:
                    new_sympy_shape.append(letter_to_dim[key])

        output_dtype = self.known_vi_[node.input[0]].type.tensor_type.elem_type
        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(helper.make_tensor_value_info(node.output[0], output_dtype, new_sympy_shape))

    def _infer_Expand(self, node):  # noqa: N802
        expand_to_shape = as_list(self._try_get_value(node, 1), keep_none=True)
        if expand_to_shape is not None:
            # new_shape's dim can come from shape value
            self._update_computed_dims(expand_to_shape)
            shape = self._get_shape(node, 0)
            new_shape = self._broadcast_shapes(shape, get_shape_from_sympy_shape(expand_to_shape))
            vi = self.known_vi_[node.output[0]]
            vi.CopyFrom(
                helper.make_tensor_value_info(
                    node.output[0],
                    self.known_vi_[node.input[0]].type.tensor_type.elem_type,
                    new_shape,
                )
            )

    def _infer_Gather(self, node):  # noqa: N802
        data_shape = self._get_shape(node, 0)
        axis = handle_negative_axis(get_attribute(node, "axis", 0), len(data_shape))
        indices_shape = self._get_shape(node, 1)
        vi = self.known_vi_[node.output[0]]
        if node.op_type == "Gather":
            elem_type = self.known_vi_[node.input[0]].type.tensor_type.elem_type
        elif node.op_type == "GatherBlockQuantized":
            # scales
            elem_type = self.known_vi_[node.input[2]].type.tensor_type.elem_type
        else:
            raise ValueError(f"Unsupported Gather op_type: {node.op_type}")
        vi.CopyFrom(
            helper.make_tensor_value_info(
                node.output[0],
                elem_type,
                data_shape[:axis] + indices_shape + data_shape[axis + 1 :],
            )
        )
        # for 1D input, do some sympy compute
        if node.input[0] in self.sympy_data_ and len(data_shape) == 1 and get_attribute(node, "axis", 0) == 0:
            idx = self._try_get_value(node, 1)
            if idx is not None:
                data = self.sympy_data_[node.input[0]]
                if type(data) is list:
                    if type(idx) is np.ndarray and len(idx.shape) == 1:
                        self.sympy_data_[node.output[0]] = [data[int(i)] for i in idx]
                    else:
                        self.sympy_data_[node.output[0]] = data[int(idx)]
                else:
                    assert idx == 0 or idx == -1
                    self.sympy_data_[node.output[0]] = data

    def _infer_GatherElements(self, node):  # noqa: N802
        indices_shape = self._get_shape(node, 1)
        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(
            helper.make_tensor_value_info(
                node.output[0],
                self.known_vi_[node.input[0]].type.tensor_type.elem_type,
                indices_shape,
            )
        )

    def _infer_GatherND(self, node):  # noqa: N802
        data_shape = self._get_shape(node, 0)
        data_rank = len(data_shape)
        indices_shape = self._get_shape(node, 1)
        len(indices_shape)
        last_index_dimension = indices_shape[-1]
        assert is_literal(last_index_dimension) and last_index_dimension <= data_rank
        new_shape = indices_shape[:-1] + data_shape[last_index_dimension:]
        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(
            helper.make_tensor_value_info(
                node.output[0],
                self.known_vi_[node.input[0]].type.tensor_type.elem_type,
                new_shape,
            )
        )

    def _infer_If(self, node):  # noqa: N802
        # special case for constant condition, in case there are mismatching shape from the non-executed branch
        subgraphs = [
            get_attribute(node, "then_branch"),
            get_attribute(node, "else_branch"),
        ]
        cond = self._try_get_value(node, 0)
        if cond is not None:
            if as_scalar(cond) > 0:
                subgraphs[1].CopyFrom(subgraphs[0])
            else:
                subgraphs[0].CopyFrom(subgraphs[1])

        for i_sub, subgraph in enumerate(subgraphs):
            subgraph_infer = self._onnx_infer_subgraph(node, subgraph, use_node_input=False)
            for i_out in range(len(node.output)):
                vi = self.known_vi_[node.output[i_out]]
                if i_sub == 0:
                    vi.CopyFrom(subgraph.output[i_out])
                    vi.name = node.output[i_out]
                else:
                    self._fuse_tensor_type(node, i_out, vi.type, subgraph.output[i_out].type)

                # pass on sympy data from subgraph, if cond is constant
                if cond is not None and i_sub == (0 if as_scalar(cond) > 0 else 1):
                    if subgraph.output[i_out].name in subgraph_infer.sympy_data_:
                        self.sympy_data_[vi.name] = subgraph_infer.sympy_data_[subgraph.output[i_out].name]

    def _infer_Loop(self, node):  # noqa: N802
        subgraph = get_attribute(node, "body")
        assert len(subgraph.input) == len(node.input)
        num_loop_carried = len(node.input) - 2  # minus the length and initial loop condition
        # when sequence_type is used as loop carried input
        # needs to run subgraph infer twice if the tensor shape in sequence contains None
        for i, si in enumerate(subgraph.input):
            si_name = si.name
            si.CopyFrom(self.known_vi_[node.input[i]])
            si.name = si_name

        self._onnx_infer_subgraph(node, subgraph)

        # check subgraph input/output for shape changes in loop carried variables
        # for tensor_type, create new symbolic dim when changing, i.e., output = Concat(input, a)
        # for sequence_type, propagate from output to input
        need_second_infer = False
        for i_out in range(1, num_loop_carried + 1):
            so = subgraph.output[i_out]
            so_shape = get_shape_from_value_info(so)
            if is_sequence(so.type):
                if so_shape and None in so_shape:
                    # copy shape from output to input
                    # note that loop input is [loop_len, cond, input_0, input_1, ...]
                    # while loop output is [cond, output_0, output_1, ...]
                    subgraph.input[i_out + 1].type.sequence_type.elem_type.CopyFrom(so.type.sequence_type.elem_type)
                    need_second_infer = True
            else:
                si = subgraph.input[i_out + 1]
                si_shape = get_shape_from_value_info(si)
                for di, dims in enumerate(zip(si_shape, so_shape, strict=False)):
                    if dims[0] != dims[1]:
                        new_dim = onnx.TensorShapeProto.Dimension()
                        new_dim.dim_param = str(self._new_symbolic_dim_from_output(node, i_out, di))
                        si.type.tensor_type.shape.dim[di].CopyFrom(new_dim)
                        so.type.tensor_type.shape.dim[di].CopyFrom(new_dim)
                        need_second_infer = True

        if need_second_infer:
            if self.verbose_ > 2:
                logger.debug(
                    f"Rerun Loop: {node.name}({node.output[0]}...), because of sequence in loop carried variables"
                )
            self._onnx_infer_subgraph(node, subgraph, inc_subgraph_id=False)

        # create a new symbolic dimension for iteration dependent dimension
        loop_iter_dim = str(self._new_symbolic_dim_from_output(node))
        for i in range(len(node.output)):
            vi = self.known_vi_[node.output[i]]
            vi.CopyFrom(subgraph.output[i + 1])  # first subgraph output is condition, not in node output
            if i >= num_loop_carried:
                assert not is_sequence(vi.type)  # TODO: handle loop accumulation in sequence_type
                subgraph_vi_dim = subgraph.output[i + 1].type.tensor_type.shape.dim
                vi.type.tensor_type.shape.ClearField("dim")
                vi_dim = vi.type.tensor_type.shape.dim
                vi_dim.add().dim_param = loop_iter_dim
                vi_dim.extend(list(subgraph_vi_dim))
            vi.name = node.output[i]

    def _infer_MatMul(self, node):  # noqa: N802
        self._compute_matmul_shape(node)

    def _infer_MatMulInteger(self, node):  # noqa: N802
        self._compute_matmul_shape(node, onnx.TensorProto.INT32)

    def _infer_MatMulNBits(self, node):  # noqa: N802
        lhs_shape = self._get_shape(node, 0)
        rhs_shape = [get_attribute(node, "K"), get_attribute(node, "N")]
        lhs_rank = len(lhs_shape)
        assert lhs_rank > 0
        if lhs_rank == 1:
            new_shape = rhs_shape[1:]
        else:
            new_shape = lhs_shape[:-1] + rhs_shape[1:]
        # merge reduce dim
        self._check_merged_dims(
            [lhs_shape[-1], rhs_shape[0]],
            allow_broadcast=False,
        )
        # infer output_dtype from input type when not specified
        output_dtype = self.known_vi_[node.input[0]].type.tensor_type.elem_type
        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(helper.make_tensor_value_info(node.output[0], output_dtype, new_shape))

    def _infer_NonMaxSuppression(self, node):  # noqa: N802
        selected = str(self._new_symbolic_dim_from_output(node))
        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(helper.make_tensor_value_info(node.output[0], onnx.TensorProto.INT64, [selected, 3]))

    def _infer_NonZero(self, node):  # noqa: N802
        input_rank = self._get_shape_rank(node, 0)
        # create a new symbolic dimension for NonZero output
        nz_len = str(self._new_symbolic_dim_from_output(node, 0, 1))
        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(helper.make_tensor_value_info(node.output[0], vi.type.tensor_type.elem_type, [input_rank, nz_len]))

    def _infer_OneHot(self, node):  # noqa: N802
        sympy_shape = self._get_sympy_shape(node, 0)
        depth = self._try_get_value(node, 1)
        axis = get_attribute(node, "axis", -1)
        axis = handle_negative_axis(axis, len(sympy_shape) + 1)
        new_shape = get_shape_from_sympy_shape(
            [
                *sympy_shape[:axis],
                self._new_symbolic_dim_from_output(node) if not is_literal(depth) else depth,
                *sympy_shape[axis:],
            ]
        )
        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(
            helper.make_tensor_value_info(
                node.output[0],
                self.known_vi_[node.input[2]].type.tensor_type.elem_type,
                new_shape,
            )
        )

    def _infer_Pad(self, node):  # noqa: N802
        if get_opset(self.out_mp_) <= 10:
            pads = get_attribute(node, "pads")
        else:
            pads = self._try_get_value(node, 1)

        sympy_shape = self._get_sympy_shape(node, 0)
        rank = len(sympy_shape)

        if pads is not None:
            assert len(pads) == 2 * rank
            new_sympy_shape = [
                d + pad_up + pad_down
                for d, pad_up, pad_down in zip(sympy_shape, pads[:rank], pads[rank:], strict=False)
            ]
            self._update_computed_dims(new_sympy_shape)
        else:
            # dynamic pads, create new symbolic dimensions
            new_sympy_shape = self._new_symbolic_shape(rank, node)
        output_tp = self.known_vi_[node.input[0]].type.tensor_type.elem_type

        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(
            helper.make_tensor_value_info(node.output[0], output_tp, get_shape_from_sympy_shape(new_sympy_shape))
        )

    def _infer_Pool(self, node):  # noqa: N802
        sympy_shape = self._compute_conv_pool_shape(node)
        self._update_computed_dims(sympy_shape)
        for o in node.output:
            if not o:
                continue
            vi = self.known_vi_[o]
            vi.CopyFrom(
                helper.make_tensor_value_info(
                    o,
                    vi.type.tensor_type.elem_type,
                    get_shape_from_sympy_shape(sympy_shape),
                )
            )

    def _infer_aten_bitwise_or(self, node):
        shape0 = self._get_shape(node, 0)
        shape1 = self._get_shape(node, 1)
        new_shape = self._broadcast_shapes(shape0, shape1)
        t0 = self.known_vi_[node.input[0]]
        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(helper.make_tensor_value_info(node.output[0], t0.type.tensor_type.elem_type, new_shape))

    def _infer_aten_diagonal(self, node):
        sympy_shape = self._get_sympy_shape(node, 0)
        rank = len(sympy_shape)
        offset = self._try_get_value(node, 1)
        dim1 = self._try_get_value(node, 2)
        dim2 = self._try_get_value(node, 3)

        assert offset is not None and dim1 is not None and dim2 is not None
        dim1 = handle_negative_axis(dim1, rank)
        dim2 = handle_negative_axis(dim2, rank)

        new_shape = []
        for dim, val in enumerate(sympy_shape):
            if dim not in [dim1, dim2]:
                new_shape.append(val)

        shape1 = sympy_shape[dim1]
        shape2 = sympy_shape[dim2]
        if offset >= 0:
            diag_shape = sympy.Max(0, sympy.Min(shape1, shape2 - offset))
        else:
            diag_shape = sympy.Max(0, sympy.Min(shape1 + offset, shape2))
        new_shape.append(diag_shape)

        if node.output[0]:
            vi = self.known_vi_[node.output[0]]
            vi.CopyFrom(
                helper.make_tensor_value_info(
                    node.output[0],
                    self.known_vi_[node.input[0]].type.tensor_type.elem_type,
                    get_shape_from_sympy_shape(new_shape),
                )
            )

    def _infer_aten_multinomial(self, node):
        sympy_shape = self._get_sympy_shape(node, 0)
        rank = len(sympy_shape)
        assert rank in [1, 2]
        num_samples = self._try_get_value(node, 1)
        di = rank - 1
        last_dim = num_samples if num_samples else str(self._new_symbolic_dim_from_output(node, 0, di))
        output_shape = [*sympy_shape[:-1], last_dim]
        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(
            helper.make_tensor_value_info(
                node.output[0],
                onnx.TensorProto.INT64,
                get_shape_from_sympy_shape(output_shape),
            )
        )

    def _infer_aten_pool2d(self, node):
        sympy_shape = self._get_sympy_shape(node, 0)
        assert len(sympy_shape) == 4
        sympy_shape[-2:] = [self._new_symbolic_dim_from_output(node, 0, i) for i in [2, 3]]
        self._update_computed_dims(sympy_shape)
        for i, o in enumerate(node.output):
            if not o:
                continue
            vi = self.known_vi_[o]
            elem_type = onnx.TensorProto.INT64 if i == 1 else self.known_vi_[node.input[0]].type.tensor_type.elem_type
            vi.CopyFrom(helper.make_tensor_value_info(o, elem_type, get_shape_from_sympy_shape(sympy_shape)))

    def _infer_aten_minmax(self, node):
        vi = self.known_vi_[node.output[0]]
        if len(node.input) == 1:
            vi.CopyFrom(
                helper.make_tensor_value_info(
                    node.output[0], self.known_vi_[node.input[0]].type.tensor_type.elem_type, []
                )
            )
        else:
            assert len(node.input) == 3
            keepdim = self._try_get_value(node, 2)
            assert keepdim is not None  # can only handle known keepdim case.
            dim = self._try_get_value(node, 1)
            if dim is None:
                rank = self._get_shape_rank(node, 0)
                output_shape = self._new_symbolic_shape(rank if keepdim else rank - 1, node)
            else:
                shape = self._get_sympy_shape(node, 0)
                dim = handle_negative_axis(dim, len(shape))
                output_shape = shape[:dim]
                if keepdim:
                    output_shape += [1]
                output_shape += shape[dim + 1 :]

            output_shape = get_shape_from_sympy_shape(output_shape)
            vi.CopyFrom(
                helper.make_tensor_value_info(
                    node.output[0], self.known_vi_[node.input[0]].type.tensor_type.elem_type, output_shape
                )
            )
            vi1 = self.known_vi_[node.output[1]]
            vi1.CopyFrom(helper.make_tensor_value_info(node.output[1], onnx.TensorProto.INT64, output_shape))

    def _infer_aten_unfold(self, node):
        sympy_shape = self._get_sympy_shape(node, 0)
        dimension = self._try_get_value(node, 1)
        size = self._try_get_value(node, 2)
        step = self._try_get_value(node, 3)
        if dimension is not None and size is not None and step is not None:
            assert dimension < len(sympy_shape)
            sympy_shape[dimension] = (sympy_shape[dimension] - size) // step + 1
            sympy_shape.append(size)
        else:
            rank = len(sympy_shape)
            sympy_shape = self._new_symbolic_shape(rank + 1, node)
        self._update_computed_dims(sympy_shape)
        if node.output[0]:
            vi = self.known_vi_[node.output[0]]
            vi.CopyFrom(
                helper.make_tensor_value_info(
                    node.output[0],
                    self.known_vi_[node.input[0]].type.tensor_type.elem_type,
                    get_shape_from_sympy_shape(sympy_shape),
                )
            )

    def _infer_aten_argmax(self, node):
        new_shape = None
        if not node.input[1]:
            # The argmax of the flattened input is returned.
            new_shape = []
        else:
            dim = self._try_get_value(node, 1)
            keepdim = self._try_get_value(node, 2)
            if keepdim is not None:
                sympy_shape = self._get_sympy_shape(node, 0)
                if dim is not None:
                    dim = handle_negative_axis(dim, len(sympy_shape))
                    if keepdim:
                        sympy_shape[dim] = 1
                    else:
                        del sympy_shape[dim]
                else:
                    rank = len(sympy_shape)
                    sympy_shape = self._new_symbolic_shape(rank if keepdim else rank - 1, node)
                self._update_computed_dims(sympy_shape)
                new_shape = get_shape_from_sympy_shape(sympy_shape)
        if node.output[0] and new_shape is not None:
            vi = self.known_vi_[node.output[0]]
            vi.CopyFrom(helper.make_tensor_value_info(node.output[0], onnx.TensorProto.INT64, new_shape))

    def _infer_aten_group_norm(self, node):
        self._propagate_shape_and_type(node)
        input_shape = self._get_shape(node, 0)
        N = input_shape[0] if input_shape is not None and len(input_shape) != 0 else None  # noqa: N806
        group = self._try_get_value(node, 6)
        output_dtype = self.known_vi_[node.input[0]].type.tensor_type.elem_type
        for i in [1, 2]:
            if node.output[i]:
                vi = self.known_vi_[node.output[i]]
                vi.CopyFrom(
                    helper.make_tensor_value_info(
                        node.output[i],
                        output_dtype,
                        [
                            N if N is not None else str(self._new_symbolic_dim_from_output(node, i, 0)),
                            (
                                as_scalar(group)
                                if group is not None
                                else str(self._new_symbolic_dim_from_output(node, i, 1))
                            ),
                        ],
                    )
                )

    def _infer_aten_upsample(self, node):
        new_shape = None
        input_shape = self._get_shape(node, 0)
        if input_shape is not None:
            new_shape = input_shape[:2]
            output_size = self._try_get_value(node, 1)
            if output_size is not None:
                new_shape += [dim_size.item() if type(dim_size) is np.int64 else dim_size for dim_size in output_size]
            else:
                rank = len(input_shape)
                new_shape += [str(self._new_symbolic_dim_from_output(node, 0, i)) for i in range(2, rank)]
        if node.output[0] and new_shape is not None:
            output_dtype = self.known_vi_[node.input[0]].type.tensor_type.elem_type
            vi = self.known_vi_[node.output[0]]
            vi.CopyFrom(helper.make_tensor_value_info(node.output[0], output_dtype, new_shape))

    def _infer_BatchNormalization(self, node):  # noqa: N802
        self._propagate_shape_and_type(node)

        # this works for opsets < 14 and 14 since we check i < len(node.output) in the loop
        for i in [1, 2, 3, 4]:
            if i < len(node.output) and node.output[i]:
                # all of these parameters have the same shape as the 1st input
                self._propagate_shape_and_type(node, input_index=1, output_index=i)

    def _infer_Range(self, node):  # noqa: N802
        vi = self.known_vi_[node.output[0]]
        input_data = self._get_int_or_float_values(node)
        if all(i is not None for i in input_data):
            start = as_scalar(input_data[0])
            limit = as_scalar(input_data[1])
            delta = as_scalar(input_data[2])
            new_sympy_shape = [sympy.Max(sympy.ceiling((limit - start) / delta), 0)]
        else:
            new_sympy_shape = [self._new_symbolic_dim_from_output(node)]
        self._update_computed_dims(new_sympy_shape)
        vi.CopyFrom(
            helper.make_tensor_value_info(
                node.output[0],
                self.known_vi_[node.input[0]].type.tensor_type.elem_type,
                get_shape_from_sympy_shape(new_sympy_shape),
            )
        )

    def _infer_ReduceSum(self, node):  # noqa: N802
        keep_dims = get_attribute(node, "keepdims", 1)
        if get_opset(self.out_mp_) >= 13 and len(node.input) > 1:
            # ReduceSum changes axes to input[1] in opset 13
            axes = self._try_get_value(node, 1)
            vi = self.known_vi_[node.output[0]]
            if axes is None:
                assert keep_dims  # can only handle keep_dims==True when axes is unknown, by generating new ranks
                vi.CopyFrom(
                    helper.make_tensor_value_info(
                        node.output[0],
                        self.known_vi_[node.input[0]].type.tensor_type.elem_type,
                        get_shape_from_sympy_shape(self._new_symbolic_shape(self._get_shape_rank(node, 0), node)),
                    )
                )
            else:
                shape = self._get_shape(node, 0)
                output_shape = []
                axes = [handle_negative_axis(a, len(shape)) for a in axes]
                for i, d in enumerate(shape):
                    if i in axes:
                        if keep_dims:
                            output_shape.append(1)
                    else:
                        output_shape.append(d)
                vi.CopyFrom(
                    helper.make_tensor_value_info(
                        node.output[0],
                        self.known_vi_[node.input[0]].type.tensor_type.elem_type,
                        output_shape,
                    )
                )

    def _infer_ReduceMean(self, node):  # noqa: N802
        if get_opset(self.out_mp_) >= 18:
            # reduce mean spec 18+ is same as reduce sum spec 13+
            self._infer_ReduceSum(node)

    def _infer_ReduceProd(self, node):  # noqa: N802
        axes = get_attribute(node, "axes")
        keep_dims = get_attribute(node, "keepdims", 1)
        if keep_dims == 0 and axes == [0]:
            data = self._get_int_or_float_values(node)[0]
            if data is not None:
                self.sympy_data_[node.output[0]] = sympy_reduce_product(data)

    def _infer_RelativePositionBias(self, node):  # noqa: N802
        seq_len = self._try_get_value(node, 1)
        real_seq_len = self._try_get_value(node, 2)
        if seq_len is None or real_seq_len is None:
            return
        num_heads = self._get_sympy_shape(node, 0)[1]

        new_shape = [1, num_heads, str(seq_len), str(real_seq_len)]

        output_dtype = self.known_vi_[node.input[0]].type.tensor_type.elem_type
        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(helper.make_tensor_value_info(node.output[0], output_dtype, new_shape))

    def _infer_Reshape(self, node):  # noqa: N802
        shape_value = self._try_get_value(node, 1)
        vi = self.known_vi_[node.output[0]]
        if shape_value is None:
            shape_shape = self._get_shape(node, 1)
            assert len(shape_shape) == 1
            shape_rank = shape_shape[0]
            assert is_literal(shape_rank)
            vi.CopyFrom(
                helper.make_tensor_value_info(
                    node.output[0],
                    vi.type.tensor_type.elem_type,
                    get_shape_from_sympy_shape(self._new_symbolic_shape(shape_rank, node)),
                )
            )
        else:
            input_sympy_shape = self._get_sympy_shape(node, 0)
            total = 1
            for d in input_sympy_shape:
                total = total * d
            new_sympy_shape = []
            deferred_dim_idx = -1
            non_deferred_size = 1
            for i, d in enumerate(shape_value):
                if type(d) is sympy.Symbol:
                    new_sympy_shape.append(d)
                elif d == 0:
                    new_sympy_shape.append(input_sympy_shape[i])
                    non_deferred_size = non_deferred_size * input_sympy_shape[i]
                else:
                    new_sympy_shape.append(d)
                if d == -1:
                    deferred_dim_idx = i
                elif d != 0:
                    non_deferred_size = non_deferred_size * d

            assert new_sympy_shape.count(-1) < 2
            if -1 in new_sympy_shape:
                new_dim = total // non_deferred_size
                new_sympy_shape[deferred_dim_idx] = new_dim

            self._update_computed_dims(new_sympy_shape)
            vi.CopyFrom(
                helper.make_tensor_value_info(
                    node.output[0],
                    vi.type.tensor_type.elem_type,
                    get_shape_from_sympy_shape(new_sympy_shape),
                )
            )

        self._pass_on_sympy_data(node)

    def _infer_Resize(self, node):  # noqa: N802
        vi = self.known_vi_[node.output[0]]
        input_sympy_shape = self._get_sympy_shape(node, 0)
        if get_opset(self.out_mp_) <= 10:
            scales = self._try_get_value(node, 1)
            if scales is not None:
                new_sympy_shape = [
                    sympy.simplify(sympy.floor(d * s)) for d, s in zip(input_sympy_shape, scales, strict=False)
                ]
                self._update_computed_dims(new_sympy_shape)
                vi.CopyFrom(
                    helper.make_tensor_value_info(
                        node.output[0],
                        self.known_vi_[node.input[0]].type.tensor_type.elem_type,
                        get_shape_from_sympy_shape(new_sympy_shape),
                    )
                )
        else:
            roi = self._try_get_value(node, 1)
            scales = self._try_get_value(node, 2)
            sizes = self._try_get_value(node, 3)
            if sizes is not None:
                new_sympy_shape = [sympy.simplify(sympy.floor(s)) for s in sizes]
                self._update_computed_dims(new_sympy_shape)
            elif scales is not None:
                rank = len(scales)
                if get_attribute(node, "coordinate_transformation_mode") == "tf_crop_and_resize":
                    assert len(roi) == 2 * rank
                    roi_start = list(roi)[:rank]
                    roi_end = list(roi)[rank:]
                else:
                    roi_start = [0] * rank
                    roi_end = [1] * rank
                scales = list(scales)
                new_sympy_shape = [
                    sympy.simplify(sympy.floor(d * (end - start) * scale))
                    for d, start, end, scale in zip(input_sympy_shape, roi_start, roi_end, scales, strict=False)
                ]
                self._update_computed_dims(new_sympy_shape)
            else:
                new_sympy_shape = self._new_symbolic_shape(self._get_shape_rank(node, 0), node)

            vi.CopyFrom(
                helper.make_tensor_value_info(
                    node.output[0],
                    self.known_vi_[node.input[0]].type.tensor_type.elem_type,
                    get_shape_from_sympy_shape(new_sympy_shape),
                )
            )

    def _infer_Scan(self, node):  # noqa: N802
        subgraph = get_attribute(node, "body")
        num_scan_inputs = get_attribute(node, "num_scan_inputs")
        scan_input_axes = get_attribute(node, "scan_input_axes", [0] * num_scan_inputs)
        num_scan_states = len(node.input) - num_scan_inputs
        scan_input_axes = [
            handle_negative_axis(ax, self._get_shape_rank(node, i + num_scan_states))
            for i, ax in enumerate(scan_input_axes)
        ]
        # We may have cases where the subgraph has optional inputs that appear in both subgraph's input and initializer,
        # but not in the node's input. In such cases, the input model might be invalid, but let's skip those optional inputs.
        assert len(subgraph.input) >= len(node.input)
        subgraph_inputs = subgraph.input[: len(node.input)]
        for i, si in enumerate(subgraph_inputs):
            subgraph_name = si.name
            si.CopyFrom(self.known_vi_[node.input[i]])
            if i >= num_scan_states:
                scan_input_dim = si.type.tensor_type.shape.dim
                scan_input_dim.remove(scan_input_dim[scan_input_axes[i - num_scan_states]])
            si.name = subgraph_name
        self._onnx_infer_subgraph(node, subgraph)
        num_scan_outputs = len(node.output) - num_scan_states
        scan_output_axes = get_attribute(node, "scan_output_axes", [0] * num_scan_outputs)
        scan_input_dim = get_shape_from_type_proto(self.known_vi_[node.input[-1]].type)[scan_input_axes[-1]]
        for i, o in enumerate(node.output):
            vi = self.known_vi_[o]
            if i >= num_scan_states:
                shape = get_shape_from_type_proto(subgraph.output[i].type)
                new_dim = handle_negative_axis(scan_output_axes[i - num_scan_states], len(shape) + 1)
                shape = [*shape[:new_dim], scan_input_dim, *shape[new_dim:]]
                vi.CopyFrom(helper.make_tensor_value_info(o, subgraph.output[i].type.tensor_type.elem_type, shape))
            else:
                vi.CopyFrom(subgraph.output[i])
            vi.name = o

    def _infer_ScatterElements(self, node):  # noqa: N802
        data_shape = self._get_shape(node, 0)
        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(
            helper.make_tensor_value_info(
                node.output[0],
                self.known_vi_[node.input[0]].type.tensor_type.elem_type,
                data_shape,
            )
        )

    def _infer_SequenceAt(self, node):  # noqa: N802
        # need to create new symbolic dimension if sequence shape has None:
        seq_shape = self._get_shape(node, 0)
        vi = self.known_vi_[node.output[0]]
        if seq_shape is not None:
            for di, d in enumerate(seq_shape):
                if d is not None:
                    continue
                new_dim = onnx.TensorShapeProto.Dimension()
                new_dim.dim_param = str(self._new_symbolic_dim_from_output(node, 0, di))
                vi.type.tensor_type.shape.dim[di].CopyFrom(new_dim)

    def _infer_SequenceInsert(self, node):  # noqa: N802
        # workaround bug in onnx's shape inference
        vi_seq = self.known_vi_[node.input[0]]
        vi_tensor = self.known_vi_[node.input[1]]
        vi_out_seq = self.known_vi_[node.output[0]]
        vi_out_seq.CopyFrom(vi_seq)
        vi_out_seq.name = node.output[0]
        self._fuse_tensor_type(node, 0, vi_out_seq.type, vi_tensor.type)

    def _infer_Shape(self, node):  # noqa: N802
        self.sympy_data_[node.output[0]] = self._get_sympy_shape(node, 0)

    def _infer_Size(self, node):  # noqa: N802
        sympy_shape = self._get_sympy_shape(node, 0)
        self.sympy_data_[node.output[0]] = sympy_reduce_product(sympy_shape)
        self.known_vi_[node.output[0]].CopyFrom(
            helper.make_tensor_value_info(node.output[0], onnx.TensorProto.INT64, [])
        )

    def _infer_Slice(self, node):  # noqa: N802
        # SymPy fails to prove that `x_0 + ... + x_n >= 0` if one of `x_i` is a `sympy.Min(a, b)`,
        # even when the relation holds for both `a` and `b`.
        #
        # When given `expr` of form `min(a, b) + ...`, this function returns `[a + ..., b + ...]`,
        # so that we can prove inequalities for both expressions separately.
        #
        # If the number of `min(...)` subexpressions is not exactly one, this function just returns `[expr]`.
        def flatten_min(expr):
            assert isinstance(expr, sympy.Add), f"Expected a sum of two arguments, got {expr}"
            min_positions = [idx for idx in range(len(expr.args)) if isinstance(expr.args[idx], sympy.Min)]
            if len(min_positions) == 1:
                min_pos = min_positions[0]

                def replace_min_with_arg(arg_idx):
                    replaced = list(expr.args)
                    assert isinstance(replaced[min_pos], sympy.Min), (
                        f"Expected a sympy.Min() at position {min_pos}, got {replaced[min_pos]}"
                    )
                    assert len(replaced[min_pos].args) == 2, (
                        f"Expected a sympy.Min() with exactly 2 arguments, got {replaced[min_pos]}"
                    )
                    replaced[min_pos] = replaced[min_pos].args[arg_idx]
                    return sympy.Add(*replaced)

                return [
                    replace_min_with_arg(0),
                    replace_min_with_arg(1),
                ]
            return [expr]

        def less_equal(x, y):
            try:
                return bool(x <= y)
            except TypeError:
                pass
            try:
                return bool(y >= x)
            except TypeError:
                pass
            try:
                return bool(-x >= -y)
            except TypeError:
                pass
            try:
                return bool(-y <= -x)
            except TypeError:
                pass
            try:
                return bool(y - x >= 0)
            except TypeError:
                # the last attempt; this may raise TypeError
                return all(bool(d >= 0) for d in flatten_min(y - x))

        def handle_negative_index(index, bound):
            """normalizes a negative index to be in [0, bound)"""
            try:
                if not less_equal(0, index):
                    if is_literal(index) and index <= -self.int_max_:
                        # this case is handled separately
                        return index
                    return bound + index
            except TypeError:
                logger.warning(f"Cannot determine if {index} < 0")
            return index

        if get_opset(self.out_mp_) <= 9:
            axes = get_attribute(node, "axes")
            starts = get_attribute(node, "starts")
            ends = get_attribute(node, "ends")
            if not axes:
                axes = list(range(len(starts)))
            steps = [1] * len(axes)
        else:
            starts = as_list(self._try_get_value(node, 1), keep_none=True)
            ends = as_list(self._try_get_value(node, 2), keep_none=True)
            axes = self._try_get_value(node, 3)
            steps = self._try_get_value(node, 4)
            if axes is None and not (starts is None and ends is None):
                axes = list(range(len(starts if starts is not None else ends)))
            if steps is None and not (starts is None and ends is None):
                steps = [1] * len(starts if starts is not None else ends)
            axes = as_list(axes, keep_none=True)
            steps = as_list(steps, keep_none=True)

        new_sympy_shape = self._get_sympy_shape(node, 0)
        if starts is None or ends is None:
            if axes is None:
                for i in range(len(new_sympy_shape)):
                    new_sympy_shape[i] = self._new_symbolic_dim_from_output(node, 0, i)
            else:
                new_sympy_shape = get_shape_from_sympy_shape(new_sympy_shape)
                for i in axes:
                    new_sympy_shape[i] = self._new_symbolic_dim_from_output(node, 0, i)
        else:
            for i, s, e, t in zip(axes, starts, ends, steps, strict=False):
                e = handle_negative_index(e, new_sympy_shape[i])  # noqa: PLW2901
                if is_literal(e):
                    if e >= self.int_max_:
                        e = new_sympy_shape[i]  # noqa: PLW2901
                    elif e <= -self.int_max_:
                        e = 0 if s > 0 else -1  # noqa: PLW2901
                    elif is_literal(new_sympy_shape[i]):
                        if e < 0:
                            e = max(0, e + new_sympy_shape[i])  # noqa: PLW2901
                        e = min(e, new_sympy_shape[i])  # noqa: PLW2901
                    else:
                        if e > 0:
                            e = (  # noqa: PLW2901
                                sympy.Min(e, new_sympy_shape[i]) if e > 1 else e
                            )  # special case for slicing first to make computation easier
                else:
                    if is_literal(new_sympy_shape[i]):
                        e = sympy.Min(e, new_sympy_shape[i])  # noqa: PLW2901
                    else:
                        try:
                            if not less_equal(e, new_sympy_shape[i]):
                                e = new_sympy_shape[i]  # noqa: PLW2901
                        except Exception:
                            logger.warning(f"Unable to determine if {e} <= {new_sympy_shape[i]}, treat as equal")
                            e = new_sympy_shape[i]  # noqa: PLW2901

                s = handle_negative_index(s, new_sympy_shape[i])  # noqa: PLW2901
                if is_literal(new_sympy_shape[i]) and is_literal(s):
                    s = max(0, min(s, new_sympy_shape[i]))  # noqa: PLW2901

                new_sympy_shape[i] = sympy.simplify((e - s + t + (-1 if t > 0 else 1)) // t)

            self._update_computed_dims(new_sympy_shape)

        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(
            helper.make_tensor_value_info(
                node.output[0],
                vi.type.tensor_type.elem_type,
                get_shape_from_sympy_shape(new_sympy_shape),
            )
        )

        # handle sympy_data if needed, for slice in shape computation
        if (
            node.input[0] in self.sympy_data_
            and axes == [0]
            and starts is not None
            and len(starts) == 1
            and ends is not None
            and len(ends) == 1
            and steps is not None
            and len(steps) == 1
        ):
            input_sympy_data = self.sympy_data_[node.input[0]]
            if type(input_sympy_data) is list or (
                type(input_sympy_data) is np.array and len(input_sympy_data.shape) == 1
            ):
                self.sympy_data_[node.output[0]] = input_sympy_data[starts[0] : ends[0] : steps[0]]

    def _infer_SoftmaxCrossEntropyLoss(self, node):  # noqa: N802
        vi = self.known_vi_[node.output[0]]
        elem_type = self.known_vi_[node.input[0]].type.tensor_type.elem_type

        # If output type is explicit specified in attribute, we use it as output tensor type.
        specified_output_type = get_attribute(node, "output_type", None)
        if specified_output_type is not None:
            elem_type = specified_output_type

        vi.type.tensor_type.elem_type = elem_type
        vi.type.tensor_type.shape.CopyFrom(onnx.TensorShapeProto())

        if len(node.output) > 1:
            data_shape = self._get_shape(node, 0)
            vi = self.known_vi_[node.output[1]]
            vi.CopyFrom(helper.make_tensor_value_info(vi.name, elem_type, data_shape))

    def _infer_Split_Common(self, node, make_value_info_func):  # noqa: N802
        input_sympy_shape = self._get_sympy_shape(node, 0)
        axis = handle_negative_axis(get_attribute(node, "axis", 0), len(input_sympy_shape))
        op_set = get_opset(self.out_mp_)

        # Depending on op-version 'split' are provided as attribute or via 2nd input
        if op_set < 13:
            split = get_attribute(node, "split")
            assert self._try_get_value(node, 1) is None
        else:
            split = self._try_get_value(node, 1)
            assert get_attribute(node, "split") is None

        if split is None:
            num_outputs = len(node.output)
            split = [input_sympy_shape[axis] / sympy.Integer(num_outputs)] * num_outputs
            self._update_computed_dims(split)
        else:
            split = [sympy.Integer(s) for s in split]

        for i_o in range(len(split)):
            vi = self.known_vi_[node.output[i_o]]
            vi.CopyFrom(
                make_value_info_func(
                    node.output[i_o],
                    self.known_vi_[node.input[0]].type.tensor_type.elem_type,
                    get_shape_from_sympy_shape([*input_sympy_shape[:axis], split[i_o], *input_sympy_shape[axis + 1 :]]),
                )
            )
            self.known_vi_[vi.name] = vi

    def _infer_Split(self, node):  # noqa: N802
        self._infer_Split_Common(node, helper.make_tensor_value_info)

    def _infer_SplitToSequence(self, node):  # noqa: N802
        self._infer_Split_Common(node, helper.make_sequence_value_info)

    def _infer_Squeeze(self, node):  # noqa: N802
        input_shape = self._get_shape(node, 0)
        op_set = get_opset(self.out_mp_)

        # Depending on op-version 'axes' are provided as attribute or via 2nd input
        if op_set < 13:
            axes = get_attribute(node, "axes")
            assert self._try_get_value(node, 1) is None
        else:
            axes = self._try_get_value(node, 1)
            assert get_attribute(node, "axes") is None

        if axes is None:
            # No axes have been provided (neither via attribute nor via input).
            # In this case the 'Shape' op should remove all axis with dimension 1.
            # For symbolic dimensions we guess they are !=1.
            output_shape = [s for s in input_shape if s != 1]
            if self.verbose_ > 0:
                symbolic_dimensions = [s for s in input_shape if type(s) != int]  # noqa: E721
                if len(symbolic_dimensions) > 0:
                    logger.debug(
                        f"Symbolic dimensions in input shape of op: '{node.op_type}' node: '{node.name}'. "
                        f"Assuming the following dimensions are never equal to 1: {symbolic_dimensions}"
                    )
        else:
            axes = [handle_negative_axis(a, len(input_shape)) for a in axes]
            output_shape = []
            for i in range(len(input_shape)):
                if i not in axes:
                    output_shape.append(input_shape[i])
                else:
                    assert input_shape[i] == 1 or type(input_shape[i]) != int  # noqa: E721
                    if self.verbose_ > 0 and type(input_shape[i]) != int:  # noqa: E721
                        logger.debug(
                            f"Symbolic dimensions in input shape of op: '{node.op_type}' node: '{node.name}'. "
                            f"Assuming the dimension '{input_shape[i]}' at index {i} of the input to be equal to 1."
                        )

        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(
            helper.make_tensor_value_info(
                node.output[0],
                self.known_vi_[node.input[0]].type.tensor_type.elem_type,
                output_shape,
            )
        )
        self._pass_on_sympy_data(node)

    def _infer_Tile(self, node):  # noqa: N802
        repeats_value = self._try_get_value(node, 1)
        new_sympy_shape = []
        if repeats_value is not None:
            input_sympy_shape = self._get_sympy_shape(node, 0)
            for i, d in enumerate(input_sympy_shape):
                new_dim = d * repeats_value[i]
                new_sympy_shape.append(new_dim)
            self._update_computed_dims(new_sympy_shape)
        else:
            new_sympy_shape = self._new_symbolic_shape(self._get_shape_rank(node, 0), node)
        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(
            helper.make_tensor_value_info(
                node.output[0],
                vi.type.tensor_type.elem_type,
                get_shape_from_sympy_shape(new_sympy_shape),
            )
        )

    def _infer_TopK(self, node):  # noqa: N802
        rank = self._get_shape_rank(node, 0)
        axis = handle_negative_axis(get_attribute(node, "axis", -1), rank)
        new_shape = self._get_shape(node, 0)

        if get_opset(self.out_mp_) <= 9:
            k = get_attribute(node, "k")
        else:
            k = self._get_int_or_float_values(node)[1]

        if k is None:
            k = self._new_symbolic_dim_from_output(node)
        else:
            k = as_scalar(k)

        if type(k) in [int, str]:
            new_shape[axis] = k
        else:
            new_sympy_shape = self._get_sympy_shape(node, 0)
            new_sympy_shape[axis] = k
            self._update_computed_dims(
                new_sympy_shape
            )  # note that TopK dim could be computed in sympy_data, so need to update computed_dims when it enters shape
            new_shape = get_shape_from_sympy_shape(new_sympy_shape)

        for i_o in range(len(node.output)):
            vi = self.known_vi_[node.output[i_o]]
            vi.CopyFrom(helper.make_tensor_value_info(node.output[i_o], vi.type.tensor_type.elem_type, new_shape))

    def _infer_Transpose(self, node):  # noqa: N802
        if node.input[0] in self.sympy_data_:
            data_shape = self._get_shape(node, 0)
            perm = get_attribute(node, "perm", reversed(list(range(len(data_shape)))))
            input_data = self.sympy_data_[node.input[0]]
            self.sympy_data_[node.output[0]] = (
                np.transpose(np.array(input_data).reshape(*data_shape), axes=tuple(perm)).flatten().tolist()
            )

    def _infer_Unsqueeze(self, node):  # noqa: N802
        input_shape = self._get_shape(node, 0)
        op_set = get_opset(self.out_mp_)

        # Depending on op-version 'axes' are provided as attribute or via 2nd input
        if op_set < 13:
            axes = get_attribute(node, "axes")
            assert self._try_get_value(node, 1) is None
        else:
            axes = self._try_get_value(node, 1)
            assert get_attribute(node, "axes") is None

        output_rank = len(input_shape) + len(axes)
        axes = [handle_negative_axis(a, output_rank) for a in axes]

        input_axis = 0
        output_shape = []
        for i in range(output_rank):
            if i in axes:
                output_shape.append(1)
            else:
                output_shape.append(input_shape[input_axis])
                input_axis += 1

        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(
            helper.make_tensor_value_info(
                node.output[0],
                self.known_vi_[node.input[0]].type.tensor_type.elem_type,
                output_shape,
            )
        )

        self._pass_on_sympy_data(node)

    def _infer_ZipMap(self, node):  # noqa: N802
        map_key_type = None
        if get_attribute(node, "classlabels_int64s") is not None:
            map_key_type = onnx.TensorProto.INT64
        elif get_attribute(node, "classlabels_strings") is not None:
            map_key_type = onnx.TensorProto.STRING

        assert map_key_type is not None
        new_vi = onnx.ValueInfoProto()
        new_vi.name = node.output[0]
        new_vi.type.sequence_type.elem_type.map_type.value_type.tensor_type.elem_type = onnx.TensorProto.FLOAT
        new_vi.type.sequence_type.elem_type.map_type.key_type = map_key_type
        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(new_vi)

    def _infer_Attention(self, node):  # noqa: N802
        shape = self._get_shape(node, 0)
        shape_weights = self._get_shape(node, 1)
        shape_bias = self._try_get_shape(node, 2)
        if shape_bias is not None:
            assert len(shape_bias) == 1
        tripled_hidden_size = shape_bias[0] if shape_bias is not None else shape_weights[1]
        if shape and len(shape) == 3:
            qkv_hidden_sizes_attr = get_attribute(node, "qkv_hidden_sizes")
            if qkv_hidden_sizes_attr is not None:
                assert len(qkv_hidden_sizes_attr) == 3
                shape[2] = int(qkv_hidden_sizes_attr[2])
            elif isinstance(tripled_hidden_size, int):
                shape[2] = int(tripled_hidden_size / 3)
            output_dtype = self.known_vi_[node.input[0]].type.tensor_type.elem_type
            vi = self.known_vi_[node.output[0]]
            vi.CopyFrom(helper.make_tensor_value_info(node.output[0], output_dtype, shape))

            if len(node.output) > 1:
                # input shape: (batch_size, sequence_length, hidden_size)
                # past shape: (2, batch_size, num_heads, past_sequence_length, head_size)
                # mask shape: (batch_size, total_sequence_length) or (batch_size, sequence_length, total_sequence_length) or (batch_size, 1, max_seq_len, max_seq_len)
                # present shape: (2, batch_size, num_heads, total_sequence_length, head_size), where total_sequence_length=sequence_length+past_sequence_length
                input_shape = self._get_shape(node, 0)
                past_shape = self._get_shape(node, 4) if len(node.input) > 4 and node.input[4] else []
                mask_shape = self._get_shape(node, 3) if len(node.input) > 3 and node.input[3] else []

                if past_shape and len(past_shape) == 5:
                    if mask_shape and len(mask_shape) in [2, 3]:
                        past_shape[3] = mask_shape[-1]
                    elif input_shape and len(input_shape) == 3:
                        if isinstance(input_shape[1], int) and isinstance(past_shape[3], int):
                            past_shape[3] = input_shape[1] + past_shape[3]
                        else:
                            past_shape[3] = f"{past_shape[3]}+{input_shape[1]}"
                    vi = self.known_vi_[node.output[1]]
                    vi.CopyFrom(helper.make_tensor_value_info(vi.name, output_dtype, past_shape))
                # No past input but present output still exists
                else:
                    num_heads = get_attribute(node, "num_heads")
                    head_size = input_shape[2] // num_heads
                    present_shape = [2, input_shape[0], num_heads, input_shape[1], head_size]
                    vi = self.known_vi_[node.output[1]]
                    vi.CopyFrom(helper.make_tensor_value_info(vi.name, output_dtype, present_shape))

    def _infer_GatedRelativePositionBias(self, node):  # noqa: N802
        # When padding is removed:
        #   query_layer: (token_count, num_heads x head_size)
        #   token_offset: (batch_size, seq_len)
        # Otherwise:
        #   query_layer: (batch_size, seq_len, num_heads x head_size)
        #   token_offset: None
        # Output shape: (batch_size, num_heads, seq_len, seq_len)
        num_heads = get_attribute(node, "num_heads")

        token_offset_shape = self._try_get_shape(node, 6)
        if token_offset_shape is not None:
            output_shape = [token_offset_shape[0], num_heads, token_offset_shape[1], token_offset_shape[1]]
        else:
            query_layer_shape = self._get_shape(node, 0)
            assert query_layer_shape is not None and len(query_layer_shape) == 3
            output_shape = [query_layer_shape[0], num_heads, query_layer_shape[1], query_layer_shape[1]]

        output_dtype = self.known_vi_[node.input[0]].type.tensor_type.elem_type
        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(helper.make_tensor_value_info(node.output[0], output_dtype, output_shape))

    def _infer_PackedAttention(self, node):  # noqa: N802
        shape = self._get_shape(node, 0)
        shape_weights = self._get_shape(node, 1)
        shape_bias = self._try_get_shape(node, 2)
        if shape_bias is not None:
            assert len(shape_bias) == 1
        tripled_hidden_size = shape_bias[0] if shape_bias is not None else shape_weights[1]
        if shape and len(shape) == 2:
            qkv_hidden_sizes_attr = get_attribute(node, "qkv_hidden_sizes")
            if qkv_hidden_sizes_attr is not None:
                assert len(qkv_hidden_sizes_attr) == 3
                shape[1] = int(qkv_hidden_sizes_attr[2])
            elif isinstance(tripled_hidden_size, int):
                shape[1] = int(tripled_hidden_size / 3)
            output_dtype = self.known_vi_[node.input[0]].type.tensor_type.elem_type
            vi = self.known_vi_[node.output[0]]
            vi.CopyFrom(helper.make_tensor_value_info(node.output[0], output_dtype, shape))

    def _infer_PackedMultiHeadAttention(self, node):  # noqa: N802
        shape_value = self._try_get_shape(node, 2)
        if shape_value is not None and len(shape_value) == 2:
            output_shape = shape_value
        else:
            shape_query = self._get_shape(node, 0)
            assert shape_query is not None and len(shape_query) == 4
            output_shape = [shape_query[0], shape_query[1] * shape_query[3]]

        output_dtype = self.known_vi_[node.input[0]].type.tensor_type.elem_type
        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(helper.make_tensor_value_info(node.output[0], output_dtype, output_shape))

    def _infer_RemovePadding(self, node):  # noqa: N802
        shape = self._get_shape(node, 0)
        if shape and len(shape) == 3:
            output_dtype = self.known_vi_[node.input[0]].type.tensor_type.elem_type
            vi = self.known_vi_[node.output[0]]
            vi.CopyFrom(helper.make_tensor_value_info(node.output[0], output_dtype, ["token_count", shape[2]]))

            vi_token_offset = self.known_vi_[node.output[1]]
            vi_token_offset.CopyFrom(
                helper.make_tensor_value_info(node.output[1], onnx.TensorProto.INT32, [shape[0], shape[1]])
            )

            vi_cumulated_seq_len = self.known_vi_[node.output[2]]
            vi_cumulated_seq_len.CopyFrom(
                helper.make_tensor_value_info(node.output[2], onnx.TensorProto.INT32, ["batch_size + 1"])
            )

            vi_max_seq_len = self.known_vi_[node.output[3]]
            vi_max_seq_len.CopyFrom(helper.make_tensor_value_info(node.output[3], onnx.TensorProto.INT32, [1]))

    def _infer_RestorePadding(self, node):  # noqa: N802
        shape_input = self._get_shape(node, 0)
        shape_token_offset = self._get_shape(node, 1)
        if shape_input and len(shape_input) == 2 and shape_token_offset and len(shape_token_offset) == 2:
            output_dtype = self.known_vi_[node.input[0]].type.tensor_type.elem_type
            vi = self.known_vi_[node.output[0]]

            output_shape = [shape_token_offset[0], shape_token_offset[1], shape_input[1]]
            vi.CopyFrom(helper.make_tensor_value_info(node.output[0], output_dtype, output_shape))

    def _infer_BiasGelu(self, node):  # noqa: N802
        self._propagate_shape_and_type(node)

    def _infer_MultiHeadAttention(self, node):  # noqa: N802
        # Output 0 has shape (batch_size, sequence_length, v_hidden_size)
        # Q, K and V without packing:
        #   Input 0 (query) has shape (batch_size, sequence_length, hidden_size)
        #   Input 1 (key) has shape (batch_size, kv_sequence_length, hidden_size) or (batch_size, num_heads, kv_sequence_length, head_size)
        #   Input 2 (value) has shape (batch_size, kv_sequence_length, v_hidden_size) or (batch_size, num_heads, kv_sequence_length, head_size)
        # Packed KV:
        #   Input 0 (query) has shape (batch_size, sequence_length, hidden_size)
        #   Input 1 (batch_size, kv_sequence_length, num_heads, 2, head_size)
        #   Input 2  nullptr
        # Packed QKV:
        #   Input 0 (batch_size, sequence_length, num_heads, 3, head_size)
        #   Input 1  nullptr
        #   Input 2  nullptr

        query_shape = self._get_shape(node, 0)
        total_sequence_length = None
        output_dtype = None
        if query_shape is not None:
            if len(query_shape) == 3:
                key_shape = self._try_get_shape(node, 1)
                # By default, hidden size is same for Q/K/V. Only need check v_hidden_size when value is provided.
                output_shape = query_shape
                if key_shape is not None and len(key_shape) == 3:
                    value_shape = self._try_get_shape(node, 2)
                    if value_shape is not None and len(value_shape) == 3:
                        output_shape[2] = value_shape[2]
                    total_sequence_length = key_shape[1]

                output_dtype = self.known_vi_[node.input[0]].type.tensor_type.elem_type
                vi = self.known_vi_[node.output[0]]
                vi.CopyFrom(helper.make_tensor_value_info(node.output[0], output_dtype, output_shape))

            elif len(query_shape) == 5:
                if isinstance(query_shape[2], int) and isinstance(query_shape[4], int):
                    output_shape = [query_shape[0], query_shape[1], query_shape[2] * query_shape[4]]
                else:
                    output_shape = [query_shape[0], query_shape[1], f"{query_shape[2]}*{query_shape[4]}"]

                total_sequence_length = query_shape[1]

                output_dtype = self.known_vi_[node.input[0]].type.tensor_type.elem_type
                vi = self.known_vi_[node.output[0]]
                vi.CopyFrom(helper.make_tensor_value_info(node.output[0], output_dtype, output_shape))

            if len(node.output) > 1:
                batch_size = query_shape[0]
                num_heads = get_attribute(node, "num_heads")

                head_size = None
                if len(query_shape) == 3:
                    head_size = (
                        int(query_shape[2] / num_heads)
                        if isinstance(query_shape[2], int)
                        else f"{query_shape[2]}/{num_heads}"
                    )
                else:
                    head_size = query_shape[4]

                past_shape = self._try_get_shape(node, 6)

                if past_shape is not None:
                    if isinstance(past_shape[2], int) and isinstance(total_sequence_length, int):
                        total_sequence_length = past_shape[2] + total_sequence_length
                    else:
                        total_sequence_length = f"{past_shape[2]}+{total_sequence_length}"

                present_shape = [batch_size, num_heads, total_sequence_length, head_size]

                assert output_dtype is not None
                if len(node.output) > 2 and node.output[1] and node.output[2]:
                    vi = self.known_vi_[node.output[1]]
                    vi.CopyFrom(helper.make_tensor_value_info(vi.name, output_dtype, present_shape))
                    vi = self.known_vi_[node.output[2]]
                    vi.CopyFrom(helper.make_tensor_value_info(vi.name, output_dtype, present_shape))

    def _infer_DecoderMaskedMultiHeadAttention(self, node):  # noqa: N802
        # Output 0 has shape (batch_size, 1, v_hidden_size)
        # Q, K and V without packing:
        #   Input 0 (query) has shape (batch_size, 1, hidden_size)
        #   Input 5 (past_key) if exists has shape (batch_size, num_heads, max_sequence_length, head_size)

        query_shape = self._get_shape(node, 0)
        if query_shape is not None:
            output_shape = query_shape
            output_dtype = self.known_vi_[node.input[0]].type.tensor_type.elem_type
            assert output_dtype is not None
            vi = self.known_vi_[node.output[0]]
            vi.CopyFrom(helper.make_tensor_value_info(node.output[0], output_dtype, output_shape))

            if len(node.output) > 2 and node.output[1] and node.output[2]:
                past_shape = self._try_get_shape(node, 5)
                if past_shape is not None:
                    vi = self.known_vi_[node.output[1]]
                    vi.CopyFrom(helper.make_tensor_value_info(vi.name, output_dtype, past_shape))
                    vi = self.known_vi_[node.output[2]]
                    vi.CopyFrom(helper.make_tensor_value_info(vi.name, output_dtype, past_shape))

    def _infer_UnfoldTensor(self, node):  # noqa: N802
        input_shape = self._get_shape(node, 0)
        if input_shape is not None:
            output_shape = input_shape.copy()
            output_dtype = self.known_vi_[node.input[0]].type.tensor_type.elem_type
            assert output_dtype is not None

            rank, dim, size, step = len(input_shape), None, None, None
            for attr in node.attribute:
                if attr.name == "dim":
                    dim = attr.i
                    dim = rank + dim if dim == -1 else dim
                elif attr.name == "size":
                    size = attr.i
                elif attr.name == "step":
                    step = attr.i

            output_shape.append(size)
            output_shape[dim] = (input_shape[dim] - size) // step + 1

            vi = self.known_vi_[node.output[0]]
            vi.CopyFrom(helper.make_tensor_value_info(node.output[0], output_dtype, output_shape))

    def _infer_DynamicTimeWarping(self, node):  # noqa: N802
        # Input 0 has shape M x N or 1 x M x N
        # Output 0 has shape (2, O) where max(M, N) <= O < M + N
        input_shape = self._get_shape(node, 0)
        if input_shape is not None:
            shape_len = len(input_shape)
            assert shape_len == 2 or shape_len == 3
            M, N = input_shape[shape_len - 2], input_shape[shape_len - 1]  # noqa: N806
            output_shape = [2, f"max({M}, {N}) <= O < {M} + {N}"]
            output_dtype = onnx.TensorProto.FLOAT
            vi = self.known_vi_[node.output[0]]
            vi.CopyFrom(helper.make_tensor_value_info(node.output[0], output_dtype, output_shape))

    def _infer_FastGelu(self, node):  # noqa: N802
        self._propagate_shape_and_type(node)

    def _infer_Gelu(self, node):  # noqa: N802
        self._propagate_shape_and_type(node)

    def _infer_QuickGelu(self, node):  # noqa: N802
        self._propagate_shape_and_type(node)

    def _infer_GemmFastGelu(self, node):  # noqa: N802
        self._compute_matmul_shape(node)

    def _infer_GemmFloat8(self, node):  # noqa: N802
        self._compute_matmul_shape(node)

    def _infer_LayerNormalization(self, node):  # noqa: N802
        self._propagate_shape_and_type(node)
        if len(node.output) > 1:
            axis = get_attribute(node, "axis")
            if axis is None:
                axis = -1
            x_shape = self._get_shape(node, 0)
            if x_shape is not None:
                rank = len(x_shape)
                axis = handle_negative_axis(axis, rank)
                mean_shape = x_shape[:axis] + [1 for _ in range(rank - axis)]
                mean_dtype = self.known_vi_[node.input[0]].type.tensor_type.elem_type
                if mean_dtype == onnx.TensorProto.FLOAT16 or mean_dtype == onnx.TensorProto.BFLOAT16:
                    mean_dtype = onnx.TensorProto.FLOAT
                vi = self.known_vi_[node.output[1]]
                vi.CopyFrom(helper.make_tensor_value_info(node.output[1], mean_dtype, mean_shape))
                if len(node.output) > 2:
                    vi = self.known_vi_[node.output[2]]
                    vi.CopyFrom(helper.make_tensor_value_info(node.output[2], mean_dtype, mean_shape))

    def _infer_LongformerAttention(self, node):  # noqa: N802
        self._propagate_shape_and_type(node)

    def _infer_EmbedLayerNormalization(self, node):  # noqa: N802
        input_ids_shape = self._get_shape(node, 0)
        word_embedding_shape = self._get_shape(node, 2)
        assert len(input_ids_shape) == 2 and len(word_embedding_shape) == 2
        output_shape = [*input_ids_shape, word_embedding_shape[1]]

        word_embedding_dtype = self.known_vi_[node.input[2]].type.tensor_type.elem_type
        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(helper.make_tensor_value_info(node.output[0], word_embedding_dtype, output_shape))

        if len(node.output) > 1 and node.output[1]:
            mask_index_shape = [input_ids_shape[0]]
            vi = self.known_vi_[node.output[1]]
            vi.CopyFrom(helper.make_tensor_value_info(node.output[1], onnx.TensorProto.INT32, mask_index_shape))

        if len(node.output) > 2:
            # Optional output of add before layer normalization is done
            # shape is same as the output
            vi = self.known_vi_[node.output[2]]
            vi.CopyFrom(helper.make_tensor_value_info(node.output[2], word_embedding_dtype, output_shape))

    def _infer_SkipLayerNormalization(self, node):  # noqa: N802
        self._propagate_shape_and_type(node)

        # If the SkipLayerNormalization node contains the optional
        # output for inference, infer the shape and type for it too
        if len(node.output) > 3:
            self._propagate_shape_and_type(node, 0, 3)

    def _infer_GroupNorm(self, node):  # noqa: N802
        self._propagate_shape_and_type(node)

    def _infer_PagedAttention(self, node):  # noqa: N802
        self._propagate_shape_and_type(node)

    def _infer_GroupQueryAttention(self, node):  # noqa: N802
        output_dtype = self.known_vi_[node.input[0]].type.tensor_type.elem_type

        past_shape = self._try_get_shape(node, 3)
        if past_shape is not None:
            # When past and present has the maximum sequence length, we can propagate the shape from past to present.
            # Note that GQA also supports different sequence lengths for past and present, but it is rarely used.
            vi = self.known_vi_[node.output[1]]
            vi.CopyFrom(helper.make_tensor_value_info(vi.name, output_dtype, past_shape))
            vi = self.known_vi_[node.output[2]]
            vi.CopyFrom(helper.make_tensor_value_info(vi.name, output_dtype, past_shape))

        if node.input[1] != "" and node.input[2] != "":
            self._propagate_shape_and_type(node, 0, 0)
        else:
            # combined qkv: (batch_size, sequence_length, num_heads * head_size + 2 * kv_num_heads * head_size)
            assert node.input[1] == "" and node.input[2] == ""
            num_heads = get_attribute(node, "num_heads")
            kv_num_heads = get_attribute(node, "kv_num_heads")
            query_shape = self._get_shape(node, 0)
            if query_shape is not None:
                hidden_size = query_shape[2]
                if isinstance(hidden_size, int):
                    head_size = int(hidden_size / (num_heads + 2 * kv_num_heads))
                    query_shape[2] = num_heads * head_size
                    vi = self.known_vi_[node.output[0]]
                    vi.CopyFrom(helper.make_tensor_value_info(node.output[0], output_dtype, query_shape))

    def _infer_SparseAttention(self, node):  # noqa: N802
        self._infer_GroupQueryAttention(node)

    def _infer_SkipGroupNorm(self, node):  # noqa: N802
        self._propagate_shape_and_type(node, 0, 0)
        if len(node.output) > 1:
            self._propagate_shape_and_type(node, 0, 1)

    def _infer_BiasSplitGelu(self, node):  # noqa: N802
        input_shape = self._get_shape(node, 0)
        bias_shape = self._get_shape(node, 1)
        if input_shape and bias_shape and isinstance(bias_shape[0], int):
            output_shape = input_shape
            output_shape[2] = int(bias_shape[0] / 2)
            vi = self.known_vi_[node.output[0]]
            output_dtype = self.known_vi_[node.input[0]].type.tensor_type.elem_type
            vi.CopyFrom(helper.make_tensor_value_info(vi.name, output_dtype, output_shape))

    def _infer_BiasAdd(self, node):  # noqa: N802
        self._propagate_shape_and_type(node)

    def _infer_RotaryEmbedding(self, node):  # noqa: N802
        if len(node.output) == 1:
            self._propagate_shape_and_type(node)
        elif len(node.output) == 2:
            # Extraneous constant nodes outputted by RotaryEmbedding function made with `export_modules_as_functions`
            self._propagate_shape_and_type(node, input_index=1, output_index=0)
            self._propagate_shape_and_type(node, input_index=0, output_index=1)  # true output
        elif len(node.output) == 3:
            # Extraneous constant nodes outputted by RotaryEmbedding function made with `export_modules_as_functions`
            self._propagate_shape_and_type(node, input_index=1, output_index=0)
            self._propagate_shape_and_type(node, input_index=1, output_index=1)
            self._propagate_shape_and_type(node, input_index=0, output_index=2)  # true output

    def _infer_PythonOp(self, node):  # noqa: N802
        output_tensor_types = get_attribute(node, "output_tensor_types")
        assert output_tensor_types, f"PythonOp '{node.name}' has no output_tensor_types attribute."
        output_tensor_ranks = get_attribute(node, "output_tensor_ranks")
        assert output_tensor_ranks, f"PythonOp '{node.name}' has no output_tensor_ranks attribute."

        from onnxruntime.capi._pybind_state import get_shape_inference_function  # noqa: PLC0415

        func_name = get_attribute(node, "func_name").decode()
        shape_inferer = get_shape_inference_function(func_name)

        # Set the context output separately.
        # The first output is torch.autograd.Function''s context.
        vi = self.known_vi_[node.output[0]]
        vi.CopyFrom(helper.make_tensor_value_info(node.output[0], onnx.TensorProto.INT64, []))

        if shape_inferer is not None:
            input_shapes = []
            input_dtypes = []
            for input_index in range(len(node.input)):
                shape = self._get_shape(node, input_index)
                input_shapes.append(shape)
                input_dtype = self.known_vi_[node.input[input_index]].type.tensor_type.elem_type
                input_dtypes.append(input_dtype)
            output_shapes, output_dtypes = shape_inferer(node, input_shapes, input_dtypes)
            assert len(output_shapes) == len(output_dtypes) == (len(node.output) - 1), (
                f"PythonOp '{func_name}' returned {len(output_shapes)} shapes and {len(output_dtypes)} dtypes, "
                f"but expected {len(node.output) - 1} outputs."
            )
            for i in range(len(node.output) - 1):
                output_index = i + 1
                vi = self.known_vi_[node.output[output_index]]
                vi.CopyFrom(
                    helper.make_tensor_value_info(node.output[output_index], output_dtypes[i], output_shapes[i])
                )
        else:
            # General shape inference for PythonOp.
            # Outputs after torch.autograd.Function's context are tensors.
            # We assume their ranks are fixed for different model inputs.
            for i in range(len(node.output) - 1):
                # Process the i-th tensor outputs.
                vi = self.known_vi_[node.output[i + 1]]
                sympy_shape = self._new_symbolic_shape(output_tensor_ranks[i], node)
                shape = get_shape_from_sympy_shape(sympy_shape)
                value_info = helper.make_tensor_value_info(node.output[i + 1], output_tensor_types[i], shape)
                vi.CopyFrom(value_info)

    def _propagate_shape_and_type(self, node, input_index=0, output_index=0):
        shape = self._get_shape(node, input_index)
        output_dtype = self.known_vi_[node.input[input_index]].type.tensor_type.elem_type
        vi = self.known_vi_[node.output[output_index]]
        vi.CopyFrom(helper.make_tensor_value_info(node.output[output_index], output_dtype, shape))

    def _is_none_dim(self, dim_value):
        if type(dim_value) != str:  # noqa: E721
            return False
        if "unk__" not in dim_value:
            return False
        if dim_value in self.symbolic_dims_:
            return False
        return True

    def _is_shape_contains_none_dim(self, out_shape):
        for out in out_shape:
            if self._is_none_dim(out):
                return out
        return None

    def _infer_impl(self, start_sympy_data=None):
        self.sympy_data_ = start_sympy_data or {}
        self.out_mp_.graph.ClearField("value_info")
        self._apply_suggested_merge(graph_input_only=True)
        self.input_symbols_ = set()
        for i in self.out_mp_.graph.input:
            input_shape = get_shape_from_value_info(i)
            if input_shape is None:
                continue

            if is_sequence(i.type):
                input_dims = i.type.sequence_type.elem_type.tensor_type.shape.dim
            else:
                input_dims = i.type.tensor_type.shape.dim

            for i_dim, dim in enumerate(input_shape):
                if dim is None:
                    # some models use None for symbolic dim in input, replace it with a string
                    input_dims[i_dim].dim_param = str(self._new_symbolic_dim(i.name, i_dim))

            self.input_symbols_.update([d for d in input_shape if type(d) is str])

        for s in self.input_symbols_:
            if s in self.suggested_merge_:
                s_merge = self.suggested_merge_[s]
                assert s_merge in self.symbolic_dims_
                self.symbolic_dims_[s] = self.symbolic_dims_[s_merge]
            else:
                # Since inputs are not produced by other ops, we can assume positivity
                self.symbolic_dims_[s] = sympy.Symbol(s, integer=True, positive=True)
        # create a temporary ModelProto for single node inference
        # note that we remove initializer to have faster inference
        # for tensor ops like Reshape/Tile/Expand that read initializer, we need to do sympy computation based inference anyways
        self.tmp_mp_ = onnx.ModelProto()
        self.tmp_mp_.CopyFrom(self.out_mp_)
        self.tmp_mp_.graph.ClearField("initializer")

        # compute prerequesite for node for topological sort
        # node with subgraphs may have dependency on implicit inputs, which will affect topological sort
        prereq_for_node = {}  # map from node to all its inputs, including implicit ones in subgraph

        def get_prereq(node):
            names = {i for i in node.input if i}
            subgraphs = []
            if node.op_type == "If":
                subgraphs = [
                    get_attribute(node, "then_branch"),
                    get_attribute(node, "else_branch"),
                ]
            elif node.op_type in ["Loop", "Scan"]:
                subgraphs = [get_attribute(node, "body")]
            for g in subgraphs:
                g_outputs_and_initializers = {i.name for i in g.initializer}
                g_prereq = set()
                for n in g.node:
                    g_outputs_and_initializers.update(n.output)
                for n in g.node:
                    g_prereq.update([i for i in get_prereq(n) if i not in g_outputs_and_initializers])
                names.update(g_prereq)
                # remove subgraph inputs from g_prereq since those are local-only
                for i in g.input:
                    names.discard(i.name)
            return names

        for n in self.tmp_mp_.graph.node:
            prereq_for_node[n.output[0]] = get_prereq(n)

        # topological sort nodes, note there might be dead nodes so we check if all graph outputs are reached to terminate
        sorted_nodes = []
        sorted_known_vi = {i.name for i in list(self.out_mp_.graph.input) + list(self.out_mp_.graph.initializer)}
        if any(o.name in sorted_known_vi for o in self.out_mp_.graph.output):
            # Loop/Scan will have some graph output in graph inputs, so don't do topological sort
            sorted_nodes = self.out_mp_.graph.node
        else:
            while not all(o.name in sorted_known_vi for o in self.out_mp_.graph.output):
                old_sorted_nodes_len = len(sorted_nodes)
                for node in self.out_mp_.graph.node:
                    if (node.output[0] not in sorted_known_vi) and all(
                        i in sorted_known_vi for i in prereq_for_node[node.output[0]] if i
                    ):
                        sorted_known_vi.update(node.output)
                        sorted_nodes.append(node)
                if old_sorted_nodes_len == len(sorted_nodes) and not all(
                    o.name in sorted_known_vi for o in self.out_mp_.graph.output
                ):
                    raise Exception("Invalid model with cyclic graph")

        for node in sorted_nodes:
            assert all(i in self.known_vi_ for i in node.input if i)
            self._onnx_infer_single_node(node)
            known_aten_op = False
            if node.op_type in self.dispatcher_:
                self.dispatcher_[node.op_type](node)
            elif node.op_type in ["ConvTranspose"]:
                # onnx shape inference ops like ConvTranspose may have empty shape for symbolic input
                # before adding symbolic compute for them
                # mark the output type as UNDEFINED to allow guessing of rank
                vi = self.known_vi_[node.output[0]]
                if len(vi.type.tensor_type.shape.dim) == 0:
                    vi.type.tensor_type.elem_type = onnx.TensorProto.UNDEFINED
            elif node.op_type == "ATen" and node.domain == "org.pytorch.aten":
                for attr in node.attribute:
                    # TODO: Is overload_name needed?
                    if attr.name == "operator":
                        aten_op_name = attr.s.decode("utf-8") if isinstance(attr.s, bytes) else attr.s
                        if aten_op_name in self.aten_op_dispatcher_:
                            known_aten_op = True
                            self.aten_op_dispatcher_[aten_op_name](node)
                        break

            if self.verbose_ > 2:
                logger.debug(node.op_type + ": " + node.name)  # noqa: G003
                for i, name in enumerate(node.input):
                    logger.debug("  Input %s: %s %s", i, name, "initializer" if name in self.initializers_ else "")

            # onnx automatically merge dims with value, i.e. Mul(['aaa', 'bbb'], [1000, 1]) -> [1000, 'bbb']
            # symbolic shape inference needs to apply merge of 'aaa' -> 1000 in this case
            if node.op_type in [
                "Add",
                "Sub",
                "Mul",
                "Div",
                "MatMul",
                "MatMulInteger",
                "MatMulInteger16",
                "Where",
                "Sum",
            ]:
                vi = self.known_vi_[node.output[0]]
                out_rank = len(get_shape_from_type_proto(vi.type))
                in_shapes = [self._get_shape(node, i) for i in range(len(node.input))]
                for d in range(out_rank - (2 if node.op_type in ["MatMul", "MatMulInteger", "MatMulInteger16"] else 0)):
                    in_dims = [s[len(s) - out_rank + d] for s in in_shapes if len(s) + d >= out_rank]
                    if len(in_dims) > 1:
                        self._check_merged_dims(in_dims, allow_broadcast=True)

            for i_o in range(len(node.output)):
                # Special cases:
                # 1) We do not care about the training related outputs of SkipLayerNormalization
                # 2) We do not care about the extraneous constant outputs in RotaryEmbedding because
                # the RotaryEmbedding op created during export can be replaced by the RotaryEmbedding
                # contrib op
                if (
                    node.op_type == "SkipLayerNormalization" or node.op_type == "SkipSimplifiedLayerNormalization"
                ) and i_o in [1, 2]:
                    continue
                if node.op_type == "RotaryEmbedding" and len(node.output) > 1:
                    # Skip symbolic shape inference for RotaryEmbedding functions that have extraneous outputs
                    # generated by `export_modules_as_functions`
                    continue

                vi = self.known_vi_[node.output[i_o]]
                out_type = vi.type
                out_type_kind = out_type.WhichOneof("value")

                # do not process shape for non-tensors
                if out_type_kind not in ["tensor_type", "sparse_tensor_type", None]:
                    if self.verbose_ > 2:
                        if out_type_kind == "sequence_type":
                            seq_cls_type = out_type.sequence_type.elem_type.WhichOneof("value")
                            if seq_cls_type == "tensor_type":
                                logger.debug(
                                    "  {}: sequence of {} {}".format(  # noqa: G001
                                        node.output[i_o],
                                        str(get_shape_from_value_info(vi)),
                                        onnx.TensorProto.DataType.Name(
                                            vi.type.sequence_type.elem_type.tensor_type.elem_type
                                        ),
                                    )
                                )
                            else:
                                logger.debug(f"  {node.output[i_o]}: sequence of {seq_cls_type}")
                        else:
                            logger.debug(f"  {node.output[i_o]}: {out_type_kind}")
                    continue

                out_shape = get_shape_from_value_info(vi)
                out_type_undefined = out_type.tensor_type.elem_type == onnx.TensorProto.UNDEFINED
                if self.verbose_ > 2:
                    logger.debug(
                        f"  {node.output[i_o]}: {out_shape!s} {onnx.TensorProto.DataType.Name(vi.type.tensor_type.elem_type)}"
                    )
                    if node.output[i_o] in self.sympy_data_:
                        logger.debug("  Sympy Data: " + str(self.sympy_data_[node.output[i_o]]))  # noqa: G003

                # onnx >= 1.11.0, use unk__#index instead of None when the shape dim is uncertain
                if (
                    out_shape is not None and (None in out_shape or self._is_shape_contains_none_dim(out_shape))
                ) or out_type_undefined:
                    if self.auto_merge_:
                        if node.op_type in [
                            "Add",
                            "Sub",
                            "Mul",
                            "Div",
                            "MatMul",
                            "MatMulInteger",
                            "MatMulInteger16",
                            "Concat",
                            "Where",
                            "Sum",
                            "Equal",
                            "Less",
                            "Greater",
                            "LessOrEqual",
                            "GreaterOrEqual",
                            "Min",
                            "Max",
                        ]:
                            shapes = [self._get_shape(node, i) for i in range(len(node.input))]
                            if node.op_type in [
                                "MatMul",
                                "MatMulInteger",
                                "MatMulInteger16",
                            ]:
                                if None in out_shape or self._is_shape_contains_none_dim(out_shape):
                                    if None in out_shape:
                                        idx = out_shape.index(None)
                                    else:
                                        idx = out_shape.index(self._is_shape_contains_none_dim(out_shape))
                                    dim_idx = [len(s) - len(out_shape) + idx for s in shapes]
                                    # only support auto merge for MatMul for dim < rank-2 when rank > 2
                                    assert len(shapes[0]) > 2 and dim_idx[0] < len(shapes[0]) - 2
                                    assert len(shapes[1]) > 2 and dim_idx[1] < len(shapes[1]) - 2
                        elif node.op_type == "Expand":
                            # auto merge for cases like Expand([min(batch, 1), min(seq, 512)], [batch, seq])
                            shapes = [
                                self._get_shape(node, 0),
                                self._get_value(node, 1),
                            ]
                        else:
                            shapes = []

                        if shapes:
                            for idx in range(len(out_shape)):
                                if out_shape[idx] is not None and not self._is_none_dim(out_shape[idx]):
                                    continue
                                # note that the broadcasting rule aligns from right to left
                                # if a tensor has a lower rank (dim_idx[idx] < 0), it would automatically broadcast and need no merge
                                dim_idx = [len(s) - len(out_shape) + idx for s in shapes]
                                if len(dim_idx) > 0:
                                    self._add_suggested_merge(
                                        [
                                            s[i] if is_literal(s[i]) else str(s[i])
                                            for s, i in zip(shapes, dim_idx, strict=False)
                                            if i >= 0
                                        ]
                                    )
                            self.run_ = True
                        else:
                            self.run_ = False
                    else:
                        self.run_ = False

                    # create new dynamic dims for ops not handled by symbolic shape inference
                    if self.run_ is False and node.op_type not in self.dispatcher_ and not known_aten_op:
                        is_unknown_op = out_type_undefined and (out_shape is None or len(out_shape) == 0)
                        if is_unknown_op:
                            # unknown op to ONNX, maybe from higher opset or other domain
                            # only guess the output rank from input 0 when using guess_output_rank option
                            out_rank = self._get_shape_rank(node, 0) if self.guess_output_rank_ else -1
                        else:
                            # valid ONNX op, but not handled by symbolic shape inference, just assign dynamic shape
                            out_rank = len(out_shape)

                        if out_rank >= 0:
                            new_shape = self._new_symbolic_shape(out_rank, node, i_o)
                            if out_type_undefined:
                                # guess output data type from input vi if not defined
                                out_dtype = self.known_vi_[node.input[0]].type.tensor_type.elem_type
                            else:
                                # otherwise, use original data type
                                out_dtype = vi.type.tensor_type.elem_type
                            vi.CopyFrom(
                                helper.make_tensor_value_info(
                                    vi.name,
                                    out_dtype,
                                    get_shape_from_sympy_shape(new_shape),
                                )
                            )

                            if self.verbose_ > 0:
                                if is_unknown_op:
                                    logger.debug(
                                        f"Possible unknown op: {node.op_type} node: {node.name}, guessing {vi.name} shape"
                                    )
                                if self.verbose_ > 2:
                                    logger.debug(f"  {node.output[i_o]}: {new_shape!s} {vi.type.tensor_type.elem_type}")

                            self.run_ = True
                            continue  # continue the inference after guess, no need to stop as no merge is needed

                    if self.verbose_ > 0 or not self.auto_merge_ or out_type_undefined:
                        logger.debug("Stopping at incomplete shape inference at %s: %s", node.op_type, node.name)
                        logger.debug("node inputs:")
                        for i in node.input:
                            if i in self.known_vi_:
                                logger.debug(self.known_vi_[i])
                            else:
                                logger.debug(f"not in known_vi_ for {i}")
                        logger.debug("node outputs:")
                        for o in node.output:
                            if o in self.known_vi_:
                                logger.debug(self.known_vi_[o])
                            else:
                                logger.debug(f"not in known_vi_ for {o}")
                        if self.auto_merge_ and not out_type_undefined:
                            logger.debug("Merging: " + str(self.suggested_merge_))  # noqa: G003
                    return False

        self.run_ = False
        return True

    def _update_output_from_vi(self):
        for output in self.out_mp_.graph.output:
            if output.name in self.known_vi_:
                output.CopyFrom(self.known_vi_[output.name])

    @staticmethod
    def infer_shapes(in_mp, int_max=2**31 - 1, auto_merge=False, guess_output_rank=False, verbose=0):
        onnx_opset = get_opset(in_mp)
        if (not onnx_opset) or onnx_opset < 7:
            logger.warning("Only support models of onnx opset 7 and above.")
            return None
        symbolic_shape_inference = SymbolicShapeInference(int_max, auto_merge, guess_output_rank, verbose)
        all_shapes_inferred = False
        symbolic_shape_inference._preprocess(in_mp)
        while symbolic_shape_inference.run_:
            all_shapes_inferred = symbolic_shape_inference._infer_impl()
        symbolic_shape_inference._update_output_from_vi()
        if not all_shapes_inferred:
            onnx.save_model(symbolic_shape_inference.out_mp_, "sym_shape_infer_temp.onnx", save_as_external_data=True)
            raise Exception("Incomplete symbolic shape inference")
        return symbolic_shape_inference.out_mp_


def parse_arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="The input model file")
    parser.add_argument("--output", help="The output model file")
    parser.add_argument(
        "--auto_merge",
        help="Automatically merge symbolic dims when confliction happens",
        action="store_true",
        default=False,
    )
    parser.add_argument(
        "--int_max",
        help="maximum value for integer to be treated as boundless for ops like slice",
        type=int,
        default=2**31 - 1,
    )
    parser.add_argument(
        "--guess_output_rank",
        help="guess output rank to be the same as input 0 for unknown ops",
        action="store_true",
        default=False,
    )
    parser.add_argument(
        "--verbose",
        help="Prints detailed logs of inference, 0: turn off, 1: warnings, 3: detailed",
        type=int,
        default=0,
    )
    parser.add_argument(
        "--save_as_external_data",
        help="Saving an ONNX model to external data",
        action="store_true",
        default=False,
    )
    parser.add_argument(
        "--all_tensors_to_one_file",
        help="Saving all the external data to one file",
        action="store_true",
        default=False,
    )
    parser.add_argument(
        "--external_data_location",
        help="The file location to save the external file",
        default="./",
    )
    parser.add_argument(
        "--external_data_size_threshold",
        help="The size threshold for external data",
        type=int,
        default=1024,
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_arguments()
    logger.info("input model: " + args.input)  # noqa: G003
    if args.output:
        logger.info("output model " + args.output)  # noqa: G003
    logger.info("Doing symbolic shape inference...")
    out_mp = SymbolicShapeInference.infer_shapes(
        onnx.load(args.input),
        args.int_max,
        args.auto_merge,
        args.guess_output_rank,
        args.verbose,
    )
    if args.output and out_mp:
        if args.save_as_external_data:
            onnx.save_model(
                out_mp,
                args.output,
                save_as_external_data=True,
                all_tensors_to_one_file=args.all_tensors_to_one_file,
                location=args.external_data_location,
                size_threshold=args.external_data_size_threshold,
                convert_attribute=False,
            )
        else:
            onnx.save(out_mp, args.output)
        logger.info("Done!")
