"""HTML extraction utilities for product pages and specification tables."""

from __future__ import annotations

from dataclasses import dataclass, field
from html.parser import HTMLParser
from urllib.parse import urljoin


@dataclass(slots=True)
class ParsedHtmlDocument:
    """Extracted structured text, headings, tables, and image URLs from HTML."""

    title: str = ""
    headings: list[str] = field(default_factory=list)
    tables: list[list[list[str]]] = field(default_factory=list)
    text_blocks: list[str] = field(default_factory=list)
    image_urls: list[str] = field(default_factory=list)

    def combined_text(self, max_chars: int = 24000) -> str:
        """Render title, headings, tables, and text blocks into compact text."""
        sections: list[str] = []
        if self.title:
            sections.append(f"TITLE: {self.title}")
        if self.headings:
            sections.append("HEADINGS:\n" + "\n".join(f"- {h}" for h in self.headings[:40]))
        for idx, table in enumerate(self.tables[:15]):
            rows = [" | ".join(row) for row in table if any(row)]
            if rows:
                sections.append(f"TABLE {idx + 1}:\n" + "\n".join(rows[:30]))
        if self.text_blocks:
            sections.append("CONTENT:\n" + "\n".join(self.text_blocks))
        joined = "\n\n".join(sections)
        return joined[:max_chars]


class _ProductHtmlParser(HTMLParser):
    """Streaming HTML parser that strips script/style tags and collects content."""

    _SKIP_TAGS = {"script", "style", "noscript", "svg", "iframe"}
    _HEADING_TAGS = {"h1", "h2", "h3", "h4"}
    _BLOCK_TAGS = {"p", "li", "dd", "dt", "figcaption", "article", "section", "div"}

    def __init__(self, base_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.doc = ParsedHtmlDocument()
        self._skip_depth = 0
        self._in_title = False
        self._in_heading = False
        self._in_cell = False
        self._cur_buf: list[str] = []
        self._cur_row: list[str] = []
        self._cur_table: list[list[str]] = []
        self._seen_imgs: set[str] = set()

    def _add_image(self, raw_url: str | None) -> None:
        if not raw_url:
            return
        cleaned = raw_url.strip()
        if not cleaned or cleaned.startswith("data:"):
            return
        resolved = urljoin(self.base_url, cleaned)
        if resolved not in self._seen_imgs:
            self._seen_imgs.add(resolved)
            self.doc.image_urls.append(resolved)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        t = tag.lower()
        if t in self._SKIP_TAGS:
            self._skip_depth += 1
            return
        if self._skip_depth > 0:
            return
        attr_map = {k.lower(): v for k, v in attrs}
        if t == "title":
            self._in_title = True
            self._cur_buf = []
        elif t in self._HEADING_TAGS:
            self._in_heading = True
            self._cur_buf = []
        elif t == "table":
            self._cur_table = []
        elif t == "tr":
            self._cur_row = []
        elif t in ("td", "th"):
            self._in_cell = True
            self._cur_buf = []
        elif t == "img":
            self._add_image(
                attr_map.get("src")
                or attr_map.get("data-src")
                or attr_map.get("data-original")
            )
        elif t == "meta":
            prop = (attr_map.get("property") or attr_map.get("name") or "").lower()
            if prop in ("og:image", "twitter:image"):
                self._add_image(attr_map.get("content"))

    def handle_endtag(self, tag: str) -> None:
        t = tag.lower()
        if t in self._SKIP_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
            return
        if self._skip_depth > 0:
            return
        text = " ".join("".join(self._cur_buf).split())
        if t == "title" and self._in_title:
            self._in_title = False
            if text and not self.doc.title:
                self.doc.title = text
            self._cur_buf = []
        elif t in self._HEADING_TAGS and self._in_heading:
            self._in_heading = False
            if text:
                self.doc.headings.append(text)
            self._cur_buf = []
        elif t in ("td", "th") and self._in_cell:
            self._in_cell = False
            self._cur_row.append(text)
            self._cur_buf = []
        elif t == "tr" and self._cur_row:
            if any(self._cur_row):
                self._cur_table.append(self._cur_row)
            self._cur_row = []
        elif t == "table" and self._cur_table:
            self.doc.tables.append(self._cur_table)
            self._cur_table = []
        elif t in self._BLOCK_TAGS and text:
            self.doc.text_blocks.append(text)
            self._cur_buf = []

    def handle_data(self, data: str) -> None:
        if self._skip_depth > 0:
            return
        if self._in_title or self._in_heading or self._in_cell:
            self._cur_buf.append(data)
        else:
            cleaned = " ".join(data.split())
            if cleaned:
                self._cur_buf.append(cleaned + " ")


def parse_html_document(html_text: str, base_url: str) -> ParsedHtmlDocument:
    """Parse HTML string and extract structured title, headings, tables, text, and images."""
    parser = _ProductHtmlParser(base_url=base_url)
    parser.feed(html_text)
    parser.close()
    trailing = " ".join("".join(parser._cur_buf).split())
    if trailing:
        parser.doc.text_blocks.append(trailing)
    return parser.doc
