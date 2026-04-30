# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------
from __future__ import annotations

import json
from collections.abc import MutableMapping
from dataclasses import dataclass
from typing import Any

import onnx

from .quant_utils import QuantType


@dataclass
class QuantTypeInfo:  # noqa: PLW1641
    """
    The quantization type information for a tensor override.
    """

    quant_type: QuantType
    symmetric: bool | None = None  # If None, assumes default is used.
    reduce_range: bool | None = None  # If None, assumes default is used.
    axis: int | None = None  # If None, assumes per-tensor quantization

    def __eq__(self, other: object):
        if isinstance(other, QuantTypeInfo):
            return (
                self.quant_type == other.quant_type
                and (self.symmetric is None or other.symmetric is None or self.symmetric == other.symmetric)
                and (self.reduce_range is None or other.reduce_range is None or self.reduce_range == other.reduce_range)
                and (self.axis == other.axis)
            )
        return NotImplemented

    @staticmethod
    def load_from_dict(
        raw_dict: dict[str, Any],
        default_qtype: QuantType | None = None,
        default_symmetric: bool | None = None,
        default_reduce_range: bool | None = None,
    ) -> QuantTypeInfo:
        return QuantTypeInfo(
            raw_dict.get("quant_type", default_qtype),
            raw_dict.get("symmetric", default_symmetric),
            raw_dict.get("reduce_range", default_reduce_range),
            raw_dict.get("axis"),
        )

    def save_to_dict(self, raw_dict: dict[str, Any]):
        raw_dict["quant_type"] = self.quant_type
        if self.symmetric is not None:
            raw_dict["symmetric"] = self.symmetric
        if self.reduce_range is not None:
            raw_dict["reduce_range"] = self.reduce_range
        if self.axis is not None:
            raw_dict["axis"] = self.axis


class TensorQuantOverridesHelper(MutableMapping):
    """
    Utility wrapper over the tensor quantization overrides passed via extra_options.
    """

    def __init__(self, raw_overrides: dict[str, list[dict[str, Any]]]):
        self.overrides = raw_overrides
        self.quant_types = None
        self.keys_unsupported_with_scale_zp = {"symmetric", "reduce_range", "rmax", "rmin"}

    def has_per_tensor_overrides(self, tensor_name: str) -> bool:
        overrides_list = self.overrides.get(tensor_name)
        return overrides_list and "axis" not in overrides_list[0]

    def has_per_channel_overrides(self, tensor_name: str) -> bool:
        overrides_list = self.overrides.get(tensor_name)
        return overrides_list and "axis" in overrides_list[0]

    def overrides_scale_zp(self, tensor_name: str) -> bool:
        overrides_list = self.overrides.get(tensor_name)
        return overrides_list and ("scale" in overrides_list[0]) and ("zero_point" in overrides_list[0])

    def get_per_tensor_overrides(
        self,
        tensor_name: str,
        default_val: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        default_list_val = [default_val] if default_val is not None else None
        overrides_list = self.overrides.get(tensor_name, default_list_val)
        if overrides_list and "axis" in overrides_list[0]:
            raise ValueError(
                f"Expected tensor '{tensor_name}' to use per-tensor quantization overrides, "
                f"but found per-channel overrides."
            )

        return overrides_list[0] if overrides_list else None

    def get_per_channel_overrides(
        self,
        tensor_name: str,
        default_val: list[dict[str, Any]] | None = None,
    ) -> list[dict[str, Any]] | None:
        overrides_list = self.overrides.get(tensor_name, default_val)

        if not overrides_list:
            return None

        if "axis" not in overrides_list[0]:
            raise ValueError(
                f"Expected tensor '{tensor_name}' to have per-channel quantization overrides (axis value is missing).",
            )

        return overrides_list

    def get_quant_types(self) -> set[QuantType]:
        if self.quant_types is not None:
            return self.quant_types

        self.quant_types = set()

        if self.overrides:
            for quant_overrides_list in self.overrides.values():
                for quant_overrides in quant_overrides_list:
                    if "quant_type" in quant_overrides:
                        self.quant_types.add(quant_overrides["quant_type"])

                    if "convert" in quant_overrides and "quant_type" in quant_overrides["convert"]:
                        self.quant_types.add(quant_overrides["convert"]["quant_type"])

        return self.quant_types

    def _is_valid_per_tensor(
        self,
        initializers,
        default_activation_qtype,
        tensor_name: str,
        quant_overrides: dict[str, Any],
    ) -> tuple[bool, str | None]:
        if not isinstance(quant_overrides, dict):
            return (
                False,
                f"Tensor quantization overrides for '{tensor_name}' are not in a dict",
            )

        is_initializer = tensor_name in initializers

        quant_type = quant_overrides.get("quant_type")
        if quant_type:
            self.quant_types.add(quant_type)

        has_scale = "scale" in quant_overrides
        has_zero_point = "zero_point" in quant_overrides

        if (has_scale and not has_zero_point) or (has_zero_point and not has_scale):
            return (
                False,
                "Must provide both 'scale' and 'zero_point' if one of the overrides is provided",
            )

        if has_scale:
            keys = self.keys_unsupported_with_scale_zp.intersection(set(quant_overrides))
            if keys:
                return (
                    False,
                    f"Tensor override option(s) [{', '.join(keys)}] are invalid with 'scale' and 'zero_point'",
                )

        if "reduce_range" in quant_overrides and not is_initializer:
            return (
                False,
                f"Option 'reduce_range' is only supported for initializers, not for activation {tensor_name}",
            )

        if "convert" in quant_overrides:
            if is_initializer:
                return False, "Cannot use 'convert' override for initializers"

            if "quant_type" not in quant_overrides["convert"]:
                return False, f"'convert' options (tensor '{tensor_name}') must specify a 'quant_type'"

            if "reduce_range" in quant_overrides["convert"]:
                return (
                    False,
                    f"Option 'reduce_range' is only supported for initializers, not for activation {tensor_name}",
                )

            convert_quant_type = quant_overrides["convert"]["quant_type"]
            original_quant_type = quant_type if quant_type is not None else default_activation_qtype
            if convert_quant_type == original_quant_type:
                return (
                    False,
                    f"'convert' quant_type must differ from original quant_type (tensor '{tensor_name}')",
                )

            convert_has_scale = "scale" in quant_overrides["convert"]
            convert_has_zero_point = "zero_point" in quant_overrides["convert"]

            if (convert_has_scale and not convert_has_zero_point) or (convert_has_zero_point and not convert_has_scale):
                return (
                    False,
                    f"Must provide both 'scale' and 'zero_point' if one of the overrides is provided (tensor '{tensor_name}')",
                )

            if convert_has_scale:
                keys = self.keys_unsupported_with_scale_zp.intersection(set(quant_overrides["convert"]))
                if keys:
                    return (
                        False,
                        f"Tensor override option(s) [{', '.join(keys)}] are invalid with 'scale' and 'zero_point' "
                        f"(tensor '{tensor_name}')",
                    )

            self.quant_types.add(convert_quant_type)

        return True, None

    def _is_valid_per_channel(
        self,
        initializers,
        tensor_name: str,
        quant_overrides_list: list[dict[str, Any]],
    ) -> tuple[bool, str | None]:
        is_initializer = tensor_name in initializers

        if not is_initializer:
            return (
                False,
                f"Tensor '{tensor_name}' has per-channel overrides, but is not an initializer",
            )

        axis = quant_overrides_list[0].get("axis")

        if axis is None:
            return (
                False,
                f"Per-channel overrides for tensor {tensor_name} is missing an 'axis' value in "
                "the first channel dictionary.",
            )

        weight_shape = list(initializers[tensor_name].dims)
        weight_rank = len(weight_shape)
        norm_axis = axis
        if norm_axis < 0:
            norm_axis += weight_rank

        if norm_axis < 0 or norm_axis >= len(weight_shape):
            return (
                False,
                f"Axis override value is out-of-bounds for tensor {tensor_name} (rank {len(weight_shape)})",
            )

        if len(quant_overrides_list) > 1 and len(quant_overrides_list) != weight_shape[norm_axis]:
            return (
                False,
                f"Incorrect number of channel overrides for tensor {tensor_name} (axis {axis}), "
                f"expected {weight_shape[axis]}, but found {len(quant_overrides_list)}.",
            )

        if "convert" in quant_overrides_list[0]:
            return False, f"Cannot use 'convert' override for initializers, such as {tensor_name}."

        quant_type = quant_overrides_list[0].get("quant_type")
        if quant_type:
            self.quant_types.add(quant_type)

        symmetric = quant_overrides_list[0].get("symmetric")
        reduce_range = quant_overrides_list[0].get("reduce_range")

        has_scale = "scale" in quant_overrides_list[0]
        has_zero_point = "zero_point" in quant_overrides_list[0]
        has_scale_zp = has_scale and has_zero_point

        if (has_scale and not has_zero_point) or (has_zero_point and not has_scale):
            return (
                False,
                "Must provide both 'scale' and 'zero_point' if one of the overrides is provided",
            )

        if has_scale_zp:
            keys = self.keys_unsupported_with_scale_zp.intersection(set(quant_overrides_list[0]))
            if keys:
                return (
                    False,
                    f"Tensor override option(s) [{', '.join(keys)}] are invalid with 'scale' and 'zero_point'",
                )

        has_rmin = "rmin" in quant_overrides_list[0]
        has_rmax = "rmax" in quant_overrides_list[0]
        has_rmin_rmax = has_rmin and has_rmax
        if (has_rmin and not has_rmax) or (not has_rmin and has_rmax):
            return (
                False,
                "Must provide both 'rmin' and 'rmax' if one is provided",
            )

        for index, quant_overrides in enumerate(quant_overrides_list[1:]):
            if not isinstance(quant_overrides, dict):
                return (
                    False,
                    f"Tensor quantization overrides at index {index} for '{tensor_name}' are not in a dict",
                )

            if "convert" in quant_overrides:
                return False, f"Cannot use 'convert' override for initializers, such as {tensor_name}."

            # For per-channel quantization, all channels must use the same quantization type, axis, symmetric
            # and reduce_range values. And, if specified, they must be present in the first channel dict
            # (i.e., quant_overrides_list[0]).
            if "quant_type" in quant_overrides and quant_type != quant_overrides["quant_type"]:
                return (
                    False,
                    "Channel quantization types for tensor '{tensor_name}' do not match at index {index}.",
                )
            if "axis" in quant_overrides and axis != quant_overrides["axis"] and norm_axis != quant_overrides["axis"]:
                return (
                    False,
                    "Channel axis for tensor '{tensor_name}' does not match at index {index}.",
                )
            if "symmetric" in quant_overrides and symmetric != quant_overrides["symmetric"]:
                return (
                    False,
                    "Channel symmetric value for tensor '{tensor_name}' does not match at index {index}.",
                )
            if "reduce_range" in quant_overrides and reduce_range != quant_overrides["reduce_range"]:
                return (
                    False,
                    "Channel reduce_range value for tensor '{tensor_name}' does not match at index {index}.",
                )

            # If override scale/zp, must do so for all channels.
            chan_has_scale_zp = "scale" in quant_overrides and "zero_point" in quant_overrides

            if has_scale_zp and not chan_has_scale_zp:
                return (
                    False,
                    "Per-channel overrides that specify scale/zero_point must do so for all channels, "
                    f"but tensor '{tensor_name}' is missing them at index {index}.",
                )

            if chan_has_scale_zp:
                keys = self.keys_unsupported_with_scale_zp.intersection(set(quant_overrides))
                if keys:
                    return (
                        False,
                        f"Tensor override option(s) [{', '.join(keys)}] are invalid with 'scale' and 'zero_point'",
                    )

            # If override rmin/rmax, must do so for all channels.
            chan_has_rmin_rmax = "rmin" in quant_overrides and "rmax" in quant_overrides
            if has_rmin_rmax and not chan_has_rmin_rmax:
                return (
                    False,
                    "Per-channel overrides that specify rmin/rmax must do so for all channels, "
                    f"but tensor '{tensor_name}' is missing them at index {index}.",
                )

        return True, None

    def is_valid(
        self,
        initializers: dict[str, onnx.TensorProto],
        activation_names: set[str],
        default_activation_qtype,
    ) -> tuple[bool, str | None]:
        self.quant_types = set()

        # Validate that compatible/valid overrides are provided.
        if self.overrides:
            for tensor_name, quant_overrides_list in self.overrides.items():
                if tensor_name not in initializers and tensor_name not in activation_names:
                    return False, f"Tensor '{tensor_name}' in TensorQuantOverrides is not present in the model"

                if not isinstance(quant_overrides_list, list):
                    return False, f"Tensor quantization overrides for '{tensor_name}' are not in a list"

                if not quant_overrides_list:
                    continue

                if not isinstance(quant_overrides_list[0], dict):
                    return False, f"Tensor quantization overrides at index 0 for '{tensor_name}' are not in a dict"

                if not quant_overrides_list[0]:
                    continue

                axis = quant_overrides_list[0].get("axis")
                is_per_channel = len(quant_overrides_list) > 1 or axis is not None

                if is_per_channel:
                    return self._is_valid_per_channel(initializers, tensor_name, quant_overrides_list)

                return self._is_valid_per_tensor(
                    initializers, default_activation_qtype, tensor_name, quant_overrides_list[0]
                )

        return True, None

    def update_tensor_overrides(
        self,
        tensor_name: str,
        new_vals: dict[str, Any],
        channels: list[int] | None = None,
        overwrite: bool = True,
    ) -> bool:
        if not new_vals:
            return False

        channels = set(channels) if channels is not None else None
        have_overrides = self.overrides.get(tensor_name)

        # If `overwrite` is False, check if we would overwrite anything.
        do_update = True
        if not overwrite and have_overrides:
            for channel, overrides in enumerate(self.overrides[tensor_name]):
                if channels is not None and channel not in channels:
                    continue
                if set(new_vals).intersection(set(overrides)):
                    do_update = False
                    break

        # Do the update if `overwrite` is True or if nothing is overwritten (do not want partial overwrites).
        if do_update:
            if not have_overrides:
                self.overrides[tensor_name] = [{}]

            for channel, overrides in enumerate(self.overrides[tensor_name]):
                if channels is not None and channel not in channels:
                    continue
                overrides.update(new_vals)

        return do_update

    def get_node_output_qtype_info(
        self,
        output_name: str,
        default_qtype: QuantType | None,
        default_symmetric: bool | None = None,
    ) -> QuantTypeInfo:
        # Outputs are activations, which do not support 'reduce_range' or 'axis'
        if output_name not in self.overrides:
            return QuantTypeInfo(default_qtype, default_symmetric)

        tensor_overrides = self.overrides[output_name][0]

        return QuantTypeInfo(
            tensor_overrides.get("quant_type", default_qtype),
            tensor_overrides.get("symmetric", default_symmetric),
        )

    def get_node_input_qtype_info(
        self,
        input_name: str,
        node_name: str,
        default_qtype: QuantType | None,
        default_symmetric: bool | None = None,
        default_reduce_range: bool | None = None,
    ) -> QuantTypeInfo:
        if input_name not in self.overrides or not self.overrides[input_name]:
            return QuantTypeInfo(default_qtype, default_symmetric, default_reduce_range)

        # Get the first overrides dict in the list. This works for both per-tensor and per-channel
        # quantization because all channels must use the same quant type.
        tensor_overrides = self.overrides[input_name][0]
        producer_type = tensor_overrides.get("quant_type", default_qtype)

        if "convert" not in tensor_overrides:
            return QuantTypeInfo(
                producer_type,
                tensor_overrides.get("symmetric", default_symmetric),
                tensor_overrides.get("reduce_range", default_reduce_range),
                tensor_overrides.get("axis"),
            )

        # This tensor is converted. Check if the node gets the original qtype or the converted qtype.
        convert_dict = tensor_overrides["convert"]
        qtype_info = QuantTypeInfo(
            producer_type,
            convert_dict.get("symmetric", default_symmetric),
            # Converted tensors are not initializers, so do not have 'axis' or 'reduce_range'.
        )

        # Check if all nodes receive the converted type (i.e., recv_nodes is None) or this node
        # is in the list of consumers (recv_nodes).
        if ("recv_nodes" not in convert_dict) or (node_name in convert_dict["recv_nodes"]):
            qtype_info.quant_type = convert_dict["quant_type"]

        return qtype_info

    def pprint_str(self, indent=None) -> str:
        return json.dumps(self.overrides, default=str, indent=indent)

    def empty(self) -> bool:
        return not self.overrides

    def get_dict(self) -> dict[str, list[dict[str, Any]]]:
        return self.overrides

    # Required implementations of abstract methods in collections.abc.MutableMapping
    # so that this class can be used like a dict.
    def __setitem__(self, key: str, value: list[dict]):
        self.overrides[key] = value

    def __getitem__(self, key: str) -> list[dict]:
        return self.overrides[key]

    def __delitem__(self, key: str):
        del self.overrides[key]

    def __iter__(self):
        return iter(self.overrides)

    def __len__(self):
        return len(self.overrides)

    def __str__(self) -> str:
        return str(self.overrides)

    def __repr__(self) -> str:
        return f"{super().__repr__()}, TensorQuantOverridesHelper({self.overrides})"
