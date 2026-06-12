from pathlib import Path


def main() -> None:
    example = Path(__file__).resolve().parents[1] / ".env.example"
    assert example.exists()
    text = example.read_text()
    assert "ENVIRONMENT=development" in text
    assert "JARVIS_API_KEY=dev-change-me" in text
    print("setup example file check passed.")


if __name__ == "__main__":
    main()
