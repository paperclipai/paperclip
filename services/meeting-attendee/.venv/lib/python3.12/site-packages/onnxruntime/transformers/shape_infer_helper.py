# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

import logging
import os
import sys

# In ORT Package the symbolic_shape_infer.py is in ../tools
file_path = os.path.dirname(__file__)
if os.path.exists(os.path.join(file_path, "../tools/symbolic_shape_infer.py")):
    sys.path.append(os.path.join(file_path, "../tools"))
else:
    sys.path.append(os.path.join(file_path, ".."))

from symbolic_shape_infer import SymbolicShapeInference, get_shape_from_type_proto, sympy  # noqa: E402

logger = logging.getLogger(__name__)


class SymbolicShapeInferenceHelper(SymbolicShapeInference):
    def __init__(self, model, verbose=0, int_max=2**31 - 1, auto_merge=True, guess_output_rank=False):
        super().__init__(int_max, auto_merge, guess_output_rank, verbose)
        self.model_ = model
        self.all_shapes_inferred_: bool = False
        self.is_inferred_: bool = False
        self.dynamic_axis_mapping_: dict[str, int] = {}

    def infer(self, dynamic_axis_mapping: dict[str, int], max_runs: int = 200):
        """Run shape inference, and try replace dynamic axis from string to integer when mapping is provided.

        Args:
            dynamic_axis_mapping (_type_): a dictionary with name of dynamic axis as key, like {"batch_size" : 4}
            max_runs (int, optional): limit maximum number of runs to avoid infinite loop. Defaults to 200.

        Returns:
            bool: whether all shapes has been inferred or not.
        """
        assert dynamic_axis_mapping is not None

        if self.is_inferred_ and self.dynamic_axis_mapping_ == dynamic_axis_mapping:
            return self.all_shapes_inferred_

        self.dynamic_axis_mapping_ = dynamic_axis_mapping

        self._preprocess(self.model_)

        count = 0
        while self.run_:
            logger.debug(f"shape infer run {count}")
            self.all_shapes_inferred_ = self._infer_impl()
            count += 1
            if max_runs > 0 and count >= max_runs:
                break

        self.is_inferred_ = True
        return self.all_shapes_inferred_

    def _get_sympy_shape(self, node, idx):
        """Override it to ensure shape inference by giving the actual value of dynamic axis."""
        sympy_shape = []

        shape = self._get_shape(node, idx)
        if shape:
            for dim in shape:
                if isinstance(dim, str):
                    if dim in self.dynamic_axis_mapping_:
                        sympy_shape.append(self.dynamic_axis_mapping_[dim])
                    elif dim in self.symbolic_dims_:
                        sympy_shape.append(self.symbolic_dims_[dim])
                    else:
                        sympy_shape.append(sympy.Symbol(dim, integer=True))
                else:
                    assert dim is not None
                    sympy_shape.append(dim)
        return sympy_shape

    def get_edge_shape(self, edge):
        """Get shape of an edge.

        Args:
            edge (str): name of edge

        Returns:
            Optional[List[int]]: the shape, or None if shape is unknown
        """
        assert self.all_shapes_inferred_
        if edge not in self.known_vi_:
            print("Cannot retrieve the shape of " + str(edge))
            return None

        type_proto = self.known_vi_[edge].type
        shape = get_shape_from_type_proto(type_proto)

        if shape is not None:
            for i, dim in enumerate(shape):
                if isinstance(dim, str) and dim in self.dynamic_axis_mapping_:
                    shape[i] = self.dynamic_axis_mapping_[dim]

        return shape

    def compare_shape(self, edge, edge_other):
        """Compare shape of two edges.

        Args:
            edge (str): name of edge
            edge_other (str): name of another edge

        Raises:
            Exception: At least one shape is missed for edges to compare

        Returns:
            bool: whether the shape is same or not
        """
        assert self.all_shapes_inferred_
        shape = self.get_edge_shape(edge)
        shape_other = self.get_edge_shape(edge_other)
        if shape is None or shape_other is None:
            raise Exception("At least one shape is missed for edges to compare")
        return shape == shape_other
