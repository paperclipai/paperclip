from .base import BaseAgent, AgentResult


class ChiefOfStaffAgent(BaseAgent):
    name = "Chief of Staff Agent"
    mission = "Protect CEO attention, prepare briefings, and turn ambiguity into execution."

    def run(self, context: dict) -> AgentResult:
        priorities = context.get("priorities", [])
        summary = "CEO operating picture prepared."
        actions = [
            "Review top briefing items",
            "Resolve or delegate the highest-risk open task",
            "Run simulations for major decisions",
        ]
        if priorities:
            actions.insert(0, f"Focus first on: {priorities[0]}")
        return AgentResult(name=self.name, summary=summary, actions=actions, confidence=0.82)
