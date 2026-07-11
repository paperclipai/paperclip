from dataclasses import dataclass, field

@dataclass
class ApplyLog:
    applied: list = field(default_factory=list)
    skipped: list = field(default_factory=list)

def apply_changeset(changeset, client, dry_run=False) -> ApplyLog:
    log = ApplyLog()
    for c in changeset["changes"]:
        if dry_run:
            log.skipped.append({**c, "reason": "dry-run"})
            continue

        target, fld = c["target"], c["field"]

        if target == "post":
            client.set_yoast_meta(c["id"], fld, c["new"])
        elif target == "page":
            client.set_yoast_meta(c["id"], fld, c["new"], post_type="pages")
        elif target == "media":
            client.set_alt_text(c["id"], c["new"])
        elif target == "site" and fld == "llms_txt":
            client.set_llms_txt(c["new"])
        else:
            log.skipped.append({**c, "reason": f"unbekanntes target/field {target}/{fld}"})
            continue

        log.applied.append({**c})

    return log
