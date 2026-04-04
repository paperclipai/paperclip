"""Tests for content fetcher."""

import pytest
import respx
import httpx

from blackbox.fetcher import extract_text_from_html, fetch_pages
from blackbox.models import ResearchArea, SearchResult


def _result(url: str, area: ResearchArea = ResearchArea.NEWS) -> SearchResult:
    return SearchResult(area=area, query="test", title="Test", url=url, snippet="...")


class TestExtractTextFromHtml:
    def test_strips_scripts(self):
        html = "<p>Hello</p><script>alert('x')</script><p>World</p>"
        assert "alert" not in extract_text_from_html(html)
        assert "Hello" in extract_text_from_html(html)
        assert "World" in extract_text_from_html(html)

    def test_strips_styles(self):
        html = "<style>.foo{color:red}</style><p>Content</p>"
        text = extract_text_from_html(html)
        assert "color" not in text
        assert "Content" in text

    def test_strips_nav_header_footer(self):
        html = "<nav>Menu</nav><main><p>Main content</p></main><footer>Footer</footer>"
        text = extract_text_from_html(html)
        assert "Menu" not in text
        assert "Footer" not in text
        assert "Main content" in text

    def test_strips_html_tags(self):
        html = "<div><p>Hello <b>world</b></p></div>"
        text = extract_text_from_html(html)
        assert "<" not in text
        assert "Hello world" in text

    def test_truncates_to_max_length(self):
        html = "<p>" + "x" * 20000 + "</p>"
        text = extract_text_from_html(html)
        assert len(text) <= 10000

    def test_collapses_whitespace(self):
        html = "<p>Hello    \n\n   World</p>"
        text = extract_text_from_html(html)
        assert "  " not in text


class TestFetchPages:
    @pytest.mark.asyncio
    @respx.mock
    async def test_successful_fetch(self):
        long_text = "The agency mission statement describes goals and objectives for the next five years of operations and service delivery."
        respx.get("https://example.gov/about").mock(
            return_value=httpx.Response(200, text=f"<html><body><p>{long_text}</p></body></html>", headers={"content-type": "text/html"})
        )
        results = [_result("https://example.gov/about", ResearchArea.MISSION_VISION)]
        pages = await fetch_pages(results, max_per_area=3)
        assert len(pages) == 1
        assert "agency mission" in pages[0].content.lower()

    @pytest.mark.asyncio
    @respx.mock
    async def test_non_html_skipped(self):
        respx.get("https://example.gov/file.pdf").mock(
            return_value=httpx.Response(200, content=b"PDF content", headers={"content-type": "application/pdf"})
        )
        results = [_result("https://example.gov/file.pdf")]
        pages = await fetch_pages(results)
        assert len(pages) == 0

    @pytest.mark.asyncio
    @respx.mock
    async def test_404_skipped(self):
        respx.get("https://example.gov/missing").mock(
            return_value=httpx.Response(404)
        )
        results = [_result("https://example.gov/missing")]
        pages = await fetch_pages(results)
        assert len(pages) == 0

    @pytest.mark.asyncio
    @respx.mock
    async def test_timeout_skipped(self):
        respx.get("https://example.gov/slow").mock(side_effect=httpx.TimeoutException("timeout"))
        results = [_result("https://example.gov/slow")]
        pages = await fetch_pages(results, timeout=1)
        assert len(pages) == 0

    @pytest.mark.asyncio
    @respx.mock
    async def test_max_per_area_limits(self):
        long_text = "This is substantial page content with enough words to pass the fifty character minimum length filter for extraction."
        for i in range(5):
            respx.get(f"https://example.gov/page{i}").mock(
                return_value=httpx.Response(200, text=f"<html><body><p>{long_text} Page {i}.</p></body></html>", headers={"content-type": "text/html"})
            )
        results = [_result(f"https://example.gov/page{i}", ResearchArea.NEWS) for i in range(5)]
        pages = await fetch_pages(results, max_per_area=2)
        assert len(pages) == 2

    @pytest.mark.asyncio
    @respx.mock
    async def test_deduplicates_urls(self):
        long_text = "This is substantial page content with enough words to pass the fifty character minimum length filter for extraction."
        respx.get("https://example.gov/page").mock(
            return_value=httpx.Response(200, text=f"<html><body><p>{long_text}</p></body></html>", headers={"content-type": "text/html"})
        )
        results = [
            _result("https://example.gov/page", ResearchArea.NEWS),
            _result("https://example.gov/page", ResearchArea.IT_LANDSCAPE),
        ]
        pages = await fetch_pages(results, max_per_area=3)
        assert len(pages) == 1
