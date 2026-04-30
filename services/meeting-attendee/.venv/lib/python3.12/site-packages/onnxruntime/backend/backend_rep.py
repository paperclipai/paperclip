# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
"""
Implements ONNX's backend API.
"""

from onnx.backend.base import BackendRep

from onnxruntime import RunOptions


class OnnxRuntimeBackendRep(BackendRep):
    """
    Computes the prediction for a pipeline converted into
    an :class:`onnxruntime.InferenceSession` node.
    """

    def __init__(self, session):
        """
        :param session: :class:`onnxruntime.InferenceSession`
        """
        self._session = session

    def run(self, inputs, **kwargs):  # type: (Any, **Any) -> Tuple[Any, ...]
        """
        Computes the prediction.
        See :meth:`onnxruntime.InferenceSession.run`.
        """

        options = RunOptions()
        for k, v in kwargs.items():
            if hasattr(options, k):
                setattr(options, k, v)

        if isinstance(inputs, list):
            inps = {}
            for i, inp in enumerate(self._session.get_inputs()):
                inps[inp.name] = inputs[i]
            outs = self._session.run(None, inps, options)
            if isinstance(outs, list):
                return outs
            else:
                output_names = [o.name for o in self._session.get_outputs()]
                return [outs[name] for name in output_names]
        else:
            inp = self._session.get_inputs()
            if len(inp) != 1:
                raise RuntimeError(f"Model expect {len(inp)} inputs")
            inps = {inp[0].name: inputs}
            return self._session.run(None, inps, options)
