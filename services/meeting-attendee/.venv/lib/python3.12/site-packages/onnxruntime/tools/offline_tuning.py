# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

import argparse
import copy
import json
import sys
from collections import OrderedDict
from pprint import pprint
from typing import Any

import onnx

TuningResults = dict[str, Any]

_TUNING_RESULTS_KEY = "tuning_results"


def _find_tuning_results_in_props(metadata_props):
    for idx, prop in enumerate(metadata_props):
        if prop.key == _TUNING_RESULTS_KEY:
            return idx
    return -1


def extract(model: onnx.ModelProto):
    idx = _find_tuning_results_in_props(model.metadata_props)
    if idx < 0:
        return None

    tuning_results_prop = model.metadata_props[idx]
    return json.loads(tuning_results_prop.value)


def embed(model: onnx.ModelProto, tuning_results: list[TuningResults], overwrite=False):
    idx = _find_tuning_results_in_props(model.metadata_props)
    assert overwrite or idx <= 0, "the supplied onnx file already have tuning results embedded!"

    if idx >= 0:
        model.metadata_props.pop(idx)

    entry = model.metadata_props.add()
    entry.key = _TUNING_RESULTS_KEY
    entry.value = json.dumps(tuning_results)
    return model


class Merger:
    class EpAndValidators:
        def __init__(self, ep: str, validators: dict[str, str]):
            self.ep = ep
            self.validators = copy.deepcopy(validators)
            self.key = (ep, tuple(sorted(validators.items())))

        def __hash__(self):
            return hash(self.key)

        def __eq__(self, other):
            return self.ep == other.ep and self.key == other.key

    def __init__(self):
        self.ev_to_results = OrderedDict()

    def merge(self, tuning_results: list[TuningResults]):
        for trs in tuning_results:
            self._merge_one(trs)

    def get_merged(self):
        tuning_results = []
        for ev, flat_results in self.ev_to_results.items():
            results = {}
            trs = {
                "ep": ev.ep,
                "validators": ev.validators,
                "results": results,
            }
            for (op_sig, params_sig), kernel_id in flat_results.items():
                kernel_map = results.setdefault(op_sig, {})
                kernel_map[params_sig] = kernel_id
            tuning_results.append(trs)
        return tuning_results

    def _merge_one(self, trs: TuningResults):
        ev = Merger.EpAndValidators(trs["ep"], trs["validators"])
        flat_results = self.ev_to_results.setdefault(ev, {})
        for op_sig, kernel_map in trs["results"].items():
            for params_sig, kernel_id in kernel_map.items():
                if (op_sig, params_sig) not in flat_results:
                    flat_results[(op_sig, params_sig)] = kernel_id


def parse_args():
    parser = argparse.ArgumentParser()
    sub_parsers = parser.add_subparsers(help="Command to execute", dest="cmd")

    extract_parser = sub_parsers.add_parser("extract", help="Extract embedded tuning results from an onnx file.")
    extract_parser.add_argument("input_onnx")
    extract_parser.add_argument("output_json")

    embed_parser = sub_parsers.add_parser("embed", help="Embed the tuning results into an onnx file.")
    embed_parser.add_argument("--force", "-f", action="store_true", help="Overwrite the tuning results if it existed.")
    embed_parser.add_argument("output_onnx", help="Path of the output onnx file.")
    embed_parser.add_argument("input_onnx", help="Path of the input onnx file.")
    embed_parser.add_argument("input_json", nargs="+", help="Path(s) of the tuning results file(s) to be embedded.")

    merge_parser = sub_parsers.add_parser("merge", help="Merge multiple tuning results files as a single one.")
    merge_parser.add_argument("output_json", help="Path of the output tuning results file.")
    merge_parser.add_argument("input_json", nargs="+", help="Paths of the tuning results files to be merged.")

    pprint_parser = sub_parsers.add_parser("pprint", help="Pretty print the tuning results.")
    pprint_parser.add_argument("json_or_onnx", help="A tuning results json file or an onnx file.")

    args = parser.parse_args()
    if len(vars(args)) == 0:
        parser.print_help()
        exit(-1)
    return args


def main():
    args = parse_args()
    if args.cmd == "extract":
        tuning_results = extract(onnx.load_model(args.input_onnx))
        if tuning_results is None:
            sys.stderr.write(f"{args.input_onnx} does not have tuning results embedded!\n")
            sys.exit(-1)
        json.dump(tuning_results, open(args.output_json, "w"))  # noqa: SIM115
    elif args.cmd == "embed":
        model = onnx.load_model(args.input_onnx)
        merger = Merger()
        for tuning_results in [json.load(open(f)) for f in args.input_json]:  # noqa: SIM115
            merger.merge(tuning_results)
        model = embed(model, merger.get_merged(), args.force)
        onnx.save_model(model, args.output_onnx)
    elif args.cmd == "merge":
        merger = Merger()
        for tuning_results in [json.load(open(f)) for f in args.input_json]:  # noqa: SIM115
            merger.merge(tuning_results)
        json.dump(merger.get_merged(), open(args.output_json, "w"))  # noqa: SIM115
    elif args.cmd == "pprint":
        tuning_results = None
        try:  # noqa: SIM105
            tuning_results = json.load(open(args.json_or_onnx))  # noqa: SIM115
        except Exception:
            # it might be an onnx file otherwise, try it latter
            pass

        if tuning_results is None:
            try:
                model = onnx.load_model(args.json_or_onnx)
                tuning_results = extract(model)
                if tuning_results is None:
                    sys.stderr.write(f"{args.input_onnx} does not have tuning results embedded!\n")
                    sys.exit(-1)
            except Exception:
                pass

        if tuning_results is None:
            sys.stderr.write(f"{args.json_or_onnx} is not a valid tuning results file or onnx file!")
            sys.exit(-1)

        pprint(tuning_results)
    else:
        # invalid choice will be handled by the parser
        pass


if __name__ == "__main__":
    main()
