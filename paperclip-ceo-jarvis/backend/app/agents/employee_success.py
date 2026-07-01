from .base import BaseAgent, AgentResult


class EmployeeSuccessAgent(BaseAgent):
    name = "Employee Success Agent"
    mission = "Improve human and agent growth, workload, and contribution quality."

    def run(self, context: dict) -> AgentResult:
        overloaded = context.get("overloaded", [])
        actions = ["Create career evolution plans", "Identify knowledge silos", "Pair humans and agents on complex artifacts"]
        if overloaded:
            actions.insert(0, "Rebalance overloaded owners immediately")
        return AgentResult(name=self.name, summary="Employee system reviewed.", actions=actions, confidence=0.78)
