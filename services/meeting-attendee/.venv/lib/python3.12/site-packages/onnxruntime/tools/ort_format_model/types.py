# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

import ort_flatbuffers_py.fbs as fbs


class FbsTypeInfo:
    "Class to provide conversion between ORT flatbuffers schema values and C++ types"

    tensordatatype_to_string = {  # noqa: RUF012
        fbs.TensorDataType.TensorDataType.FLOAT: "float",
        fbs.TensorDataType.TensorDataType.UINT8: "uint8_t",
        fbs.TensorDataType.TensorDataType.INT8: "int8_t",
        fbs.TensorDataType.TensorDataType.UINT16: "uint16_t",
        fbs.TensorDataType.TensorDataType.INT16: "int16_t",
        fbs.TensorDataType.TensorDataType.INT32: "int32_t",
        fbs.TensorDataType.TensorDataType.INT64: "int64_t",
        fbs.TensorDataType.TensorDataType.STRING: "std::string",
        fbs.TensorDataType.TensorDataType.BOOL: "bool",
        fbs.TensorDataType.TensorDataType.FLOAT16: "MLFloat16",
        fbs.TensorDataType.TensorDataType.DOUBLE: "double",
        fbs.TensorDataType.TensorDataType.UINT32: "uint32_t",
        fbs.TensorDataType.TensorDataType.UINT64: "uint64_t",
        # fbs.TensorDataType.TensorDataType.COMPLEX64: 'complex64 is not supported',
        # fbs.TensorDataType.TensorDataType.COMPLEX128: 'complex128 is not supported',
        fbs.TensorDataType.TensorDataType.BFLOAT16: "BFloat16",
        fbs.TensorDataType.TensorDataType.FLOAT8E4M3FN: "Float8E4M3FN",
        fbs.TensorDataType.TensorDataType.FLOAT8E4M3FNUZ: "Float8E4M3FNUZ",
        fbs.TensorDataType.TensorDataType.FLOAT8E5M2: "Float8E5M2",
        fbs.TensorDataType.TensorDataType.FLOAT8E5M2FNUZ: "Float8E5M2FNUZ",
    }

    @staticmethod
    def typeinfo_to_str(type: fbs.TypeInfo):
        value_type = type.ValueType()
        value = type.Value()
        type_str = "unknown"

        if value_type == fbs.TypeInfoValue.TypeInfoValue.tensor_type:
            tensor_type_and_shape = fbs.TensorTypeAndShape.TensorTypeAndShape()
            tensor_type_and_shape.Init(value.Bytes, value.Pos)
            elem_type = tensor_type_and_shape.ElemType()
            type_str = FbsTypeInfo.tensordatatype_to_string[elem_type]

        elif value_type == fbs.TypeInfoValue.TypeInfoValue.map_type:
            map_type = fbs.MapType.MapType()
            map_type.init(value.Bytes, value.Pos)
            key_type = map_type.KeyType()  # TensorDataType
            key_type_str = FbsTypeInfo.tensordatatype_to_string[key_type]
            value_type = map_type.ValueType()  # TypeInfo
            value_type_str = FbsTypeInfo.typeinfo_to_str(value_type)
            type_str = f"std::map<{key_type_str},{value_type_str}>"

        elif value_type == fbs.TypeInfoValue.TypeInfoValue.sequence_type:
            sequence_type = fbs.SequenceType.SequenceType()
            sequence_type.Init(value.Bytes, value.Pos)
            elem_type = sequence_type.ElemType()  # TypeInfo
            elem_type_str = FbsTypeInfo.typeinfo_to_str(elem_type)
            # TODO: Decide if we need to wrap the type in a std::vector. Issue is that the element type is internal
            # to the onnxruntime::Tensor class so we're really returning the type inside the Tensor not vector<Tensor>.
            # For now, return the element type (which will be the Tensor element type, or a map<A,B>) as
            # an operator input or output will either be a sequence or a not, so we don't need to disambiguate
            # between the two (i.e. we know if the returned value refers to the contents of a sequence, and can
            # handle whether it's the element type of a Tensor in the sequence, or the map type in a sequence of maps
            # due to this).
            type_str = elem_type_str
        else:
            raise ValueError(f"Unknown or missing value type of {value_type}")

        return type_str


def get_typeinfo(name: str, value_name_to_typeinfo: dict) -> fbs.TypeInfo:
    "Lookup a name in a dictionary mapping value name to TypeInfo."
    if name not in value_name_to_typeinfo:
        raise RuntimeError("Missing TypeInfo entry for " + name)

    return value_name_to_typeinfo[name]  # TypeInfo object


def value_name_to_typestr(name: str, value_name_to_typeinfo: dict):
    "Lookup TypeInfo for value name and convert to a string representing the C++ type."
    type = get_typeinfo(name, value_name_to_typeinfo)
    type_str = FbsTypeInfo.typeinfo_to_str(type)
    return type_str
