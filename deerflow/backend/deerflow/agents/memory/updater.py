"""Memory updater for reading, writing, and updating memory data."""

import json
import re
import uuid
from datetime import datetime
from typing import Any

from deerflow.agents.memory.prompt import (
    MEMORY_UPDATE_PROMPT,
    format_conversation_for_update,
)
from deerflow.agents.memory.storage import get_memory_storage
from deerflow.config.memory_config import get_memory_config
from deerflow.models import create_chat_model


def get_memory_data(agent_name: str | None = None) -> dict[str, Any]:
    """Get the current memory data (cached with file modification time check).

    The cache is automatically invalidated if the memory file has been modified
    since the last load, ensuring fresh data is always returned.

    Args:
        agent_name: If provided, loads per-agent memory. If None, loads global memory.

    Returns:
        The memory data dictionary.
    """
    return get_memory_storage().load(agent_name)


def reload_memory_data(agent_name: str | None = None) -> dict[str, Any]:
    """Reload memory data from file, forcing cache invalidation.

    Args:
        agent_name: If provided, reloads per-agent memory. If None, reloads global memory.

    Returns:
        The reloaded memory data dictionary.
    """
    storage = get_memory_storage()
    if hasattr(storage, "invalidate_cache"):
        storage.invalidate_cache(agent_name)
    return storage.load(agent_name)


# Matches sentences that describe a file-upload *event* rather than general
# file-related work.  Deliberately narrow to avoid removing legitimate facts
# such as "User works with CSV files" or "prefers PDF export".
_UPLOAD_SENTENCE_RE = re.compile(
    r"[^.!?]*\b(?:"
    r"upload(?:ed|ing)?(?:\s+\w+){0,3}\s+(?:file|files?|document|documents?|attachment|attachments?)"
    r"|file\s+upload"
    r"|/mnt/user-data/uploads/"
    r"|<uploaded_files>"
    r")[^.!?]*[.!?]?\s*",
    re.IGNORECASE,
)


def _strip_upload_mentions_from_memory(memory_data: dict[str, Any]) -> dict[str, Any]:
    """Remove sentences about file uploads from all memory summaries and facts.

    Uploaded files are session-scoped; persisting upload events in long-term
    memory causes the agent to search for non-existent files in future sessions.
    """
    # Scrub summaries in user/history sections
    for section in ("user", "history"):
        section_data = memory_data.get(section, {})
        for _key, val in section_data.items():
            if isinstance(val, dict) and "summary" in val:
                cleaned = _UPLOAD_SENTENCE_RE.sub("", val["summary"]).strip()
                cleaned = re.sub(r"  +", " ", cleaned)
                val["summary"] = cleaned

    # Also remove any facts that describe upload events
    facts = memory_data.get("facts", [])
    if facts:
        memory_data["facts"] = [f for f in facts if not _UPLOAD_SENTENCE_RE.search(f.get("content", ""))]

    return memory_data


def _extract_json(text: str) -> dict[str, Any]:
    """Extract a valid JSON object from text that may contain reasoning/explanation.

    Tries json.raw_decode at each '{' position, preferring the largest valid object.
    Raises json.JSONDecodeError if no valid JSON is found.
    """
    decoder = json.JSONDecoder()
    best: dict[str, Any] | None = None
    best_len = 0

    for i, ch in enumerate(text):
        if ch != "{":
            continue
        try:
            obj, end = decoder.raw_decode(text, i)
            if isinstance(obj, dict) and (end - i) > best_len:
                best = obj
                best_len = end - i
        except json.JSONDecodeError:
            continue

    if best is not None:
        return best
    raise json.JSONDecodeError("No valid JSON object found in response", text, 0)


def _sync_facts_to_paperclip(
    facts: list[dict],
    paperclip_ctx: dict[str, str],
    thread_id: str | None = None,
) -> None:
    """Best-effort sync of new facts to the Paperclip shared memory API."""
    import requests

    api_url = paperclip_ctx["api_url"]
    company_id = paperclip_ctx["company_id"]
    auth_token = paperclip_ctx["auth_token"]
    url = f"{api_url}/api/companies/{company_id}/memories"
    headers = {
        "Authorization": f"Bearer {auth_token}",
        "Content-Type": "application/json",
    }

    for fact in facts:
        try:
            requests.post(
                url,
                headers=headers,
                json={
                    "content": fact.get("content", ""),
                    "category": fact.get("category", "knowledge"),
                    "confidence": fact.get("confidence", 0.9),
                    "scopeType": "company",
                },
                timeout=3,
            )
        except Exception as e:
            print(f"Memory sync to Paperclip failed for fact: {e}")


class MemoryUpdater:
    """Updates memory using LLM based on conversation context."""

    def __init__(self, model_name: str | None = None):
        """Initialize the memory updater.

        Args:
            model_name: Optional model name to use. If None, uses config or default.
        """
        self._model_name = model_name

    def _get_model(self):
        """Get the model for memory updates."""
        config = get_memory_config()
        model_name = self._model_name or config.model_name
        return create_chat_model(name=model_name, thinking_enabled=False)

    def update_memory(self, messages: list[Any], thread_id: str | None = None, agent_name: str | None = None, paperclip_ctx: dict[str, str] | None = None, correction_hint: bool = False) -> bool:
        """Update memory based on conversation messages.

        Args:
            messages: List of conversation messages.
            thread_id: Optional thread ID for tracking source.
            agent_name: If provided, updates per-agent memory. If None, updates global memory.
            paperclip_ctx: Optional Paperclip API context for syncing facts to shared memory.
            correction_hint: If True, append a correction hint to the LLM prompt.

        Returns:
            True if update was successful, False otherwise.
        """
        config = get_memory_config()
        if not config.enabled:
            return False

        if not messages:
            return False

        try:
            # Get current memory
            current_memory = get_memory_data(agent_name)

            # Format conversation for prompt
            conversation_text = format_conversation_for_update(messages)

            if not conversation_text.strip():
                return False

            # Build prompt
            prompt = MEMORY_UPDATE_PROMPT.format(
                current_memory=json.dumps(current_memory, indent=2),
                conversation=conversation_text,
            )

            if correction_hint:
                prompt += "\n\nIMPORTANT: The user has corrected or contradicted previous information in this conversation. Pay special attention to identifying which existing facts should be removed (via factsToRemove) and replaced with corrected versions in newFacts."

            # Call LLM
            model = self._get_model()
            response = model.invoke(prompt)
            response_text = str(response.content).strip()

            # Parse response — handle quirks from smaller models (e.g. Qwen)
            # 1. Strip <think>...</think> reasoning tags
            response_text = re.sub(r"<think>[\s\S]*?</think>", "", response_text).strip()

            # 2. Handle empty responses gracefully
            if not response_text:
                print("Memory update: LLM returned empty response, skipping")
                return False

            # 3. Remove markdown code blocks if present
            if response_text.startswith("```"):
                lines = response_text.split("\n")
                response_text = "\n".join(lines[1:-1] if lines[-1] == "```" else lines[1:])

            # 4. Extract valid JSON from response that may contain reasoning text
            update_data = _extract_json(response_text)

            # Apply updates
            updated_memory = self._apply_updates(current_memory, update_data, thread_id)

            # Strip file-upload mentions from all summaries before saving.
            # Uploaded files are session-scoped and won't exist in future sessions,
            # so recording upload events in long-term memory causes the agent to
            # try (and fail) to locate those files in subsequent conversations.
            updated_memory = _strip_upload_mentions_from_memory(updated_memory)

            # Save
            saved = get_memory_storage().save(updated_memory, agent_name)

            # Sync new facts to Paperclip shared memory
            if saved and paperclip_ctx:
                new_facts = update_data.get("newFacts", [])
                valid_facts = [f for f in new_facts if f.get("confidence", 0) >= config.fact_confidence_threshold]
                if valid_facts:
                    _sync_facts_to_paperclip(valid_facts, paperclip_ctx, thread_id)

            return saved

        except json.JSONDecodeError as e:
            print(f"Failed to parse LLM response for memory update: {e}")
            return False
        except Exception as e:
            print(f"Memory update failed: {e}")
            return False

    def _apply_updates(
        self,
        current_memory: dict[str, Any],
        update_data: dict[str, Any],
        thread_id: str | None = None,
    ) -> dict[str, Any]:
        """Apply LLM-generated updates to memory.

        Args:
            current_memory: Current memory data.
            update_data: Updates from LLM.
            thread_id: Optional thread ID for tracking.

        Returns:
            Updated memory data.
        """
        config = get_memory_config()
        now = datetime.utcnow().isoformat() + "Z"

        # Update user sections
        user_updates = update_data.get("user", {})
        for section in ["workContext", "personalContext", "topOfMind"]:
            section_data = user_updates.get(section, {})
            if section_data.get("shouldUpdate") and section_data.get("summary"):
                current_memory["user"][section] = {
                    "summary": section_data["summary"],
                    "updatedAt": now,
                }

        # Update history sections
        history_updates = update_data.get("history", {})
        for section in ["recentMonths", "earlierContext", "longTermBackground"]:
            section_data = history_updates.get(section, {})
            if section_data.get("shouldUpdate") and section_data.get("summary"):
                current_memory["history"][section] = {
                    "summary": section_data["summary"],
                    "updatedAt": now,
                }

        # Remove facts
        facts_to_remove = set(update_data.get("factsToRemove", []))
        if facts_to_remove:
            current_memory["facts"] = [f for f in current_memory.get("facts", []) if f.get("id") not in facts_to_remove]

        # Add new facts
        new_facts = update_data.get("newFacts", [])
        for fact in new_facts:
            confidence = fact.get("confidence", 0.5)
            if confidence >= config.fact_confidence_threshold:
                fact_entry = {
                    "id": f"fact_{uuid.uuid4().hex[:8]}",
                    "content": fact.get("content", ""),
                    "category": fact.get("category", "context"),
                    "confidence": confidence,
                    "createdAt": now,
                    "source": thread_id or "unknown",
                }
                current_memory["facts"].append(fact_entry)

        # Enforce max facts limit
        if len(current_memory["facts"]) > config.max_facts:
            # Sort by confidence and keep top ones
            current_memory["facts"] = sorted(
                current_memory["facts"],
                key=lambda f: f.get("confidence", 0),
                reverse=True,
            )[: config.max_facts]

        return current_memory


def clear_memory_data(agent_name: str | None = None) -> bool:
    """Clear all memory data, resetting to empty structure."""
    from deerflow.agents.memory.storage import _create_empty_memory

    empty = _create_empty_memory()
    return get_memory_storage().save(empty, agent_name)


def delete_memory_fact(fact_id: str, agent_name: str | None = None) -> bool:
    """Delete a single fact by ID. Returns True if found and deleted, False if not found."""
    storage = get_memory_storage()
    data = storage.load(agent_name)
    original_count = len(data.get("facts", []))
    data["facts"] = [f for f in data.get("facts", []) if f.get("id") != fact_id]
    if len(data["facts"]) == original_count:
        return False
    storage.save(data, agent_name)
    return True


VALID_CATEGORIES = {"preference", "knowledge", "context", "behavior", "goal", "correction"}


def create_memory_fact(
    content: str,
    category: str = "knowledge",
    confidence: float = 0.9,
    agent_name: str | None = None,
) -> dict[str, Any]:
    """Create a new memory fact manually.

    Args:
        content: Fact content (non-empty, max 500 chars).
        category: One of preference, knowledge, context, behavior, goal, correction.
        confidence: 0.0-1.0.
        agent_name: Per-agent or global memory.

    Returns:
        The created fact dict.

    Raises:
        ValueError: If validation fails.
    """
    if not content or not content.strip():
        raise ValueError("Fact content must be non-empty")
    if len(content) > 500:
        raise ValueError("Fact content must be 500 characters or fewer")
    if category not in VALID_CATEGORIES:
        raise ValueError(f"Invalid category '{category}'. Must be one of: {', '.join(sorted(VALID_CATEGORIES))}")
    if not (0.0 <= confidence <= 1.0):
        raise ValueError(f"Confidence must be between 0.0 and 1.0, got {confidence}")

    storage = get_memory_storage()
    data = storage.load(agent_name)
    now = datetime.utcnow().isoformat() + "Z"
    fact = {
        "id": f"fact_{uuid.uuid4().hex[:8]}",
        "content": content.strip(),
        "category": category,
        "confidence": confidence,
        "createdAt": now,
        "source": "manual",
    }
    data.setdefault("facts", []).append(fact)
    storage.save(data, agent_name)
    return fact


def update_memory_fact(
    fact_id: str,
    content: str | None = None,
    category: str | None = None,
    confidence: float | None = None,
    agent_name: str | None = None,
) -> dict[str, Any] | None:
    """Update an existing fact.

    Args:
        fact_id: ID of the fact to update.
        content: New content (if provided).
        category: New category (if provided).
        confidence: New confidence (if provided).
        agent_name: Per-agent or global memory.

    Returns:
        Updated fact dict, or None if not found.

    Raises:
        ValueError: If provided values fail validation.
    """
    if content is not None and not content.strip():
        raise ValueError("Fact content must be non-empty")
    if content is not None and len(content) > 500:
        raise ValueError("Fact content must be 500 characters or fewer")
    if category is not None and category not in VALID_CATEGORIES:
        raise ValueError(f"Invalid category '{category}'. Must be one of: {', '.join(sorted(VALID_CATEGORIES))}")
    if confidence is not None and not (0.0 <= confidence <= 1.0):
        raise ValueError(f"Confidence must be between 0.0 and 1.0, got {confidence}")

    storage = get_memory_storage()
    data = storage.load(agent_name)
    for fact in data.get("facts", []):
        if fact.get("id") == fact_id:
            if content is not None:
                fact["content"] = content.strip()
            if category is not None:
                fact["category"] = category
            if confidence is not None:
                fact["confidence"] = confidence
            storage.save(data, agent_name)
            return fact
    return None


def import_memory_data(
    data: dict[str, Any],
    merge: bool = False,
    agent_name: str | None = None,
) -> bool:
    """Import memory data, either replacing or merging.

    Args:
        data: Memory data to import.
        merge: If True, merge with existing data. If False, replace entirely.
        agent_name: Per-agent or global memory.

    Returns:
        True if successful.
    """
    storage = get_memory_storage()

    if not merge:
        return storage.save(data, agent_name)

    # Merge mode
    existing = storage.load(agent_name)

    # Merge user/history sections: keep whichever has a newer updatedAt
    for section_key in ("user", "history"):
        existing_section = existing.get(section_key, {})
        import_section = data.get(section_key, {})
        for sub_key in existing_section:
            if sub_key not in import_section:
                continue
            existing_updated = existing_section.get(sub_key, {}).get("updatedAt", "")
            import_updated = import_section.get(sub_key, {}).get("updatedAt", "")
            if import_updated > existing_updated:
                existing_section[sub_key] = import_section[sub_key]

    # Merge facts: import wins on ID conflict
    existing_facts = {f["id"]: f for f in existing.get("facts", []) if "id" in f}
    for fact in data.get("facts", []):
        if "id" in fact:
            existing_facts[fact["id"]] = fact
    existing["facts"] = list(existing_facts.values())

    return storage.save(existing, agent_name)


def update_memory_from_conversation(messages: list[Any], thread_id: str | None = None, agent_name: str | None = None) -> bool:
    """Convenience function to update memory from a conversation.

    Args:
        messages: List of conversation messages.
        thread_id: Optional thread ID.
        agent_name: If provided, updates per-agent memory. If None, updates global memory.

    Returns:
        True if successful, False otherwise.
    """
    updater = MemoryUpdater()
    return updater.update_memory(messages, thread_id, agent_name)
