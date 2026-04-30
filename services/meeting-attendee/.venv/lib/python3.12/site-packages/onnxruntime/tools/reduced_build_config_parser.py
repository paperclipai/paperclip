# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
from __future__ import annotations

import os

# Check if the flatbuffers module is available. If not we cannot handle type reduction information in the config.
try:
    import flatbuffers  # noqa: F401

    have_flatbuffers = True
    from .ort_format_model import GloballyAllowedTypesOpTypeImplFilter, OperatorTypeUsageManager
except ImportError:
    have_flatbuffers = False


def parse_config(config_file: str, enable_type_reduction: bool = False):
    """
    Parse the configuration file and return the required operators dictionary and an
    OpTypeImplFilterInterface instance.

    Configuration file lines can do the following:
    1. specify required operators
    2. specify globally allowed types for all operators
    3. specify what it means for no required operators to be specified

    1. Specifying required operators

    The basic format for specifying required operators is `domain;opset1,opset2;op1,op2...`
    e.g. `ai.onnx;11;Add,Cast,Clip,... for a single opset
         `ai.onnx;11,12;Add,Cast,Clip,... for multiple opsets

         note: Configuration information is accrued as the file is parsed. If an operator requires support from multiple
         opsets that can be done with one entry for each opset, or one entry with multiple opsets in it.

    If the configuration file is generated from ORT format models it may optionally contain JSON for per-operator
    type reduction. The required types are generally listed per input and/or output of the operator.
    The type information is in a map, with 'inputs' and 'outputs' keys. The value for 'inputs' or 'outputs' is a map
    between the index number of the input/output and the required list of types.

    For example, both the input and output types are relevant to ai.onnx:Cast.
    Type information for input 0 and output 0 could look like this:
        `{"inputs": {"0": ["float", "int32_t"]}, "outputs": {"0": ["float", "int64_t"]}}`

    which is added directly after the operator name in the configuration file.
    e.g.
        `ai.onnx;12;Add,Cast{"inputs": {"0": ["float", "int32_t"]}, "outputs": {"0": ["float", "int64_t"]}},Concat`

    If for example the types of inputs 0 and 1 were important, the entry may look like this (e.g. ai.onnx:Gather):
        `{"inputs": {"0": ["float", "int32_t"], "1": ["int32_t"]}}`

    Finally some operators do non-standard things and store their type information under a 'custom' key.
    ai.onnx.OneHot is an example of this, where the three input types are combined into a triple.
        `{"custom": [["float", "int64_t", "int64_t"], ["int64_t", "std::string", "int64_t"]]}`

    2. Specifying globally allowed types for all operators

    The format for specifying globally allowed types for all operators is:
        `!globally_allowed_types;T0,T1,...`

    Ti should be a C++ scalar type supported by ONNX and ORT.
    At most one globally allowed types specification is allowed.

    Specifying per-operator type information and specifying globally allowed types are mutually exclusive - it is an
    error to specify both.

    3. Specify what it means for no required operators to be specified

    By default, if no required operators are specified, NO operators are required.

    With the following line, if no required operators are specified, ALL operators are required:
        `!no_ops_specified_means_all_ops_are_required`

    :param config_file: Configuration file to parse
    :param enable_type_reduction: Set to True to use the type information in the config.
                                  If False the type information will be ignored.
                                  If the flatbuffers module is unavailable type information will be ignored as the
                                  type-based filtering has a dependency on the ORT flatbuffers schema.
    :return: required_ops: Dictionary of domain:opset:[ops] for required operators. If None, all operators are
                           required.
             op_type_impl_filter: OpTypeImplFilterInterface instance if type reduction is enabled, the flatbuffers
                                  module is available, and type reduction information is present. None otherwise.
    """

    if not os.path.isfile(config_file):
        raise ValueError(f"Configuration file {config_file} does not exist")

    # only enable type reduction when flatbuffers is available
    enable_type_reduction = enable_type_reduction and have_flatbuffers

    required_ops = {}
    no_ops_specified_means_all_ops_are_required = False
    op_type_usage_manager = OperatorTypeUsageManager() if enable_type_reduction else None
    has_op_type_reduction_info = False
    globally_allowed_types = None

    def process_non_op_line(line):
        if not line or line.startswith("#"):  # skip empty lines and comments
            return True

        if line.startswith("!globally_allowed_types;"):  # handle globally allowed types
            if enable_type_reduction:
                nonlocal globally_allowed_types
                if globally_allowed_types is not None:
                    raise RuntimeError("Globally allowed types were already specified.")
                globally_allowed_types = {segment.strip() for segment in line.split(";")[1].split(",")}
            return True

        if line == "!no_ops_specified_means_all_ops_are_required":  # handle all ops required line
            nonlocal no_ops_specified_means_all_ops_are_required
            no_ops_specified_means_all_ops_are_required = True
            return True

        return False

    with open(config_file) as config:
        for line in [orig_line.strip() for orig_line in config]:
            if process_non_op_line(line):
                continue

            domain, opset_str, operators_str = (segment.strip() for segment in line.split(";"))
            opsets = [int(s) for s in opset_str.split(",")]

            # any type reduction information is serialized json that starts/ends with { and }.
            # type info is optional for each operator.
            if "{" in operators_str:
                has_op_type_reduction_info = True

                # parse the entries in the json dictionary with type info
                operators = set()
                cur = 0
                end = len(operators_str)
                while cur < end:
                    next_comma = operators_str.find(",", cur)
                    next_open_brace = operators_str.find("{", cur)

                    if next_comma == -1:
                        next_comma = end

                    # the json string starts with '{', so if that is found (next_open_brace != -1)
                    # before the next comma (which would be the start of the next operator if there is no type info
                    # for the current operator), we have type info to parse.
                    # e.g. need to handle extracting the operator name and type info for OpB and OpD,
                    #      and just the operator names for OpA and OpC from this example string
                    #      OpA,OpB{"inputs": {"0": ["float", "int32_t"]}},OpC,OpD{"outputs": {"0": ["int32_t"]}}
                    if 0 < next_open_brace < next_comma:
                        operator = operators_str[cur:next_open_brace].strip()
                        operators.add(operator)

                        # parse out the json dictionary with the type info by finding the closing brace that matches
                        # the opening brace
                        i = next_open_brace + 1
                        num_open_braces = 1
                        while num_open_braces > 0 and i < end:
                            if operators_str[i] == "{":
                                num_open_braces += 1
                            elif operators_str[i] == "}":
                                num_open_braces -= 1
                            i += 1

                        if num_open_braces != 0:
                            raise RuntimeError("Mismatched { and } in type string: " + operators_str[next_open_brace:])

                        if op_type_usage_manager:
                            type_str = operators_str[next_open_brace:i]
                            op_type_usage_manager.restore_from_config_entry(domain, operator, type_str)

                        cur = i + 1
                    else:
                        # comma or end of line is next
                        end_str = next_comma if next_comma != -1 else end
                        operators.add(operators_str[cur:end_str].strip())
                        cur = end_str + 1

            else:
                operators = {op.strip() for op in operators_str.split(",")}

            for opset in opsets:
                if domain not in required_ops:
                    required_ops[domain] = {opset: operators}
                elif opset not in required_ops[domain]:
                    required_ops[domain][opset] = operators
                else:
                    required_ops[domain][opset].update(operators)

    if len(required_ops) == 0 and no_ops_specified_means_all_ops_are_required:
        required_ops = None

    op_type_impl_filter = None
    if enable_type_reduction:
        if not has_op_type_reduction_info:
            op_type_usage_manager = None
        if globally_allowed_types is not None and op_type_usage_manager is not None:
            raise RuntimeError(
                "Specifying globally allowed types and per-op type reduction info together is unsupported."
            )

        if globally_allowed_types is not None:
            op_type_impl_filter = GloballyAllowedTypesOpTypeImplFilter(globally_allowed_types)
        elif op_type_usage_manager is not None:
            op_type_impl_filter = op_type_usage_manager.make_op_type_impl_filter()

    return required_ops, op_type_impl_filter
