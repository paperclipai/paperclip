from typing import List, Dict
from pr_shepherd.domain import PullRequest

class DigestGenerator:
    def __init__(self, repo_name: str = "paperclip_oss"):
        self.repo_name = repo_name

    def generate_markdown(self, merged_prs: List[PullRequest], held_prs: Dict[int, List[str]]) -> str:
        """Generates a formatted markdown digest of daily activity."""
        merged_count = len(merged_prs)
        held_count = len(held_prs)
        
        # Header & Summary
        md = f"# 🐑 PR-Shepherd Daily Digest\n\n"
        md += f"**Summary**: Auto-merged today: **{merged_count}** | Waiting on owner: **{held_count}**\n\n"
        md += "---\n\n"

        # Auto-Merged PRs
        md += "## ✅ Auto-Merged PRs\n"
        if merged_count == 0:
            md += "_No pull requests were auto-merged today._\n"
        else:
            for pr in merged_prs:
                pr_link = f"https://github.com/{self.repo_name}/pull/{pr.number}"
                md += f"- **[#{pr.number}]({pr_link})**: {pr.title} (by @{pr.author})\n"
        md += "\n"

        # Held PRs (Waiting on Human)
        md += "## 🛑 Held PRs (Action Required)\n"
        if held_count == 0:
            md += "_No pull requests are currently blocked or waiting on human action._\n"
        else:
            for pr_num, reasons in held_prs.items():
                pr_link = f"https://github.com/{self.repo_name}/pull/{pr_num}"
                md += f"- **[#{pr_num}]({pr_link})**:\n"
                for reason in reasons:
                    md += f"  - ⚠️ {reason}\n"
        
        md += "\n---\n"
        md += "_PR-Shepherd runs automatically on open agent pull requests. Use the `human-driving` label to take manual control._\n"
        return md
