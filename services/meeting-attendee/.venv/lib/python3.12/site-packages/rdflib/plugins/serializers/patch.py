from __future__ import annotations

import warnings
from typing import IO, Any, Optional
from uuid import uuid4

from rdflib import Dataset
from rdflib.plugins.serializers.nquads import _nq_row
from rdflib.plugins.serializers.nt import _nt_row
from rdflib.serializer import Serializer

add_remove_methods = {"add": "A", "remove": "D"}


class PatchSerializer(Serializer):
    """
    Creates an RDF patch file to add and remove triples/quads.
    Can either:
    - Create an add or delete patch for a single Dataset.
    - Create a patch to represent the difference between two Datasets.
    """

    def __init__(
        self,
        store: Dataset,
    ):
        self.store: Dataset = store
        super().__init__(store)

    def serialize(
        self,
        stream: IO[bytes],
        base: Optional[str] = None,
        encoding: Optional[str] = None,
        **kwargs: Any,
    ) -> None:
        """Serialize the store to the given stream.

        Args:
            stream: The stream to serialize to.
            base: The base URI to use for the serialization.
            encoding: The encoding to use for the serialization.
            kwargs: Additional keyword arguments.

        Supported keyword arguments:

        - operation: The operation to perform. Either 'add' or 'remove'.
        - target: The target Dataset to compare against.
        NB: Only one of 'operation' or 'target' should be provided.
        - header_id: The header ID to use.
        - header_prev: The previous header ID to use.
        """
        operation = kwargs.get("operation")
        target = kwargs.get("target")
        header_id = kwargs.get("header_id")
        header_prev = kwargs.get("header_prev")
        if not header_id:
            header_id = f"uuid:{uuid4()}"
        encoding = self.encoding
        if base is not None:
            warnings.warn("PatchSerializer does not support base.")
        if encoding is not None and encoding.lower() != self.encoding.lower():
            warnings.warn(
                "PatchSerializer does not use custom encoding. "
                f"Given encoding was: {encoding}"
            )

        def write_header():
            stream.write(f"H id <{header_id}> .\n".encode(encoding, "replace"))
            if header_prev:
                stream.write(f"H prev <{header_prev}>\n".encode(encoding, "replace"))
            stream.write("TX .\n".encode(encoding, "replace"))

        def write_triples(contexts, op_code, use_passed_contexts=False):
            for context in contexts:
                if not use_passed_contexts:
                    context = self.store.get_context(context.identifier)
                for triple in context:
                    stream.write(
                        self._patch_row(triple, context.identifier, op_code).encode(
                            encoding, "replace"
                        )
                    )

        if operation:
            assert operation in add_remove_methods, f"Invalid operation: {operation}"
        elif not target:
            # No operation specified and no target specified
            # Fall back to default operation of "add" to prevent a no-op
            operation = "add"
        write_header()
        if operation:
            operation_code = add_remove_methods.get(operation)
            write_triples(self.store.contexts(), operation_code)
        elif target:
            to_add, to_remove = self._diff(target)
            write_triples(to_add.contexts(), "A", use_passed_contexts=True)
            write_triples(to_remove.contexts(), "D", use_passed_contexts=True)

        stream.write("TC .\n".encode(encoding, "replace"))

    def _diff(self, target):
        rows_to_add = target - self.store
        rows_to_remove = self.store - target
        return rows_to_add, rows_to_remove

    def _patch_row(self, triple, context_id, operation):
        if context_id == self.store.default_context.identifier:
            return f"{operation} {_nt_row(triple)}"
        else:
            return f"{operation} {_nq_row(triple, context_id)}"
