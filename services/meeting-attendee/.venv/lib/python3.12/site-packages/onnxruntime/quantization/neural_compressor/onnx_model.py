#
#  The implementation of this file is based on:
# https://github.com/intel/neural-compressor/tree/master/neural_compressor
#
# Copyright (c) 2023 Intel Corporation
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#    http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Class for ONNX model."""

import copy
import logging
import os
from collections import deque
from pathlib import Path

import onnx
import onnx.external_data_helper
import onnx_ir as ir

from .util import MAXIMUM_PROTOBUF, find_by_name

logger = logging.getLogger("neural_compressor")

# TODO: Check https://github.com/microsoft/onnxruntime/blob/main/onnxruntime/python/tools/quantization/onnx_model.py to see if we can integrate with it.


class ONNXModel:
    """Build ONNX model."""

    def __init__(self, model, **kwargs):
        """Initialize an ONNX model.

        Args:
            model (str or ModelProto): path to onnx model or loaded ModelProto model object.
            ignore_warning (bool): ignore large model warning. Default is False.
            load_external_data (bool): load external data for large model. Default is True.
        """
        self._model = model if not isinstance(model, str) else onnx.load(model, load_external_data=False)
        self._model_path = None if not isinstance(model, str) else model

        self.check_is_large_model()
        if self._is_large_model and self._model_path is None and not kwargs.get("ignore_warning", False):
            logger.warning("Model size > 2GB. Please use model path instead of onnx model object to quantize")

        if self._is_large_model and isinstance(model, str) and kwargs.get("load_external_data", True):
            onnx.external_data_helper.load_external_data_for_model(self._model, os.path.dirname(self._model_path))

        self._config = None
        if isinstance(model, str) and os.path.exists(Path(model).parent.joinpath("config.json").as_posix()):
            from transformers import AutoConfig  # noqa: PLC0415

            self._config = AutoConfig.from_pretrained(Path(model).parent.as_posix())

        self.node_name_counter = {}
        self._output_name_to_node = {}
        self._input_name_to_nodes = {}
        self._get_input_name_to_nodes(self._model.graph.node)
        self._get_output_name_to_node(self._model.graph.node)
        self._graph_info = {}
        self._get_graph_info()
        self._q_config = None

    def check_is_large_model(self):
        """Check model > 2GB."""
        ir_graph = ir.from_proto(self._model.graph)
        initializer_size = sum(
            v.const_value.nbytes for v in ir_graph.initializers.values() if v.const_value is not None
        )
        self._is_large_model = initializer_size > MAXIMUM_PROTOBUF

    @property
    def is_large_model(self):
        """Check the onnx model is over 2GB."""
        return self._is_large_model

    @property
    def model_path(self):
        """Return model path."""
        return self._model_path

    @model_path.setter
    def model_path(self, path):
        """Set model path."""
        self._model_path = path

    def framework(self):
        """Return framework."""
        return "onnxruntime"

    @property
    def q_config(self):
        """Return q_config."""
        return self._q_config

    @q_config.setter
    def q_config(self, q_config):
        """Set q_config."""
        self._q_config = q_config

    @property
    def hf_config(self):
        """Return huggingface config if model is Transformer-based."""
        return self._config

    @property
    def model(self):
        """Return model itself."""
        return self._model

    @model.setter
    def model(self, model):
        """Set model itself."""
        self._model = model
        self._graph_info = {}
        self._get_graph_info()
        self._output_name_to_node = {}
        self._input_name_to_nodes = {}
        self._get_input_name_to_nodes(self._model.graph.node)
        self._get_output_name_to_node(self._model.graph.node)

    def input(self):
        """Return input of model."""
        return [i.name for i in self._model.graph.input]

    def output(self):
        """Return output of model."""
        return [i.name for i in self._model.graph.output]

    def update(self):
        """Update model info."""
        self._graph_info = {}
        self._get_graph_info()
        self._output_name_to_node = {}
        self._input_name_to_nodes = {}
        self._get_input_name_to_nodes(self._model.graph.node)
        self._get_output_name_to_node(self._model.graph.node)

    @property
    def graph_info(self):
        """Return ORT Graph Info object holding information about backend graph."""
        return self._graph_info

    def _get_graph_info(self):
        """Update graph info."""
        for node in self._model.graph.node:
            self.graph_info.update({node.name: node.op_type})

    def save(self, root):
        """Save ONNX model."""
        if os.path.split(root)[0] != "" and not os.path.exists(os.path.split(root)[0]):
            raise ValueError('"root" directory does not exists.')
        if self.is_large_model:
            onnx.external_data_helper.load_external_data_for_model(self._model, os.path.split(self._model_path)[0])
            onnx.save_model(
                self._model,
                root,
                save_as_external_data=True,
                all_tensors_to_one_file=True,
                location=root.split("/")[-1] + "_data",
                size_threshold=1024,
                convert_attribute=False,
            )
        else:
            onnx.save(self._model, root)

        if self._config is not None:
            model_type = "" if not hasattr(self._config, "model_type") else self._config.model_type
            self._config.__class__.model_type = model_type
            output_config_file = Path(root).parent.joinpath("config.json").as_posix()
            self._config.to_json_file(output_config_file, use_diff=False)

    def nodes(self):
        """Return model nodes."""
        return self._model.graph.node

    def initializer(self):
        """Return model initializer."""
        return self._model.graph.initializer

    def graph(self):
        """Return model graph."""
        return self._model.graph

    def ir_version(self):
        """Return model ir_version."""
        return self._model.ir_version

    def opset_import(self):
        """Return model opset_import."""
        return self._model.opset_import

    def remove_node(self, node):
        """Remove a node from model."""
        if node in self._model.graph.node:
            self._model.graph.node.remove(node)

    def remove_nodes(self, nodes_to_remove):
        """Remove nodes from model."""
        for node in nodes_to_remove:
            self.remove_node(node)

    def add_node(self, node):
        """Add a node to model."""
        self._model.graph.node.extend([node])

    def add_nodes(self, nodes_to_add):
        """Add nodes to model."""
        self._model.graph.node.extend(nodes_to_add)

    def add_initializer(self, tensor):
        """Add a initializer to model."""
        if find_by_name(tensor.name, self._model.graph.initializer) is None:
            self._model.graph.initializer.extend([tensor])

    def add_initializers(self, tensors):
        """Add initializers to model."""
        for tensor in tensors:
            self.add_initializer(tensor)

    def get_initializer(self, name):
        """Get an initializer by name."""
        for tensor in self._model.graph.initializer:
            if tensor.name == name:
                return tensor
        return None

    def get_initializer_share_num(self, name):
        """Get the number of shares of initializer."""
        num = 0
        if self.get_initializer(name) is None:
            return num

        for node in self.nodes():
            if name in node.input:
                num += 1
        return num

    def get_node(self, name):
        """Get a node by name."""
        for node in self._model.graph.node:
            if node.name == name:
                return node
        return None

    def remove_initializer(self, tensor):
        """Remove an initializer from model."""
        if tensor in self._model.graph.initializer:
            self._model.graph.initializer.remove(tensor)

    def remove_initializers(self, init_to_remove):
        """Remove initializers from model."""
        for initializer in init_to_remove:
            self.remove_initializer(initializer)

    def set_initializer(self, tensor, array, raw=False):
        """Update initializer."""
        old_tensor = self.get_initializer(tensor)
        self.remove_initializer(old_tensor)
        dims = old_tensor.dims
        data_type = old_tensor.data_type
        new_tensor = (
            onnx.helper.make_tensor(tensor, data_type, dims, array.flatten().tolist())
            if not raw
            else onnx.helper.make_tensor(tensor, data_type, dims, array.tostring(), raw=raw)
        )
        self.add_initializer(new_tensor)

    @property
    def input_name_to_nodes(self):
        """Return input names of nodes."""
        return self._input_name_to_nodes

    def _get_input_name_to_nodes(self, nodes):
        """Get input names of nodes."""
        for node in nodes:
            attrs = [
                attr
                for attr in node.attribute
                if attr.type == onnx.AttributeProto.GRAPH or attr.type == onnx.AttributeProto.GRAPHS
            ]
            if len(attrs) > 0:
                for attr in attrs:
                    self._get_input_name_to_nodes(attr.g.node)
            for input_name in node.input:
                if len(input_name.strip()) != 0:
                    if input_name not in self._input_name_to_nodes:
                        self._input_name_to_nodes[input_name] = [node]
                    else:
                        self._input_name_to_nodes[input_name].append(node)

    @property
    def output_name_to_node(self):
        """Return output names of nodes."""
        return self._output_name_to_node

    def _get_output_name_to_node(self, nodes):
        """Get output names of nodes."""
        for node in nodes:
            attrs = [
                attr
                for attr in node.attribute
                if attr.type == onnx.AttributeProto.GRAPH or attr.type == onnx.AttributeProto.GRAPHS
            ]
            if len(attrs) > 0:
                for attr in attrs:
                    self._get_output_name_to_node(attr.g.node)
            for output_name in node.output:
                if len(output_name.strip()) != 0:
                    self._output_name_to_node[output_name] = node

    def get_siblings(self, node):
        """Get siblings nodes."""
        siblings = []
        for parent in self.get_parents(node):
            for child in self.get_children(parent):
                if child.name != node.name:
                    siblings.append(child)
        return siblings

    def get_children(self, node, input_name_to_nodes=None):
        """Get children nodes."""
        if input_name_to_nodes is None:
            input_name_to_nodes = self._input_name_to_nodes

        children = []
        for output in node.output:
            if output in input_name_to_nodes:
                for child in input_name_to_nodes[output]:
                    children.append(child)  # noqa:  PERF402
        return children

    def get_parents(self, node, output_name_to_node=None):
        """Get parents nodes."""
        if output_name_to_node is None:
            output_name_to_node = self._output_name_to_node

        parents = []
        for input in node.input:
            if input in output_name_to_node:
                parents.append(output_name_to_node[input])
        return parents

    def get_parent(self, node, idx, output_name_to_node=None):
        """Get parent node by idx."""
        if output_name_to_node is None:
            output_name_to_node = self._output_name_to_node

        if len(node.input) <= idx:
            return None

        input = node.input[idx]
        if input not in output_name_to_node:
            return None

        return output_name_to_node[input]

    def find_node_by_name(self, node_name, new_nodes_list, graph):
        """Find out node by name."""
        graph_nodes_list = list(graph.node)  # deep copy
        graph_nodes_list.extend(new_nodes_list)
        node = find_by_name(node_name, graph_nodes_list)
        return node

    def find_nodes_by_initializer(self, graph, initializer):
        """Find all nodes with given initializer as an input."""
        nodes = []
        for node in graph.node:
            for node_input in node.input:
                if node_input == initializer.name:
                    nodes.append(node)
        return nodes

    def get_scale_zero(self, tensor):
        """Help function to get scale and zero_point."""
        if not tensor.endswith("_quantized"):
            logger.debug(f"Find {tensor} in the quantized graph is not quantized.")
            return None, None

        def _searcher(tensor_name):
            """Search scale and zero point tensor recursively."""
            node = self._input_name_to_nodes[tensor_name][0]
            parent = self._output_name_to_node.get(tensor_name, None)
            direct_int8 = ["Reshape", "Transpose", "Squeeze", "Unsqueeze", "MaxPool", "Pad", "Split"]
            if parent is not None and parent.op_type in direct_int8:
                fp32_tensor_name = (
                    parent.input[0]
                    .replace("_quantized", "")
                    .replace("_QuantizeLinear", "")
                    .replace("_QuantizeInput", "")
                )
            elif node.op_type in ["Gather"]:  # pragma: no cover
                fp32_tensor_name = (
                    node.output[0]
                    .replace("_quantized", "")
                    .replace("_QuantizeLinear", "")
                    .replace("_QuantizeInput", "")
                )
            else:
                fp32_tensor_name = (
                    tensor_name.replace("_quantized", "").replace("_QuantizeLinear", "").replace("_QuantizeInput", "")
                )
            scale = fp32_tensor_name + "_scale"
            scale_tensor = self.get_initializer(scale)
            zo = fp32_tensor_name + "_zero_point"
            zo_tensor = self.get_initializer(zo)

            if scale_tensor is None or zo_tensor is None:
                if parent is not None:
                    scale_tensor, zo_tensor = _searcher(parent.input[0])
            return scale_tensor, zo_tensor

        node = self._input_name_to_nodes[tensor][0]
        # TODO check if scale_tensor and zero_point is needed
        # for bias of qlinearconv, scale and zero_point is not needed
        if (node.op_type == "QLinearConv" and tensor == node.input[-1]) or (
            node.op_type == "QGemm" and tensor == node.input[-3]
        ):
            return None, None
        else:
            scale_tensor, zo_tensor = _searcher(tensor)
            assert scale_tensor, f"missing scale for tensor {tensor}"
            assert zo_tensor, f"missing zero point for tensor {tensor}"
            return scale_tensor, zo_tensor

    def save_model_to_file(self, output_path, use_external_data_format=False):
        """Save model to external data, which is needed for model size > 2GB."""
        if use_external_data_format:
            onnx.external_data_helper.convert_model_to_external_data(
                self._model, all_tensors_to_one_file=True, location=Path(output_path).name + ".data"
            )
        onnx.save_model(self._model, output_path)

    @staticmethod
    def replace_node_input(node, old_input_name, new_input_name):
        """Replace input of a node."""
        assert isinstance(old_input_name, str) and isinstance(new_input_name, str)
        for j in range(len(node.input)):
            if node.input[j] == old_input_name:
                node.input[j] = new_input_name

    def replace_input_of_all_nodes(self, old_input_name, new_input_name, white_optype=None, black_optype=None):
        """Replace inputs of all nodes."""
        if white_optype is None:
            white_optype = []
        if black_optype is None:
            black_optype = []
        if len(white_optype) > 0:
            for node in self.model.graph.node:
                if node.op_type in white_optype:
                    ONNXModel.replace_node_input(node, old_input_name, new_input_name)
        else:
            for node in self.model.graph.node:
                if node.op_type not in black_optype:
                    ONNXModel.replace_node_input(node, old_input_name, new_input_name)

    @staticmethod
    def replace_node_output(node, old_output_name, new_output_name):
        """Replace output of a node."""
        assert isinstance(old_output_name, str) and isinstance(new_output_name, str)
        for j in range(len(node.output)):
            if node.output[j] == old_output_name:
                node.output[j] = new_output_name

    def replace_output_of_all_nodes(self, old_output_name, new_output_name, white_optype=None, black_optype=None):
        """Replace outputs of all nodes."""
        if white_optype is None:
            white_optype = []
        if black_optype is None:
            black_optype = []
        if len(white_optype) > 0:
            for node in self.model.graph.node:
                if node.op_type in white_optype:
                    ONNXModel.replace_node_output(node, old_output_name, new_output_name)
        else:
            for node in self.model.graph.node:
                if node.op_type not in black_optype:
                    ONNXModel.replace_node_output(node, old_output_name, new_output_name)

    def remove_unused_nodes(self):
        """Remove unused nodes."""
        unused_nodes = []
        nodes = self.nodes()
        for node in nodes:
            if (
                node.op_type == "Constant"
                and node.output[0] not in self._model.graph.output
                and node.output[0] not in self._input_name_to_nodes
            ):
                unused_nodes.append(node)
            elif (
                node.op_type == "QuantizeLinear"
                and len(self.get_children(node)) == 1
                and self.get_children(node)[0].op_type == "DequantizeLinear"
                and node.input[0] not in self._output_name_to_node
                and self.get_children(node)[0].output[0] not in self._input_name_to_nodes
            ):
                unused_nodes.append(node)
                unused_nodes.extend(self.get_children(node))
            else:
                # remove the node if it does not serve as the input or output of any other nodes
                unused = True
                for output in node.output:
                    if output in self._input_name_to_nodes or output in self.output():
                        unused = False
                        break
                for input in node.input:
                    if self.get_initializer(input) is not None:
                        continue
                    elif input in self._output_name_to_node or input in self.input():
                        unused = False
                        break
                if unused:
                    unused_nodes.append(node)
        self.remove_nodes(unused_nodes)

        ununsed_weights = []
        for w in self._model.graph.initializer:
            if w.name not in self._input_name_to_nodes and w.name not in self._model.graph.output:
                ununsed_weights.append(w)
                # Remove from graph.input
                for graph_input in self.graph().input:
                    if graph_input.name == w.name:
                        self.graph().input.remove(graph_input)

        self.remove_initializers(ununsed_weights)
        self.update()

    def topological_sort(self, enable_subgraph=False):
        """Topological sort the model."""

        if not enable_subgraph:
            input_name_to_nodes = {}
            output_name_to_node = {}
            for node in self.model.graph.node:
                for input_name in node.input:
                    if len(input_name.strip()) != 0:
                        if input_name not in input_name_to_nodes:
                            input_name_to_nodes[input_name] = [node]
                        else:
                            input_name_to_nodes[input_name].append(node)
                for output_name in node.output:
                    if len(output_name.strip()) != 0:
                        output_name_to_node[output_name] = node
        else:  # pragma: no cover
            input_name_to_nodes = self._input_name_to_nodes
            output_name_to_node = self._output_name_to_node

        all_nodes = {}
        q = deque()
        wait = deque()
        for inp in self.model.graph.input:
            q.extend(input_name_to_nodes[inp.name])
        for n in self.model.graph.node:
            if all(i not in output_name_to_node and i not in self.input() for i in n.input):
                q.append(n)

        while q:
            n = q.popleft()
            if not all(output_name_to_node[i].name in all_nodes for i in n.input if i in output_name_to_node):
                if n not in wait:
                    wait.append(n)
                continue

            all_nodes[n.name] = n
            for out in n.output:
                if out in input_name_to_nodes:
                    q.extend([i for i in input_name_to_nodes[out] if i.name not in all_nodes and i not in q])
            if len(q) == 0 and len(wait) != 0:
                q = copy.deepcopy(wait)
                wait.clear()
        nodes = [i[1] for i in all_nodes.items()]
        assert len(list({n.name for n in nodes})) == len(list({n.name for n in self.model.graph.node}))
        self.model.graph.ClearField("node")
        self.model.graph.node.extend(nodes)

    def get_nodes_chain(self, start, stop, result_chain=None):
        """Get nodes chain with given start node and stop node."""
        if result_chain is None:
            result_chain = []
        # process start node list
        start_node = deque()
        for node in start:
            if isinstance(node, str):
                start_node.append(node)
            elif isinstance(node, onnx.NodeProto):
                start_node.append(node.name)
            else:
                assert False, "'get_nodes_chain' function only support list[string]or list[NodeProto] params"  # noqa: B011

        # process stop node list
        stop_node = []
        for node in stop:
            if isinstance(node, str):
                stop_node.append(node)
            elif isinstance(node, onnx.NodeProto):
                stop_node.append(node.name)
            else:
                assert False, "'get_nodes_chain' function only support list[string]or list[NodeProto] params"  # noqa: B011

        while start_node:
            node_name = start_node.popleft()
            if node_name in stop_node:
                continue
            if node_name not in result_chain:
                result_chain.append(node_name)
            else:
                continue

            node = find_by_name(node_name, list(self.model.graph.node))
            for parent in self.get_parents(node):
                start_node.append(parent.name)

        return result_chain

    def find_split_node_for_layer_wise_quantization(self):
        """Find split node for layer wise quantization."""
        # find split nodes of decoder blocks
        # embed -> decoder.0 -(split_node)-> ... -(split_node)-> decoder.n -(split_node)-> norm -> head
        # after split: embed -> decoder.0,
        #              decoder.1,
        #              decoder.2,
        #              ...,
        #              decoder.n,
        #              norm -> head
        start_nodes = []
        for node in self._model.graph.node:
            start_node, qkv_nodes_list = None, None
            if node.op_type == "SkipLayerNormalization":
                start_node = node
                qkv_nodes_list = [
                    self.match_parent_path(
                        start_node,
                        ["MatMul", "Reshape", "Transpose", "Reshape", "MatMul"],
                        [None, 0, 0, 0, 0],
                    ),
                    self.match_parent_path(
                        start_node,
                        ["Add", "MatMul", "Reshape", "Transpose", "MatMul"],
                        [1, 1, 0, 0, 0],
                    ),
                ]
            if node.op_type == "Add":
                start_node = node
                qkv_nodes_list = [
                    # match base attention structure
                    self.match_parent_path(
                        start_node,
                        ["Add", "MatMul", "Reshape", "Transpose", "MatMul"],
                        [0, None, 0, 0, 0],
                    ),
                    self.match_parent_path(
                        start_node, ["Add", "MatMul", "Reshape", "Transpose", "MatMul"], [1, None, 0, 0, 0]
                    ),
                    # match gpt attention no past structure
                    self.match_parent_path(
                        start_node,
                        ["Reshape", "Gemm", "Reshape", "Reshape", "Transpose", "MatMul"],
                        [None, 0, 0, 0, 0, 0],
                        output_name_to_node=self.output_name_to_node,
                        return_indice=[],
                    ),
                    # match bart attention structure
                    self.match_parent_path(
                        start_node,
                        ["Add", "MatMul", "Reshape", "Transpose", "Reshape", "MatMul"],
                        [0, None, 0, 0, 0, 0],
                    ),
                    self.match_parent_path(
                        start_node,
                        ["Add", "MatMul", "Reshape", "Transpose", "Reshape", "MatMul"],
                        [1, None, 0, 0, 0, 0],
                    ),
                    self.match_parent_path(
                        start_node,
                        ["MatMul", "Mul", "MatMul", "Mul", "Div", "Add"],
                        [None, 0, None, 0, None, 0],
                    ),
                    self.match_parent_path(
                        start_node,
                        ["MatMul", "Mul", "MatMul", "SimplifiedLayerNormalization", "Add"],
                        [None, 0, None, 0, 0],
                    ),
                ]
            if not start_node:
                continue
            if not any(qkv_nodes_list):
                continue
            start_nodes.append(start_node)
        return start_nodes

    def find_qkv_in_attention(self, find_all=False):
        """Find qkv MatMul in Attention.

        Args:
            find_all (bool, optional): find all qkv MatMul. Defaults to False

        Returns:
            qkv (list): qkv MatMul list
        """
        qkv = []
        for node in self._model.graph.node:
            if node.op_type == "Attention":
                qkv.append([node.name])
                continue
            start_node, qkv_nodes_list = None, None
            if node.op_type == "SkipLayerNormalization":
                start_node = node
                qkv_nodes_list = [
                    self.match_parent_path(
                        start_node,
                        ["MatMul", "Reshape", "Transpose", "Reshape", "MatMul"],
                        [None, 0, 0, 0, 0],
                    ),
                    self.match_parent_path(
                        start_node,
                        ["Add", "MatMul", "Reshape", "Transpose", "MatMul"],
                        [1, 1, 0, 0, 0],
                    ),
                ]
            if node.op_type == "Add":
                start_node = node
                qkv_nodes_list = [
                    # match base attention structure
                    self.match_parent_path(
                        start_node,
                        ["Add", "MatMul", "Reshape", "Transpose", "MatMul"],
                        [0, None, 0, 0, 0],
                    ),
                    self.match_parent_path(
                        start_node, ["Add", "MatMul", "Reshape", "Transpose", "MatMul"], [1, None, 0, 0, 0]
                    ),
                    # match gpt attention no past structure
                    self.match_parent_path(
                        start_node,
                        ["Reshape", "Gemm", "Reshape", "Reshape", "Transpose", "MatMul"],
                        [None, 0, 0, 0, 0, 0],
                        output_name_to_node=self.output_name_to_node,
                        return_indice=[],
                    ),
                    # match bart attention structure
                    self.match_parent_path(
                        start_node,
                        ["Add", "MatMul", "Reshape", "Transpose", "Reshape", "MatMul"],
                        [0, None, 0, 0, 0, 0],
                    ),
                    self.match_parent_path(
                        start_node,
                        ["Add", "MatMul", "Reshape", "Transpose", "Reshape", "MatMul"],
                        [1, None, 0, 0, 0, 0],
                    ),
                ]
            if not start_node:
                continue
            if not any(qkv_nodes_list):
                continue
            qkv_nodes = [qkv for qkv in qkv_nodes_list if qkv is not None][-1]
            other_inputs = []
            for input in start_node.input:
                if input not in self.output_name_to_node:
                    continue
                if input == qkv_nodes[0].output[0]:
                    continue
                other_inputs.append(input)
            if len(other_inputs) != 1:
                continue
            root_input = other_inputs[0]
            input_name_to_nodes = self.input_name_to_nodes
            children = input_name_to_nodes[root_input]
            children_types = [child.op_type for child in children]
            if children_types.count("MatMul") == 3:
                qkv.append([child.name for child in children if child.op_type == "MatMul"])
                if not find_all:
                    break
        return qkv

    def find_ffn_matmul(self, attention_index, attention_matmul_list, block_len):
        """Find MatMul in FFN.

        Args:
            attention_index (list): index of Attention
            attention_matmul_list (list): list of Attention and MatMul nodes
            block_len (int): block length

        Returns:
            list: list of MatMul in FFN
        """
        ffn_matmul = []
        for idx in range(len(attention_index)):
            if idx != len(attention_index) - 1:
                index = attention_index[idx + 1]
                if index - 2 >= 0:
                    ffn_matmul.append([attention_matmul_list[index - 2], attention_matmul_list[index - 1]])
            else:
                index = attention_index[idx]
                if index + block_len - 1 < len(attention_matmul_list):
                    ffn_matmul.append(
                        [attention_matmul_list[index + block_len - 2], attention_matmul_list[index + block_len - 1]]
                    )
        return ffn_matmul

    def export(self, save_path, conf):
        """Export Qlinear to QDQ model."""
        from neural_compressor.config import ONNXQlinear2QDQConfig  # noqa: PLC0415
        from neural_compressor.utils.export import onnx_qlinear_to_qdq  # noqa: PLC0415

        if isinstance(conf, ONNXQlinear2QDQConfig):
            add_nodes, remove_nodes, inits = onnx_qlinear_to_qdq(self._model, self._input_name_to_nodes)
            self.add_nodes(add_nodes)
            self.remove_nodes(remove_nodes)
            self.add_initializers(inits)
            self.update()
            self.remove_unused_nodes()
            self.topological_sort()
            self.save(save_path)
        else:
            logger.warning("Unsupported config for export, only ONNXQlinear2QDQConfig is supported!")
            exit(0)

    def add_tensors_to_outputs(self, tensor_names):
        """Add the tensors to the model outputs to gets their values.

        Args:
            tensor_names: The names of tensors to be dumped.
        """
        added_outputs = []
        for tensor in tensor_names:
            if tensor not in self.output():
                added_tensor = onnx.helper.ValueInfoProto()
                added_tensor.name = tensor
                added_outputs.append(added_tensor)
        self._model.graph.output.extend(added_outputs)  # pylint: disable=no-member

    def remove_tensors_from_outputs(self, tensor_names):
        """Remove the tensors from the model outputs.

        Args:
            tensor_names: The names of tensors to be removed.
        """
        removed_outputs = []
        for tensor in tensor_names:
            if tensor in self.output():
                removed_outputs.append(self._model.graph.output[self.output().index(tensor)])
        for output in removed_outputs:
            self._model.graph.output.remove(output)

    def match_first_parent(self, node, parent_op_type, output_name_to_node, exclude=None):
        """Find parent node based on constraints on op_type.

        Args:
            node (str): current node name.
            parent_op_type (str): constraint of parent node op_type.
            output_name_to_node (dict): dictionary with output name as key, and node as value.
            exclude (list): list of nodes that are excluded (not allowed to match as parent).

        Returns:
            parent: The matched parent node. None if not found.
            index: The input index of matched parent node. None if not found.
        """
        if exclude is None:
            exclude = []
        for i, input in enumerate(node.input):
            if input in output_name_to_node:
                parent = output_name_to_node[input]
                if parent.op_type == parent_op_type and parent not in exclude:
                    return parent, i
        return None, None

    def match_parent(
        self,
        node,
        parent_op_type,
        input_index=None,
        output_name_to_node=None,
        exclude=None,
        return_indice=None,
    ):
        """Find parent node based on constraints on op_type and index.

        Args:
            node (str): current node name.
            parent_op_type (str): constraint of parent node op_type.
            input_index (int or None): only check the parent given input index of current node.
            output_name_to_node (dict): dictionary with output name as key, and node as value.
            exclude (list): list of nodes that are excluded (not allowed to match as parent).
            return_indice (list): a list to append the input index when input_index is None.

        Returns:
            parent: The matched parent node.
        """
        assert node is not None
        assert input_index is None or input_index >= 0
        if exclude is None:
            exclude = []
        if output_name_to_node is None:
            output_name_to_node = self._output_name_to_node

        if input_index is None:
            parent, index = self.match_first_parent(node, parent_op_type, output_name_to_node, exclude)
            if return_indice is not None:
                return_indice.append(index)
            return parent

        if input_index >= len(node.input):
            return None

        parent = self.get_parent(node, input_index, output_name_to_node)
        if parent is not None and parent.op_type == parent_op_type and parent not in exclude:
            return parent

        return None

    def match_parent_path(
        self,
        node,
        parent_op_types,
        parent_input_index,
        output_name_to_node=None,
        return_indice=None,
    ):
        """Find a sequence of input edges based on constraints on parent op_type and index.

        Args:
            node (str): current node name.
            parent_op_types (str): constraint of parent node op_type of each input edge.
            parent_input_index (list): constraint of input index of each input edge.
                                       None means no constraint.
            output_name_to_node (dict): dictionary with output name as key, and node as value.
            return_indice (list): a list to append the input index when there is
                                  no constraint on input index of an edge.

        Returns:
            parents: a list of matched parent node.
        """
        assert len(parent_input_index) == len(parent_op_types)

        if output_name_to_node is None:
            output_name_to_node = self._output_name_to_node

        current_node = node
        matched_parents = []
        for i, op_type in enumerate(parent_op_types):
            matched_parent = self.match_parent(
                current_node,
                op_type,
                parent_input_index[i],
                output_name_to_node,
                exclude=[],
                return_indice=return_indice,
            )
            if matched_parent is None:
                return None

            matched_parents.append(matched_parent)
            current_node = matched_parent

        return matched_parents

    def is_smoothquant_model(self):
        """Check the model is smooth quantized or not.

        Returns:
            bool: the model is smooth quantized or not.
        """
        for init in self.model.graph.initializer:  # noqa: SIM110
            if "_smooth_scale" in init.name:
                return True
        return False

    def find_split_nodes(self):
        """Find split nodes for layer-wise quantization."""
        split_nodes = self.find_split_node_for_layer_wise_quantization()
        return split_nodes

    def split_model_with_node(
        self, split_node_name, path_of_model_to_split, shape_infer=True, save_both_split_models=True
    ):
        """Split model into two parts at a given node.

        Args:
            split_node_name (str): name of the node where the model is split at>
            path_of_model_to_split (str): path of model to be split.
            shape_infer (bool): do shape inference. Default is True.
            save_both_split_models (bool): whether to save the two split models.
                False means only save the first split model.
                True means save both the two split models.
                Default id True.

        Returns:
            tuple: the first split model, the second split model
        """
        # origin model : ... -> node_1 -> split_node -> node_2 -> ...
        # split model 1: ... -> node_1 -> split_node
        # split model 2: node_2 -> ...

        split_model_part_1 = onnx.ModelProto()
        split_model_part_1.CopyFrom(self._model)
        split_model_part_1.graph.ClearField("node")

        split_model_part_2 = onnx.ModelProto()
        split_model_part_2.CopyFrom(self._model)
        split_model_part_2.graph.ClearField("node")

        split_node_output = None
        part_idx = 1
        for node in self._model.graph.node:
            if part_idx == 1:
                split_model_part_1.graph.node.append(node)
            elif part_idx == 2:
                split_model_part_2.graph.node.append(node)

            if node.name == split_node_name:
                split_node_output = node.output
                part_idx = 2

        assert len(split_node_output) == 1, (
            f"Only support split at node with 1 output tensor, while current split node {split_node_name} has {len(split_node_output)} output tensors"
        )
        split_tensor_name = split_node_output[0]

        # infer shape of the model to be split
        if shape_infer:
            try:
                from neural_compressor.adaptor.ox_utils.util import infer_shapes  # noqa: PLC0415

                self._model = infer_shapes(self._model, auto_merge=True, base_dir=os.path.dirname(self._model_path))
            except Exception as e:  # pragma: no cover
                logger.error(
                    "Shape infer fails for layer-wise quantization. "
                    "We would recommend checking the graph optimization level of your model "
                    "and setting it to 'DISABLE_ALL' or 'ENABLE_BASIC', "
                    "as this may help avoid this error."
                )
                raise e

        split_tensor_type, split_tensor_shape = self._get_output_type_shape_by_tensor_name(split_tensor_name)
        split_tensor = onnx.helper.make_tensor_value_info(split_tensor_name, split_tensor_type, split_tensor_shape)

        split_model_part_1 = ONNXModel(split_model_part_1, ignore_warning=True)
        split_model_part_2 = ONNXModel(split_model_part_2, ignore_warning=True)

        # remove unused input & output
        split_model_part_1._remove_unused_input_output()
        split_model_part_2._remove_unused_input_output()

        split_model_part_1.model.graph.output.append(split_tensor)
        split_model_part_2.model.graph.input.append(split_tensor)

        insert_output_for_model_1 = []
        insert_input_for_model_2 = []
        for output in split_model_part_1.output_name_to_node:
            if output in split_model_part_2.input_name_to_nodes:
                output_type, output_shape = self._get_output_type_shape_by_tensor_name(output)
                output_tensor = onnx.helper.make_tensor_value_info(output, output_type, output_shape)
                if output_tensor not in split_model_part_1.model.graph.output:
                    insert_output_for_model_1.append(output_tensor)
                if output_tensor not in split_model_part_2.model.graph.input:
                    insert_input_for_model_2.append(output_tensor)

        # insert model 1 output
        for output in insert_output_for_model_1:
            split_model_part_1.model.graph.output.append(output)

        # insert model 2 input
        for input in insert_input_for_model_2:
            split_model_part_2.model.graph.input.append(input)

        # remove unused init
        split_model_part_1.remove_unused_init()
        split_model_part_2.remove_unused_init()

        split_model_part_1.update()
        split_model_part_2.update()

        dir_of_model_to_split = os.path.dirname(path_of_model_to_split)

        split_model_part_1.load_model_initializer_by_tensor(dir_of_model_to_split)
        split_model_part_1_path = os.path.join(dir_of_model_to_split, "split_model_part_1.onnx")
        split_model_part_1.model_path = split_model_part_1_path
        split_model_part_1._save_split_model(split_model_part_1_path)
        split_model_part_1.check_is_large_model()
        logger.debug(f"save split model part 1 to {split_model_part_1_path} for layer wise quantization")

        if save_both_split_models:
            split_model_part_2.load_model_initializer_by_tensor(dir_of_model_to_split)
            split_model_part_2_path = os.path.join(dir_of_model_to_split, "split_model_part_2.onnx")
            split_model_part_2.model_path = split_model_part_2_path
            split_model_part_2._save_split_model(split_model_part_2_path)
            split_model_part_2.check_is_large_model()
            logger.debug(f"save split model part 2 to {split_model_part_2_path} for layer wise quantization")
            return split_model_part_1, split_model_part_2
        else:
            return split_model_part_1, split_model_part_2

    def _save_split_model(self, save_path):
        """Save split model as external data for layer wise quantization.

        Args:
            save_path (str): the path to save the split model
        """
        if os.path.exists(save_path + "_data"):
            os.remove(save_path + "_data")
        onnx.save_model(
            self._model,
            save_path,
            save_as_external_data=True,
            all_tensors_to_one_file=True,
            location=save_path.split("/")[-1] + "_data",
            size_threshold=1024,
            convert_attribute=False,
        )

    def _get_output_type_shape_by_tensor_name(self, tensor_name):
        """Get output type and shape with a tensor name.

        Args:
            tensor_name (str): name of a tensor

        Returns:
            tuple: output type and shape
        """
        elem_type = onnx.TensorProto.FLOAT
        shape = None
        for output in self._model.graph.value_info:
            if output.name == tensor_name:
                elem_type = output.type.tensor_type.elem_type
                shape = [
                    dim.dim_value if dim.HasField("dim_value") else -1 for dim in output.type.tensor_type.shape.dim
                ]
                break
        return elem_type, shape

    def _remove_unused_input_output(self):
        """Remove unused input & output for split model."""
        remove_outputs = []
        remove_inputs = []
        for output in self._model.graph.output:
            if output.name not in self.output_name_to_node:
                remove_outputs.append(output)

        for input in self._model.graph.input:
            if input.name not in self.input_name_to_nodes:
                remove_inputs.append(input)

        for output in remove_outputs:
            self._model.graph.output.remove(output)
        for input in remove_inputs:
            self._model.graph.input.remove(input)

    def remove_unused_init(self):
        """Remove unused init."""
        remov_inits = []
        for init in self._model.graph.initializer:
            if init.name not in self.input_name_to_nodes:
                remov_inits.append(init)
        self.remove_initializers(remov_inits)

    def load_model_initializer_by_tensor(self, data_path=None):
        """Load model initializer by tensor.

        Args:
            data_path (str, optional): the directory of saved initializer. Defaults to None.
        """
        if data_path is None:
            data_path = os.path.dirname(self._model_path)
        for init in self._model.graph.initializer:
            if init.HasField("data_location") and init.data_location == onnx.TensorProto.EXTERNAL:
                onnx.external_data_helper.load_external_data_for_tensor(init, data_path)

    def write_external_data_to_new_location(self, external_data_location="external.data", overwrite=False):
        """Write external data of merged quantized model to new location to save memory.

        Args:
            external_data_location (str, optional): external data location of merged quantized model.
                                                    Defaults to "external.data".
            overwrite (bool, optional): if True, remove existed externa data. Defaults to False.
        """
        if overwrite and os.path.exists(os.path.join(os.path.dirname(self._model_path), external_data_location)):
            os.remove(os.path.join(os.path.dirname(self._model_path), external_data_location))
        self.load_model_initializer_by_tensor()
        onnx.external_data_helper.convert_model_to_external_data(self._model, location=external_data_location)
        # TODO : if init is already saved, skip write it
        onnx.external_data_helper.write_external_data_tensors(self._model, filepath=os.path.dirname(self._model_path))

    def merge_split_models(self, to_merge_model):
        """Merge two split model into final model."""
        to_merge_model.write_external_data_to_new_location()
        self.add_nodes(list(to_merge_model.nodes()))
        self.add_initializers(list(to_merge_model.initializer()))
        self.update()

        # add new output
        for output in to_merge_model.graph().output:
            if output.name not in self.output():
                self._model.graph.output.append(output)

        # remove unused output
        remove_output = []
        for output in self._model.graph.output:
            if output.name in to_merge_model.input():
                remove_output.append(output)
        for output in remove_output:
            self._model.graph.output.remove(output)

        # add new input
        for input in to_merge_model.graph().input:
            if (
                input.name not in self.input()
                and input.name not in self.output()
                and input.name not in self.output_name_to_node
            ):
                self._model.graph.input.append(input)

    def re_org_output(self, origin_output):
        """Re-org output of merged model for layer-wise quantization."""
        outputs = {}
        tmp_remove = []
        for output in self._model.graph.output:
            outputs[output.name] = output
            tmp_remove.append(output)

        for output in tmp_remove:
            self._model.graph.output.remove(output)

        for out_name in origin_output:
            self._model.graph.output.append(outputs[out_name])
