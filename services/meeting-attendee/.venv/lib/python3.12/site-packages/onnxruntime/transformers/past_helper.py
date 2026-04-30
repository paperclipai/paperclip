# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.  See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------

import logging

import torch

logger = logging.getLogger(__name__)


class PastKeyValuesHelper:
    """Helper functions to process past key values for encoder-decoder model"""

    @staticmethod
    def get_past_names(num_layers, present: bool = False):
        past_self_names = []
        past_cross_names = []
        for i in range(num_layers):
            past_self_names.extend(
                [f"present_key_self_{i}", f"present_value_self_{i}"]
                if present
                else [f"past_key_self_{i}", f"past_value_self_{i}"]
            )
            past_cross_names.extend(
                [f"present_key_cross_{i}", f"present_value_cross_{i}"]
                if present
                else [f"past_key_cross_{i}", f"past_value_cross_{i}"]
            )
        return past_self_names + past_cross_names

    @staticmethod
    def group_by_self_or_cross(present_key_values):
        """Split present state from grouped by layer to grouped by self/cross attention.
        Before: (past_key_self_0, past_value_self_0, past_key_cross_0, past_value_cross_0), (past_key_self_1, past_value_self_1, past_key_cross_1, past_value_cross_1), ...
        After: (past_key_self_0, past_value_self_0, past_key_self_1, past_value_self_1, ...), (past_key_cross_0, past_value_cross_0, past_key_cross_1, past_value_cross_1, ...)

        """
        present_self = []
        present_cross = []
        for _i, present_layer_i in enumerate(present_key_values):
            assert len(present_layer_i) == 4, f"Expected to have four items. Got {len(present_layer_i)}"
            (
                present_key_self,
                present_value_self,
                present_key_cross,
                present_value_cross,
            ) = present_layer_i
            present_self.extend([present_key_self, present_value_self])
            present_cross.extend([present_key_cross, present_value_cross])
        return present_self, present_cross

    @staticmethod
    def group_by_layer(past, num_layers):
        """Reorder past state from grouped by self/cross attention to grouped by layer.
        Before: past_key_self_0, past_value_self_0, past_key_self_1, past_value_self_1, ..., past_key_cross_0, past_value_cross_0, past_key_cross_1, past_value_cross_1, ...
        After: (past_key_self_0, past_value_self_0, past_key_cross_0, past_value_cross_0), (past_key_self_1, past_value_self_1, past_key_cross_1, past_value_cross_1),
        """
        assert len(past) == 4 * num_layers
        return tuple(
            [
                past[2 * i],
                past[2 * i + 1],
                past[2 * num_layers + 2 * i],
                past[2 * num_layers + 2 * i + 1],
            ]
            for i in range(num_layers)
        )

    @staticmethod
    def back_group_by_layer(past_key_values: tuple[tuple[torch.Tensor]]):
        """Categorize present_key_values from self and cross attention to layer by layer.

        Reorder past state from grouped by self/cross attention to grouped by layer.
        Before: past_key_self_0, past_value_self_0, past_key_self_1, past_value_self_1, ...,
                past_key_cross_0, past_value_cross_0, past_key_cross_1, past_value_cross_1, ...
        After: (past_key_self_0, past_value_self_0, past_key_cross_0, past_value_cross_0),
                (past_key_self_1, past_value_self_1, past_key_cross_1, past_value_cross_1),

        Args:
            present_key_values: From past_key_values of a model (group by self and cross attention)

        Returns:
            past_tuples: present key and values grouped by layer.
        """
        past_tuples = ()
        half_idx = len(past_key_values) // 2
        for i in range(len(past_key_values) // 4):
            idx = 2 * i
            past_tuples += (
                (
                    past_key_values[idx],
                    past_key_values[idx + 1],
                    past_key_values[half_idx + idx],
                    past_key_values[half_idx + idx + 1],
                ),
            )
        return past_tuples

    @staticmethod
    def group_by_self_and_cross(present_key_values: tuple[torch.Tensor], concat: bool = False):
        """Categorize present_key_values into self and cross attention.

        Split present state from grouped by layer to grouped by self/cross attention.
        Before: (past_key_self_0, past_value_self_0, past_key_cross_0, past_value_cross_0),
                (past_key_self_1, past_value_self_1, past_key_cross_1, past_value_cross_1), ...
        After: (past_key_self_0, past_value_self_0, past_key_self_1, past_value_self_1, ...),
                (past_key_cross_0, past_value_cross_0, past_key_cross_1, past_value_cross_1, ...)

        Args:
            present_key_values: From past_key_values of a model (group by layer)
            concat: If concat self attention with cross attention key/value to return

        Returns:
            present_self (Tuple[torch.Tensor]): present key and values from self attention
            present_cross (Tuple[torch.Tensor]): present key and values from cross attention
        """
        present_self: list[torch.Tensor] = []
        present_cross: list[torch.Tensor] = []
        for _, present_layer_i in enumerate(present_key_values):
            assert len(present_layer_i) == 4, f"Expected to have four items. Got {len(present_layer_i)}"
            present_key_self, present_value_self, present_key_cross, present_value_cross = present_layer_i
            present_self.extend([present_key_self, present_value_self])
            present_cross.extend([present_key_cross, present_value_cross])
        if concat:
            return present_self + present_cross
        else:
            return present_self, present_cross

    @staticmethod
    def get_input_names(past_key_values: tuple[tuple[torch.Tensor]], encoder=True):
        """Process input names of model wrapper.

        Args:
            past_key_values: Consider `self` and `cross` past_key_values

        Returns:
            names (List[string]): input names
        """
        names = []
        num_layers = len(past_key_values) // 4 if encoder else len(past_key_values)
        prefix = "past_" if not encoder else "present_"
        for i in range(num_layers):
            names.extend([prefix + s for s in [f"key_self_{i}", f"value_self_{i}"]])
        for i in range(num_layers):
            names.extend([prefix + s for s in [f"key_cross_{i}", f"value_cross_{i}"]])
        return names
