#!/usr/bin/env python3
"""Census: does the design guide's component inventory match reality?

Answers a question the guide asserts about itself but never checks. It makes
three hand-duplicated inventories out of one list of components:

  A = disk    every component module under ui/src/components (recursive)
  B = index   .claude/skills/design-guide/references/component-index.md
  C = page    the "Component Coverage" roster in ui/src/pages/DesignGuide.tsx

SKILL.md sec.10 rule 1 ("when you add a new reusable component you MUST add it
to the design guide page") and sec.11 ("add it to the component index") tell an
author to update TWO places. There are THREE lists, and the third is the one
that actually defines what the page claims to cover.

Exit status is 1 when the three disagree, so this can gate CI once the
board decides how strict to be (K-20207). Set --warn to report without failing.

Two extraction traps this script exists to avoid -- both produced wrong
numbers in earlier drafts and are the reason to prefer structured comparison
over parsing prose:

  * `variant="outline"` and `variant="ghost"` on the Badge wrapper of the
    coverage roster look exactly like roster entries. Parse the JS array
    literal, not every quoted string in the block.
  * Component modules live in subdirectory barrels, e.g.
    components/environment-variables-editor/index.tsx. A flat os.listdir
    reports EnvironmentVariablesEditor as a component that does not exist.
    Walk recursively and also index exported symbols.
"""
import argparse
import json
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class CensusInputError(RuntimeError):
    """A source this census depends on no longer looks the way it expects.

    Distinct from drift. Every caller reports it as "I could not read the
    inputs", never as "the inventories agree" -- a census that reports clean
    because it stopped looking is worse than no census at all.
    """

COMPONENTS = os.path.join(REPO, "ui/src/components")
INDEX = os.path.join(REPO, ".claude/skills/design-guide/references/component-index.md")
PAGE = os.path.join(REPO, "ui/src/pages/DesignGuide.tsx")

INDEX_SECTIONS = (
    "## Custom Components",
    "## Layout Components",
    "## Dialog & Form Components",
    "## Property Panel Components",
    "## Agent Configuration",
)


def walk_modules(directory):
    """Component basenames under `directory`, excluding tests and stories."""
    found = set()
    for root, _, files in os.walk(directory):
        for name in files:
            if not name.endswith(".tsx") or ".test." in name or ".spec." in name:
                continue
            found.add(name[:-4])
    return found


def exported_symbols(directory):
    """Every exported PascalCase symbol defined anywhere under `directory`."""
    symbols = set()
    for root, _, files in os.walk(directory):
        for name in files:
            if not name.endswith((".tsx", ".ts")) or ".test." in name:
                continue
            try:
                with open(os.path.join(root, name), errors="ignore") as handle:
                    source = handle.read().replace("\n", " ")
            except OSError:
                continue
            symbols.update(re.findall(
                r"export\s+(?:const|function|class)\s+([A-Z][A-Za-z0-9_]*)", source))
            for group in re.findall(r"export\s*\{([^}]*)\}", source):
                symbols.update(
                    part.strip().split(" as ")[-1].strip()
                    for part in group.split(",") if part.strip())
    return symbols


def section(text, header):
    if header not in text:
        raise CensusInputError(
            f'component-index.md is missing the "{header}" heading, so the '
            'documented inventory cannot be read.')
    return text.split(header)[1].split("\n## ")[0]


def roster_arrays(page_text):
    """The two hardcoded name arrays inside DesignGuide's coverage section.

    Parsed as JS array literals so a `variant="outline"` prop on the wrapper
    Badge cannot be mistaken for a component name.
    """
    if '<Section title="Component Coverage">' not in page_text:
        raise CensusInputError(
            'DesignGuide.tsx has no <Section title="Component Coverage">. The '
            'page was restructured, so this script no longer knows where the '
            'roster lives -- fix the markers here rather than reading an empty '
            'roster as "no drift".')
    block = page_text.split('<Section title="Component Coverage">')[1]
    block = block.split("</Section>")[0]
    for marker in ('title="UI primitives"', 'title="App components"'):
        if marker not in block:
            raise CensusInputError(
                f'The Component Coverage section is missing {marker}.')
    ui_part = block.split('title="UI primitives"')[1]
    app_part = block.split('title="App components"')[1]

    def names(fragment, label):
        match = re.search(r"\{\s*\[(.*?)\]\s*\.map", fragment, re.S)
        if not match:
            raise CensusInputError(
                f'The {label} roster no longer matches the expected '
                '[...].map array shape, so its names cannot be read.')
        found = set(re.findall(r'"([^"]+)"', match.group(1)))
        if not found:
            raise CensusInputError(f'The {label} roster parsed as empty.')
        return found

    return (names(ui_part.split('title="App components"')[0], "UI primitives"),
            names(app_part, "App components"))


def index_inventory(index_text):
    """Names the index documents, and the files it points them at.

    A component is "in the index" if EITHER its `### Name` heading is present
    OR a documented file is named after it. Both are needed: the roster lists
    component names, but a component may live in a differently-named module
    (BuiltInLifecycleChip lives in BuiltInAgentBadges.tsx), and a barrel
    directory is documented by path rather than by a flat .tsx name. Matching
    on filename alone reports both as missing when they are documented.
    """
    primitives = set(re.findall(
        r"`([a-z0-9\-]+)\.tsx`",
        section(index_text, "## shadcn/ui Primitives").split("\n## ")[0]))
    documented = set()
    for header in INDEX_SECTIONS:
        body = section(index_text, header)
        # `### ComponentName` headings, plus table-row first cells
        documented.update(re.findall(r"^###\s+([A-Za-z0-9_]+)\s*$", body, re.M))
        documented.update(m[:-4] for m in re.findall(r"`([A-Za-z0-9_]+\.tsx)`", body))
        documented.update(os.path.basename(f)[:-4] for f in re.findall(
            r"\*\*File:\*\*\s*`([A-Za-z0-9_\-./]+\.tsx)`", body))
    documented = {d.replace(".production", "") for d in documented}
    return primitives, documented


# Which disagreements are actual contract violations, per surface.

# Primitives: the shadcn table IS the vocabulary list a developer learns from and
# the page roster claims to cover "UI primitives", so all five directions bind.
# There are 26 primitives and every one of them is meant to be reusable.
PRIMITIVE_BINDING = (
    "on_disk_missing_from_index",
    "on_disk_missing_from_page_roster",
    "roster_names_with_no_such_component",
    "in_index_missing_from_page_roster",
    "on_page_roster_missing_from_index",
)

# App components: only two directions bind.
#   * A roster name with no such component is a phantom badge on a live page.
#   * A roster name with no index entry breaks the guide's own "you MUST add it
#     to the component index" rule -- the roster commits the guide to a claim
#     it has not documented.
# The other three are NOT violations and must not be counted as drift:
#   * on_disk_missing_from_index -- SKILL.md sec.6 says "Do NOT create a
#     component for one-off layouts specific to a single page", so the several
#     hundred page-local modules below ui/src/components are the convention
#     working. Calling that gap drift would be a false positive on ~95% of the
#     surface.
#   * on_disk_missing_from_page_roster -- the page roster is a curated showcase,
#     not a coverage claim. It is not supposed to list every component.
#   * in_index_missing_from_page_roster -- documented is not the same as
#     showcased. The index is reference documentation; the page is a gallery.
#
# This scoping is load-bearing: an earlier draft treated all five directions as
# drift on both surfaces, which made the script permanently red. A guard that can
# never go green is not a guard, it is a permanent CI failure nobody can action.
COMPOSITE_BINDING = (
    "roster_names_with_no_such_component",
    "on_page_roster_missing_from_index",
)


def index_export_claims(index_text):
    """Export names each primitive row asserts, for the cells that assert a list.

    The shadcn table is the vocabulary list a developer learns from, and a name
    in it gets copied into an import. Three rows in this file's first draft
    promised identifiers the modules never exported (`AttachmentIcon`,
    `Panel`/`PanelGroup`/`PanelResizeHandle`), so following the guidance produced
    code that does not compile. The three-way name census cannot see this: it
    compares component names, not the export names printed beside them, which is
    why the errors survived a green run.

    Only cells that are *structurally* a list of identifiers are read. "Key
    Props" is a mixed column -- some rows list exports (`DialogTrigger,
    DialogContent`), others describe props in prose (`className for sizing`) --
    so the test is whether every comma-separated segment is a PascalCase
    identifier. Rows that fail it are skipped rather than guessed at, because a
    false accusation is worse than an unchecked row: this file has been wrong
    about its own scope before.
    """
    claims = {}
    for line in section(index_text, "## shadcn/ui Primitives").splitlines():
        cells = [cell.strip() for cell in line.split("|")]
        if len(cells) < 4 or not cells[1] or set(cells[1]) <= set("- "):
            continue
        module = re.fullmatch(r"`([a-z0-9\-]+)\.tsx`", cells[2])
        if not module:
            continue
        cell = cells[3].replace("`", "").strip()
        if not cell or cell == "\u2014":
            continue
        segments = [part.strip() for part in cell.split(",")]
        if not segments or not all(
            re.fullmatch(r"[A-Z][A-Za-z0-9_]*", part) for part in segments):
            continue
        claims[module.group(1)] = set(segments)
    return claims


def export_names(module_path):
    """PascalCase identifiers a module exports, or None when unreadable."""
    try:
        with open(module_path, errors="ignore") as handle:
            source = handle.read()
    except OSError as error:
        raise CensusInputError(
            f"cannot read {module_path}: {error}. The export check compares "
            "documented names against module source.") from error
    names = set(re.findall(
        r"export\s+(?:const|function|class|interface|type)\s+([A-Z][A-Za-z0-9_]*)",
        source))
    for group in re.findall(r"export\s*\{([^}]*)\}", source):
        for part in group.split(","):
            if part.strip():
                names.add(part.strip().split(" as ")[-1].strip())
    return names


def unbacked_export_claims(index_text, primitives_dir):
    """Documented export names the module does not export, per module."""
    unsupported = {}
    for module, claimed in index_export_claims(index_text).items():
        path = os.path.join(primitives_dir, f"{module}.tsx")
        if not os.path.exists(path):
            continue
        actual = export_names(path)
        bogus = sorted(claimed - actual)
        if bogus:
            unsupported[module] = bogus
    return unsupported


def compare(disk, indexed, roster, label, known, binding):
    """One surface's three-way comparison, with only real disagreements kept."""
    present = lambda n: n in known or n in disk
    return {
        "surface": label,
        "counts": {
            "on_disk": len(disk),
            "in_index": len(indexed),
            "on_page_roster": len(roster),
            "agree_in_all_three": len(disk & indexed & roster),
        },
        "on_disk_missing_from_index": sorted(disk - indexed),
        "on_disk_missing_from_page_roster": sorted(disk - roster),
        "roster_names_with_no_such_component": sorted(
            n for n in roster - disk if not present(n)),
        "in_index_missing_from_page_roster": sorted(indexed - roster),
        "on_page_roster_missing_from_index": sorted(roster - indexed),
        "binding": list(binding),
        # Only non-empty binding violations are kept here. `any(drift)` over a dict
        # of key -> [] is truthy for a dict that has keys, so an all-clean surface
        # would still report DRIFT; test the values, not the mapping.
        "drift": {k: sorted(v) for k, v in (
            ("on_disk_missing_from_index", disk - indexed),
            ("on_disk_missing_from_page_roster", disk - roster),
            ("roster_names_with_no_such_component",
             {n for n in roster - disk if not present(n)}),
            ("in_index_missing_from_page_roster", indexed - roster),
            ("on_page_roster_missing_from_index", roster - indexed),
        ) if k in binding and v},
    }


def read_input(path):
    try:
        with open(path, errors="ignore") as handle:
            return handle.read()
    except OSError as error:
        raise CensusInputError(
            f"cannot read {path}: {error}. The census compares named inputs; if "
            "one of them moved or was deleted, this script needs its path "
            "updated rather than reporting drift.") from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--warn", action="store_true",
                        help="report drift but always exit 0")
    parser.add_argument("--json", action="store_true", help="machine-readable output")
    args = parser.parse_args()

    index_text = read_input(INDEX)
    page_text = read_input(PAGE)

    modules = walk_modules(COMPONENTS)
    symbols = exported_symbols(COMPONENTS)
    primitives = walk_modules(os.path.join(COMPONENTS, "ui"))
    composites = modules - primitives

    idx_prim, idx_comp = index_inventory(index_text)
    roster_prim, roster_comp = roster_arrays(page_text)

    if not idx_prim:
        raise CensusInputError(
            "component-index.md yielded no shadcn/ui primitive names; the "
            "primitives table is probably empty or restructured.")

    unbacked = unbacked_export_claims(index_text, os.path.join(COMPONENTS, "ui"))

    report = {
        "primitives": compare(primitives, idx_prim, roster_prim,
                              "shadcn/ui primitives", symbols, PRIMITIVE_BINDING),
        "composites": compare(composites, idx_comp, roster_comp,
                              "app components", symbols, COMPOSITE_BINDING),
    }
    if unbacked:
        report["primitives"]["export_names_not_exported"] = unbacked
        report["primitives"]["drift"]["export_names_not_exported"] = sorted(unbacked)
    drifted = any(surface["drift"] for surface in report.values())

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        for surface in report.values():
            counts = surface["counts"]
            print(f"\n== {surface['surface']} ==")
            print(f"   on disk {counts['on_disk']:>4}   in index {counts['in_index']:>3}"
                  f"   on page roster {counts['on_page_roster']:>3}"
                  f"   agree in all three {counts['agree_in_all_three']:>3}")
            for key in ("export_names_not_exported",
                        "roster_names_with_no_such_component",
                        "on_disk_missing_from_index",
                        "on_disk_missing_from_page_roster",
                        "on_page_roster_missing_from_index",
                        "in_index_missing_from_page_roster"):
                items = surface.get(key) or []
                if items:
                    if isinstance(items, dict):
                        shown = "; ".join(
                            f"{module}: {', '.join(names)}"
                            for module, names in sorted(items.items()))
                    else:
                        shown = ", ".join(items[:8]) + (" ..." if len(items) > 8 else "")
                    # export_names_not_exported is deliberately absent from
                    # `binding` (it only ever exists on the primitives surface),
                    # but it is a real violation, not an out-of-scope count.
                    if key == "export_names_not_exported" or key in surface["binding"]:
                        tag = ""
                    else:
                        tag = "  (out of scope, not drift)"
                    print(f"   {key} ({len(items)}): {shown}{tag}")
        if drifted:
            print("\nDRIFT (only binding directions count; see PRIMITIVE_BINDING/"
                  "COMPOSITE_BINDING in this file)")
            for surface in report.values():
                for key, items in surface["drift"].items():
                    if isinstance(items, dict):
                        detail = "; ".join(
                            f"{module}: {', '.join(names)}"
                            for module, names in sorted(items.items()))
                        print(f"   {surface['surface']}: {key} ({len(items)}): {detail}")
                    else:
                        print(f"   {surface['surface']}: {key} ({len(items)}): "
                              + ", ".join(items[:12]) + (" ..." if len(items) > 12 else ""))
        else:
            print("\nIN SYNC")

    return 0 if (args.warn or not drifted) else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except CensusInputError as error:
        # Exit 3, not 1: an unreadable input is not drift, and a caller that
        # watches for a red exit must be able to tell "the guide disagrees with
        # itself" from "this script needs updating for a page restructure".
        print(f"CANNOT READ INPUTS: {error}", file=sys.stderr)
        sys.exit(3)
