# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""
Support for registering ONNX Runtime's built-in contrib ops with
PyTorch-ONNX exporter (torch.onnx.export).
"""

import contextlib
import typing

try:
    # TODO(justinchuby): Create a function to alert users when torch is not installed
    import torch
except ModuleNotFoundError:
    raise ModuleNotFoundError(  # noqa: B904
        "This module is only useful in combination with PyTorch. To install PyTorch see https://pytorch.org/."
    )

from torch.onnx import symbolic_helper

_OPSET_VERSION = 1
_registered_ops: typing.AbstractSet[str] = set()


def _reg(symbolic_fn: typing.Callable, namespace: str = "aten"):
    name = f"{namespace}::{symbolic_fn.__name__}"
    torch.onnx.register_custom_op_symbolic(name, symbolic_fn, _OPSET_VERSION)
    _registered_ops.add(name)


def register():
    """Register ONNX Runtime's built-in contrib ops.

    Should be run before torch.onnx.export().
    """

    def grid_sampler(g, input, grid, mode, padding_mode, align_corners):
        # mode
        #   'bilinear'      : onnx::Constant[value={0}]
        #   'nearest'       : onnx::Constant[value={1}]
        #   'bicubic'       : onnx::Constant[value={2}]
        # padding_mode
        #   'zeros'         : onnx::Constant[value={0}]
        #   'border'        : onnx::Constant[value={1}]
        #   'reflection'    : onnx::Constant[value={2}]
        mode = symbolic_helper._maybe_get_const(mode, "i")
        padding_mode = symbolic_helper._maybe_get_const(padding_mode, "i")
        mode_str = ["bilinear", "nearest", "bicubic"][mode]
        padding_mode_str = ["zeros", "border", "reflection"][padding_mode]
        align_corners = int(symbolic_helper._maybe_get_const(align_corners, "b"))

        return g.op(
            "com.microsoft::GridSample",
            input,
            grid,
            mode_s=mode_str,
            padding_mode_s=padding_mode_str,
            align_corners_i=align_corners,
        )

    _reg(grid_sampler)

    def inverse(g, self):
        return g.op("com.microsoft::Inverse", self).setType(self.type())

    _reg(inverse)
    torch.onnx.register_custom_op_symbolic("aten::linalg_inv", inverse, _OPSET_VERSION)
    _registered_ops.add("aten::linalg_inv")

    def gelu(g, self: torch._C.Value, approximate="none"):
        # PyTorch can emit aten::gelu with or without the optional approximate arg.
        if not isinstance(approximate, str):
            approximate = symbolic_helper._maybe_get_const(approximate, "s")

        # Use microsoft::Gelu for performance if possible. It only supports approximate == "none".
        if approximate == "none":
            return g.op("com.microsoft::Gelu", self).setType(self.type())
        return torch.onnx.symbolic_opset9.gelu(g, self, approximate)

    _reg(gelu)
    # Some PyTorch versions dispatch GELU symbolic lookup by exporter opset.
    # Registering across stable opsets keeps ORT Gelu fusion consistently enabled.
    for opset in range(9, 21):
        torch.onnx.register_custom_op_symbolic("aten::gelu", gelu, opset)

    def triu(g, self, diagonal):
        return g.op("com.microsoft::Trilu", self, diagonal, upper_i=1).setType(self.type())

    _reg(triu)

    def tril(g, self, diagonal):
        return g.op("com.microsoft::Trilu", self, diagonal, upper_i=0).setType(self.type())

    _reg(tril)

    @torch.onnx.symbolic_helper.parse_args("v")
    def DynamicTimeWarping(g, self):  # noqa: N802
        return g.op("com.microsoft::DynamicTimeWarping", self)

    _reg(DynamicTimeWarping, namespace="onnxruntime")

    def UnfoldTensor(g, self, dim, size, step):  # noqa: N802
        dim = int(symbolic_helper._maybe_get_const(dim, "i"))
        size = int(symbolic_helper._maybe_get_const(size, "i"))
        step = int(symbolic_helper._maybe_get_const(step, "i"))
        return g.op(
            "com.microsoft::UnfoldTensor",
            self,
            dim_i=dim,
            size_i=size,
            step_i=step,
        ).setType(self.type().with_sizes([None, None, None, None, size]))

    _reg(UnfoldTensor, namespace="onnxruntime")


def unregister():
    """Unregister ONNX Runtime's built-in contrib ops."""
    for name in _registered_ops:
        try:
            torch.onnx.unregister_custom_op_symbolic(name, _OPSET_VERSION)
        except AttributeError:
            # The symbolic_registry module was removed in PyTorch 1.13.
            # We are importing it here for backwards compatibility
            # because unregister_custom_op_symbolic is not available before PyTorch 1.12
            from torch.onnx import symbolic_registry  # noqa: PLC0415

            namespace, kind = name.split("::")
            for version in symbolic_helper._onnx_stable_opsets:
                if version >= _OPSET_VERSION and symbolic_registry.is_registered_op(kind, namespace, version):
                    del symbolic_registry._registry[(namespace, version)][kind]

    # Also clean up gelu's multi-opset registrations (see register()).
    for opset in range(9, 21):
        with contextlib.suppress(Exception):
            torch.onnx.unregister_custom_op_symbolic("aten::gelu", opset)
