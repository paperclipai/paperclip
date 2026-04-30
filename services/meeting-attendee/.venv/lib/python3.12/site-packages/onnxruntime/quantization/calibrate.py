#!/usr/bin/env python
# -------------------------------------------------------------------------
# Copyright (c) Microsoft, Intel Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------
import abc
import copy
import itertools
import os
import uuid
from collections.abc import Sequence
from enum import Enum
from pathlib import Path

import numpy as np
import onnx
from onnx import ModelProto, TensorProto, helper, numpy_helper

import onnxruntime

from .quant_utils import apply_plot, load_model_with_shape_infer, smooth_distribution


def rel_entr(pk: np.ndarray, qk: np.ndarray) -> np.ndarray:
    """
    See https://docs.scipy.org/doc/scipy/reference/generated/scipy.special.rel_entr.html#scipy.special.rel_entr.
    Python implementation.
    """
    res = np.empty(pk.shape, dtype=pk.dtype)
    res[:] = pk[:] * np.log(pk[:] / qk[:])
    c2 = (pk == 0) & (qk >= 0)
    res[c2] = 0
    c1 = (pk > 0) & (qk > 0)
    res[~c1] = np.inf
    return res


def entropy(
    pk: np.ndarray,
    qk: np.ndarray,
    base: float | None = None,
    axis: int = 0,
) -> np.ndarray:
    """
    Simplifeied version of entropy.
    Source: https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.entropy.html.
    This avoids taking a dependency on scipy just for this function.
    """
    assert base is None or base > 0, "base={base} must be a positive number or `None`."
    assert qk is not None, "qk is None"

    pk = np.asarray(pk).astype(np.float32)
    pk = 1.0 * pk / np.sum(pk, axis=axis, keepdims=True)

    qk = np.asarray(qk).astype(np.float32)
    pk, qk = np.broadcast_arrays(pk, qk)
    qk = 1.0 * qk / np.sum(qk, axis=axis, keepdims=True)
    vec = rel_entr(pk, qk)

    s = np.sum(vec, axis=axis)
    if base is not None:
        s /= np.log(base)
    return s.astype(pk.dtype)


class TensorData:
    _allowed = frozenset(["avg", "std", "lowest", "highest", "hist", "hist_edges", "bins"])
    _floats = frozenset(["avg", "std", "lowest", "highest", "hist_edges"])

    def __init__(self, **kwargs):
        self._attrs = list(kwargs.keys())
        for k, v in kwargs.items():
            if k not in TensorData._allowed:
                raise ValueError(f"Unexpected value {k!r} not in {TensorData._allowed}.")
            if k in TensorData._floats:
                if not hasattr(v, "dtype"):
                    raise ValueError(f"Unexpected type {type(v)} for k={k!r}")
                if v.dtype not in (np.float16, np.float32):
                    raise ValueError(f"Unexpected dtype {v.dtype} for k={k!r}")
            setattr(self, k, v)

    @property
    def range_value(self):
        if not hasattr(self, "lowest") or not hasattr(self, "highest"):
            raise AttributeError(f"Attributes 'lowest' and/or 'highest' missing in {dir(self)}.")
        return (self.lowest, self.highest)

    @property
    def avg_std(self):
        if not hasattr(self, "avg") or not hasattr(self, "std"):
            raise AttributeError(f"Attributes 'avg' and/or 'std' missing in {dir(self)}.")
        return (self.avg, self.std)

    def to_dict(self):
        # This is needed to serialize the data into JSON.
        data = {k: getattr(self, k) for k in self._attrs}
        data["CLS"] = self.__class__.__name__
        return data


class TensorsData:
    def __init__(self, calibration_method, data: dict[str, TensorData | tuple]):
        self.calibration_method = calibration_method
        self.data = {}
        for k, v in data.items():
            if not isinstance(k, str):
                raise TypeError(f"Keys must be strings not {type(k)}.")
            if isinstance(v, tuple):
                if calibration_method == CalibrationMethod.MinMax and len(v) == 2:
                    self.data[k] = TensorData(lowest=v[0], highest=v[1])
                    continue
                if len(v) == 4:
                    self.data[k] = TensorData(lowest=v[0], highest=v[1], hist=v[2], bins=v[3])
                    continue
                raise TypeError(f"Unexpected tuple for {k:r}, it has {len(v)} elements: {v}.")
            if not isinstance(v, TensorData):
                raise TypeError(f"Values must be TensorData not {type(v)}.")
            self.data[k] = v

    def __iter__(self):
        yield from self.data

    def __contains__(self, key):
        return key in self.data

    def __getitem__(self, key):
        return self.data[key]

    def __setitem__(self, key, value):
        if key not in self.data:
            raise RuntimeError(f"Only an existing tensor can be modified, {key!r} is not.")
        self.data[key] = value

    def keys(self):
        return self.data.keys()

    def values(self):
        return self.data.values()

    def items(self):
        return self.data.items()

    def to_dict(self):
        # This is needed to serialize the data into JSON.
        data = {
            "CLS": self.__class__.__name__,
            "data": self.data,
            "calibration_method": self.calibration_method,
        }
        return data


class CalibrationMethod(Enum):
    MinMax = 0
    Entropy = 1
    Percentile = 2
    Distribution = 3


class CalibrationDataReader(metaclass=abc.ABCMeta):
    @classmethod
    def __subclasshook__(cls, subclass):
        return (hasattr(subclass, "get_next") and callable(subclass.get_next)) or NotImplemented

    @abc.abstractmethod
    def get_next(self) -> dict:
        """generate the input data dict for ONNXinferenceSession run"""
        raise NotImplementedError

    def __iter__(self):
        return self

    def __next__(self):
        result = self.get_next()
        if result is None:
            raise StopIteration
        return result

    def __len__(self):
        raise NotImplementedError

    def set_range(self, start_index: int, end_index: int):
        raise NotImplementedError


class CalibraterBase:
    def __init__(
        self,
        model_path: str | Path,
        op_types_to_calibrate: Sequence[str] | None = None,
        augmented_model_path="augmented_model.onnx",
        symmetric=False,
        use_external_data_format=False,
        per_channel=False,
    ):
        """
        :param model_path: ONNX model to calibrate. It should be a model file path
        :param op_types_to_calibrate: operator types to calibrate. By default, calibrate all the float32/float16 tensors.
        :param augmented_model_path: save augmented model to this path.
        :param symmetric: make range of tensor symmetric (central point is 0).
        :param use_external_data_format: use external data format to store model which size is >= 2Gb.
        :param per_channel: whether to compute ranges per each channel.
        """
        if isinstance(model_path, str):
            self.model = load_model_with_shape_infer(Path(model_path))
        elif isinstance(model_path, Path):
            self.model = load_model_with_shape_infer(model_path)
        else:
            raise ValueError("model_path should be model path.")

        self.op_types_to_calibrate = op_types_to_calibrate
        self.augmented_model_path = augmented_model_path
        self.symmetric = symmetric
        self.use_external_data_format = use_external_data_format
        self.per_channel = per_channel

        self.augment_model = None
        self.infer_session = None
        self.execution_providers = ["CPUExecutionProvider"]

    def set_execution_providers(self, execution_providers=["CPUExecutionProvider"]):  # noqa: B006
        """
        reset the execution providers to execute the collect_data. It triggers to re-creating inference session.
        """
        self.execution_providers = execution_providers
        self.create_inference_session()

    def create_inference_session(self):
        """
        create an OnnxRuntime InferenceSession.
        """
        sess_options = onnxruntime.SessionOptions()
        sess_options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_DISABLE_ALL
        self.infer_session = onnxruntime.InferenceSession(
            self.augmented_model_path,
            sess_options=sess_options,
            providers=self.execution_providers,
        )

    def select_tensors_to_calibrate(self, model: ModelProto):
        """
        select input/output tensors of candidate nodes to calibrate.
        returns:
            tensors (set): set of tensor name.
            value_infos (dict): tensor name to value info.
        """
        value_infos = {vi.name: vi for vi in model.graph.value_info}
        value_infos.update({ot.name: ot for ot in model.graph.output})
        value_infos.update({it.name: it for it in model.graph.input})
        initializer = {init.name for init in model.graph.initializer}

        tensors_to_calibrate = set()
        tensor_type_to_calibrate = {TensorProto.FLOAT, TensorProto.FLOAT16}

        for node in model.graph.node:
            if not self.op_types_to_calibrate or node.op_type in self.op_types_to_calibrate:
                for tensor_name in itertools.chain(node.input, node.output):
                    if tensor_name in value_infos:
                        vi = value_infos[tensor_name]
                        if (
                            vi.type.HasField("tensor_type")
                            and (vi.type.tensor_type.elem_type in tensor_type_to_calibrate)
                            and (tensor_name not in initializer)
                        ):
                            tensors_to_calibrate.add(tensor_name)

        return tensors_to_calibrate, value_infos

    def get_augment_model(self):
        """
        return: augmented onnx model. Call after calling augment_graph
        """
        return self.model

    def augment_graph(self):
        """
        abstract method: augment the input model to prepare for collecting data. It will:
            1. augment the model to be able to collect desired statistics data
            2. save augmented model to augmented_model_paths
        """
        raise NotImplementedError

    def collect_data(self, data_reader: CalibrationDataReader):
        """
        abstract method: collect the tensors that will be used for range computation. It can be called multiple times.
        """
        raise NotImplementedError

    def compute_data(self) -> TensorsData:
        """
        abstract method: compute data based on the calibration method stored in TensorsData
        """
        raise NotImplementedError


class MinMaxCalibrater(CalibraterBase):
    def __init__(
        self,
        model_path: str | Path,
        op_types_to_calibrate: Sequence[str] | None = None,
        augmented_model_path="augmented_model.onnx",
        symmetric=False,
        use_external_data_format=False,
        moving_average=False,
        averaging_constant=0.01,
        max_intermediate_outputs=None,
        per_channel=False,
    ):
        """
        :param model_path: ONNX model to calibrate. It is a model path
        :param op_types_to_calibrate: operator types to calibrate. By default, calibrate all the float32/float16 tensors.
        :param augmented_model_path: save augmented model to this path.
        :param symmetric: make range of tensor symmetric (central point is 0).
        :param use_external_data_format: use external data format to store model which size is >= 2Gb
        :param moving_average: compute the moving average of the minimum and maximum values instead of the global minimum and maximum.
        :param averaging_constant: constant smoothing factor to use when computing the moving average.
        :param max_intermediate_outputs: maximum number of intermediate outputs before an intermediate range is computed.
        :param per_channel: whether to compute ranges per each channel.
        """
        super().__init__(
            model_path,
            op_types_to_calibrate=op_types_to_calibrate,
            augmented_model_path=augmented_model_path,
            symmetric=symmetric,
            use_external_data_format=use_external_data_format,
            per_channel=per_channel,
        )
        self.intermediate_outputs = []
        self.calibrate_tensors_range = None
        self.num_model_outputs = len(self.model.graph.output)
        self.model_original_outputs = {output.name for output in self.model.graph.output}
        self.moving_average = moving_average
        if moving_average and (averaging_constant < 0 or averaging_constant > 1):
            raise ValueError("Invalid averaging constant, which should not be < 0 or > 1.")
        self.averaging_constant = averaging_constant
        self.max_intermediate_outputs = max_intermediate_outputs

    def augment_graph(self):
        """
        Adds ReduceMin and ReduceMax nodes to all quantization_candidates op type nodes in
        model and ensures their outputs are stored as part of the graph output
        :return: augmented ONNX model
        """
        tensors, _ = self.select_tensors_to_calibrate(self.model)
        reshape_shape_name = str(uuid.uuid4())
        reshape_shape = numpy_helper.from_array(np.array([-1], dtype=np.int64), reshape_shape_name)
        self.model.graph.initializer.append(reshape_shape)

        def get_op_version(op_type, model):
            for opset_import in model.opset_import:
                if onnx.defs.has(op_type, opset_import.domain):
                    return opset_import.version
            raise RuntimeError(f"Model does not contain a version for '{op_type}'.")

        def insert_nodes(tensor_name, new_nodes):
            index = next(
                (i for i, x in enumerate(self.model.graph.node) if tensor_name in x.input), len(self.model.graph.node)
            )
            for node in new_nodes:
                self.model.graph.node.insert(index, node)
                index += 1

        def add_reduce_min_max(tensor_name, reduce_op_name):
            # When doing ReduceMax/ReduceMin, ORT can't reduce on dim with value of 0 if 'keepdims' is false.
            # To make the code simple, we always let keepdims to be 1.
            keepdims = 1

            # Adding ReduceMin/ReduceMax nodes: ReduceMin/ReduceMax -> Reshape-> (output)
            reduce_output = tensor_name + "_" + reduce_op_name
            intermediate_output = reduce_output + "_Reshape"
            reduce_node = onnx.helper.make_node(
                reduce_op_name, [tensor_name], [intermediate_output], keepdims=keepdims, name=reduce_output
            )

            reshape_node = onnx.helper.make_node(
                "Reshape",
                inputs=[intermediate_output, reshape_shape_name],
                outputs=[reduce_output],
                name=intermediate_output,
            )

            value_infos = {vi.name: vi for vi in self.model.graph.value_info}
            value_infos.update({o.name: o for o in self.model.graph.output})
            value_infos.update({i.name: i for i in self.model.graph.input})
            if tensor_name in value_infos:
                onnx_type = value_infos[tensor_name].type.tensor_type.elem_type
            else:
                raise ValueError(
                    f"Unable to guess tensor type for tensor {tensor_name!r}, "
                    "running shape inference before quantization may resolve this issue."
                )

            # Include axes in reduce_op when per_channel, always keeping axis=1
            if self.per_channel:
                tensor_rank = len(value_infos[tensor_name].type.tensor_type.shape.dim)
                reduced_axes = [0, *range(2, tensor_rank)]
                # Depending on opset version, axes in ReduceMin/ReduceMax are in attribute or inputs
                if get_op_version(reduce_op_name, self.model) < 18:
                    reduce_node.attribute.append(helper.make_attribute("axes", reduced_axes))
                else:
                    reduce_axes_name = str(uuid.uuid4())
                    reduce_axes = numpy_helper.from_array(np.array(reduced_axes, dtype=np.int64), reduce_axes_name)
                    reduce_node.input.append(reduce_axes_name)
                    self.model.graph.initializer.append(reduce_axes)

            insert_nodes(tensor_name, [reduce_node, reshape_node])
            self.model.graph.output.append(helper.make_tensor_value_info(reduce_output, onnx_type, [None]))

        for tensor in tensors:
            add_reduce_min_max(tensor, "ReduceMin")
            add_reduce_min_max(tensor, "ReduceMax")

        onnx.save(
            self.model,
            self.augmented_model_path,
            save_as_external_data=self.use_external_data_format,
        )

    def clear_collected_data(self):
        self.intermediate_outputs = []

    def collect_data(self, data_reader: CalibrationDataReader):
        while True:
            inputs = data_reader.get_next()
            if not inputs:
                break
            self.intermediate_outputs.append(
                [
                    value if sess_o.name not in self.model_original_outputs else None
                    for sess_o, value in zip(
                        self.infer_session.get_outputs(), self.infer_session.run(None, inputs), strict=False
                    )
                ]
            )
            if (
                self.max_intermediate_outputs is not None
                and len(self.intermediate_outputs) == self.max_intermediate_outputs
            ):
                self.clear_collected_data()

        if len(self.intermediate_outputs) == 0 and self.calibrate_tensors_range is None:
            raise ValueError("No data is collected.")

        t = self.compute_data()
        if not isinstance(t, TensorsData):
            raise TypeError(f"compute_data must return a TensorsData not {type(t)}.")
        self.clear_collected_data()

    def merge_range(self, old_range, new_range):
        if not old_range:
            return new_range

        for key, value in old_range.items():
            # Handling for structured data types with TensorData
            if isinstance(value, TensorData):
                old_min = value.range_value[0]
                old_max = value.range_value[1]
            else:
                old_min, old_max = value

            if isinstance(new_range[key], TensorData):
                new_min = new_range[key].range_value[0]
                new_max = new_range[key].range_value[1]
            else:
                new_min, new_max = new_range[key]

            if self.moving_average:
                min_value = old_min + self.averaging_constant * (new_min - old_min)
                max_value = old_max + self.averaging_constant * (new_max - old_max)
            else:
                min_value = min(old_min, new_min)
                max_value = max(old_max, new_max)

            # If structured as TensorData, wrap the result accordingly
            if isinstance(value, TensorData) or isinstance(new_range[key], TensorData):
                new_range[key] = TensorData(lowest=min_value, highest=max_value)
            else:
                new_range[key] = (min_value, max_value)

        return new_range

    def compute_data(self) -> TensorsData:
        """
        Compute the min-max range of tensor
        :return: dictionary mapping: {added node names: (ReduceMin, ReduceMax) pairs }
        """

        if len(self.intermediate_outputs) == 0:
            return self.calibrate_tensors_range

        output_names = [self.infer_session.get_outputs()[i].name for i in range(len(self.intermediate_outputs[0]))]
        output_dicts_list = [
            dict(zip(output_names, intermediate_output, strict=False))
            for intermediate_output in self.intermediate_outputs
        ]

        merged_output_dict = {}
        for d in output_dicts_list:
            for k, v in d.items():
                merged_output_dict.setdefault(k, []).append(v)
        added_output_names = output_names[self.num_model_outputs :]
        calibrate_tensor_names = [
            added_output_names[i].rpartition("_")[0] for i in range(0, len(added_output_names), 2)
        ]  # output names

        merged_added_output_dict = {
            i: merged_output_dict[i] for i in merged_output_dict if i not in self.model_original_outputs
        }

        pairs = []
        for i in range(0, len(added_output_names), 2):
            if self.moving_average:
                min_value_array = np.nanmean(merged_added_output_dict[added_output_names[i]], axis=0)
                max_value_array = np.nanmean(merged_added_output_dict[added_output_names[i + 1]], axis=0)
            else:
                min_value_array = np.nanmin(merged_added_output_dict[added_output_names[i]], axis=0)
                max_value_array = np.nanmax(merged_added_output_dict[added_output_names[i + 1]], axis=0)

            if self.symmetric:
                max_absolute_value = np.nanmax([np.abs(min_value_array), np.abs(max_value_array)], axis=0)
                pairs.append((-max_absolute_value, max_absolute_value))
            else:
                pairs.append((min_value_array, max_value_array))

        new_calibrate_tensors_range = TensorsData(
            CalibrationMethod.MinMax, dict(zip(calibrate_tensor_names, pairs, strict=False))
        )
        if self.calibrate_tensors_range:
            self.calibrate_tensors_range = self.merge_range(self.calibrate_tensors_range, new_calibrate_tensors_range)
        else:
            self.calibrate_tensors_range = new_calibrate_tensors_range

        return self.calibrate_tensors_range


class HistogramCalibrater(CalibraterBase):
    def __init__(
        self,
        model_path: str | Path,
        op_types_to_calibrate: Sequence[str] | None = None,
        augmented_model_path="augmented_model.onnx",
        use_external_data_format=False,
        method="percentile",
        symmetric=False,
        num_bins=128,
        num_quantized_bins=2048,
        percentile=99.999,
        scenario="same",
    ):
        """
        :param model_path: ONNX model to calibrate. It is a model path.
        :param op_types_to_calibrate: operator types to calibrate. By default, calibrate all the float32/float16 tensors.
        :param augmented_model_path: save augmented model to this path.
        :param use_external_data_format: use external data format to store model which size is >= 2Gb
        :param method: A string. One of ['entropy', 'percentile'].
        :param symmetric: make range of tensor symmetric (central point is 0).
        :param num_bins: number of bins to create a new histogram for collecting tensor values.
        :param num_quantized_bins: number of quantized bins. Default 128.
        :param percentile: A float number between [0, 100]. Default 99.99.
        :param scenario: see :class:`DistributionCalibrater`
        """
        super().__init__(
            model_path,
            op_types_to_calibrate=op_types_to_calibrate,
            augmented_model_path=augmented_model_path,
            symmetric=symmetric,
            use_external_data_format=use_external_data_format,
        )
        self.intermediate_outputs = []
        self.calibrate_tensors_range = None
        self.num_model_outputs = len(self.model.graph.output)
        self.model_original_outputs = {output.name for output in self.model.graph.output}
        self.collector = None
        self.method = method
        self.num_bins = num_bins
        self.num_quantized_bins = num_quantized_bins
        self.percentile = percentile
        self.tensors_to_calibrate = None
        self.scenario = scenario

    def augment_graph(self):
        """
        make all quantization_candidates op type nodes as part of the graph output.
        :return: augmented ONNX model
        """
        self.tensors_to_calibrate, value_infos = self.select_tensors_to_calibrate(self.model)
        for tensor in self.tensors_to_calibrate:
            if tensor not in self.model_original_outputs:
                self.model.graph.output.append(value_infos[tensor])

        onnx.save(
            self.model,
            self.augmented_model_path,
            save_as_external_data=self.use_external_data_format,
        )

    def clear_collected_data(self):
        self.intermediate_outputs = []

    def collect_data(self, data_reader: CalibrationDataReader):
        """
        Entropy Calibrator collects operators' tensors as well as generates tensor histogram for each operator.
        """
        input_names_set = {node_arg.name for node_arg in self.infer_session.get_inputs()}
        output_names = [node_arg.name for node_arg in self.infer_session.get_outputs()]

        while True:
            inputs = data_reader.get_next()
            if not inputs:
                break
            outputs = self.infer_session.run(None, inputs)

            # Copy np.ndarray only for graph outputs that are also graph inputs to workaround bug:
            # https://github.com/microsoft/onnxruntime/issues/21922
            fixed_outputs = []
            for output_index, output in enumerate(outputs):
                if output_names[output_index] in input_names_set:
                    fixed_outputs.append(copy.copy(output))
                else:
                    fixed_outputs.append(output)

            self.intermediate_outputs.append(fixed_outputs)

        if len(self.intermediate_outputs) == 0:
            raise ValueError("No data is collected.")

        output_dicts_list = [
            dict(zip(output_names, intermediate_output, strict=False))
            for intermediate_output in self.intermediate_outputs
        ]

        merged_dict = {}
        for d in output_dicts_list:
            for k, v in d.items():
                merged_dict.setdefault(k, []).append(v)

        clean_merged_dict = {i: merged_dict[i] for i in merged_dict if i in self.tensors_to_calibrate}

        if not self.collector:
            self.collector = HistogramCollector(
                method=self.method,
                symmetric=self.symmetric,
                num_bins=self.num_bins,
                num_quantized_bins=self.num_quantized_bins,
                percentile=self.percentile,
                scenario=self.scenario,
            )
        self.collector.collect(clean_merged_dict)

        self.clear_collected_data()

    def compute_data(self) -> TensorsData:
        """
        Compute the min-max range of tensor
        :return: dictionary mapping: {tensor name: (min value, max value)}
        """
        if not self.collector:
            raise ValueError("No collector created and can't generate calibration data.")

        if isinstance(self, EntropyCalibrater):
            cal = CalibrationMethod.Entropy
        elif isinstance(self, PercentileCalibrater):
            cal = CalibrationMethod.Percentile
        elif isinstance(self, DistributionCalibrater):
            cal = CalibrationMethod.Distribution
        else:
            raise TypeError(f"Unknown calibrater {type(self)}. This method must be overwritten.")
        return TensorsData(cal, self.collector.compute_collection_result())


class EntropyCalibrater(HistogramCalibrater):
    def __init__(
        self,
        model_path: str | Path,
        op_types_to_calibrate: Sequence[str] | None = None,
        augmented_model_path="augmented_model.onnx",
        use_external_data_format=False,
        method="entropy",
        symmetric=False,
        num_bins=128,
        num_quantized_bins=128,
    ):
        """
        :param model_path: ONNX model to calibrate. It is a model path
        :param op_types_to_calibrate: operator types to calibrate. By default, calibrate all the float32/float16 tensors.
        :param augmented_model_path: save augmented model to this path.
        :param use_external_data_format: use external data format to store model which size is >= 2Gb
        :param method: A string. One of ['entropy', 'percentile', 'distribution'].
        :param symmetric: make range of tensor symmetric (central point is 0).
        :param num_bins: number of bins to create a new histogram for collecting tensor values.
        :param num_quantized_bins: number of quantized bins. Default 128.
        """
        super().__init__(
            model_path,
            op_types_to_calibrate,
            augmented_model_path,
            use_external_data_format,
            method=method,
            symmetric=symmetric,
            num_bins=num_bins,
            num_quantized_bins=num_quantized_bins,
        )


class PercentileCalibrater(HistogramCalibrater):
    def __init__(
        self,
        model_path: str | Path,
        op_types_to_calibrate: Sequence[str] | None = None,
        augmented_model_path="augmented_model.onnx",
        use_external_data_format=False,
        method="percentile",
        symmetric=False,
        num_bins=2048,
        percentile=99.999,
    ):
        """
        :param model_path: ONNX model to calibrate. It is a model path
        :param op_types_to_calibrate: operator types to calibrate. By default, calibrate all the float32/float16 tensors.
        :param augmented_model_path: save augmented model to this path.
        :param use_external_data_format: use external data format to store model which size is >= 2Gb
        :param method: A string. One of ['entropy', 'percentile', 'distribution'].
        :param symmetric: make range of tensor symmetric (central point is 0).
        :param num_quantized_bins: number of quantized bins. Default 128.
        :param percentile: A float number between [0, 100]. Default 99.99.
        """
        super().__init__(
            model_path,
            op_types_to_calibrate,
            augmented_model_path,
            use_external_data_format,
            method=method,
            symmetric=symmetric,
            num_bins=num_bins,
            percentile=percentile,
        )


class DistributionCalibrater(HistogramCalibrater):
    def __init__(
        self,
        model_path: str | Path,
        op_types_to_calibrate: Sequence[str] | None = None,
        augmented_model_path="augmented_model.onnx",
        use_external_data_format=False,
        method="distribution",
        num_bins=128,
        scenario="same",
    ):
        """
        :param model_path: ONNX model to calibrate. It is a model path
        :param op_types_to_calibrate: operator types to calibrate. By default, calibrate all the float32/float16 tensors.
        :param augmented_model_path: save augmented model to this path.
        :param use_external_data_format: use external data format to store model which size is >= 2Gb
        :param method: A string. One of ['entropy', 'percentile', 'distribution'].
        :param symmetric: make range of tensor symmetric (central point is 0).
        :param num_bins: number of bins to create a new histogram for collecting tensor values.
        :param scenario: for float 8 only, if `scenario="same"`,
            the algorithm weights and float 8 follow the same distribution,
            if `scenario="p3"`, it assumes the weights follow
            a gaussian law and float 8 ~ X^3 where X is a gaussian law
        """
        super().__init__(
            model_path,
            op_types_to_calibrate,
            augmented_model_path,
            use_external_data_format,
            method=method,
            num_bins=num_bins,
            scenario=scenario,
        )


class CalibrationDataCollector(metaclass=abc.ABCMeta):
    """
    Base class for collecting data for calibration-based quantization.
    """

    @abc.abstractmethod
    def collect(self, name_to_arr):
        """
        Generate informative data based on given data.
            name_to_arr : dict
                tensor name to NDArray data
        """
        raise NotImplementedError

    @abc.abstractmethod
    def compute_collection_result(self):
        """
        Get the optimal result among collection data.
        """
        raise NotImplementedError


class HistogramCollector(CalibrationDataCollector):
    """
    Collecting histogram for each tensor. Percentile and Entropy method are supported.

    ref: https://github.com//apache/incubator-mxnet/blob/master/python/mxnet/contrib/quantization.py
    ref: https://docs.nvidia.com/deeplearning/tensorrt/pytorch-quantization-toolkit/docs/_modules/
                 pytorch_quantization/calib/histogram.html
    """

    def __init__(self, method, symmetric, num_bins, num_quantized_bins, percentile, scenario):
        self.histogram_dict = {}
        self.method = method
        self.symmetric = symmetric
        self.num_bins = num_bins
        self.num_quantized_bins = num_quantized_bins
        self.percentile = percentile
        self.scenario = scenario

    def get_histogram_dict(self):
        return self.histogram_dict

    def collect(self, name_to_arr):
        print("Collecting tensor data and making histogram ...")

        # TODO: Currently we have different collect() for entropy and percentile method respectively.
        #       Need unified collect in the future.
        if self.method in {"distribution", "entropy"}:
            return self.collect_value(name_to_arr)
        elif self.method == "percentile":
            if self.symmetric:
                return self.collect_absolute_value(name_to_arr)
            else:
                return self.collect_value(name_to_arr)
        else:
            raise ValueError("Only 'entropy', 'percentile' or 'distribution' methods are supported")

    def collect_absolute_value(self, name_to_arr):
        """
        Collect histogram on absolute value
        """
        for tensor, data_arr in name_to_arr.items():
            if isinstance(data_arr, list):
                for arr in data_arr:
                    assert isinstance(arr, np.ndarray), f"Unexpected type {type(arr)} for tensor={tensor!r}"
                dtypes = {a.dtype for a in data_arr}
                assert len(dtypes) == 1, (
                    f"The calibration expects only one element type but got {dtypes} for tensor={tensor!r}"
                )
                data_arr_np = np.asarray(data_arr)
            elif not isinstance(data_arr, np.ndarray):
                raise ValueError(f"Unexpected type {type(data_arr)} for tensor={tensor!r}")
            else:
                data_arr_np = data_arr
            data_arr_np = data_arr_np.flatten()
            if data_arr_np.size > 0:
                min_value = np.nanmin(data_arr_np)
                max_value = np.nanmax(data_arr_np)
            else:
                min_value = np.array(0, dtype=data_arr_np.dtype)
                max_value = np.array(0, dtype=data_arr_np.dtype)

            data_arr_np = np.absolute(data_arr_np)  # only consider absolute value

            if tensor not in self.histogram_dict:
                # first time it uses num_bins to compute histogram.
                hist, hist_edges = np.histogram(data_arr_np, bins=self.num_bins)
                hist_edges = hist_edges.astype(data_arr_np.dtype)
                assert data_arr_np.dtype != np.float64, (
                    "only float32 or float16 is supported, every constant must be explicitly typed"
                )
                self.histogram_dict[tensor] = (hist, hist_edges, min_value, max_value)
            else:
                old_histogram = self.histogram_dict[tensor]
                old_min = old_histogram[2]
                old_max = old_histogram[3]
                assert hasattr(old_min, "dtype"), f"old_min should be a numpy array but is {type(old_min)}"
                assert hasattr(old_max, "dtype"), f"old_min should be a numpy array but is {type(old_max)}"
                old_hist = old_histogram[0]
                old_hist_edges = old_histogram[1]
                temp_amax = np.nanmax(data_arr_np)
                if temp_amax > old_hist_edges[-1]:
                    # increase the number of bins
                    width = old_hist_edges[1] - old_hist_edges[0]
                    # NOTE: np.arange may create an extra bin after the one containing temp_amax
                    new_bin_edges = np.arange(old_hist_edges[-1] + width, temp_amax + width, width)
                    old_hist_edges = np.hstack((old_hist_edges, new_bin_edges))
                hist, hist_edges = np.histogram(data_arr_np, bins=old_hist_edges)
                hist_edges = hist_edges.astype(data_arr_np.dtype)
                hist[: len(old_hist)] += old_hist
                assert data_arr_np.dtype != np.float64, (
                    "only float32 or float16 is supported, every constant must be explicitly typed"
                )
                self.histogram_dict[tensor] = (hist, hist_edges, min(old_min, min_value), max(old_max, max_value))

    def collect_value(self, name_to_arr):
        """
        Collect histogram on real value
        """
        for tensor, data_arr in name_to_arr.items():
            data_arr = np.asarray(data_arr)  # noqa: PLW2901
            data_arr = data_arr.flatten()  # noqa: PLW2901

            if data_arr.size > 0:
                min_value = np.nanmin(data_arr)
                max_value = np.nanmax(data_arr)
            else:
                min_value = np.array(0, dtype=data_arr.dtype)
                max_value = np.array(0, dtype=data_arr.dtype)

            threshold = np.array(max(abs(min_value), abs(max_value)), dtype=data_arr.dtype)

            if tensor in self.histogram_dict:
                old_histogram = self.histogram_dict[tensor]
                self.histogram_dict[tensor] = self.merge_histogram(
                    old_histogram, data_arr, min_value, max_value, threshold
                )
            else:
                hist, hist_edges = np.histogram(data_arr, self.num_bins, range=(-threshold, threshold))
                self.histogram_dict[tensor] = (
                    hist,
                    hist_edges,
                    min_value,
                    max_value,
                    threshold,
                )

    def merge_histogram(self, old_histogram, data_arr, new_min, new_max, new_threshold):
        (old_hist, old_hist_edges, old_min, old_max, old_threshold) = old_histogram

        if new_threshold <= old_threshold:
            new_hist, _ = np.histogram(data_arr, len(old_hist), range=(-old_threshold, old_threshold))
            return (
                new_hist + old_hist,
                old_hist_edges,
                min(old_min, new_min),
                max(old_max, new_max),
                old_threshold,
            )
        else:
            if old_threshold == 0:
                hist, hist_edges = np.histogram(data_arr, len(old_hist), range=(-new_threshold, new_threshold))
                hist += old_hist
            else:
                old_num_bins = len(old_hist)
                old_stride = 2 * old_threshold / old_num_bins
                half_increased_bins = int((new_threshold - old_threshold) // old_stride + 1)
                new_num_bins = old_num_bins + 2 * half_increased_bins
                new_threshold = half_increased_bins * old_stride + old_threshold
                hist, hist_edges = np.histogram(data_arr, new_num_bins, range=(-new_threshold, new_threshold))
                hist[half_increased_bins : new_num_bins - half_increased_bins] += old_hist
            return (
                hist,
                hist_edges,
                min(old_min, new_min),
                max(old_max, new_max),
                new_threshold,
            )

    def compute_collection_result(self):
        if not self.histogram_dict or len(self.histogram_dict) == 0:
            raise ValueError("Histogram has not been collected. Please run collect() first.")
        print(f"Finding optimal threshold for each tensor using {self.method!r} algorithm ...")

        if self.method == "entropy":
            return self.compute_entropy()
        elif self.method == "percentile":
            return self.compute_percentile()
        elif self.method == "distribution":
            return self.compute_distribution()
        else:
            raise ValueError("Only 'entropy', 'percentile' or 'distribution' methods are supported")

    def compute_percentile(self):
        if self.percentile < 0 or self.percentile > 100:
            raise ValueError("Invalid percentile. Must be in range 0 <= percentile <= 100.")

        histogram_dict = self.histogram_dict
        percentile = self.percentile

        thresholds_dict = {}  # per tensor thresholds

        print(f"Number of tensors : {len(histogram_dict)}")
        print(f"Number of histogram bins : {self.num_bins}")
        print(f"Percentile : ({100.0 - percentile},{percentile})")

        for tensor, histogram in histogram_dict.items():
            hist = histogram[0]
            hist_edges = histogram[1]
            total = hist.sum()
            cdf = np.cumsum(hist / total)
            if self.symmetric:
                idx_right = np.searchsorted(cdf, percentile / 100.0)

                thresholds_dict[tensor] = (
                    -np.array(hist_edges[idx_right], dtype=hist_edges.dtype),
                    np.array(hist_edges[idx_right], dtype=hist_edges.dtype),
                )
            else:
                percent_to_cut_one_side = (100.0 - percentile) / 200.0
                idx_right = np.searchsorted(cdf, 1.0 - percent_to_cut_one_side)
                idx_left = np.searchsorted(cdf, percent_to_cut_one_side)
                thresholds_dict[tensor] = (
                    np.array(hist_edges[idx_left], dtype=hist_edges.dtype),
                    np.array(hist_edges[idx_right], dtype=hist_edges.dtype),
                )
            min_value = histogram[2]
            max_value = histogram[3]
            if thresholds_dict[tensor][0] < min_value:
                thresholds_dict[tensor] = (min_value, thresholds_dict[tensor][1])
            if thresholds_dict[tensor][1] > max_value:
                thresholds_dict[tensor] = (thresholds_dict[tensor][0], max_value)
            thresholds_dict[tensor] = (*thresholds_dict[tensor], *hist[:2])
            # Plot histogram for debug only
            if os.environ.get("QUANTIZATION_DEBUG", "0") in (1, "1"):
                apply_plot(hist, hist_edges)

        return thresholds_dict

    def compute_entropy(self):
        histogram_dict = self.histogram_dict
        num_quantized_bins = self.num_quantized_bins

        thresholds_dict = {}  # per tensor thresholds

        print(f"Number of tensors : {len(histogram_dict)}")
        print(f"Number of histogram bins : {self.num_bins} (The number may increase depends on the data it collects)")
        print(f"Number of quantized bins : {self.num_quantized_bins}")

        for tensor, histogram in histogram_dict.items():
            optimal_threshold = self.get_entropy_threshold(histogram, num_quantized_bins)
            thresholds_dict[tensor] = optimal_threshold
            thresholds_dict[tensor] = (*optimal_threshold, *histogram[:2])

            # Plot histogram for debug only
            if os.environ.get("QUANTIZATION_DEBUG", "0") in (1, "1"):
                apply_plot(histogram[0], histogram[1])

        return thresholds_dict

    @staticmethod
    def _avg_std(hist, hist_edges, power=1):
        if power <= 0:
            raise ValueError(f"power={power} <= 0 is invalid.")
        values = (hist_edges[:-1] + hist_edges[1:]) * 0.5
        if power == 1:
            avg = (hist * values).sum() / hist.sum()
            std = ((hist * values**2).sum() / hist.sum() - avg**2) ** 0.5
            return np.array(avg, dtype=hist_edges.dtype), np.array(std, dtype=hist_edges.dtype)
        if int(power) == power and int(power) % 2 == 1:
            avg = (hist * values**power).sum() / hist.sum()
            std = ((hist * (values**power - avg) ** 2).sum() / hist.sum()) ** 0.5
            return np.array(avg, dtype=hist_edges.dtype), np.array(std, dtype=hist_edges.dtype)

        fact = np.abs(values) / values
        fact[np.isnan(fact)] = 1
        fact[np.isinf(fact)] = 1
        values = np.abs(values) ** power * fact
        avg = (hist * values).sum() / hist.sum()
        std = ((hist * values**2).sum() / hist.sum() - avg**2) ** 0.5
        return np.array(avg, dtype=hist_edges.dtype), np.array(std, dtype=hist_edges.dtype)

    def compute_distribution(self):
        if self.num_bins < 512:
            raise ValueError("Invalid num_bins. Must be in range 512 <= num_bins.")

        histogram_dict = self.histogram_dict
        thresholds_dict = {}  # per tensor thresholds

        print(f"Number of tensors : {len(histogram_dict)}")
        print(f"Number of histogram bins : {self.num_bins}")
        print(f"Scenario : {self.scenario!r})")

        for tensor, histogram in histogram_dict.items():
            hist = histogram[0]
            hist_edges = histogram[1]

            assert hist_edges.dtype != np.float64
            if self.scenario == "same":
                avg_coef, std_coef = self._avg_std(hist, hist_edges, power=1)
            elif self.scenario == "p3":
                avg_coef, std_coef = self._avg_std(hist, hist_edges, power=1.0 / 3.0)
            else:
                raise ValueError("Invalid scenario. Must be in {'same', 'p3'}.")
            assert avg_coef.dtype != np.float64
            assert std_coef.dtype != np.float64
            assert hist_edges.dtype != np.float64
            thresholds_dict[tensor] = TensorData(
                avg=avg_coef,
                std=std_coef,
                hist=hist,
                hist_edges=hist_edges,
                lowest=hist_edges.min(),
                highest=hist_edges.max(),
            )

            # Plot histogram for debug only
            if os.environ.get("QUANTIZATION_DEBUG", "0") in (1, "1"):
                apply_plot(hist, hist_edges)

        return thresholds_dict

    def get_entropy_threshold(self, histogram, num_quantized_bins):
        """Given a dataset, find the optimal threshold for quantizing it.
        The reference distribution is `q`, and the candidate distribution is `p`.
        `q` is a truncated version of the original distribution.
        Ref: http://on-demand.gputechconf.com/gtc/2017/presentation/s7310-8-bit-inference-with-tensorrt.pdf
        """
        hist = histogram[0]
        hist_edges = histogram[1]
        num_bins = hist.size
        zero_bin_index = num_bins // 2
        num_half_quantized_bin = num_quantized_bins // 2

        dtype = histogram[1].dtype
        kl_divergence = np.zeros(zero_bin_index - num_half_quantized_bin + 1)
        thresholds = [(np.array(0, dtype=dtype), np.array(0, dtype=dtype)) for i in range(kl_divergence.size)]

        # <------------ num bins ---------------->
        #        <--- quantized bins ---->
        # |======|===========|===========|=======|
        #              zero bin index
        #        ^                       ^
        #        |                       |
        #   start index               end index          (start of iteration)
        #     ^                             ^
        #     |                             |
        #  start index                  end index               ...
        # ^                                      ^
        # |                                      |
        # start index                    end index       (end of iteration)

        for i in range(num_half_quantized_bin, zero_bin_index + 1, 1):
            start_index = zero_bin_index - i
            end_index = min(zero_bin_index + i + 1, num_bins)

            thresholds[i - num_half_quantized_bin] = (hist_edges[start_index], hist_edges[end_index])

            sliced_distribution = copy.deepcopy(hist[start_index:end_index])

            # reference distribution p
            p = sliced_distribution.copy()  # a copy of np array
            left_outliers_count = sum(hist[:start_index])
            right_outliers_count = sum(hist[end_index:])
            p[0] += left_outliers_count
            p[-1] += right_outliers_count

            # nonzeros[i] incidates whether p[i] is non-zero
            nonzeros = (p != 0).astype(np.int64)

            # quantize p.size bins into quantized bins (default 128 bins)
            quantized_bins = np.zeros(num_quantized_bins, dtype=np.int64)
            num_merged_bins = sliced_distribution.size // num_quantized_bins

            # merge bins into quantized bins
            for index in range(num_quantized_bins):
                start = index * num_merged_bins
                end = start + num_merged_bins
                quantized_bins[index] = sum(sliced_distribution[start:end])
            quantized_bins[-1] += sum(sliced_distribution[num_quantized_bins * num_merged_bins :])

            # in order to compare p and q, we need to make length of q equals to length of p
            # expand quantized bins into p.size bins
            q = np.zeros(p.size, dtype=np.int64)
            for index in range(num_quantized_bins):
                start = index * num_merged_bins
                end = start + num_merged_bins

                norm = sum(nonzeros[start:end])
                if norm != 0:
                    q[start:end] = quantized_bins[index] / norm

            p = smooth_distribution(p)
            q = smooth_distribution(q)
            if p is None or q is None:
                div = np.array(np.inf, dtype=dtype)
            else:
                div = np.array(entropy(p, q), dtype=dtype)
            kl_divergence[i - num_half_quantized_bin] = div

        min_kl_divergence_idx = np.argmin(kl_divergence)
        optimal_threshold = thresholds[min_kl_divergence_idx]
        min_value = histogram[2]
        max_value = histogram[3]
        if optimal_threshold[0] < min_value:
            optimal_threshold = (min_value, optimal_threshold[1])
        if optimal_threshold[1] > max_value:
            optimal_threshold = (optimal_threshold[0], max_value)
        assert hasattr(optimal_threshold[0], "dtype")
        assert hasattr(optimal_threshold[1], "dtype")
        return optimal_threshold


def create_calibrator(
    model: str | Path,
    op_types_to_calibrate: Sequence[str] | None = None,
    augmented_model_path="augmented_model.onnx",
    calibrate_method=CalibrationMethod.MinMax,
    use_external_data_format=False,
    providers=None,
    extra_options={},  # noqa: B006
):
    calibrator = None
    if calibrate_method == CalibrationMethod.MinMax:
        # default settings for min-max algorithm
        symmetric = extra_options.get("symmetric", False)
        moving_average = extra_options.get("moving_average", False)
        averaging_constant = extra_options.get("averaging_constant", 0.01)
        max_intermediate_outputs = extra_options.get("max_intermediate_outputs", None)
        per_channel = extra_options.get("per_channel", False)
        calibrator = MinMaxCalibrater(
            model,
            op_types_to_calibrate,
            augmented_model_path,
            use_external_data_format=use_external_data_format,
            symmetric=symmetric,
            moving_average=moving_average,
            averaging_constant=averaging_constant,
            max_intermediate_outputs=max_intermediate_outputs,
            per_channel=per_channel,
        )
    elif calibrate_method == CalibrationMethod.Entropy:
        # default settings for entropy algorithm
        num_bins = extra_options.get("num_bins", 128)
        num_quantized_bins = extra_options.get("num_quantized_bins", 128)
        symmetric = extra_options.get("symmetric", False)
        calibrator = EntropyCalibrater(
            model,
            op_types_to_calibrate,
            augmented_model_path,
            use_external_data_format=use_external_data_format,
            symmetric=symmetric,
            num_bins=num_bins,
            num_quantized_bins=num_quantized_bins,
        )
    elif calibrate_method == CalibrationMethod.Percentile:
        # default settings for percentile algorithm
        num_bins = extra_options.get("num_bins", 2048)
        percentile = extra_options.get("percentile", 99.999)
        symmetric = extra_options.get("symmetric", True)
        calibrator = PercentileCalibrater(
            model,
            op_types_to_calibrate,
            augmented_model_path,
            use_external_data_format=use_external_data_format,
            symmetric=symmetric,
            num_bins=num_bins,
            percentile=percentile,
        )

    elif calibrate_method == CalibrationMethod.Distribution:
        # default settings for percentile algorithm
        num_bins = extra_options.get("num_bins", 2048)
        scenario = extra_options.get("scenario", "same")

        calibrator = DistributionCalibrater(
            model,
            op_types_to_calibrate,
            augmented_model_path,
            use_external_data_format=use_external_data_format,
            num_bins=num_bins,
            scenario=scenario,
        )

    if calibrator:
        calibrator.augment_graph()
        if providers:
            calibrator.execution_providers = providers
        calibrator.create_inference_session()
        return calibrator

    raise ValueError(f"Unsupported calibration method {calibrate_method}")
