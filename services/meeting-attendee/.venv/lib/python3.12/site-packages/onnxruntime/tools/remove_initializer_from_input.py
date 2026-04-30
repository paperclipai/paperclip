import argparse

import onnx


def get_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="input model")
    parser.add_argument("--output", required=True, help="output model")
    args = parser.parse_args()
    return args


def remove_initializer_from_input(model: onnx.ModelProto) -> bool:
    if model.ir_version < 4:
        print("Model with ir_version below 4 requires to include initializer in graph input")
        return False

    inputs = model.graph.input
    name_to_input = {}
    for input in inputs:
        name_to_input[input.name] = input

    modified = False
    for initializer in model.graph.initializer:
        if initializer.name in name_to_input:
            modified = True
            inputs.remove(name_to_input[initializer.name])

    return modified


if __name__ == "__main__":
    args = get_args()
    model = onnx.load(args.input)
    remove_initializer_from_input(model)
    onnx.save(model, args.output)
