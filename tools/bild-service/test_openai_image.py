from openai_image import build_request_body

def test_build_body_maps_fields():
    brief = {"prompt": "Hallo", "size": "1024x1536", "quality": "high", "background": "transparent"}
    body = build_request_body(brief)
    assert body == {
        "model": "gpt-image-1", "prompt": "Hallo", "size": "1024x1536",
        "quality": "high", "background": "transparent", "output_format": "png", "n": 1,
    }
