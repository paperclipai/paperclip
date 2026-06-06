def optimize_meeting(topic: str, participants: list[str], desired_outcome: str) -> dict:
    trimmed = participants[:7]
    return {
        "topic": topic,
        "recommended_length_minutes": 25 if len(trimmed) <= 5 else 45,
        "participants": trimmed,
        "removed_participants": participants[7:],
        "agenda": [
            "State desired outcome",
            "Review facts and constraints",
            "Decide owner, metric, and deadline",
            "Confirm risks and follow-up actions",
        ],
        "anti_waste_rule": "Cancel the meeting if no decision, artifact, or blocker resolution is expected.",
        "dry_note": "A meeting without an outcome is just a group hallucination with calendar invites.",
    }
