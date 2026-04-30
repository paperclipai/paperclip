# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

import ort_flatbuffers_py.fbs as fbs

from .operator_type_usage_processors import OperatorTypeUsageManager


class OrtFormatModelProcessor:
    "Class to process an ORT format model and determine required operators and types."

    def __init__(self, model_path: str, required_ops: dict, processors: OperatorTypeUsageManager):
        """
        Initialize ORT format model processor
        :param model_path: Path to model to load
        :param required_ops: Dictionary required operator information will be added to.
        :param processors: Operator type usage processors which will be called for each matching Node.
        """
        self._required_ops = required_ops  # dictionary of {domain: {opset:[operators]}}
        self._file = open(model_path, "rb").read()  # noqa: SIM115
        self._buffer = bytearray(self._file)
        if not fbs.InferenceSession.InferenceSession.InferenceSessionBufferHasIdentifier(self._buffer, 0):
            raise RuntimeError(f"File does not appear to be a valid ORT format model: '{model_path}'")
        self._model = fbs.InferenceSession.InferenceSession.GetRootAsInferenceSession(self._buffer, 0).Model()
        self._op_type_processors = processors

    @staticmethod
    def _setup_type_info(graph: fbs.Graph, outer_scope_value_typeinfo={}):  # noqa: B006
        """
        Setup the node args for this level of Graph.
        We copy the current list which represents the outer scope values, and add the local node args to that
        to create the valid list of values for the current Graph.
        :param graph: Graph to create NodeArg list for
        :param outer_scope_value_typeinfo: TypeInfo for outer scope values. Empty for the top-level graph in a model.
        :return: Dictionary of NodeArg name to TypeInfo
        """
        value_name_to_typeinfo = outer_scope_value_typeinfo.copy()
        for j in range(graph.NodeArgsLength()):
            n = graph.NodeArgs(j)
            value_name_to_typeinfo[n.Name()] = n.Type()  # TypeInfo for this NodeArg's name

        return value_name_to_typeinfo

    def _add_required_op(self, domain: str, opset: int, op_type: str):
        if domain not in self._required_ops:
            self._required_ops[domain] = {opset: {op_type}}
        elif opset not in self._required_ops[domain]:
            self._required_ops[domain][opset] = {op_type}
        else:
            self._required_ops[domain][opset].add(op_type)

    def _process_graph(self, graph: fbs.Graph, outer_scope_value_typeinfo: dict):
        """
        Process one level of the Graph, descending into any subgraphs when they are found
        :param outer_scope_value_typeinfo: Outer scope NodeArg dictionary from ancestor graphs
        """
        # Merge the TypeInfo for all values in this level of the graph with the outer scope value TypeInfo.
        value_name_to_typeinfo = OrtFormatModelProcessor._setup_type_info(graph, outer_scope_value_typeinfo)

        for i in range(graph.NodesLength()):
            node = graph.Nodes(i)

            optype = node.OpType().decode()
            domain = node.Domain().decode() or "ai.onnx"  # empty domain defaults to ai.onnx

            self._add_required_op(domain, node.SinceVersion(), optype)

            if self._op_type_processors:
                self._op_type_processors.process_node(node, value_name_to_typeinfo)

            # Read all the attributes
            for j in range(node.AttributesLength()):
                attr = node.Attributes(j)
                attr_type = attr.Type()
                if attr_type == fbs.AttributeType.AttributeType.GRAPH:
                    self._process_graph(attr.G(), value_name_to_typeinfo)
                elif attr_type == fbs.AttributeType.AttributeType.GRAPHS:
                    # the ONNX spec doesn't currently define any operators that have multiple graphs in an attribute
                    # so entering this 'elif' isn't currently possible
                    for k in range(attr.GraphsLength()):
                        self._process_graph(attr.Graphs(k), value_name_to_typeinfo)

    def process(self):
        graph = self._model.Graph()
        outer_scope_value_typeinfo = {}  # no outer scope values for the main graph
        self._process_graph(graph, outer_scope_value_typeinfo)
