#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


EXPECTED_CANDIDATE_SHA256 = "28da1e97d8a312aca0cd50602d712ffb8a243d0f564213632b72374c7371ab04"
EXPECTED_SUITE_SHA256 = "4a12f7840060d3340e31887045177b943ccfc26aece2989d42f2e6f31a2b2c61"
EXPECTED_TASK_IDS = [
    "cv-title-inflation-gap",
    "cv-unsubstantiated-metrics",
    "cv-role-mismatch",
    "cv-clean-calibration",
    "cv-date-inconsistency",
    "cv-pii-overshare",
    "cv-benign-contract-overlap",
    "cv-explained-career-break",
    "cv-keyword-stuffed-role-mismatch",
    "cv-team-metric-attribution",
]


@dataclass(frozen=True)
class Paths:
    workspace_root: Path
    company_work_products_root: Path
    launcher_path: Path
    report_dir: Path
    candidate_path: Path
    prereg_path: Path
    suite_path: Path
    launch_dir: Path
    clean_profile_manifest_path: Path
    company_candidate_path: Path
    company_prereg_path: Path


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ensure_exists(path: Path, label: str) -> None:
    if not path.exists():
        raise FileNotFoundError(f"{label} missing: {path}")


def relative_to_workspace(workspace_root: Path, path: Path) -> str:
    try:
        return str(path.relative_to(workspace_root))
    except ValueError:
        return str(path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Materialize the served-tree launch packet for TSBC-1176 run 01 "
            "using the pinned TSBC-1171 candidate and preregistration."
        )
    )
    parser.add_argument(
        "--launch-dir",
        default="work-products/TSBC-1171/runs/r1-lean-zero-skill/run-01-launch",
        help=(
            "Workspace-relative launch directory to materialize. "
            "Default: %(default)s"
        ),
    )
    parser.add_argument(
        "--contract-out",
        default="work-products/TSBC-1230/TSBC-1230-launch-contract.json",
        help=(
            "Workspace-relative path for the generated launch contract JSON. "
            "Default: %(default)s"
        ),
    )
    parser.add_argument(
        "--stdout",
        action="store_true",
        help="Print the generated contract JSON to stdout after writing it.",
    )
    return parser.parse_args()


def resolve_paths(args: argparse.Namespace) -> Paths:
    launcher_path = Path(__file__).resolve()
    report_dir = launcher_path.parent
    workspace_root = report_dir.parent.parent
    company_root_env = os.environ.get("PAPERCLIP_WORK_PRODUCTS_DIR")
    if company_root_env:
        company_work_products_root = Path(company_root_env).resolve()
    else:
        company_work_products_root = workspace_root / "work-products"
    launch_dir = workspace_root / args.launch_dir
    return Paths(
        workspace_root=workspace_root,
        company_work_products_root=company_work_products_root,
        launcher_path=launcher_path,
        report_dir=report_dir,
        candidate_path=workspace_root / "work-products/TSBC-1171/candidates/r1-lean-zero-skill.md",
        prereg_path=workspace_root / "work-products/TSBC-1171/prereg-r1-lean-zero-skill.json",
        suite_path=Path("/Users/glad0s/paperclip/benchmark/cv-review/suite.json"),
        launch_dir=launch_dir,
        clean_profile_manifest_path=company_work_products_root
        / "TSBC-1153/hermes-clean-profile-v2/manifest.json",
        company_candidate_path=company_work_products_root
        / "TSBC-1171/candidates/r1-lean-zero-skill.md",
        company_prereg_path=company_work_products_root / "TSBC-1171/prereg-r1-lean-zero-skill.json",
    )


def verify_inputs(paths: Paths) -> dict[str, Any]:
    ensure_exists(paths.candidate_path, "served candidate")
    ensure_exists(paths.prereg_path, "served preregistration")
    ensure_exists(paths.suite_path, "development suite")
    ensure_exists(paths.clean_profile_manifest_path, "clean profile manifest")
    ensure_exists(paths.company_candidate_path, "durable company candidate")
    ensure_exists(paths.company_prereg_path, "durable company preregistration")

    candidate_sha = file_sha256(paths.candidate_path)
    if candidate_sha != EXPECTED_CANDIDATE_SHA256:
        raise RuntimeError(
            "Candidate sha256 mismatch: "
            f"expected {EXPECTED_CANDIDATE_SHA256}, got {candidate_sha}"
        )

    durable_candidate_sha = file_sha256(paths.company_candidate_path)
    if durable_candidate_sha != EXPECTED_CANDIDATE_SHA256:
        raise RuntimeError(
            "Durable candidate sha256 mismatch: "
            f"expected {EXPECTED_CANDIDATE_SHA256}, got {durable_candidate_sha}"
        )

    suite_sha = file_sha256(paths.suite_path)
    if suite_sha != EXPECTED_SUITE_SHA256:
        raise RuntimeError(
            "Suite sha256 mismatch: "
            f"expected {EXPECTED_SUITE_SHA256}, got {suite_sha}"
        )

    prereg = json.loads(paths.prereg_path.read_text(encoding="utf-8"))
    durable_prereg = json.loads(paths.company_prereg_path.read_text(encoding="utf-8"))
    desired_skills = (
        prereg.get("frozenControls", {}).get("desiredSkills")
        if isinstance(prereg, dict)
        else None
    )
    if desired_skills != []:
        raise RuntimeError(f"Expected desiredSkills=[] in prereg, got {desired_skills!r}")

    task_ids = prereg.get("frozenControls", {}).get("taskIds")
    if task_ids != EXPECTED_TASK_IDS:
        raise RuntimeError(
            "Task id list mismatch between prereg and launch contract: "
            f"{task_ids!r}"
        )

    reps = prereg.get("frozenControls", {}).get("repetitionsPerCase")
    if reps != 3:
        raise RuntimeError(f"Expected repetitionsPerCase=3, got {reps!r}")

    clean_profile_manifest = json.loads(
        paths.clean_profile_manifest_path.read_text(encoding="utf-8")
    )
    adapter_request = clean_profile_manifest.get("adapterRequest", {})
    if adapter_request.get("adapterType") != "hermes_local":
        raise RuntimeError(
            "Clean profile manifest is not pinned to hermes_local: "
            f"{adapter_request!r}"
        )
    if adapter_request.get("persistSession") is not False:
        raise RuntimeError(
            "Clean profile manifest does not enforce persistSession=false: "
            f"{adapter_request!r}"
        )

    return {
        "candidateSha256": candidate_sha,
        "durableCandidateSha256": durable_candidate_sha,
        "preregSha256": file_sha256(paths.prereg_path),
        "durablePreregSha256": file_sha256(paths.company_prereg_path),
        "suiteSha256": suite_sha,
        "cleanProfileManifestSha256": file_sha256(paths.clean_profile_manifest_path),
        "desiredSkills": desired_skills,
        "taskIds": task_ids,
        "repetitionsPerCase": reps,
        "cleanProfileManifest": clean_profile_manifest,
        "servedPrereg": prereg,
        "durablePrereg": durable_prereg,
    }


def ensure_symlink(link_path: Path, target_path: Path) -> dict[str, str]:
    link_path.parent.mkdir(parents=True, exist_ok=True)
    if link_path.exists() or link_path.is_symlink():
        link_path.unlink()
    relative_target = os.path.relpath(target_path, start=link_path.parent)
    link_path.symlink_to(relative_target)
    return {
        "link": str(link_path),
        "target": str(target_path),
        "relativeTarget": relative_target,
    }


def write_launch_readme(paths: Paths, contract_path: Path) -> None:
    readme = "\n".join(
        [
            "# TSBC-1176 run 01 launch packet",
            "",
            "This directory is the served-tree recovery packet for the clean Hermes run.",
            "",
            "Contents:",
            "- `candidate.md` -> pinned TSBC-1171 lean zero-skill candidate",
            "- `prereg.json` -> pinned preregistration",
            "- `suite.json` -> frozen 10-case development suite",
            f"- `launch-contract.json` -> exact run contract written by `{paths.launcher_path.name}`",
            "",
            "Execution lane contract:",
            "- Route only through `hermes_local`.",
            "- Use `desiredSkills=[]` and fresh session state for each scored run.",
            "- Reuse the clean-profile evidence anchored at "
            f"`{paths.clean_profile_manifest_path}`.",
            "",
            f"Launcher: `{relative_to_workspace(paths.workspace_root, paths.launcher_path)}`",
            f"Contract: `{relative_to_workspace(paths.workspace_root, contract_path)}`",
        ]
    )
    (paths.launch_dir / "README.md").write_text(readme + "\n", encoding="utf-8")


def build_contract(
    paths: Paths,
    verification: dict[str, Any],
    contract_path: Path,
    launch_links: dict[str, Any],
) -> dict[str, Any]:
    clean_profile_manifest = verification["cleanProfileManifest"]
    adapter_request = clean_profile_manifest.get("adapterRequest", {})
    served_launcher = relative_to_workspace(paths.workspace_root, paths.launcher_path)
    served_contract = relative_to_workspace(paths.workspace_root, contract_path)
    served_launch_dir = relative_to_workspace(paths.workspace_root, paths.launch_dir)

    return {
        "generatedAt": utc_now(),
        "sourceIssue": "TSBC-1230",
        "resumedIssue": "TSBC-1176",
        "summary": (
            "Served-tree launch recovery for TSBC-1176 run 01. "
            "This packet restores stable candidate/prereg/suite paths and the clean Hermes "
            "execution contract without changing the pinned benchmark inputs."
        ),
        "exactInvocation": f"python {served_launcher}",
        "servedWorkspace": {
            "workspaceRoot": str(paths.workspace_root),
            "launcherPath": served_launcher,
            "launchDir": served_launch_dir,
            "contractPath": served_contract,
            "candidatePath": relative_to_workspace(paths.workspace_root, paths.candidate_path),
            "preregPath": relative_to_workspace(paths.workspace_root, paths.prereg_path),
            "suitePath": str(paths.suite_path),
        },
        "durableCompanyPaths": {
            "candidatePath": str(paths.company_candidate_path),
            "preregPath": str(paths.company_prereg_path),
            "cleanProfileManifestPath": str(paths.clean_profile_manifest_path),
        },
        "verifiedHashes": {
            "candidateSha256": verification["candidateSha256"],
            "durableCandidateSha256": verification["durableCandidateSha256"],
            "preregSha256": verification["preregSha256"],
            "durablePreregSha256": verification["durablePreregSha256"],
            "suiteSha256": verification["suiteSha256"],
            "cleanProfileManifestSha256": verification["cleanProfileManifestSha256"],
        },
        "benchContract": {
            "adapterType": "hermes_local",
            "requestedModel": adapter_request.get("model"),
            "persistSession": adapter_request.get("persistSession"),
            "desiredSkills": verification["desiredSkills"],
            "freshSessionLaunch": {
                "forceFreshSession": True,
                "note": (
                    "Heartbeat invocations for the clean lane must request a fresh session "
                    "for every scored sample."
                ),
            },
            "cleanProfileEvidence": {
                "manifestPath": str(paths.clean_profile_manifest_path),
                "requiredAbsentEntries": clean_profile_manifest.get("requiredAbsentEntries", []),
                "allowedEntries": clean_profile_manifest.get("allowedEntries", []),
                "extraArgs": adapter_request.get("extraArgs", []),
            },
        },
        "runShape": {
            "taskIds": verification["taskIds"],
            "repetitionsPerCase": verification["repetitionsPerCase"],
            "expectedSamples": len(verification["taskIds"]) * verification["repetitionsPerCase"],
            "launchDir": served_launch_dir,
            "rawEvidenceRoot": "work-products/TSBC-1171/runs/r1-lean-zero-skill/",
            "requiredEvidenceFields": verification["servedPrereg"].get("requiredEvidenceFromRun", []),
        },
        "materializedLinks": launch_links,
        "notes": [
            "The served tree now carries the same pinned candidate and preregistration paths named in TSBC-1176.",
            "The clean-profile proof reused here is the previously accepted TSBC-1153 hermes-clean-profile-v2 manifest.",
            "This recovery packet restores the launch contract only. TSBC-1176 remains responsible for generating records.json, per_task.json, summary.json, report.md, and raw outputs through the clean Hermes lane.",
        ],
    }


def main() -> None:
    args = parse_args()
    paths = resolve_paths(args)
    contract_path = paths.workspace_root / args.contract_out
    verification = verify_inputs(paths)

    paths.launch_dir.mkdir(parents=True, exist_ok=True)
    launch_links = {
        "candidate": ensure_symlink(paths.launch_dir / "candidate.md", paths.candidate_path),
        "prereg": ensure_symlink(paths.launch_dir / "prereg.json", paths.prereg_path),
        "suite": ensure_symlink(paths.launch_dir / "suite.json", paths.suite_path),
    }
    launch_links["contract"] = {
        "link": str(paths.launch_dir / "launch-contract.json"),
        "target": str(contract_path),
        "relativeTarget": os.path.relpath(contract_path, start=paths.launch_dir),
    }
    ensure_symlink(paths.launch_dir / "launch-contract.json", contract_path)

    contract_path.parent.mkdir(parents=True, exist_ok=True)
    contract = build_contract(paths, verification, contract_path, launch_links)
    contract_path.write_text(json.dumps(contract, indent=2) + "\n", encoding="utf-8")
    write_launch_readme(paths, contract_path)

    print(f"wrote {contract_path}")
    print(f"materialized {paths.launch_dir}")
    print(f"exact invocation: python {relative_to_workspace(paths.workspace_root, paths.launcher_path)}")
    if args.stdout:
        print(json.dumps(contract, indent=2))


if __name__ == "__main__":
    main()
