"""RFP file parsing: PDF/DOCX text extraction and Claude-based field extraction."""

from __future__ import annotations

import logging
import re
from pathlib import Path

from anthropic import AsyncAnthropic

from blackbox.models import ContractType, RFPContext

logger = logging.getLogger(__name__)

RFP_EXTRACTION_TOOL = {
    "name": "extract_rfp_fields",
    "description": "Extract structured fields from an RFP document.",
    "input_schema": {
        "type": "object",
        "properties": {
            "agency_name": {"type": "string", "description": "The issuing government agency name"},
            "scope": {"type": "string", "description": "Brief description of the work scope"},
            "contract_type": {
                "type": "string",
                "enum": [ct.value for ct in ContractType],
                "description": "Contract type",
            },
            "naics_code": {"type": "string", "description": "NAICS code if mentioned"},
            "set_aside": {"type": "string", "description": "Set-aside type (e.g. 8(a), SDVOSB)"},
            "due_date": {"type": "string", "description": "Proposal due date"},
            "estimated_value": {"type": "string", "description": "Estimated contract value"},
            "solicitation_number": {"type": "string", "description": "Solicitation/RFP number"},
        },
        "required": ["agency_name"],
    },
}


class ParseError(Exception):
    pass


def extract_text_from_pdf(path: Path) -> str:
    """Extract text from PDF using PyMuPDF."""
    try:
        import fitz  # PyMuPDF

        doc = fitz.open(str(path))
        text = ""
        for page in doc:
            text += page.get_text()
        doc.close()
        return text.strip()
    except Exception as exc:
        raise ParseError(f"Failed to parse PDF {path.name}: {exc}") from exc


def extract_text_from_docx(path: Path) -> str:
    """Extract text from DOCX using python-docx."""
    try:
        import docx

        doc = docx.Document(str(path))
        paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
        return "\n".join(paragraphs)
    except Exception as exc:
        raise ParseError(f"Failed to parse DOCX {path.name}: {exc}") from exc


def _heuristic_extract(text: str) -> RFPContext:
    """Fallback: extract agency name and basic fields using regex heuristics."""
    agency = ""
    sol_num = ""

    # Look for common agency name patterns
    for pattern in [
        r"(?:issued by|agency|department|office)[:\s]+([A-Z][A-Za-z\s&]+(?:Department|Agency|Office|Administration|Bureau|Commission))",
        r"((?:Department|Agency|Office|Bureau|Commission)\s+of\s+[A-Za-z\s&]+)",
    ]:
        m = re.search(pattern, text[:5000])
        if m:
            agency = m.group(1).strip()
            break

    # Look for solicitation number
    for pattern in [
        r"(?:Solicitation|RFP|RFQ|IFB|ITB)[\s#:]+([A-Z0-9][\w\-]+)",
        r"(?:Contract|Reference)[\s#:]+([A-Z0-9][\w\-]+)",
    ]:
        m = re.search(pattern, text[:5000])
        if m:
            sol_num = m.group(1).strip()
            break

    if not agency:
        # Last resort: first line that looks like an org name
        for line in text[:3000].splitlines():
            line = line.strip()
            if len(line) > 10 and line[0].isupper() and not line.startswith("Page"):
                agency = line[:100]
                break

    return RFPContext(
        agency_name=agency or "Unknown Agency",
        solicitation_number=sol_num,
        raw_text=text,
    )


async def parse_rfp(
    path: Path, client: AsyncAnthropic, model: str
) -> RFPContext:
    """Extract RFP fields using Claude with tool_use. Falls back to heuristics."""
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        text = extract_text_from_pdf(path)
    elif suffix in (".docx", ".doc"):
        text = extract_text_from_docx(path)
    else:
        raise ParseError(f"Unsupported file type: {suffix}. Use .pdf or .docx")

    if not text.strip():
        return RFPContext(agency_name="Unknown Agency", raw_text="")

    # Truncate to ~20K chars for Haiku context
    truncated = text[:20_000]

    try:
        response = await client.messages.create(
            model=model,
            max_tokens=1024,
            system="You are an expert at parsing US government RFP documents. Extract the key fields from the provided RFP text.",
            messages=[
                {
                    "role": "user",
                    "content": f"Extract the structured fields from this RFP:\n\n{truncated}",
                }
            ],
            tools=[RFP_EXTRACTION_TOOL],
            tool_choice={"type": "tool", "name": "extract_rfp_fields"},
        )

        tool_block = next(
            (b for b in response.content if b.type == "tool_use"), None
        )
        if tool_block is None:
            logger.warning("Claude returned no tool_use block, falling back to heuristics")
            return _heuristic_extract(text)

        fields = tool_block.input
        return RFPContext(
            agency_name=fields.get("agency_name", "Unknown Agency"),
            scope=fields.get("scope", ""),
            contract_type=ContractType(fields.get("contract_type", "UNKNOWN")),
            naics_code=fields.get("naics_code", ""),
            set_aside=fields.get("set_aside", ""),
            due_date=fields.get("due_date", ""),
            estimated_value=fields.get("estimated_value", ""),
            solicitation_number=fields.get("solicitation_number", ""),
            raw_text=text,
        )
    except Exception as exc:
        logger.warning("Claude RFP extraction failed: %s. Using heuristics.", exc)
        return _heuristic_extract(text)
