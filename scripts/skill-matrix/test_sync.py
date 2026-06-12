# scripts/skill-matrix/test_sync.py
import sync

def test_compute_diff_add_and_remove():
    cur = ["paperclip", "online-recherche", "comfyui-flux"]
    tgt = ["paperclip", "whitestag-brand"]
    add, remove = sync.compute_diff(cur, tgt)
    assert add == ["whitestag-brand"]
    assert sorted(remove) == ["comfyui-flux", "online-recherche"]

def test_resolve_prefers_existing_ref():
    refmap = {"whitestag-brand": "local/abc123/whitestag-brand"}
    installed = {"copywriting"}
    assert sync.resolve("whitestag-brand", refmap, installed) == "local/abc123/whitestag-brand"
    # installierter Company-Skill ohne vorhandene Ref -> reiner Slug
    assert sync.resolve("copywriting", refmap, installed) == "copywriting"

def test_resolve_unknown_raises():
    try:
        sync.resolve("does-not-exist", {}, set())
        assert False, "sollte werfen"
    except ValueError:
        pass
