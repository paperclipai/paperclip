"""
A parse tree.
"""
import dataclasses
from collections.abc import Iterable

from segments.errors import replace


@dataclasses.dataclass
class TreeNode:
    """
    Private class that creates the tree data structure from the orthography profile for
    parsing.
    """
    char: str
    children: dict[str, 'TreeNode'] = dataclasses.field(default_factory=dict)
    sentinel: bool = False


class Tree:  # pylint: disable=R0903
    """
    The parse tree.

    >>> t = Tree('abcdefg')
    >>> t.parse('abcde')
    ['a', 'b', 'c', 'd', 'e']
    >>> t = Tree(['ab', 'c', 'de'])
    >>> t.parse('abcde')
    ['ab', 'c', 'de']
    """
    def __init__(self, graphemes: Iterable[str]):
        def _multigraph(node, line):
            # Internal function to add a multigraph starting at node.
            for char in line:
                node = node.children.setdefault(char, TreeNode(char))
            node.sentinel = True

        self.root = TreeNode('', sentinel=True)
        for grapheme in graphemes:
            _multigraph(self.root, grapheme)

    def parse(self, line: str, error=replace) -> list[str]:
        """Segment `line` into graphemes."""
        res, idx = self._parse(self.root, line, 0)
        rem = line[idx:]
        while rem:
            # Chop off one character and try parsing the remainder:
            res.append(error(rem[0]))
            rem = rem[1:]
            r, i = self._parse(self.root, rem, 0)
            res.extend(r)
            rem = rem[i:]
        return res

    def _parse(self, root: TreeNode, line: str, idx: int) -> tuple[list[str], int]:
        """
        :param root: Tree node.
        :param line: String to parse.
        :param idx: Global counter of characters parsed.
        :return: (list of parsed graphemes, incremented character count)
        """
        # Base (or degenerate..) case.
        if len(line) == 0:
            return [], idx

        parse = []
        curr = 0
        node = root
        cidx = idx
        while curr < len(line):
            node = node.children.get(line[curr])
            curr += 1
            if not node:
                break
            if node.sentinel:
                subparse, cidx = self._parse(root, line[curr:], idx + curr)
                # Always keep the latest valid parse, which will be
                # the longest-matched (greedy match) graphemes.
                parse = [line[:curr]]
                parse.extend(subparse)
        if parse:
            idx = cidx
        return parse, idx
