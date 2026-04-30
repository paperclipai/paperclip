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

"""Helper classes or functions for onnxrt adaptor."""

import importlib
import logging

import numpy as np

logger = logging.getLogger("neural_compressor")


MAXIMUM_PROTOBUF = 2147483648


def simple_progress_bar(total, i):
    """Progress bar for cases where tqdm can't be used."""
    progress = i / total
    bar_length = 20
    bar = "#" * int(bar_length * progress)
    spaces = " " * (bar_length - len(bar))
    percentage = progress * 100
    print(f"\rProgress: [{bar}{spaces}] {percentage:.2f}%", end="")


def find_by_name(name, item_list):
    """Helper function to find item by name in a list."""
    items = []
    for item in item_list:
        assert hasattr(item, "name"), f"{item} should have a 'name' attribute defined"  # pragma: no cover
        if item.name == name:
            items.append(item)
    if len(items) > 0:
        return items[0]
    else:
        return None


def to_numpy(data):
    """Convert to numpy ndarrays."""
    import torch  # noqa: PLC0415

    if not isinstance(data, np.ndarray):
        if not importlib.util.find_spec("torch"):
            logger.error(
                "Please install torch to enable subsequent data type check and conversion, "
                "or reorganize your data format to numpy array."
            )
            exit(0)
        if isinstance(data, torch.Tensor):
            if data.dtype is torch.bfloat16:  # pragma: no cover
                return data.detach().cpu().to(torch.float32).numpy()
            if data.dtype is torch.chalf:  # pragma: no cover
                return data.detach().cpu().to(torch.cfloat).numpy()
            return data.detach().cpu().numpy()
        else:
            try:
                return np.array(data)
            except Exception:
                assert False, (  # noqa: B011
                    f"The input data for onnx model is {type(data)}, which is not supported to convert to numpy ndarrays."
                )
    else:
        return data
