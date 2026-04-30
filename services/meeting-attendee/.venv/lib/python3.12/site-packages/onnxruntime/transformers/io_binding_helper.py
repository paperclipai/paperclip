import copy
import logging
from collections import OrderedDict
from collections.abc import Mapping
from typing import Any

import numpy
import torch
from onnx import TensorProto

from onnxruntime import InferenceSession, RunOptions

# Type alias
ShapeDict = Mapping[str, tuple | list[int]]

logger = logging.getLogger(__name__)


class TypeHelper:
    @staticmethod
    def get_input_type(ort_session: InferenceSession, name: str) -> str:
        for _i, input in enumerate(ort_session.get_inputs()):
            if input.name == name:
                return input.type
        raise ValueError(f"input name {name} not found")

    @staticmethod
    def get_output_type(ort_session, name: str) -> str:
        for _i, output in enumerate(ort_session.get_outputs()):
            if output.name == name:
                return output.type

        raise ValueError(f"output name {name} not found")

    @staticmethod
    def ort_type_to_numpy_type(ort_type: str):
        ort_type_to_numpy_type_map = {
            "tensor(int64)": numpy.int64,
            "tensor(int32)": numpy.int32,
            "tensor(float)": numpy.float32,
            "tensor(float16)": numpy.float16,
            "tensor(bool)": bool,
            "tensor(uint8)": numpy.uint8,
            "tensor(int8)": numpy.int8,
            "tensor(double)": numpy.float64,
            "tensor(int16)": numpy.int16,
            "tensor(uint16)": numpy.uint16,
            "tensor(uint32)": numpy.uint32,
            "tensor(uint64)": numpy.uint64,
            "tensor(complex64)": numpy.complex64,
            "tensor(complex128)": numpy.complex128,
        }
        if ort_type not in ort_type_to_numpy_type_map:
            raise ValueError(f"{ort_type} not found in map")

        return ort_type_to_numpy_type_map[ort_type]

    @staticmethod
    def ort_type_to_torch_type(ort_type: str):
        ort_type_to_torch_type_map = {
            "tensor(int64)": torch.int64,
            "tensor(int32)": torch.int32,
            "tensor(float)": torch.float32,
            "tensor(float16)": torch.float16,
            "tensor(bfloat16)": torch.bfloat16,
            "tensor(bool)": torch.bool,
            "tensor(uint8)": torch.uint8,
            "tensor(int8)": torch.int8,
            "tensor(double)": torch.float64,
            "tensor(int16)": torch.int16,
            "tensor(uint16)": torch.uint16,
            "tensor(uint32)": torch.uint32,
            "tensor(uint64)": torch.uint64,
            "tensor(complex64)": torch.complex64,
            "tensor(complex128)": torch.complex128,
            "tensor(float8e4m3fn)": torch.float8_e4m3fn,
            "tensor(float8e4m3fnuz)": torch.float8_e4m3fnuz,
            "tensor(float8e5m2)": torch.float8_e5m2,
            "tensor(float8e5m2fnuz)": torch.float8_e5m2fnuz,
            "tensor(int4)": torch.int4,
            "tensor(uint4)": torch.uint4,
        }
        if ort_type not in ort_type_to_torch_type_map:
            raise ValueError(f"{ort_type} not found in map")

        return ort_type_to_torch_type_map[ort_type]

    @staticmethod
    def get_io_onnx_type_map(ort_session: InferenceSession) -> dict[str, int]:
        """Create a mapping from input/output name to onnx data type"""
        name_to_onnx_type = {}
        for input in ort_session.get_inputs():
            name_to_onnx_type[input.name] = TypeHelper.ort_type_to_onnx_type(input.type)

        for output in ort_session.get_outputs():
            name_to_onnx_type[output.name] = TypeHelper.ort_type_to_onnx_type(output.type)
        return name_to_onnx_type

    @staticmethod
    def ort_type_to_onnx_type(ort_type: str):
        ort_type_to_onnx_type_map = {
            "tensor(int64)": TensorProto.INT64,
            "tensor(int32)": TensorProto.INT32,
            "tensor(float)": TensorProto.FLOAT,
            "tensor(float16)": TensorProto.FLOAT16,
            "tensor(bfloat16)": TensorProto.BFLOAT16,
            "tensor(bool)": TensorProto.BOOL,
            "tensor(uint8)": TensorProto.UINT8,
            "tensor(int8)": TensorProto.INT8,
            "tensor(double)": TensorProto.DOUBLE,
            "tensor(int16)": TensorProto.INT16,
            "tensor(uint16)": TensorProto.UINT16,
            "tensor(uint32)": TensorProto.UINT32,
            "tensor(uint64)": TensorProto.UINT64,
            "tensor(complex64)": TensorProto.COMPLEX64,
            "tensor(complex128)": TensorProto.COMPLEX128,
            "tensor(float8e4m3fn)": TensorProto.FLOAT8E4M3FN,
            "tensor(float8e4m3fnuz)": TensorProto.FLOAT8E4M3FNUZ,
            "tensor(float8e5m2)": TensorProto.FLOAT8E5M2,
            "tensor(float8e5m2fnuz)": TensorProto.FLOAT8E5M2FNUZ,
            "tensor(float4e2m1)": TensorProto.FLOAT4E2M1,
            "tensor(int4)": TensorProto.INT4,
            "tensor(uint4)": TensorProto.UINT4,
            "tensor(string)": TensorProto.STRING,
        }
        if ort_type not in ort_type_to_onnx_type_map:
            raise ValueError(f"{ort_type} not found in map")

        return ort_type_to_onnx_type_map[ort_type]

    @staticmethod
    def numpy_type_to_torch_type(numpy_type: numpy.dtype):
        numpy_type_to_torch_type_map = {
            numpy.int64: torch.int64,
            numpy.int32: torch.int32,
            numpy.float32: torch.float32,
            numpy.float16: torch.float16,
            bool: torch.bool,
            numpy.uint8: torch.uint8,
            numpy.int8: torch.int8,
            numpy.float64: torch.float64,
            numpy.int16: torch.int16,
            numpy.uint16: torch.uint16,
            numpy.uint32: torch.uint32,
            numpy.uint64: torch.uint64,
            numpy.complex64: torch.complex64,
            numpy.complex128: torch.complex128,
        }

        if numpy_type not in numpy_type_to_torch_type_map:
            raise ValueError(f"{numpy_type} not found in map")

        return numpy_type_to_torch_type_map[numpy_type]

    @staticmethod
    def torch_type_to_numpy_type(torch_type: torch.dtype):
        torch_type_to_numpy_type_map = {
            torch.int64: numpy.int64,
            torch.int32: numpy.int32,
            torch.float32: numpy.float32,
            torch.float16: numpy.float16,
            torch.bool: bool,
            torch.uint8: numpy.uint8,
            torch.int8: numpy.int8,
            torch.float64: numpy.float64,
            torch.int16: numpy.int16,
            torch.uint16: numpy.uint16,
            torch.uint32: numpy.uint32,
            torch.uint64: numpy.uint64,
            torch.complex64: numpy.complex64,
            torch.complex128: numpy.complex128,
        }

        if torch_type not in torch_type_to_numpy_type_map:
            raise ValueError(f"{torch_type} not found in map")

        return torch_type_to_numpy_type_map[torch_type]

    @staticmethod
    def get_io_numpy_type_map(ort_session: InferenceSession) -> dict[str, numpy.dtype]:
        """Create a mapping from input/output name to numpy data type"""
        name_to_numpy_type = {}
        for input in ort_session.get_inputs():
            name_to_numpy_type[input.name] = TypeHelper.ort_type_to_numpy_type(input.type)

        for output in ort_session.get_outputs():
            name_to_numpy_type[output.name] = TypeHelper.ort_type_to_numpy_type(output.type)
        return name_to_numpy_type

    @staticmethod
    def get_io_torch_type_map(ort_session: InferenceSession) -> dict[str, torch.dtype]:
        """Create a mapping from input/output name to torch data type"""
        name_to_torch_type = {}
        for input in ort_session.get_inputs():
            name_to_torch_type[input.name] = TypeHelper.ort_type_to_torch_type(input.type)

        for output in ort_session.get_outputs():
            name_to_torch_type[output.name] = TypeHelper.ort_type_to_torch_type(output.type)
        return name_to_torch_type


class IOBindingHelper:
    @staticmethod
    def get_output_buffers(ort_session: InferenceSession, output_shapes, device):
        """Returns a dictionary of output name as key, and 1D tensor as value. The tensor has enough space for given shape."""
        output_buffers = {}
        for name, shape in output_shapes.items():
            ort_type = TypeHelper.get_output_type(ort_session, name)
            torch_type = TypeHelper.ort_type_to_torch_type(ort_type)
            output_buffers[name] = torch.empty(numpy.prod(shape), dtype=torch_type, device=device)
        return output_buffers

    @staticmethod
    def prepare_io_binding(
        ort_session,
        input_ids: torch.Tensor,
        position_ids: torch.Tensor,
        attention_mask: torch.Tensor,
        past: list[torch.Tensor],
        output_buffers,
        output_shapes,
    ):
        """IO binding for a session: bind inputs (input_ids, position_ids, attention_mask, past_*) and outputs."""

        name_to_onnx_type = TypeHelper.get_io_onnx_type_map(ort_session)

        # Bind inputs and outputs to onnxruntime session
        io_binding = ort_session.io_binding()

        # Bind inputs
        assert input_ids.is_contiguous()
        io_binding.bind_input(
            "input_ids",
            input_ids.device.type,
            0,
            name_to_onnx_type["input_ids"],
            list(input_ids.size()),
            input_ids.data_ptr(),
        )

        if past is not None:
            for i, past_i in enumerate(past):
                assert past_i.is_contiguous()

                data_ptr = past_i.data_ptr()
                if data_ptr == 0:
                    # When past_sequence_length is 0, its data_ptr will be zero. IO Binding asserts that data_ptr shall not be zero.
                    # Here we workaround and pass data pointer of input_ids. Actual data is not used for past so it does not matter.
                    data_ptr = input_ids.data_ptr()

                io_binding.bind_input(
                    f"past_{i}",
                    past_i.device.type,
                    0,
                    name_to_onnx_type[f"past_{i}"],
                    list(past_i.size()),
                    data_ptr,
                )

        if attention_mask is not None:
            assert attention_mask.is_contiguous()
            io_binding.bind_input(
                "attention_mask",
                attention_mask.device.type,
                0,
                name_to_onnx_type["attention_mask"],
                list(attention_mask.size()),
                attention_mask.data_ptr(),
            )

        if position_ids is not None:
            assert position_ids.is_contiguous()
            io_binding.bind_input(
                "position_ids",
                position_ids.device.type,
                0,
                name_to_onnx_type["position_ids"],
                list(position_ids.size()),
                position_ids.data_ptr(),
            )

        # Bind outputs
        for output in ort_session.get_outputs():
            output_name = output.name
            output_buffer = output_buffers[output_name]
            logger.debug(f"{output_name} device type={output_buffer.device.type} shape={list(output_buffer.size())}")
            io_binding.bind_output(
                output_name,
                output_buffer.device.type,
                0,
                name_to_onnx_type[output_name],
                output_shapes[output_name],
                output_buffer.data_ptr(),
            )

        return io_binding

    @staticmethod
    def get_outputs_from_io_binding_buffer(ort_session, output_buffers, output_shapes, return_numpy=True):
        """Copy results to cpu. Returns a list of numpy array."""
        ort_outputs = []
        for output in ort_session.get_outputs():
            output_name = output.name
            buffer = output_buffers[output_name]
            shape = output_shapes[output_name]
            copy_tensor = buffer[0 : numpy.prod(shape)].reshape(shape).clone().detach()
            if return_numpy:
                ort_outputs.append(copy_tensor.cpu().numpy())
            else:
                ort_outputs.append(copy_tensor)
        return ort_outputs


class CudaSession:
    """Inference Session with IO Binding for ONNX Runtime CUDA or TensorRT provider"""

    def __init__(self, ort_session: InferenceSession, device: torch.device, enable_cuda_graph=False):
        self.ort_session = ort_session
        self.input_names = [input.name for input in self.ort_session.get_inputs()]
        self.output_names = [output.name for output in self.ort_session.get_outputs()]
        self.io_name_to_onnx_type = TypeHelper.get_io_onnx_type_map(self.ort_session)
        self.io_name_to_torch_type = TypeHelper.get_io_torch_type_map(self.ort_session)
        self.io_binding = self.ort_session.io_binding()
        self.enable_cuda_graph = enable_cuda_graph

        self.input_tensors = OrderedDict()
        self.output_tensors = OrderedDict()
        self.device = device

        # Pairs of input and output names that share the same buffer.
        self.buffer_sharing: dict[str, str] = {}

    def set_buffer_sharing(self, input_name: str, output_name: str):
        assert input_name in self.input_names
        assert output_name in self.output_names
        self.buffer_sharing[input_name] = output_name
        self.buffer_sharing[output_name] = input_name

    def __del__(self):
        del self.input_tensors
        del self.output_tensors
        del self.io_binding

    def bind_input_and_buffer_sharing(self, name: str, tensor: torch.Tensor):
        device_id = tensor.device.index if tensor.device.index is not None else 0
        tensor_shape = [1] if len(tensor.shape) == 0 else list(tensor.shape)

        self.io_binding.bind_input(
            name,
            tensor.device.type,
            device_id,
            self.io_name_to_onnx_type[name],
            tensor_shape,
            tensor.data_ptr(),
        )

        if name in self.buffer_sharing:
            self.io_binding.bind_output(
                self.buffer_sharing[name],
                tensor.device.type,
                device_id,
                self.io_name_to_onnx_type[name],
                tensor_shape,
                tensor.data_ptr(),
            )
            self.output_tensors[self.buffer_sharing[name]] = tensor

    def allocate_buffers(self, shape_dict: ShapeDict):
        """Allocate tensors for I/O Binding"""
        if self.enable_cuda_graph:
            for name, shape in shape_dict.items():
                if name in self.input_names:
                    # Reuse allocated buffer when the shape is same
                    if name in self.input_tensors:
                        if tuple(self.input_tensors[name].shape) == tuple(shape):
                            continue
                        raise RuntimeError("Expect static input shape for cuda graph")

                    torch_dtype = self.io_name_to_torch_type[name]
                    tensor = torch.empty(tuple(shape), dtype=torch_dtype).to(device=self.device)
                    self.input_tensors[name] = tensor
                    self.bind_input_and_buffer_sharing(name, tensor)

        for name, shape in shape_dict.items():
            if name in self.output_names:
                # Reuse allocated buffer when the shape is same
                if name in self.output_tensors and tuple(self.output_tensors[name].shape) == tuple(shape):
                    continue

                if name in self.buffer_sharing:
                    continue

                torch_dtype = self.io_name_to_torch_type[name]
                tensor = torch.empty(tuple(shape), dtype=torch_dtype).to(device=self.device)
                self.output_tensors[name] = tensor

                self.io_binding.bind_output(
                    name,
                    tensor.device.type,
                    tensor.device.index if tensor.device.index is not None else 0,
                    self.io_name_to_onnx_type[name],
                    list(tensor.size()),
                    tensor.data_ptr(),
                )

    def infer(self, feed_dict: dict[str, torch.Tensor], run_options: RunOptions = None, synchronize: bool = True):
        """Bind input tensors and run inference"""
        for name, tensor in feed_dict.items():
            assert isinstance(tensor, torch.Tensor) and tensor.is_contiguous()
            if name in self.input_names:
                if self.enable_cuda_graph:
                    assert self.input_tensors[name].nelement() == tensor.nelement()
                    assert self.input_tensors[name].dtype == tensor.dtype
                    assert tensor.device.type == "cuda"
                    self.input_tensors[name].copy_(tensor)
                else:
                    self.bind_input_and_buffer_sharing(name, tensor)

        if synchronize:
            self.io_binding.synchronize_inputs()
            self.ort_session.run_with_iobinding(self.io_binding, run_options)
            self.io_binding.synchronize_outputs()
        else:
            self.ort_session.run_with_iobinding(self.io_binding, run_options)

        return self.output_tensors

    @staticmethod
    def get_cuda_provider_options(device_id: int, enable_cuda_graph: bool, stream: int = 0) -> dict[str, Any]:
        options = {
            "device_id": device_id,
            "arena_extend_strategy": "kSameAsRequested",
            "enable_cuda_graph": enable_cuda_graph,
        }

        # Stream is address of a CUDA stream. 0 means the default stream.
        if stream != 0:
            options["user_compute_stream"] = str(stream)

        return options


class GpuBinding(CudaSession):
    def __init__(
        self,
        ort_session: InferenceSession,
        device: torch.device,
        shape_dict: ShapeDict,
        enable_gpu_graph: bool = False,
        gpu_graph_id: int = -1,
        stream: int = 0,
        buffer_sharing: dict[str, str] | None = None,
    ):
        super().__init__(ort_session, device, enable_gpu_graph)
        if buffer_sharing:
            for input_name, output_name in buffer_sharing.items():
                self.set_buffer_sharing(input_name, output_name)

        self.allocate_buffers(shape_dict)
        self.gpu_graph_id = gpu_graph_id
        # For cuda graph, we need to keep a copy of shape_dict to check if the shape is same in inference later.
        self.shape_dict = copy.deepcopy(shape_dict) if enable_gpu_graph else None
        self.stream = stream
        # The gpu graph id of last run. It will be saved to image metadata.
        self.last_run_gpu_graph_id = None

    def get_run_options(self, disable_cuda_graph_in_run: bool = False) -> RunOptions:
        options = RunOptions()

        gpu_graph_id = -1 if disable_cuda_graph_in_run else self.gpu_graph_id

        options.add_run_config_entry("gpu_graph_id", str(gpu_graph_id))

        self.last_run_gpu_graph_id = gpu_graph_id

        return options

    def infer(self, feed_dict: dict[str, torch.Tensor], disable_cuda_graph_in_run: bool = False):
        run_options = self.get_run_options(disable_cuda_graph_in_run)

        if self.stream:
            run_options.add_run_config_entry("disable_synchronize_execution_providers", "1")

        return super().infer(feed_dict, run_options)


class GpuBindingManager:
    """A manager for I/O bindings that support multiple CUDA Graphs.
    One cuda graph is reused for same input shape. Automatically add a new cuda graph for new input shape.
    """

    def __init__(self, ort_session: InferenceSession, device: torch.device, stream: int = 0, max_cuda_graphs: int = 1):
        self.ort_session = ort_session
        self.device = device

        # Binding supports cuda graphs. For a binding, it is able to disable cuda graph for a specific run.
        self.graph_bindings = []

        # Binding for not using cuda graph.
        self.no_graph_binding = None

        self.stream = stream

        self.max_cuda_graphs = max_cuda_graphs

    def get_binding(
        self,
        shape_dict: ShapeDict,
        use_cuda_graph: bool = False,
        buffer_sharing: dict[str, str] | None = None,
    ) -> GpuBinding:
        for gpu_graph_binding in self.graph_bindings:
            # Found a cuda graph that captured with the same shape
            if gpu_graph_binding.shape_dict == shape_dict:
                return gpu_graph_binding

        # Reached the maximum number of cuda graphs. Return a binding without cuda graph.
        if len(self.graph_bindings) >= self.max_cuda_graphs or (not use_cuda_graph):
            if self.no_graph_binding is None:
                self.no_graph_binding = GpuBinding(
                    self.ort_session, self.device, shape_dict, stream=self.stream, buffer_sharing=buffer_sharing
                )
            else:
                self.no_graph_binding.allocate_buffers(shape_dict)
            return self.no_graph_binding

        # This is a new input shape, create a new cuda graph
        gpu_graph_binding = GpuBinding(
            self.ort_session,
            self.device,
            shape_dict,
            enable_gpu_graph=True,
            gpu_graph_id=len(self.graph_bindings),
            stream=self.stream,
            buffer_sharing=buffer_sharing,
        )
        self.graph_bindings.append(gpu_graph_binding)
        return gpu_graph_binding
