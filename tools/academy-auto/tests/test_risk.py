from academy_auto.config import Config
from academy_auto.risk import GREEN, YELLOW, classify


def _cfg(**over):
    base = dict(Config.default().__dict__)
    base.update(over)
    return Config(**base)


def test_only_source_and_tests_is_green():
    r = classify(_cfg(), ["src/app/login.tsx", "tests/screens/login.test.tsx"], diff_lines=42)
    assert r.level == GREEN


def test_empty_change_is_yellow():
    """Kein Diff heisst: die Einstufung hat nichts gesehen. Nicht mergen."""
    assert classify(_cfg(), [], diff_lines=0).level == YELLOW


def test_dependency_or_build_config_is_yellow():
    """package.json, tsconfig, app.json, CI, native Ordner: alles, was Build,
    Abhaengigkeiten oder Auslieferung veraendert, gehoert vor Walters Augen."""
    for path in ("package.json", "package-lock.json", "tsconfig.json", "app.json",
                 "eslint.config.js", "jest.config.js", ".github/workflows/ci.yml",
                 "ios/Podfile", "android/build.gradle", "babel.config.js"):
        r = classify(_cfg(), [path], diff_lines=5)
        assert r.level == YELLOW, f"{path} haette gelb sein muessen"
        assert path in r.reason


def test_file_outside_the_green_prefixes_is_yellow():
    r = classify(_cfg(), ["src/app/login.tsx", "supabase/seed/seed-lessons.ts"], diff_lines=20)
    assert r.level == YELLOW
    assert "supabase/seed/seed-lessons.ts" in r.reason


def test_large_diff_is_yellow_even_inside_src():
    cfg = _cfg(auto_merge_max_lines=300)
    r = classify(cfg, ["src/app/login.tsx"], diff_lines=301)
    assert r.level == YELLOW
    assert "301" in r.reason


def test_diff_exactly_at_the_limit_is_still_green():
    cfg = _cfg(auto_merge_max_lines=300)
    assert classify(cfg, ["src/app/login.tsx"], diff_lines=300).level == GREEN


def test_classification_does_not_depend_on_an_llm():
    """Reine Funktion: gleiche Eingabe, gleiches Ergebnis, kein Netz, kein Modell."""
    cfg = _cfg()
    files = ["src/a.ts", "tests/a.test.ts"]
    assert classify(cfg, files, 10).level == classify(cfg, files, 10).level
