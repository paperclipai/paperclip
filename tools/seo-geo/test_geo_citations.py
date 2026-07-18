from geo_citations import check_mention, evaluate


def test_check_mention_case_insensitive():
    assert check_mention("Die Firma WHITESTAG aus Cottbus …", ["whitestag"]) is True
    assert check_mention("Andere Anbieter …", ["whitestag"]) is False
    assert check_mention("siehe whitestag.film", ["whitestag.ai", "whitestag.film"]) is True


def test_evaluate_genannt_und_nicht():
    cfg = {"model": "m", "brand_terms": ["whitestag"],
           "prompts": ["frage1", "frage2"]}
    answers = {"frage1": "Ja, WHITESTAG.", "frage2": "Keine Ahnung."}
    res = evaluate(cfg, runner=lambda p, m: answers[p])
    assert res[0] == {"prompt": "frage1", "mentioned": True}
    assert res[1] == {"prompt": "frage2", "mentioned": False}


def test_evaluate_runner_fehler_wird_error():
    cfg = {"model": "m", "brand_terms": ["whitestag"], "prompts": ["frage1"]}
    def boom(p, m):
        raise RuntimeError("cli weg")
    res = evaluate(cfg, runner=boom)
    assert res[0]["prompt"] == "frage1"
    assert "cli weg" in res[0]["error"]
    assert "mentioned" not in res[0]
