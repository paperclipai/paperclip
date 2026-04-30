"""
This file provides a single function `serialize_in_chunks()` which can serialize a
Graph into a number of NT files with a maximum number of triples or maximum file size.

There is an option to preserve any prefixes declared for the original graph in the first
file, which will be a Turtle file.
"""

from __future__ import annotations

from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import TYPE_CHECKING, BinaryIO, Generator, Optional, Tuple

from rdflib.graph import Graph
from rdflib.plugins.serializers.nt import _nt_row

# from rdflib.term import Literal

# if TYPE_CHECKING:
#     from rdflib.graph import _TriplePatternType

__all__ = ["serialize_in_chunks"]


def serialize_in_chunks(
    g: Graph,
    max_triples: int = 10000,
    max_file_size_kb: Optional[int] = None,
    file_name_stem: str = "chunk",
    output_dir: Optional[Path] = None,
    write_prefixes: bool = False,
) -> None:
    """Serializes a given Graph into a series of n-triples with a given length.

    Args:
        g: The graph to serialize.
        max_file_size_kb: Maximum size per NT file in kB (1,000 bytes)
            Equivalent to ~6,000 triples, depending on Literal sizes.
        max_triples: Maximum size per NT file in triples
            Equivalent to lines in file.
            If both this parameter and max_file_size_kb are set, max_file_size_kb will be used.
        file_name_stem: Prefix of each file name.
            e.g. "chunk" = chunk_000001.nt, chunk_000002.nt...
        output_dir: The directory you want the files to be written to.
        write_prefixes: The first file created is a Turtle file containing original graph prefixes.

    See `../test/test_tools/test_chunk_serializer.py` for examples of this in use.
    """

    if output_dir is None:
        output_dir = Path.cwd()

    if not output_dir.is_dir():
        raise ValueError(
            "If you specify an output_dir, it must actually be a directory!"
        )

    @contextmanager
    def _start_new_file(file_no: int) -> Generator[Tuple[Path, BinaryIO], None, None]:
        if TYPE_CHECKING:
            # this is here because mypy gets a bit confused
            assert output_dir is not None
        fp = Path(output_dir) / f"{file_name_stem}_{str(file_no).zfill(6)}.nt"
        with open(fp, "wb") as fh:
            yield fp, fh

    def _serialize_prefixes(g: Graph) -> str:
        pres = []
        for k, v in g.namespace_manager.namespaces():
            pres.append(f"PREFIX {k}: <{v}>")

        return "\n".join(sorted(pres)) + "\n"

    if write_prefixes:
        with open(
            Path(output_dir) / f"{file_name_stem}_000000.ttl", "w", encoding="utf-8"
        ) as fh:
            fh.write(_serialize_prefixes(g))

    bytes_written = 0
    with ExitStack() as xstack:
        if max_file_size_kb is not None:
            max_file_size = max_file_size_kb * 1000
            file_no = 1 if write_prefixes else 0
            for i, t in enumerate(g.triples((None, None, None))):
                row_bytes = _nt_row(t).encode("utf-8")
                if len(row_bytes) > max_file_size:
                    raise ValueError(
                        # type error: Unsupported operand types for / ("bytes" and "int")
                        f"cannot write triple {t!r} as it's serialized size of {row_bytes / 1000} exceeds max_file_size_kb = {max_file_size_kb}"  # type: ignore[operator]
                    )
                if i == 0:
                    fp, fhb = xstack.enter_context(_start_new_file(file_no))
                    bytes_written = 0
                elif (bytes_written + len(row_bytes)) >= max_file_size:
                    file_no += 1
                    fp, fhb = xstack.enter_context(_start_new_file(file_no))
                    bytes_written = 0

                bytes_written += fhb.write(row_bytes)

        else:
            # count the triples in the graph
            graph_length = len(g)

            if graph_length <= max_triples:
                # the graph is less than max so just NT serialize the whole thing
                g.serialize(
                    destination=Path(output_dir) / f"{file_name_stem}_all.nt",
                    format="nt",
                )
            else:
                # graph_length is > max_lines, make enough files for all graph
                # no_files = math.ceil(graph_length / max_triples)
                file_no = 1 if write_prefixes else 0
                for i, t in enumerate(g.triples((None, None, None))):
                    if i % max_triples == 0:
                        fp, fhb = xstack.enter_context(_start_new_file(file_no))
                        file_no += 1
                    fhb.write(_nt_row(t).encode("utf-8"))
            return
