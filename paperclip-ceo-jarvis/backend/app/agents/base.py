from dataclasses import dataclass


@dataclass
class AgentResult:
    name: str
    summary: str
    actions: list[str]
    confidence: float = 0.75


class BaseAgent:
    name = "Base Agent"
    mission = "Provide useful assistance."

    def run(self, context: dict) -> AgentResult:
        raise NotImplementedError
