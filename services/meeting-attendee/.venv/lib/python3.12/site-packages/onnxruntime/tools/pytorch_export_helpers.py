# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

from __future__ import annotations

import inspect
from collections import abc

import torch


def _parse_inputs_for_onnx_export(all_input_parameters, inputs, kwargs):
    # extracted from https://github.com/microsoft/onnxruntime/blob/239c6ad3f021ff7cc2e6247eb074bd4208dc11e2/orttraining/orttraining/python/training/ortmodule/_io.py#L433

    def _add_input(name, input):
        """Returns number of expanded inputs that _add_input processed"""

        if input is None:
            # Drop all None inputs and return 0.
            return 0

        num_expanded_non_none_inputs = 0
        if isinstance(input, abc.Sequence):
            # If the input is a sequence (like a list), expand the list so that
            # each element of the list is an input by itself.
            for i, val in enumerate(input):
                # Name each input with the index appended to the original name of the
                # argument.
                num_expanded_non_none_inputs += _add_input(f"{name}_{i}", val)

            # Return here since the list by itself is not a valid input.
            # All the elements of the list have already been added as inputs individually.
            return num_expanded_non_none_inputs
        elif isinstance(input, abc.Mapping):
            # If the input is a mapping (like a dict), expand the dict so that
            # each element of the dict is an input by itself.
            for key, val in input.items():
                num_expanded_non_none_inputs += _add_input(f"{name}_{key}", val)

            # Return here since the dict by itself is not a valid input.
            # All the elements of the dict have already been added as inputs individually.
            return num_expanded_non_none_inputs

        # InputInfo should contain all the names irrespective of whether they are
        # a part of the onnx graph or not.
        input_names.append(name)

        # A single input non none input was processed, return 1
        return 1

    input_names = []
    var_positional_idx = 0
    num_expanded_non_none_positional_inputs = 0

    for input_idx, input_parameter in enumerate(all_input_parameters):
        if input_parameter.kind == inspect.Parameter.VAR_POSITIONAL:
            # VAR_POSITIONAL parameter carries all *args parameters from original forward method
            for args_i in range(input_idx, len(inputs)):
                name = f"{input_parameter.name}_{var_positional_idx}"
                var_positional_idx += 1
                inp = inputs[args_i]
                num_expanded_non_none_positional_inputs += _add_input(name, inp)
        elif (
            input_parameter.kind == inspect.Parameter.POSITIONAL_ONLY
            or input_parameter.kind == inspect.Parameter.POSITIONAL_OR_KEYWORD
            or input_parameter.kind == inspect.Parameter.KEYWORD_ONLY
        ):
            # All positional non-*args and non-**kwargs are processed here
            name = input_parameter.name
            inp = None
            input_idx += var_positional_idx  # noqa: PLW2901
            is_positional = True
            if input_idx < len(inputs) and inputs[input_idx] is not None:
                inp = inputs[input_idx]
            elif name in kwargs and kwargs[name] is not None:
                inp = kwargs[name]
                is_positional = False
            num_expanded_non_none_inputs_local = _add_input(name, inp)
            if is_positional:
                num_expanded_non_none_positional_inputs += num_expanded_non_none_inputs_local
        elif input_parameter.kind == inspect.Parameter.VAR_KEYWORD:
            # **kwargs is always the last argument of forward()
            for name, inp in kwargs.items():
                if name not in input_names:
                    _add_input(name, inp)

    return input_names


def _flatten_module_input(names, args, kwargs):
    """Flatten args and kwargs in a single tuple of tensors."""
    # extracted from https://github.com/microsoft/onnxruntime/blob/239c6ad3f021ff7cc2e6247eb074bd4208dc11e2/orttraining/orttraining/python/training/ortmodule/_io.py#L110

    def is_primitive_type(value):
        return type(value) in {int, bool, float}

    def to_tensor(value):
        return torch.tensor(value)

    ret = [to_tensor(arg) if is_primitive_type(arg) else arg for arg in args]
    ret += [
        to_tensor(kwargs[name]) if is_primitive_type(kwargs[name]) else kwargs[name] for name in names if name in kwargs
    ]

    # if kwargs is empty, append an empty dictionary at the end of the sample inputs to make exporter
    # happy. This is because the exporter is confused with kwargs and dictionary inputs otherwise.
    if not kwargs:
        ret.append({})

    return tuple(ret)


def infer_input_info(module: torch.nn.Module, *inputs, **kwargs):
    """
    Infer the input names and order from the arguments used to execute a PyTorch module for usage exporting
    the model via torch.onnx.export.
    Assumes model is on CPU. Use `module.to(torch.device('cpu'))` if it isn't.

    Example usage:
    input_names, inputs_as_tuple = infer_input_info(module, ...)
    torch.onnx.export(module, inputs_as_type, 'model.onnx', input_names=input_names, output_names=[...], ...)

    :param module: Module
    :param inputs: Positional inputs
    :param kwargs: Keyword argument inputs
    :return: Tuple of ordered input names and input values. These can be used directly with torch.onnx.export as the
            `input_names` and `inputs` arguments.
    """
    module_parameters = inspect.signature(module.forward).parameters.values()
    input_names = _parse_inputs_for_onnx_export(module_parameters, inputs, kwargs)
    inputs_as_tuple = _flatten_module_input(input_names, inputs, kwargs)

    return input_names, inputs_as_tuple
