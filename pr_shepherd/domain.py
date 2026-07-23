from dataclasses import dataclass, field
from typing import List, Optional

@dataclass
class FileChange:
    filename: str
    additions: int
    deletions: int
    patch: Optional[str] = None

@dataclass
class Comment:
    id: int
    body: str
    user: str
    path: Optional[str] = None
    line: Optional[int] = None
    in_reply_to_id: Optional[int] = None
    association: Optional[str] = None  # e.g., "OWNER", "COLLABORATOR", "NONE"

@dataclass
class Review:
    id: int
    user: str
    state: str  # "APPROVED", "CHANGES_REQUESTED", "COMMENTED"
    body: str
    association: Optional[str] = None  # e.g., "OWNER", "COLLABORATOR", "MEMBER"
    commit_id: Optional[str] = None  # SHA of the commit approved

@dataclass
class CheckRun:
    name: str
    status: str  # "queued", "in_progress", "completed"
    conclusion: Optional[str]  # "success", "failure", "neutral", "cancelled", etc.
    details_url: Optional[str] = None

@dataclass
class PullRequest:
    number: int
    title: str
    body: str
    state: str  # "open", "closed"
    author: str
    labels: List[str]
    changed_files: List[FileChange]
    comments: List[Comment]
    reviews: List[Review]
    check_runs: List[CheckRun]
    head_sha: str
    base_sha: str
    mergeable: Optional[bool] = None
