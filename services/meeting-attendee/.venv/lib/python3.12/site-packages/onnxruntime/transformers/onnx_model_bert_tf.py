# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

import logging

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper
from onnx_model_bert import BertOnnxModel

logger = logging.getLogger(__name__)


class BertOnnxModelTF(BertOnnxModel):
    def __init__(self, model, num_heads, hidden_size):
        super().__init__(model, num_heads, hidden_size)

    def remove_identity(self):
        nodes_to_remove = []
        for node in self.nodes():
            if node.op_type == "Identity":
                if not self.find_graph_output(node.output[0]):
                    self.replace_input_of_all_nodes(node.output[0], node.input[0])
                    nodes_to_remove.append(node)
        self.remove_nodes(nodes_to_remove)
        logger.info(f"Removed Identity count: {len(nodes_to_remove)}")

    def match_mask_path(self, add_or_sub_before_softmax):
        mask_nodes = self.match_parent_path(
            add_or_sub_before_softmax,
            ["Mul", "Sub", "Reshape", "Cast"],
            [1, None, 1, 0],
        )
        if mask_nodes is not None:
            return mask_nodes

        mask_nodes = self.match_parent_path(
            add_or_sub_before_softmax,
            ["Mul", "Sub", "Cast", "Slice", "Unsqueeze"],
            [1, 0, 1, 0, 0],
        )
        if mask_nodes is not None:
            return mask_nodes

        mask_nodes = self.match_parent_path(
            add_or_sub_before_softmax,
            ["Mul", "Sub", "Cast", "Unsqueeze", "Unsqueeze"],
            [1, None, 1, 0, 0],
        )

        return mask_nodes

    def get_2d_initializers_from_parent_subgraphs(self, current_node):
        """
        Find initializers that is 2D. Returns a dictionary with name as key and shape as value.
        """
        parent_nodes = self.get_parent_subgraph_nodes(current_node, [])
        initializers = {}
        for node in parent_nodes:
            for input in node.input:
                initializer = self.get_initializer(input)
                if initializer:
                    temp = numpy_helper.to_array(initializer)
                    if len(temp.shape) == 2:
                        initializers[initializer.name] = temp.shape

        return initializers

    def find_segment_ids(self, segment_embedding, input_ids):
        input_name_to_nodes = self.input_name_to_nodes()
        if segment_embedding not in input_name_to_nodes:
            return None

        nodes = input_name_to_nodes[segment_embedding]
        if len(nodes) != 1:
            return None

        graph_inputs = self.get_graph_inputs(nodes[0], recursive=True)
        if len(graph_inputs) > 1:
            print("Found multiple candidates of segment_ids", graph_inputs)
            return None
        # Find segment ids in graph inputs. The segment id input must not be the same as input_ids.
        if len(graph_inputs) == 1 and graph_inputs[0] != input_ids:
            return graph_inputs[0]

        # If the segment id candidate is the same as the input_ids, try to assign alternative segment ids and simplify the graph if needed.
        segment_ids = nodes[0].input[1]
        _, segment_id_path, _ = self.match_parent_paths(
            nodes[0],
            [
                (
                    ["ConstantOfShape", "Cast", "Concat", "Slice", "Cast", "Shape"],
                    [1, 0, 0, 0, 0, 0],
                ),
                (
                    [
                        "ConstantOfShape",
                        "Cast",
                        "Concat",
                        "Unsqueeze",
                        "Squeeze",
                        "Slice",
                        "Cast",
                        "Shape",
                    ],
                    [1, 0, 0, 0, 0, 0, 0, 0],
                ),
            ],
            None,
        )

        if segment_id_path and input_ids and input_ids == segment_id_path[-1].input[0]:
            logger.debug("Simplify semgent id path...")
            constantofshape_node = segment_id_path[0]
            graph_name = self.get_graph_by_node(constantofshape_node).name
            self.add_node(
                helper.make_node("Shape", inputs=[input_ids], outputs=["input_shape"]),
                graph_name,
            )
            constantofshape_value = helper.get_attribute_value(constantofshape_node.attribute[0])
            self.add_node(
                helper.make_node(
                    "ConstantOfShape",
                    inputs=["input_shape"],
                    outputs=["zeros_for_input_shape"],
                    value=constantofshape_value,
                ),
                graph_name,
            )
            segment_ids = "zeros_for_input_shape"
        return segment_ids

    def find_input_ids(self, word_embedding):
        input_name_to_nodes = self.input_name_to_nodes()
        if word_embedding not in input_name_to_nodes:
            return None

        nodes = input_name_to_nodes[word_embedding]
        if len(nodes) != 1:
            return None

        graph_inputs = self.get_graph_inputs(nodes[0], recursive=True)
        if len(graph_inputs) == 1:
            return graph_inputs[0]

        print("Found multiple candidates of input_ids", graph_inputs)
        return None

    def find_mask_input(self, excluded_graph_inputs):
        for node in self.nodes():
            if node.op_type == "Softmax":
                mask_path = self.match_parent_path(
                    node,
                    ["Add", "Mul", "Sub", "Cast", "Slice", "Unsqueeze"],
                    [0, 1, None, 1, 0, 0],
                )
                if mask_path is None:
                    continue
                (
                    add_node,
                    mul_node,
                    sub_node,
                    cast_node,
                    slice_node,
                    unsqueeze_node,
                ) = mask_path
                if self.has_constant_input(mul_node, -10000) and self.has_constant_input(sub_node, 1):
                    graph_inputs = self.get_graph_inputs(sub_node, recursive=True)
                    inputs = [input for input in graph_inputs if input not in excluded_graph_inputs]
                    if len(inputs) > 1:
                        print("Found multiple candidates of mask input", inputs)
                        return None
                    if len(inputs) == 1:
                        return inputs[0]
                    # Duplicated input found. Try to simplify the graph.
                    path_to_be_simplified = self.match_parent_path(
                        mask_path[-1],
                        [
                            "ConstantOfShape",
                            "Cast",
                            "Concat",
                            "Unsqueeze",
                            "Squeeze",
                            "Slice",
                            "Cast",
                            "Shape",
                        ],
                        [0, 0, 0, 0, 0, 0, 0, 0],
                    )
                    duplicated_inputs = [input for input in graph_inputs if input in excluded_graph_inputs]
                    # Simplify graph for dynamic axes.
                    if (
                        path_to_be_simplified
                        and duplicated_inputs
                        and len(duplicated_inputs) == 1
                        and duplicated_inputs[0] == path_to_be_simplified[-1].input[0]
                    ):
                        logger.debug("Simplify semgent id path...")
                        constantofshape_node = path_to_be_simplified[0]
                        constantofshape_value = helper.get_attribute_value(constantofshape_node.attribute[0])
                        graph_name = self.get_graph_by_node(constantofshape_node).name
                        self.add_node(
                            helper.make_node(
                                "Shape",
                                inputs=[duplicated_inputs[0]],
                                outputs=["input_shape_for_mask"],
                            ),
                            graph_name,
                        )
                        self.add_node(
                            helper.make_node(
                                "ConstantOfShape",
                                inputs=["input_shape_for_mask"],
                                outputs=[unsqueeze_node.input[0]],
                                value=constantofshape_value,
                            ),
                            graph_name,
                        )
                    return unsqueeze_node.input[0]
        return None

    def create_embedding_subgraph(self, normalize_node, word_embedding, segment_embedding, position_embedding):
        input_ids = self.find_input_ids(word_embedding)
        if input_ids is None:
            logger.info("Failed to find input_ids. Cannot fuse embedding layer.")
            return False

        segment_ids = self.find_segment_ids(segment_embedding, input_ids)
        if segment_ids is None:
            logger.info("Failed to find segment_ids. Cannot fuse embedding layer.")
            return False

        mask_input = self.find_mask_input([segment_ids, input_ids])
        if mask_input is None:
            logger.info("Failed to find input_mask. Cannot fuse embedding layer.")
            return False

        self.bert_inputs = [input_ids, segment_ids, mask_input]

        mask_index = self.create_node_name("mask_index")
        self.attention_mask.set_mask_indice(mask_input, mask_index)

        if self.find_graph_input(input_ids).type.tensor_type.elem_type != TensorProto.INT32:
            casted, input_ids = self.utils.cast_graph_input_to_int32(input_ids)

        if self.find_graph_input(segment_ids):
            casted, segment_ids = self.utils.cast_graph_input_to_int32(segment_ids)
        else:
            segment_ids, segment_id_cast_node = self.utils.cast_input_to_int32(segment_ids)

        if self.find_graph_input(mask_input):
            casted, mask_input = self.utils.cast_graph_input_to_int32(mask_input)
        else:
            mask_input, mask_input_cast_node = self.utils.cast_input_to_int32(mask_input)

        embed_output = self.create_node_name("embed_output")
        embed_node = onnx.helper.make_node(
            "EmbedLayerNormalization",
            inputs=[
                input_ids,
                segment_ids,
                word_embedding,
                position_embedding,
                segment_embedding,
                normalize_node.input[1],  # gamma
                normalize_node.input[2],  # beta
                mask_input,
            ],
            outputs=[embed_output, mask_index],
            name="EmbedLayer",
        )
        embed_node.domain = "com.microsoft"
        self.replace_input_of_all_nodes(normalize_node.output[0], embed_output)
        self.add_node(embed_node, self.get_graph_by_node(normalize_node).name)

    def process_embedding(self):
        """
        Automatically detect word, segment and position embeddings.
        """
        logger.info("start processing embedding layer...")
        output_name_to_node = self.output_name_to_node()

        layer_norm_nodes = self.get_nodes_by_op_type("LayerNormalization")
        for layer_norm_node in layer_norm_nodes:
            pos_embed_path = self.match_parent_path(
                layer_norm_node,
                ["Add", "Reshape", "Slice"],
                [0, 1, 0],
                output_name_to_node,
            )
            if pos_embed_path is None:
                continue

            add_node, reshape_node, slice_node = pos_embed_path
            initializer = self.get_initializer(slice_node.input[0])
            if initializer is None:
                continue

            temp = numpy_helper.to_array(initializer)
            if len(temp.shape) == 2:
                logger.info(f"Found position embedding. name:{initializer.name}, shape:{temp.shape}")
                position_embedding = initializer.name
            else:
                logger.info(f"Failed to find position embedding. name:{initializer.name}, shape:{temp.shape}")
                return

            first_parent = self.get_parent(add_node, 0, output_name_to_node)
            if first_parent is not None and first_parent.op_type == "Add":
                embeddings = self.get_2d_initializers_from_parent_subgraphs(first_parent)
                if len(embeddings) != 2:
                    logger.warning(
                        f"Failed to find two embeddings (word and segment) from Add node. Found {embeddings}"
                    )
                    return

                word_embedding = None
                segment_embedding = None
                for name, shape in embeddings.items():
                    if shape[0] == 2:
                        segment_embedding = name
                        logger.info(f"Found segment embedding. name:{name}, shape:{shape}")
                    else:
                        word_embedding = name
                        logger.info(f"Found words embedding. name:{name}, shape:{shape}")

                if word_embedding is None or segment_embedding is None:
                    logger.info("Failed to find both word and segment embedding")
                    return

                logger.info("Create Embedding node")
                self.create_embedding_subgraph(
                    layer_norm_node,
                    word_embedding,
                    segment_embedding,
                    position_embedding,
                )
                # Prune graph to remove those original embedding nodes.
                self.prune_graph()
                break

    def check_attention_input(self, matmul_q, matmul_k, matmul_v, parent, output_name_to_node):
        for x in [matmul_q, matmul_k, matmul_v]:
            root_input = x.input[0]
            root_node = output_name_to_node[root_input]
            if root_node == parent:
                continue
            logger.debug(f"Check attention input failed:{root_input}, {parent.output[0]}")
            return False

        return True

    def fuse_attention(self):
        output_name_to_node = self.output_name_to_node()

        nodes_to_remove = []
        attention_count = 0

        start_nodes = []
        skip_layer_norm_nodes = self.get_nodes_by_op_type("SkipLayerNormalization")
        layer_norm_nodes = self.get_nodes_by_op_type("LayerNormalization")
        # Sometimes we can not fuse skiplayernormalization since the add before layernorm has an output that used by nodes outside skiplayernorm
        # Conceptually we treat add before layernorm as skiplayernorm node since they share the same pattern
        start_nodes.extend(skip_layer_norm_nodes)
        start_nodes.extend(layer_norm_nodes)

        for normalize_node in start_nodes:
            graph_name = self.get_graph_by_node(normalize_node).name
            # SkipLayerNormalization has two inputs, and one of them is the root input for attention.
            if normalize_node.op_type == "LayerNormalization":
                add_before_layernorm = self.match_parent(normalize_node, "Add", 0)
                if add_before_layernorm is not None:
                    normalize_node = add_before_layernorm  # noqa: PLW2901
                else:
                    continue
            parent = self.get_parent(normalize_node, 1)
            if parent is None or parent.op_type not in [
                "SkipLayerNormalization",
                "LayerNormalization",
                "Reshape",
            ]:
                parent = self.get_parent(normalize_node, 0)
                if parent is None or parent.op_type not in [
                    "SkipLayerNormalization",
                    "LayerNormalization",
                    "Reshape",
                ]:
                    logger.debug("Failed to match parent of normalize_node")
                    continue

            qkv_nodes = self.match_parent_path(
                normalize_node,
                ["Add", "MatMul", "Reshape", "Transpose", "MatMul"],
                [0, 0, 0, 0, 0],
            )
            if qkv_nodes is None:
                qkv_nodes = self.match_parent_path(
                    normalize_node,
                    ["MatMul", "Reshape", "Transpose", "MatMul"],
                    [1, 0, 0, 0],
                )
                if qkv_nodes is None:
                    qkv_nodes = self.match_parent_path(normalize_node, ["Add", "Einsum", "Einsum"], [0, 0, 0])
                    if qkv_nodes is None:
                        logger.debug("Failed to match qkv nodes")
                        continue

            matmul_qkv = qkv_nodes[-1]
            v_nodes = self.match_parent_path(matmul_qkv, ["Transpose", "Reshape", "Add", "MatMul"], [1, 0, 0, 0])
            if v_nodes is None:
                v_nodes = self.match_parent_path(matmul_qkv, ["Add", "Einsum"], [1, 0])
                if v_nodes is None:
                    logger.debug("Failed to match v path")
                    continue

            add_v = v_nodes[-2]
            matmul_v = v_nodes[-1]
            qk_nodes = self.match_parent_path(matmul_qkv, ["Softmax", "Add", "Mul", "MatMul"], [0, 0, 0, 0])
            if qk_nodes is None:
                qk_nodes = self.match_parent_path(matmul_qkv, ["Softmax", "Add", "Einsum"], [0, 0, 0])
                if qk_nodes is None:
                    logger.debug("Failed to match qk_paths")
                    continue
            matmul_qk = qk_nodes[-1]

            q_nodes = self.match_parent_path(matmul_qk, ["Transpose", "Reshape", "Add", "MatMul"], [0, 0, 0, 0])
            if q_nodes is None:
                q_nodes = self.match_parent_path(matmul_qk, ["Add", "Einsum"], [0, 0])
                if q_nodes is None:
                    logger.debug("Failed to match q path")
                    continue

            add_q = q_nodes[-2]
            matmul_q = q_nodes[-1]

            k_nodes = self.match_parent_path(matmul_qk, ["Transpose", "Reshape", "Add", "MatMul"], [1, 0, 0, 0])
            if k_nodes is None:
                k_nodes = self.match_parent_path(matmul_qk, ["Mul", "Add", "Einsum"], [1, 0, 0])
                if k_nodes is None:
                    logger.debug("Failed to match k path")
                    continue
            add_k = k_nodes[-2]
            matmul_k = k_nodes[-1]

            mask_nodes = self.match_mask_path(qk_nodes[1])

            if mask_nodes is None:
                logger.debug("Cannot find mask_nodes.")
                continue

            if not self.has_constant_input(mask_nodes[1], 1):
                logger.debug("Sub node expected to have an input with constant value 1.0.")
                continue

            # add a squeeze node to convert a 3-d mask to 2-d
            squeeze_node = self.match_parent_path(mask_nodes[-1], ["Squeeze"], [0]) or self.match_parent_path(
                mask_nodes[-1], ["Expand"], [0]
            )
            squeeze_node_name = "Squeeze_3d_to_2d_mask"
            squeeze_output_name = squeeze_node_name + "_output"
            if squeeze_node is None and len(mask_nodes) == 5 and self.find_graph_input(mask_nodes[-1].input[0]) is None:
                mask_input = mask_nodes[-1].input[1]
                self.add_node(
                    helper.make_node(
                        "Squeeze",
                        [mask_input],
                        [squeeze_output_name],
                        squeeze_node_name,
                        axes=[1],
                    ),
                    graph_name,
                )
                mask_nodes[-1].input[0] = squeeze_output_name

            is_same_root = self.check_attention_input(matmul_q, matmul_k, matmul_v, parent, output_name_to_node)
            if is_same_root:
                mask_index = self.attention_mask.process_mask(mask_nodes[-1].input[0])
                logger.debug("Create an Attention node.")

                # For tf models, q and v are flipped.
                attention_node = self.attention_fusion.create_attention_node(
                    mask_index=mask_index,
                    q_matmul=matmul_k,
                    k_matmul=matmul_q,
                    v_matmul=matmul_v,
                    q_add=add_k,
                    k_add=add_q,
                    v_add=add_v,
                    num_heads=self.num_heads,
                    hidden_size=self.hidden_size,
                    first_input=parent.output[0],
                    output=qkv_nodes[2].output[0],
                )
                if attention_node is None:
                    continue

                if qkv_nodes[1].op_type == "Einsum":
                    # add reshape before einsum
                    tensor = helper.make_tensor(
                        name=qkv_nodes[1].name + "_newshape",
                        data_type=TensorProto.INT64,
                        dims=[4],
                        vals=np.int64(
                            [
                                [
                                    0,
                                    0,
                                    self.num_heads,
                                    int(self.hidden_size / self.num_heads),
                                ]
                            ]
                        ).tobytes(),
                        raw=True,
                    )
                    self.add_initializer(tensor, graph_name)
                    reshape_ = helper.make_node(
                        "Reshape",
                        inputs=[
                            attention_node.output[0],
                            qkv_nodes[1].name + "_newshape",
                        ],
                        outputs=[qkv_nodes[1].name + "_reshape_output"],
                        name=qkv_nodes[1].name + "_reshape",
                    )
                    qkv_nodes[1].input[0] = qkv_nodes[1].name + "_reshape_output"
                    self.add_node(reshape_, graph_name)
                if parent.op_type == "Reshape":
                    # Temporary work around: we require the skiplayernorm and attention op be fed with 3-d input
                    hidden_size = numpy_helper.to_array(self.get_initializer(parent.input[1]))[1]
                    tensor = helper.make_tensor(
                        name=parent.name + "_modified",
                        data_type=TensorProto.INT64,
                        dims=[3],
                        vals=np.int64([[1, -1, hidden_size]]).tobytes(),
                        raw=True,
                    )
                    self.add_initializer(tensor, graph_name)
                    parent.input[1] = parent.name + "_modified"

                self.add_node(attention_node, graph_name)
                attention_count += 1

                nodes_to_remove.extend(qkv_nodes[2:])
                nodes_to_remove.extend(qk_nodes)
                nodes_to_remove.extend(q_nodes)
                nodes_to_remove.extend(k_nodes)
                nodes_to_remove.extend(v_nodes)
                nodes_to_remove.extend(mask_nodes)
            else:
                logger.debug("Root node not matched.")
                continue
        self.remove_nodes(nodes_to_remove)
        self.update_graph()
        logger.info(f"Fused Attention count:{attention_count}")

    def preprocess(self):
        self.remove_identity()
        self.process_embedding()
        self.skip_reshape()

    def skip_reshape(self):
        count = 0
        reshape_nodes = self.get_nodes_by_op_type("Reshape")
        for reshape_node in reshape_nodes:
            parent = self.get_parent(reshape_node, 0)
            if parent is not None and parent.op_type == "Reshape":
                reshape_node.input[0] = parent.input[0]
                count += 1

        if count > 0:
            logger.info(f"Skip consequent Reshape count: {count}")

    def remove_reshape_before_first_attention(self):
        attention_nodes = self.get_nodes_by_op_type("Attention")
        for attention_node in attention_nodes:
            path = self.match_parent_path(attention_node, ["Reshape", "EmbedLayerNormalization"], [0, 0])
            if path is None:
                continue
            logger.info("Remove Reshape before first Attention node.")
            reshape, _ = path
            self.replace_input_of_all_nodes(reshape.output[0], reshape.input[0])
            self.remove_node(reshape)
            break

    def postprocess(self):
        self.remove_reshape_before_first_attention()
        self.prune_graph()
