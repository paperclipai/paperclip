# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
from __future__ import annotations

import json
from abc import ABC, abstractmethod

import ort_flatbuffers_py.fbs as fbs

from .types import FbsTypeInfo, value_name_to_typestr


def _create_op_key(domain: str, optype: str):
    return f"{domain}:{optype}"


def _ort_constant_for_domain(domain: str):
    """
    Map a string domain value to the internal ONNX Runtime constant for that domain.
    :param domain: Domain string to map.
    :return: Internal ONNX Runtime constant
    """

    # constants are defined in <ORT root>/include/onnxruntime/core/graph/constants.h
    # This list is limited to just the domains we have processors for
    domain_to_constant_map = {"ai.onnx": "kOnnxDomain", "ai.onnx.ml": "kMLDomain", "com.microsoft": "kMSDomain"}

    if domain not in domain_to_constant_map:
        raise ValueError(f"Domain {domain} not found in map to ONNX Runtime constant. Please update map.")

    return domain_to_constant_map[domain]


def _reg_type_to_cpp_type(reg_type: str):
    if reg_type == "string":
        return "std::string"
    return reg_type


def _split_reg_types(reg_types_str: str):
    """
    Split on underscores but append "_t" to the previous element.
    """
    tokens = reg_types_str.split("_")
    reg_types = []
    for token in tokens:
        if token == "t" and len(reg_types) > 0:
            reg_types[-1] += "_t"
        else:
            reg_types += [token]
    return reg_types


class TypeUsageProcessor(ABC):
    """
    Abstract base class for processors which implement operator specific logic to determine the type or types required.
    """

    def __init__(self, domain: str, optype: str):
        self.domain = domain
        self.optype = optype
        self.name = _create_op_key(domain, optype)

    @abstractmethod
    def process_node(self, node: fbs.Node, value_name_to_typeinfo: dict):
        pass

    def is_typed_registration_needed(self, type_in_registration: str, globally_allowed_types: set[str] | None):
        """
        Given the string from a kernel registration, determine if the registration is required or not.
        :param type_in_registration: Type string from kernel registration
        :param globally_allowed_types: Optional set of globally allowed types. If provided, these types take precedence
                                       in determining the required types.
        :return: True is required. False if not.
        """
        # Not all operators have typed registrations, so this is optionally implemented by derived classes
        raise RuntimeError(f"Did not expect processor for {self.name} to have typed registrations.")

    def get_cpp_entry(self):
        """
        Get the C++ code that specifies this operator's required types.
        :return: List with any applicable C++ code for this operator's required types. One line per entry.
        """
        # Not applicable for some ops, so return no lines by default.
        return []

    @abstractmethod
    def to_config_entry(self):
        """
        Generate a configuration file entry in JSON format with the required types for the operator.
        :return: JSON string with required type information.
        """

    @abstractmethod
    def from_config_entry(self, entry: str):
        """
        Re-create the types required from a configuration file entry created with to_config_entry.
        NOTE: Any existing type information should be cleared prior to re-creating from a config file entry.
        :param entry: Configuration file entry
        """


class DefaultTypeUsageProcessor(TypeUsageProcessor):
    """
    Operator processor which tracks the types used for selected input/s and/or output/s.
    """

    def __init__(
        self,
        domain: str,
        optype: str,
        inputs: [int] = [0],  # noqa: B006
        outputs: [int] = [],  # noqa: B006
        required_input_types: dict[int, set[str]] = {},  # noqa: B006
        required_output_types: dict[int, set[str]] = {},  # noqa: B006
    ):
        """
        Create DefaultTypeUsageProcessor. Types for one or more inputs and/or outputs can be tracked by the processor.
        The default is to track the types required for input 0, as this is the most common use case in ONNX.

        Required input and output types may be specified. These are only applicable to is_typed_registration_needed().
        If a registration type matches a required type, the typed registration is needed.
        There is a separate mechanism for specifying required types from C++ for kernels with untyped registration.

        :param domain: Operator domain.
        :param optype: Operator name.
        :param inputs: Inputs to track. Zero based index. May be empty.
        :param outputs: Outputs to track. Zero based index. May be empty.
        :param required_input_types: Required input types. May be empty.
        :param required_output_types: Required output types. May be empty.
        """
        super().__init__(domain, optype)
        self._input_types = {}
        self._output_types = {}

        for i in inputs:
            self._input_types[i] = set()

        for o in outputs:
            self._output_types[o] = set()

        if not inputs and not outputs:
            raise ValueError("At least one input or output must be tracked")

        self._required_input_types = required_input_types
        self._required_output_types = required_output_types

    def _is_type_enabled(self, reg_type, index, required_types, allowed_type_set):
        cpp_type = _reg_type_to_cpp_type(reg_type)
        return cpp_type in required_types.get(index, set()) or cpp_type in allowed_type_set

    def is_input_type_enabled(self, reg_type, index, allowed_type_set=None):
        """Whether input type is enabled based on required and allowed types."""
        if allowed_type_set is None:
            allowed_type_set = self._input_types[index]
        return self._is_type_enabled(reg_type, index, self._required_input_types, allowed_type_set)

    def is_output_type_enabled(self, reg_type, index, allowed_type_set=None):
        """Whether output type is enabled based on required and allowed types."""
        if allowed_type_set is None:
            allowed_type_set = self._output_types[index]
        return self._is_type_enabled(reg_type, index, self._required_output_types, allowed_type_set)

    def process_node(self, node: fbs.Node, value_name_to_typeinfo: dict):
        for i in self._input_types:
            if i >= node.InputsLength():
                # Some operators have fewer inputs in earlier versions where data that was as an attribute
                # become an input in later versions to allow it to be dynamically provided. Allow for that.
                # e.g. Slice-1 had attributes for the indices, and Slice-10 moved those to be inputs
                # raise RuntimeError('Node has {} outputs. Tracker for {} incorrectly configured as it requires {}.'
                #                    .format(node.OutputsLength(), self.name, o))
                pass
            else:
                type_str = value_name_to_typestr(node.Inputs(i), value_name_to_typeinfo)
                self._input_types[i].add(type_str)

        for o in self._output_types:
            # Don't know of any ops where the number of outputs changed across versions, so require a valid length
            if o >= node.OutputsLength():
                raise RuntimeError(
                    f"Node has {node.OutputsLength()} outputs. Tracker for {self.name} incorrectly configured as it requires {o}."
                )

            type_str = value_name_to_typestr(node.Outputs(o), value_name_to_typeinfo)
            self._output_types[o].add(type_str)

    def is_typed_registration_needed(self, type_in_registration: str, globally_allowed_types: set[str] | None):
        if 0 not in self._input_types:
            # currently all standard typed registrations are for input 0.
            # custom registrations can be handled by operator specific processors (e.g. OneHotProcessor below).
            raise RuntimeError(f"Expected typed registration to use type from input 0. Node:{self.name}")

        return self.is_input_type_enabled(type_in_registration, 0, globally_allowed_types)

    def get_cpp_entry(self):
        entries = []
        domain = _ort_constant_for_domain(self.domain)
        for i in sorted(self._input_types.keys()):
            if self._input_types[i]:
                entries.append(
                    "ORT_SPECIFY_OP_KERNEL_ARG_ALLOWED_TYPES({}, {}, Input, {}, {});".format(
                        domain, self.optype, i, ", ".join(sorted(self._input_types[i]))
                    )
                )

        for o in sorted(self._output_types.keys()):
            if self._output_types[o]:
                entries.append(
                    "ORT_SPECIFY_OP_KERNEL_ARG_ALLOWED_TYPES({}, {}, Output, {}, {});".format(
                        domain, self.optype, o, ", ".join(sorted(self._output_types[o]))
                    )
                )

        return entries

    def to_config_entry(self):
        # convert the sets of types to lists so they can easily written out using the json model
        aggregate_info = {"inputs": {}, "outputs": {}}

        # filter out empty entries and sort the types
        for i in sorted(self._input_types.keys()):
            if self._input_types[i]:
                aggregate_info["inputs"][i] = sorted(self._input_types[i])

        for o in sorted(self._output_types.keys()):
            if self._output_types[o]:
                aggregate_info["outputs"][o] = sorted(self._output_types[o])

        # remove any empty keys
        if not aggregate_info["inputs"]:
            aggregate_info.pop("inputs")
        if not aggregate_info["outputs"]:
            aggregate_info.pop("outputs")

        entry = json.dumps(aggregate_info) if aggregate_info else None
        return entry

    def from_config_entry(self, entry: str):
        self._input_types.clear()
        self._output_types.clear()

        aggregate_info = json.loads(entry)
        if "inputs" in aggregate_info:
            for i_str, values in aggregate_info["inputs"].items():
                self._input_types[int(i_str)] = set(values)

        if "outputs" in aggregate_info:
            for o_str, values in aggregate_info["outputs"].items():
                self._output_types[int(o_str)] = set(values)


class Input1TypedRegistrationProcessor(DefaultTypeUsageProcessor):
    """
    Processor for operators where the second input type is used in a typed kernel registration.
    """

    def __init__(self, domain: str, optype: str):
        # init with tracking of input 1 only.
        super().__init__(domain, optype, inputs=[1], outputs=[])

    def is_typed_registration_needed(self, type_in_registration: str, globally_allowed_types: set[str] | None):
        return self.is_input_type_enabled(type_in_registration, 1, globally_allowed_types)


class Output0TypedRegistrationProcessor(DefaultTypeUsageProcessor):
    """
    Processor for operators where the first output type is used in a typed kernel registration.
    """

    def __init__(self, domain: str, optype: str):
        # init with tracking of output 0 only.
        super().__init__(domain, optype, inputs=[], outputs=[0])

    def is_typed_registration_needed(self, type_in_registration: str, globally_allowed_types: set[str] | None):
        return self.is_output_type_enabled(type_in_registration, 0, globally_allowed_types)


class OneHotProcessor(TypeUsageProcessor):
    """
    Processor for the OneHot operator, which requires custom logic as the type registration key is a concatenation of
    the three types involved instead of a single type name.
    """

    def __init__(self):
        super().__init__("ai.onnx", "OneHot")
        self._triples = set()

    def process_node(self, node: fbs.Node, value_name_to_typeinfo: dict):
        type0 = value_name_to_typestr(node.Inputs(0), value_name_to_typeinfo)
        type1 = value_name_to_typestr(node.Inputs(1), value_name_to_typeinfo)
        type2 = value_name_to_typestr(node.Inputs(2), value_name_to_typeinfo)
        # types in kernel registration are ordered this way: input (T1), output (T3), depth (T2)
        key = (type0, type2, type1)
        self._triples.add(key)

    def is_typed_registration_needed(self, type_in_registration: str, globally_allowed_types: set[str] | None):
        # the OneHot registration involves a concatenation of the 3 types involved
        reg_types = tuple([_reg_type_to_cpp_type(reg_type) for reg_type in _split_reg_types(type_in_registration)])
        if globally_allowed_types is not None:
            return all(reg_type in globally_allowed_types for reg_type in reg_types)
        else:
            return reg_types in self._triples

    def to_config_entry(self):
        if not self._triples:
            return None

        aggregate_info = {"custom": sorted(self._triples)}
        entry = json.dumps(aggregate_info)
        return entry

    def from_config_entry(self, entry: str):
        self._triples.clear()
        aggregate_info = json.loads(entry)
        if "custom" in aggregate_info:
            self._triples = {tuple(triple) for triple in aggregate_info["custom"]}


def _create_operator_type_usage_processors():
    """
    Create a set of processors that determine the required types for all enabled operators.
    :return: Dictionary of operator key to processor. Key is 'domain:operator (e.g. ai.onnx:Cast)'.
    """
    operator_processors = {}

    def add(processor):
        if processor.name in operator_processors:
            raise RuntimeError("Duplicate processor for " + processor.name)

        operator_processors[processor.name] = processor

    # Starting with ops from:
    #   - Priority 1P models
    #   - Mobilenet + SSD Mobilenet + MobileBert
    #   - some known large kernels
    #
    # Ops we are ignoring currently so as not to produce meaningless/unused output:
    # - Implementation is type agnostic:
    #    ai.onnx: If, Loop, Reshape, Scan, Shape, Squeeze, Tile, Unsqueeze
    #    com.microsoft: DynamicQuantizeMatMul, MatMulIntegerToFloat
    # - Only one type supported in the ORT implementation:
    #    ai.onnx: NonMaxSuppression
    #    com.microsoft: FusedConv, FusedGemm, FusedMatMul
    # - Implementation does not have any significant type specific code:
    #    ai.onnx: Concat, Flatten, Not, Reshape, Shape, Squeeze, Unsqueeze
    #
    default_processor_onnx_ops = [
        "Abs",
        "ArgMax",
        "ArgMin",
        "AveragePool",
        "BatchNormalization",
        "BitShift",
        "Ceil",
        "Clip",
        "Conv",
        "CumSum",
        "Exp",
        "Expand",
        "Floor",
        "Gemm",
        "IsNaN",
        "Log",
        "LogSoftmax",
        "LpNormalization",
        "MatMul",
        "Max",
        "MaxPool",
        "Mean",
        "Min",
        "NonZero",
        "Pad",
        "QLinearConv",
        "QLinearMatMul",
        "Range",
        "Reciprocal",
        "ReduceL1",
        "ReduceL2",
        "ReduceLogSum",
        "ReduceLogSumExp",
        "ReduceMax",
        "ReduceMean",
        "ReduceMin",
        "ReduceProd",
        "ReduceSum",
        "ReduceSumSquare",
        "Relu",
        "Resize",
        "ReverseSequence",
        "RoiAlign",
        "Round",
        "Scatter",
        "ScatterElements",
        "ScatterND",
        "Shrink",
        "Sigmoid",
        "Sign",
        "Sin",
        "Softmax",
        "Split",
        "SplitToSequence",
        "Sqrt",
        "Sum",
        "Tanh",
        "TopK",
        "Transpose",
        "Unique",
    ]

    # ops that are used to manipulate shapes or indices so require int32_t and int64_t to be available
    default_processor_onnx_ops_requiring_ints_for_input_0 = [
        "Add",
        "Concat",
        "Div",
        "Equal",
        "Greater",
        "Less",
        "Mul",
        "Neg",  # used in tflite TransposeConv conversion
        "Sub",
    ]

    # NOTE: QLinearConv has ONNX and internal implementations
    internal_ops = ["QLinearAdd", "QLinearMul", "QLinearConv"]

    # TODO - review and add ML ops as needed
    # ML Op notes.
    #  CastMap: Switch on value type of input map type, and output type
    #  DictVectorizer: Templatized on key+value of input so need to handle like OneHot with custom processor
    #  LabelEncoder: Implementation switches on input and output types (only supports string and int64 in T1 and T2)
    #  LinearClassifier: Internal switch on input type and also switch on output type
    #  SVMClassifier: ditto
    #  TreeEnsembleClassifier: Templatized on input type and also switch on output type
    #  ZipMap: Switch on output type (derived from attributes)
    default_processor_onnxml_ops = []

    [add(DefaultTypeUsageProcessor("ai.onnx", op)) for op in default_processor_onnx_ops]
    [
        add(DefaultTypeUsageProcessor("ai.onnx", op, required_input_types={0: {"int32_t", "int64_t"}}))
        for op in default_processor_onnx_ops_requiring_ints_for_input_0
    ]
    [add(DefaultTypeUsageProcessor("ai.onnx.ml", op)) for op in default_processor_onnxml_ops]
    [add(DefaultTypeUsageProcessor("com.microsoft", op)) for op in internal_ops]

    #
    # Operators that require custom handling
    #

    # Cast switches on types of input 0 and output 0
    add(DefaultTypeUsageProcessor("ai.onnx", "Cast", inputs=[0], outputs=[0]))

    # Operators that switch on the type of input 0 and 1
    add(DefaultTypeUsageProcessor("ai.onnx", "Gather", inputs=[0, 1]))
    add(DefaultTypeUsageProcessor("ai.onnx", "GatherElements", inputs=[0, 1]))
    add(DefaultTypeUsageProcessor("ai.onnx", "Pow", inputs=[0, 1]))
    add(DefaultTypeUsageProcessor("ai.onnx", "Slice", inputs=[0, 1]))

    # Operators that switch on output type
    add(DefaultTypeUsageProcessor("ai.onnx", "ConstantOfShape", inputs=[], outputs=[0]))

    # Random generator ops produce new data so we track the output type
    onnx_random_ops = ["RandomNormal", "RandomNormalLike", "RandomUniform", "RandomUniformLike", "Multinomial"]
    [add(DefaultTypeUsageProcessor("ai.onnx", op, inputs=[], outputs=[0])) for op in onnx_random_ops]

    # Where always has a boolean first input so track the second input type for typed registration
    add(Input1TypedRegistrationProcessor("ai.onnx", "Where"))

    # we only support 'float' as input for [Dynamic]QuantizeLinear so just track the output type
    # as that's what is used in the typed registration
    add(Output0TypedRegistrationProcessor("ai.onnx", "QuantizeLinear"))
    add(Output0TypedRegistrationProcessor("ai.onnx", "DynamicQuantizeLinear"))

    # make sure all the dequantize types are enabled. we use int32_t for parts of GEMM and Conv so just
    # enabling int8 and uint8 is not enough.
    # TODO: Only apply required types to the global type list and ignore if it's model based per-op type reduction
    add(
        DefaultTypeUsageProcessor(
            "ai.onnx", "DequantizeLinear", inputs=[0], required_input_types={0: {"int8_t", "uint8_t", "int32_t"}}
        )
    )

    # OneHot concatenates type strings into a triple in the typed registration
    #   e.g. float_int64_t_int64_t
    add(OneHotProcessor())

    return operator_processors


class OpTypeImplFilterInterface(ABC):
    """
    Class that filters operator implementations based on type.
    """

    @abstractmethod
    def is_typed_registration_needed(self, domain: str, optype: str, type_registration_str: str):
        """
        Given the string from a kernel registration, determine if the registration is required or not.
        :param domain: Operator domain.
        :param optype: Operator type.
        :param type_registration_str: Type string from kernel registration
        :return: True is required. False if not.
        """

    @abstractmethod
    def get_cpp_entries(self):
        """
        Get the C++ code that specifies the operator types to enable.
        :return: List of strings. One line of C++ code per entry.
        """


class OperatorTypeUsageManager:
    """
    Class to manage the operator type usage processors.
    TODO: Currently the type tracking is not specific to a version of the operator.
    It's unclear how/where version specific logic could/should be added, and it would add significant complexity
    to track types on a per-version basis. Not clear there's enough benefit from doing so either.
    """

    def __init__(self):
        self._all_operator_processors = _create_operator_type_usage_processors()  # all possible processors
        self._operator_processors = {}  # processors we have actually used so we can limit output to be meaningful

    def _get_op_processor(self, key):
        "Add the processor to _operator_processors as it is about to be used."
        processor = None
        if key in self._all_operator_processors:
            if key not in self._operator_processors:
                self._operator_processors[key] = self._all_operator_processors[key]

            processor = self._operator_processors[key]

        return processor

    def process_node(self, node: fbs.Node, value_name_to_typeinfo: dict):
        """
        Process a Node and record info on the types used.
        :param node: Node from ORT format model
        :param value_name_to_typeinfo: Map of value names to TypeInfo instances
        """
        optype = node.OpType().decode()
        domain = node.Domain().decode() or "ai.onnx"  # empty domain defaults to ai.onnx

        key = _create_op_key(domain, optype)
        op_processor = self._get_op_processor(key)
        if op_processor:
            op_processor.process_node(node, value_name_to_typeinfo)

    def get_config_entry(self, domain: str, optype: str):
        """
        Get the config entry specifying the types for this operator.
        :param domain: Operator domain.
        :param optype: Operator type.
        :return: JSON string with type info if available, else None
        """
        key = _create_op_key(domain, optype)
        config_str = None
        if key in self._operator_processors:
            config_str = self._operator_processors[key].to_config_entry()

        return config_str

    def restore_from_config_entry(self, domain: str, optype: str, config_entry: str):
        """
        Restore the per-operator type information from a configuration file entry.
        :param domain: Operator domain.
        :param optype: Operator type.
        :param config_entry: JSON string with type info as created by get_config_entry
        """
        key = _create_op_key(domain, optype)
        op_processor = self._get_op_processor(key)
        if op_processor:
            op_processor.from_config_entry(config_entry)

    def debug_dump(self):
        print("C++ code that will be emitted:")
        [print(cpp_line) for cpp_line in self.get_cpp_entries()]

        print("Config file type information that will be returned by get_config_entry:")
        for key in sorted(self._operator_processors.keys()):
            entry = self._operator_processors[key].to_config_entry()
            if entry:
                print(f"{key} -> {entry}")

                # roundtrip test to validate that we can initialize the processor from the entry and get the
                # same values back
                self._operator_processors[key].from_config_entry(entry)
                assert entry == self._operator_processors[key].to_config_entry()

    class _OpTypeImplFilter(OpTypeImplFilterInterface):
        def __init__(self, manager):
            self._manager = manager

        def is_typed_registration_needed(self, domain: str, optype: str, type_registration_str: str):
            needed = True  # we keep the registration unless the per-operator processor says not to
            key = _create_op_key(domain, optype)
            if key in self._manager._operator_processors:
                needed = self._manager._operator_processors[key].is_typed_registration_needed(
                    type_in_registration=type_registration_str, globally_allowed_types=None
                )

            return needed

        def get_cpp_entries(self):
            entries = []
            for key in sorted(self._manager._operator_processors.keys()):
                entries.extend(self._manager._operator_processors[key].get_cpp_entry())

            return entries

    def make_op_type_impl_filter(self):
        """
        Creates an OpTypeImplFilterInterface instance from this manager.
        Filtering uses the manager's operator type usage processor state.
        """
        return OperatorTypeUsageManager._OpTypeImplFilter(self)


class GloballyAllowedTypesOpTypeImplFilter(OpTypeImplFilterInterface):
    """
    Operator implementation filter which uses globally allowed types.
    """

    _valid_allowed_types = set(FbsTypeInfo.tensordatatype_to_string.values())  # noqa: RUF012

    def __init__(self, globally_allowed_types: set[str]):
        self._operator_processors = _create_operator_type_usage_processors()

        if not globally_allowed_types.issubset(self._valid_allowed_types):
            raise ValueError(
                f"Globally allowed types must all be valid. Invalid types: {sorted(globally_allowed_types - self._valid_allowed_types)}"
            )

        self._globally_allowed_types = globally_allowed_types

    def is_typed_registration_needed(self, domain: str, optype: str, type_registration_str: str):
        key = _create_op_key(domain, optype)
        if key in self._operator_processors:
            needed = self._operator_processors[key].is_typed_registration_needed(
                type_in_registration=type_registration_str, globally_allowed_types=self._globally_allowed_types
            )
        else:
            needed = _reg_type_to_cpp_type(type_registration_str) in self._globally_allowed_types

        return needed

    def get_cpp_entries(self):
        return [
            "ORT_SPECIFY_OP_KERNEL_GLOBAL_ALLOWED_TYPES({});".format(", ".join(sorted(self._globally_allowed_types)))
        ]

    def global_type_list(self):
        return self._globally_allowed_types
