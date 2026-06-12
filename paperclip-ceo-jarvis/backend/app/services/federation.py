from __future__ import annotations

import json
import shlex
import shutil
import subprocess
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any, Literal

import httpx
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import ApprovalRequest, AuditLog, Company, DecisionJournal, FederationTrace, Task, WorkflowRun
from .alignment import alignment_report
from .decision_simulator import simulate_decision
from .opportunity import opportunity_radar

SYSTEMS: tuple[str, ...] = ("paperclip", "hermes", "pi", "opencode")

DENYLIST_TERMS: tuple[str, ...] = (
    "delete",
    "drop database",
    "wipe",
    "destroy",
    "exfiltrate",
    "steal",
    "bypass audit",
    "disable audit",
    "hide from audit",
    "wire transfer",
    "send payment",
    "legal notice",
    "public release",
    "publish externally",
    "production deploy",
    "credential",
    "password",
    "secret",
    "api key",
    "token",
)


@dataclass
class AdapterResult:
    system: str
    status: str
    summary: str
    payload: dict[str, Any]
    fallback: bool = False


class BaseAdapter:
    name: str = "base"
    command_setting: str | None = None
    base_url_setting: str | None = None
    api_key_setting: str | None = None

    def __init__(self) -> None:
        self.settings = get_settings()

    def config(self) -> dict[str, Any]:
        base_url = getattr(self.settings, self.base_url_setting) if self.base_url_setting else None
        command = getattr(self.settings, self.command_setting) if self.command_setting else None
        api_key = getattr(self.settings, self.api_key_setting) if self.api_key_setting else None
        return {"base_url": base_url, "command": command, "api_key_present": bool(api_key)}

    def _command_parts(self) -> list[str]:
        command = self.config()["command"]
        if not command:
            return []
        if isinstance(command, str):
            return shlex.split(command)
        return list(command)

    def _command_resolvable(self) -> bool:
        parts = self._command_parts()
        if not parts:
            return False
        head = parts[0]
        return bool(shutil.which(head) or head.startswith("/") or head.startswith("."))

    def cli_prompt(self, op: str, payload: dict[str, Any]) -> str:
        return json.dumps({"op": op, **payload}, indent=2, sort_keys=True)

    def cli_args(self, op: str, payload: dict[str, Any]) -> list[str]:
        return []

    def cli_stdin(self, op: str, payload: dict[str, Any]) -> str | None:
        return self.cli_prompt(op, payload)

    def cli_summary(self, stdout: str, stderr: str) -> str:
        text = (stdout or stderr or "").strip()
        if not text:
            return "no output"
        messages: list[str] = []
        for raw in text.splitlines():
            line = raw.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except Exception:
                continue
            if not isinstance(event, dict):
                continue
            event_type = str(event.get("type", ""))
            if event_type == "text":
                part = event.get("part") if isinstance(event.get("part"), dict) else {}
                piece = str(part.get("text", "")).strip() if isinstance(part, dict) else ""
                if piece:
                    messages.append(piece)
                continue
            if event_type == "message_update":
                assistant = event.get("assistantMessageEvent") if isinstance(event.get("assistantMessageEvent"), dict) else {}
                if isinstance(assistant, dict) and str(assistant.get("type", "")) == "text_delta":
                    delta = str(assistant.get("delta", "")).strip()
                    if delta:
                        messages.append(delta)
                continue
            if event_type in {"turn_end", "agent_end"}:
                message = event.get("message") if isinstance(event.get("message"), dict) else {}
                if isinstance(message, dict):
                    content = message.get("content")
                    if isinstance(content, str):
                        piece = content.strip()
                        if piece:
                            messages.append(piece)
                    elif isinstance(content, list):
                        piece = "".join(
                            str(item.get("text", ""))
                            for item in content
                            if isinstance(item, dict) and item.get("type") == "text"
                        ).strip()
                        if piece:
                            messages.append(piece)
                continue
        if messages:
            return messages[-1].strip()
        return text.splitlines()[0].strip()

    def cli_result(self, stdout: str, stderr: str) -> dict[str, Any]:
        summary = self.cli_summary(stdout, stderr)
        try:
            parsed = json.loads(stdout) if stdout.strip().startswith("{") or stdout.strip().startswith("[") else None
        except Exception:
            parsed = None
        return {
            "stdout": stdout.strip(),
            "stderr": stderr.strip(),
            "result": parsed or {"text": summary},
            "summary": summary,
            "transport": "cli",
        }

    def status(self) -> dict[str, Any]:
        cfg = self.config()
        if cfg["base_url"]:
            mode = "http"
        elif cfg["command"] and self._command_resolvable():
            mode = "cli"
        else:
            mode = "local"
        return {"system": self.name, "mode": mode, "configured": mode != "local", "config": cfg}

    def _http_call(self, op: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        base_url = self.config()["base_url"]
        if not base_url:
            return None
        url = f"{base_url.rstrip('/')}/{op.lstrip('/')}"
        headers = {"Content-Type": "application/json"}
        api_key = getattr(self.settings, self.api_key_setting) if self.api_key_setting else None
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        try:
            with httpx.Client(timeout=60) as client:
                resp = client.post(url, json=payload, headers=headers)
                resp.raise_for_status()
                try:
                    return resp.json()
                except Exception:
                    return {"text": resp.text}
        except Exception as exc:
            return {"error": str(exc), "transport": "http"}

    def _cli_call(self, op: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        command = self._command_parts()
        if not command:
            return None
        try:
            args = [*command, *self.cli_args(op, payload)]
            proc = subprocess.run(
                args,
                input=self.cli_stdin(op, payload),
                shell=False,
                check=False,
                capture_output=True,
                text=True,
                timeout=120,
            )
            stdout = proc.stdout or ""
            stderr = proc.stderr or ""
            result = self.cli_result(stdout, stderr)
            result.update({"exit_code": proc.returncode})
            return result
        except Exception as exc:
            return {"error": str(exc), "transport": "cli"}

    def _invoke(self, op: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        http_result = self._http_call(op, payload)
        if http_result is not None and "error" not in http_result:
            return http_result
        cli_result = self._cli_call(op, payload)
        if cli_result is not None and "error" not in cli_result:
            return cli_result
        return None

    def read(self, db: Session, query: dict[str, Any]) -> AdapterResult:
        raise NotImplementedError

    def plan(self, db: Session, request: dict[str, Any]) -> AdapterResult:
        raise NotImplementedError

    def execute(self, db: Session, request: dict[str, Any]) -> AdapterResult:
        raise NotImplementedError

    def report(self, db: Session, trace_id: str) -> dict[str, Any]:
        trace = db.query(FederationTrace).filter(FederationTrace.trace_id == trace_id).first()
        if not trace:
            return {"trace_id": trace_id, "found": False}
        return {
            "trace_id": trace.trace_id,
            "kind": trace.kind,
            "target_system": trace.target_system,
            "status": trace.status,
            "blocked_reason": trace.blocked_reason,
            "rollback_hint": trace.rollback_hint,
            "request": trace.request,
            "result": trace.result,
            "created_at": trace.created_at,
        }


class PaperclipAdapter(BaseAdapter):
    name = "paperclip"
    base_url_setting = "paperclip_base_url"
    api_key_setting = "paperclip_api_key"

    def config(self) -> dict[str, Any]:
        cfg = super().config()
        cfg["company_id"] = getattr(self.settings, "paperclip_company_id", None)
        cfg["agent_id"] = getattr(self.settings, "paperclip_agent_id", None)
        return cfg

    def status(self) -> dict[str, Any]:
        cfg = self.config()
        base_url = cfg["base_url"]
        api_key_present = bool(getattr(self.settings, self.api_key_setting) if self.api_key_setting else None)
        mode = "http" if base_url else "local"
        return {
            "system": self.name,
            "mode": mode,
            "configured": bool(base_url and api_key_present),
            "config": {
                "base_url": base_url,
                "api_key_present": api_key_present,
                "company_id": cfg.get("company_id"),
                "agent_id": cfg.get("agent_id"),
            },
        }

    def _api_base_url(self) -> str | None:
        base_url = self.config()["base_url"]
        if not base_url:
            return None
        trimmed = str(base_url).rstrip("/")
        return trimmed if trimmed.endswith("/api") else f"{trimmed}/api"

    def _strip_remote_metadata(self, payload: Any) -> Any:
        if isinstance(payload, list):
            return [self._strip_remote_metadata(item) for item in payload]
        if not isinstance(payload, dict):
            return payload
        cleaned = dict(payload)
        cleaned.pop("transport", None)
        cleaned.pop("api_url", None)
        cleaned.pop("status_code", None)
        return cleaned

    def _remote_request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        trace_id: str | None = None,
    ) -> dict[str, Any] | None:
        base_url = self._api_base_url()
        if not base_url:
            return None
        url = f"{base_url}{path if path.startswith('/') else '/' + path}"
        headers = {"Accept": "application/json"}
        api_key = getattr(self.settings, self.api_key_setting) if self.api_key_setting else None
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        if trace_id:
            headers["X-Paperclip-Run-Id"] = trace_id
        if payload is not None:
            headers["Content-Type"] = "application/json"
        try:
            with httpx.Client(timeout=60) as client:
                response = client.request(method.upper(), url, json=payload, headers=headers)
        except Exception as exc:
            return {"error": str(exc), "transport": "http", "api_url": base_url}

        body: Any = None
        if response.text.strip():
            try:
                body = response.json()
            except Exception:
                body = response.text.strip()

        if not response.is_success:
            return {
                "error": f"{method.upper()} {path} failed with {response.status_code}",
                "transport": "http",
                "api_url": base_url,
                "status_code": response.status_code,
                "body": body,
            }

        if body is None:
            return {}
        return body if isinstance(body, (dict, list)) else {"text": body}

    def _resolve_company_id(self, remote_self: dict[str, Any]) -> str | None:
        configured_company = self.config().get("company_id")
        if configured_company:
            return str(configured_company)
        for key in ("companyId", "company_id"):
            value = remote_self.get(key)
            if value:
                return str(value)
        return None

    def _resolve_agent_id(self, remote_self: dict[str, Any]) -> str | None:
        configured_agent = self.config().get("agent_id")
        if configured_agent:
            return str(configured_agent)
        for key in ("id", "agentId", "agent_id"):
            value = remote_self.get(key)
            if value:
                return str(value)
        return None

    def _normalize_priority(self, value: Any) -> str:
        if isinstance(value, int):
            if value <= 2:
                return "low"
            if value == 3:
                return "medium"
            return "high"
        if isinstance(value, str):
            lowered = value.strip().lower()
            if lowered in {"1", "2", "low"}:
                return "low"
            if lowered in {"3", "medium"}:
                return "medium"
            if lowered in {"4", "5", "high", "critical"}:
                return "high" if lowered != "critical" else "critical"
            return lowered or "medium"
        return "medium"

    def _remote_snapshot(self, query: dict[str, Any], trace_id: str | None = None) -> dict[str, Any]:
        base_url = self._api_base_url()
        if not base_url:
            return {"hard_error": "Paperclip remote API is not configured.", "transport": "http", "api_url": None}

        cfg = self.config()
        company_id = cfg.get("company_id")
        agent_id = cfg.get("agent_id")
        remote_self: dict[str, Any] | None = None

        if not company_id or not agent_id:
            remote_self = self._remote_request("GET", "/agents/me", trace_id=trace_id)
            if remote_self and remote_self.get("error"):
                remote_self = None
            if not company_id and remote_self:
                company_id = self._resolve_company_id(remote_self)
            if not agent_id and remote_self:
                agent_id = self._resolve_agent_id(remote_self)

        if not company_id:
            return {
                "hard_error": "Paperclip company id unavailable from config or /api/agents/me.",
                "transport": "http",
                "api_url": base_url,
                "agent": self._strip_remote_metadata(remote_self) if remote_self else {"id": agent_id} if agent_id else {},
            }

        company = self._remote_request("GET", f"/companies/{company_id}", trace_id=trace_id)
        dashboard = self._remote_request("GET", f"/companies/{company_id}/dashboard", trace_id=trace_id)
        activity = self._remote_request("GET", f"/companies/{company_id}/activity", trace_id=trace_id)
        issues = self._remote_request("GET", f"/companies/{company_id}/issues?status=todo,in_progress,blocked", trace_id=trace_id)
        approvals = self._remote_request("GET", f"/companies/{company_id}/approvals?status=pending", trace_id=trace_id)

        errors: list[str] = []
        for label, payload in (("company", company), ("dashboard", dashboard), ("activity", activity), ("issues", issues), ("approvals", approvals)):
            if isinstance(payload, dict) and payload.get("error"):
                errors.append(f"{label}: {payload['error']}")

        snapshot = {
            "transport": "http",
            "api_url": base_url,
            "company_id": company_id,
            "agent": self._strip_remote_metadata(remote_self) if remote_self else ({"id": agent_id} if agent_id else {}),
            "company": self._strip_remote_metadata(company),
            "dashboard": self._strip_remote_metadata(dashboard),
            "activity": self._strip_remote_metadata(activity),
            "open_issues": self._strip_remote_metadata(issues),
            "pending_approvals": self._strip_remote_metadata(approvals),
            "requested_sources": query.get("include_sources", list(SYSTEMS)),
            "focus": query.get("focus", "CEO briefing"),
        }
        if errors:
            snapshot["errors"] = errors
        return snapshot

    def _local_read(self, db: Session, query: dict[str, Any]) -> AdapterResult:
        companies = db.query(Company).all()
        tasks = db.query(Task).filter(Task.status == "open").order_by(Task.priority.desc()).limit(10).all()
        approvals = db.query(ApprovalRequest).filter(ApprovalRequest.status == "pending").order_by(ApprovalRequest.created_at.desc()).limit(10).all()
        workflows = db.query(WorkflowRun).filter(WorkflowRun.status.in_(["running", "blocked"])).order_by(WorkflowRun.created_at.desc()).limit(10).all()
        result = {
            "scope": query.get("focus", "CEO briefing"),
            "companies": [{"id": c.id, "name": c.name, "health_score": c.health_score} for c in companies],
            "open_tasks": [{"id": t.id, "title": t.title, "priority": t.priority, "risk_level": t.risk_level} for t in tasks],
            "pending_approvals": [{"id": a.id, "title": a.title, "risk_level": a.risk_level} for a in approvals],
            "active_workflows": [{"id": w.id, "title": w.title, "status": w.status} for w in workflows],
            "recent_audit": [{"action": row.action, "allowed": row.allowed, "risk_level": row.risk_level} for row in db.query(AuditLog).order_by(AuditLog.created_at.desc()).limit(5).all()],
        }
        return AdapterResult(self.name, "local", "Paperclip local state summary prepared.", result, fallback=True)

    def _remote_read(self, db: Session, query: dict[str, Any], trace_id: str | None = None) -> AdapterResult:
        snapshot = self._remote_snapshot(query, trace_id=trace_id)
        if snapshot.get("hard_error"):
            return AdapterResult(self.name, "remote_error", "Paperclip remote API unavailable.", snapshot, fallback=False)
        open_issues = snapshot.get("open_issues")
        pending_approvals = snapshot.get("pending_approvals")
        result = {
            "scope": snapshot.get("focus", query.get("focus", "CEO briefing")),
            "source": "paperclip-remote-api",
            "snapshot": snapshot,
            "summary": [
                "Paperclip remote API snapshot loaded.",
                f"Open issues: {len(open_issues) if isinstance(open_issues, list) else 'unknown'}.",
                f"Pending approvals: {len(pending_approvals) if isinstance(pending_approvals, list) else 'unknown'}.",
                "Use Paperclip as the durable system of record for tasks and approvals.",
            ],
        }
        return AdapterResult(self.name, "connected", "Paperclip remote read complete.", result, fallback=False)

    def read(self, db: Session, query: dict[str, Any]) -> AdapterResult:
        if self._api_base_url():
            return self._remote_read(db, query)
        return self._local_read(db, query)

    def _local_plan(self, db: Session, request: dict[str, Any]) -> AdapterResult:
        summary = self.read(db, request).payload
        result = {
            "paperclip_plan": [
                "Update the canonical task state in Paperclip.",
                "Write or confirm the approval record if the action is high-impact.",
                "Persist the execution trace so other systems inherit the result.",
            ],
            "state_snapshot": summary,
        }
        return AdapterResult(self.name, "local", "Paperclip plan synthesized locally.", result, fallback=True)

    def _remote_plan(self, db: Session, request: dict[str, Any], trace_id: str | None = None) -> AdapterResult:
        snapshot = self._remote_snapshot(request, trace_id=trace_id)
        if snapshot.get("hard_error"):
            return AdapterResult(self.name, "remote_error", "Paperclip remote API unavailable.", snapshot, fallback=False)
        issues = snapshot.get("open_issues") if isinstance(snapshot.get("open_issues"), list) else []
        approvals = snapshot.get("pending_approvals") if isinstance(snapshot.get("pending_approvals"), list) else []
        dashboard = snapshot.get("dashboard") if isinstance(snapshot.get("dashboard"), dict) else {}
        result = {
            "recommended_path": [
                "Keep the company state in Paperclip as the source of truth.",
                "Start with the smallest reversible change and record it in the audit trail.",
                "Gate high-impact changes behind approvals before execution.",
            ],
            "state_snapshot": snapshot,
            "priority_signals": {
                "open_issue_count": len(issues),
                "pending_approval_count": len(approvals),
                "task_counts": dashboard.get("task_counts", {}),
                "agent_counts": dashboard.get("agent_counts", {}),
            },
        }
        return AdapterResult(self.name, "connected", "Paperclip remote plan complete.", result, fallback=False)

    def plan(self, db: Session, request: dict[str, Any]) -> AdapterResult:
        if self._api_base_url():
            return self._remote_plan(db, request, trace_id=request.get("trace_id"))
        return self._local_plan(db, request)

    def _local_execute(self, db: Session, request: dict[str, Any]) -> AdapterResult:
        task = Task(
            title=request.get("task", "Federated Paperclip update"),
            description=request.get("description", request.get("task", "")),
            priority=int(request.get("priority", 3)),
            risk_level=request.get("risk_level", "low"),
        )
        db.add(task)
        db.commit()
        result = {"task_id": task.id, "title": task.title, "status": task.status}
        return AdapterResult(self.name, "local", "Paperclip state updated locally.", result, fallback=True)

    def _remote_execute(self, db: Session, request: dict[str, Any], trace_id: str | None = None) -> AdapterResult:
        if not request.get("approved", True):
            snapshot = self._remote_snapshot(request, trace_id=trace_id)
            return AdapterResult(
                self.name,
                "approval_required",
                "Paperclip remote execution requires approval before mutation.",
                {"approval_required": True, "state_snapshot": snapshot},
                fallback=False,
            )

        snapshot = self._remote_snapshot(request, trace_id=trace_id)
        if snapshot.get("hard_error"):
            return AdapterResult(self.name, "remote_error", "Paperclip remote API unavailable.", snapshot, fallback=False)

        company_id = snapshot.get("company_id")
        agent_id = self._resolve_agent_id(snapshot.get("agent", {}) if isinstance(snapshot.get("agent"), dict) else {})
        title = str(request.get("title") or request.get("task") or "Federated Paperclip update")
        description = str(
            request.get("description")
            or request.get("context", {}).get("description")
            or request.get("context", {}).get("notes")
            or request.get("task", "")
        )
        issue_payload: dict[str, Any] = {
            "title": title,
            "description": description,
            "status": request.get("status", "todo"),
            "priority": self._normalize_priority(request.get("priority", "medium")),
        }
        assignee_id = request.get("assigneeAgentId") or request.get("assignee_agent_id") or agent_id
        if assignee_id:
            issue_payload["assigneeAgentId"] = assignee_id
        for key, source in (("parentId", "parent_id"), ("projectId", "project_id"), ("goalId", "goal_id"), ("billingCode", "billing_code")):
            value = request.get(key) or request.get(source)
            if value:
                issue_payload[key] = value

        issue_id = request.get("issueId") or request.get("issue_id")
        if issue_id:
            update_payload: dict[str, Any] = {
                "comment": request.get("comment") or f"Jarvis federation trace {trace_id or 'n/a'}."
            }
            title_override = request.get("title")
            if title_override:
                update_payload["title"] = str(title_override)
            description_override = request.get("description")
            if description_override:
                update_payload["description"] = str(description_override)
            status_override = request.get("status")
            if status_override is not None:
                update_payload["status"] = status_override
            priority_override = request.get("priority")
            if priority_override is not None:
                update_payload["priority"] = self._normalize_priority(priority_override)
            if assignee_id:
                update_payload["assigneeAgentId"] = assignee_id
            for key, source in (("parentId", "parent_id"), ("projectId", "project_id"), ("goalId", "goal_id"), ("billingCode", "billing_code")):
                value = request.get(key) or request.get(source)
                if value:
                    update_payload[key] = value
            updated = self._remote_request("PATCH", f"/issues/{issue_id}", update_payload, trace_id=trace_id)
            if updated and not updated.get("error"):
                result = {
                    "transport": "http",
                    "api_url": snapshot.get("api_url"),
                    "company_id": company_id,
                    "issue_id": issue_id,
                    "updated_issue": self._strip_remote_metadata(updated),
                    "state_snapshot": snapshot,
                }
                return AdapterResult(self.name, "connected", "Paperclip remote issue updated.", result, fallback=False)
            return AdapterResult(self.name, "remote_error", "Paperclip issue update failed.", updated or snapshot, fallback=False)

        issue_payload["description"] = f"{description}\n\nJarvis federation trace: {trace_id or 'n/a'}".strip()
        created = self._remote_request("POST", f"/companies/{company_id}/issues", issue_payload, trace_id=trace_id)
        if created and not created.get("error"):
            result = {
                "transport": "http",
                "api_url": snapshot.get("api_url"),
                "company_id": company_id,
                "agent_id": assignee_id,
                "created_issue": self._strip_remote_metadata(created),
                "state_snapshot": snapshot,
            }
            return AdapterResult(self.name, "connected", "Paperclip remote issue created.", result, fallback=False)
        return AdapterResult(self.name, "remote_error", "Paperclip issue creation failed.", created or snapshot, fallback=False)

    def execute(self, db: Session, request: dict[str, Any]) -> AdapterResult:
        if self._api_base_url():
            return self._remote_execute(db, request, trace_id=request.get("trace_id"))
        return self._local_execute(db, request)


class HermesAdapter(BaseAdapter):
    name = "hermes"
    base_url_setting = "hermes_base_url"
    api_key_setting = "hermes_api_key"
    command_setting = "hermes_command"

    def cli_args(self, op: str, payload: dict[str, Any]) -> list[str]:
        prompt = self.cli_prompt(op, payload)
        return [prompt]

    def cli_stdin(self, op: str, payload: dict[str, Any]) -> str | None:
        return None

    def cli_summary(self, stdout: str, stderr: str) -> str:
        text = (stdout or stderr or "").strip()
        return text.splitlines()[0].strip() if text else "Hermes produced no output"

    def read(self, db: Session, query: dict[str, Any]) -> AdapterResult:
        payload = self._invoke("read", query)
        if payload:
            return AdapterResult(self.name, "connected" if payload.get("transport") else "ok", "Hermes remote analysis complete.", payload, fallback=False)
        decision = simulate_decision(
            db,
            title=query.get("focus", "Strategic review"),
            decision=query.get("decision", query.get("focus", "")),
            horizon_days=int(query.get("horizon_days", 90)),
            assumptions=query.get("assumptions", []),
            constraints=query.get("constraints", []),
        )
        result = {
            "strategy": decision["recommendation"],
            "confidence": decision["confidence"],
            "forecast": decision["forecast"],
            "risks": decision["risks"],
            "mitigations": decision["mitigations"],
            "opportunities": opportunity_radar(db)[:5],
            "alignment": alignment_report(db),
        }
        return AdapterResult(self.name, "local", "Hermes strategic synthesis prepared.", result, fallback=True)

    def plan(self, db: Session, request: dict[str, Any]) -> AdapterResult:
        payload = self._invoke("plan", request)
        if payload:
            return AdapterResult(self.name, "connected" if payload.get("transport") else "ok", "Hermes remote plan complete.", payload, fallback=False)
        readback = self.read(db, request).payload
        result = {
            "recommended_path": readback.get("strategy", "Proceed with the safest reversible option."),
            "scenario_branches": [
                {"branch": "best_case", "condition": "Execution stays reversible and evidence improves."},
                {"branch": "base_case", "condition": "Proceed with one owner and one review date."},
                {"branch": "worst_case", "condition": "Denylist or missing evidence stops execution."},
            ],
            "supporting_evidence": readback,
        }
        return AdapterResult(self.name, "local", "Hermes plan synthesized locally.", result, fallback=True)

    def execute(self, db: Session, request: dict[str, Any]) -> AdapterResult:
        payload = self._invoke("execute", request)
        if payload:
            return AdapterResult(self.name, "connected" if payload.get("transport") else "ok", "Hermes remote execution complete.", payload, fallback=False)
        journal = DecisionJournal(
            title=request.get("task", "Hermes strategic synthesis"),
            context=json.dumps(request.get("context", {})),
            chosen_path=request.get("task", ""),
            expected_outcome="Strategic recommendation captured for review.",
            review_at=datetime.utcnow() + timedelta(days=7),
        )
        db.add(journal)
        db.commit()
        result = {"decision_journal_id": journal.id, "title": journal.title}
        return AdapterResult(self.name, "local", "Hermes synthesis recorded locally.", result, fallback=True)


class PiAdapter(BaseAdapter):
    name = "pi"
    base_url_setting = "pi_base_url"
    api_key_setting = "pi_api_key"
    command_setting = "pi_command"

    def cli_args(self, op: str, payload: dict[str, Any]) -> list[str]:
        prompt = self.cli_prompt(op, payload)
        return [prompt]

    def cli_stdin(self, op: str, payload: dict[str, Any]) -> str | None:
        return None

    def cli_summary(self, stdout: str, stderr: str) -> str:
        text = (stdout or stderr or "").strip()
        return text.splitlines()[0].strip() if text else "Pi produced no output"

    def read(self, db: Session, query: dict[str, Any]) -> AdapterResult:
        payload = self._invoke("read", query)
        if payload:
            return AdapterResult(self.name, "connected" if payload.get("transport") else "ok", "Pi remote read complete.", payload, fallback=False)
        tasks = db.query(Task).filter(Task.status == "open").order_by(Task.priority.desc()).limit(10).all()
        result = {
            "implementation_focus": query.get("focus", "Build and test safely"),
            "open_tasks": [{"id": task.id, "title": task.title, "priority": task.priority, "risk_level": task.risk_level} for task in tasks],
            "recommended_next_step": "Turn one approved outcome into a concrete task, test, and change plan.",
        }
        return AdapterResult(self.name, "local", "Pi implementation context prepared.", result, fallback=True)

    def plan(self, db: Session, request: dict[str, Any]) -> AdapterResult:
        payload = self._invoke("plan", request)
        if payload:
            return AdapterResult(self.name, "connected" if payload.get("transport") else "ok", "Pi remote plan complete.", payload, fallback=False)
        result = {
            "implementation_steps": [
                "Scope the smallest useful change.",
                "Add or update tests first when possible.",
                "Implement one slice.",
                "Run verification and capture the diff.",
            ],
            "files_hint": request.get("files", []),
        }
        return AdapterResult(self.name, "local", "Pi implementation plan prepared locally.", result, fallback=True)

    def execute(self, db: Session, request: dict[str, Any]) -> AdapterResult:
        payload = self._invoke("execute", request)
        if payload:
            return AdapterResult(self.name, "connected" if payload.get("transport") else "ok", "Pi remote execution complete.", payload, fallback=False)
        task = Task(
            title=f"Implement: {request.get('task', 'federated work')}",
            description=request.get("description", request.get("task", "")),
            priority=int(request.get("priority", 3)),
            risk_level=request.get("risk_level", "medium"),
        )
        db.add(task)
        db.commit()
        result = {"task_id": task.id, "title": task.title, "status": task.status}
        return AdapterResult(self.name, "local", "Pi created local implementation task.", result, fallback=True)


class OpenCodeAdapter(BaseAdapter):
    name = "opencode"
    base_url_setting = "opencode_base_url"
    api_key_setting = "opencode_api_key"
    command_setting = "opencode_command"

    def cli_args(self, op: str, payload: dict[str, Any]) -> list[str]:
        return []

    def cli_stdin(self, op: str, payload: dict[str, Any]) -> str | None:
        return self.cli_prompt(op, payload)

    def cli_summary(self, stdout: str, stderr: str) -> str:
        text = (stdout or stderr or "").strip()
        if not text:
            return "OpenCode produced no output"
        for line in text.splitlines():
            candidate = line.strip()
            if candidate:
                try:
                    event = json.loads(candidate)
                except Exception:
                    continue
                if isinstance(event, dict):
                    part = event.get("part") if isinstance(event.get("part"), dict) else {}
                    if event.get("type") == "text" and isinstance(part, dict):
                        piece = str(part.get("text", "")).strip()
                        if piece:
                            return piece
        return text.splitlines()[0].strip()

    def read(self, db: Session, query: dict[str, Any]) -> AdapterResult:
        payload = self._invoke("read", query)
        if payload:
            return AdapterResult(self.name, "connected" if payload.get("transport") else "ok", "OpenCode remote read complete.", payload, fallback=False)
        result = {
            "code_context": query.get("focus", "Current codebase and open work"),
            "recent_tasks": [{"id": task.id, "title": task.title, "risk_level": task.risk_level} for task in db.query(Task).order_by(Task.created_at.desc()).limit(5).all()],
            "recommended_next_step": "Use code execution only when the change is explicit and reviewable.",
        }
        return AdapterResult(self.name, "local", "OpenCode local read prepared.", result, fallback=True)

    def plan(self, db: Session, request: dict[str, Any]) -> AdapterResult:
        payload = self._invoke("plan", request)
        if payload:
            return AdapterResult(self.name, "connected" if payload.get("transport") else "ok", "OpenCode remote plan complete.", payload, fallback=False)
        result = {
            "code_plan": [
                "Inspect the target files or command.",
                "Make the smallest safe edit.",
                "Run the narrowest useful verification.",
                "Record the diff and any residual risks.",
            ],
            "command_hint": request.get("command", ""),
        }
        return AdapterResult(self.name, "local", "OpenCode code plan prepared locally.", result, fallback=True)

    def execute(self, db: Session, request: dict[str, Any]) -> AdapterResult:
        payload = self._invoke("execute", request)
        if payload:
            return AdapterResult(self.name, "connected" if payload.get("transport") else "ok", "OpenCode remote execution complete.", payload, fallback=False)
        result = {
            "code_action": "drafted",
            "files": request.get("files", []),
            "command": request.get("command", ""),
            "note": "OpenCode fallback prepared a reviewable execution request instead of mutating code locally.",
        }
        return AdapterResult(self.name, "local", "OpenCode execution prepared locally.", result, fallback=True)


ADAPTERS: dict[str, BaseAdapter] = {
    "paperclip": PaperclipAdapter(),
    "hermes": HermesAdapter(),
    "pi": PiAdapter(),
    "opencode": OpenCodeAdapter(),
}


def _trace_id(kind: str) -> str:
    return f"{kind[:3]}-{uuid.uuid4().hex[:12]}"


def _blocked_reason(text: str) -> str:
    lowered = text.lower()
    for term in DENYLIST_TERMS:
        if term in lowered:
            return f"Blocked by immutable denylist term: {term}."
    return ""


def _store_trace(
    db: Session,
    *,
    trace_id: str,
    kind: str,
    source_systems: list[str],
    target_system: str,
    request: dict[str, Any],
    result: dict[str, Any],
    status: str,
    blocked_reason: str = "",
    rollback_hint: str = "",
) -> FederationTrace:
    row = FederationTrace(
        trace_id=trace_id,
        kind=kind,
        source_systems=source_systems,
        target_system=target_system,
        status=status,
        request=request,
        result=result,
        blocked_reason=blocked_reason,
        rollback_hint=rollback_hint,
    )
    db.add(row)
    db.add(
        AuditLog(
            actor="jarvis",
            action=f"federation:{kind}:{target_system}",
            risk_level="high" if status == "blocked" else "medium",
            allowed=status != "blocked",
            details={"trace_id": trace_id, "kind": kind, "target_system": target_system, "status": status},
        )
    )
    db.commit()
    db.refresh(row)
    return row


def _select_system(task: str, preferred_system: Literal["paperclip", "hermes", "pi", "opencode", "auto"] = "auto") -> str:
    if preferred_system != "auto":
        return preferred_system
    lowered = task.lower()
    if any(term in lowered for term in ["approval", "audit", "workflow", "task", "state", "sync", "paperclip"]):
        return "paperclip"
    if any(term in lowered for term in ["strategy", "decision", "scenario", "forecast", "market", "reason", "why"]):
        return "hermes"
    if any(term in lowered for term in ["implement", "test", "build", "patch", "refactor", "fix", "feature"]):
        return "pi"
    if any(term in lowered for term in ["code", "edit", "apply patch", "command", "script", "shell"]):
        return "opencode"
    return "hermes"


def system_statuses(db: Session) -> dict[str, Any]:
    statuses = {name: ADAPTERS[name].status() for name in SYSTEMS}
    traces = db.query(FederationTrace).order_by(FederationTrace.created_at.desc()).limit(10).all()
    statuses["recent_traces"] = [
        {
            "trace_id": t.trace_id,
            "kind": t.kind,
            "target_system": t.target_system,
            "status": t.status,
            "blocked_reason": t.blocked_reason,
            "created_at": t.created_at,
        }
        for t in traces
    ]
    return statuses


def briefing(db: Session, focus: str, include_sources: list[str] | None = None) -> dict[str, Any]:
    include_sources = include_sources or list(SYSTEMS)
    blocks = {name: ADAPTERS[name].read(db, {"focus": focus}) for name in include_sources if name in ADAPTERS}
    result = {
        "focus": focus,
        "systems": {name: block.payload for name, block in blocks.items()},
        "summary": [
            "Paperclip holds the canonical operational state.",
            "Hermes should frame the decision and the scenarios.",
            "Pi should turn approved work into the smallest executable slice.",
            "OpenCode should apply or execute the reviewable code change.",
        ],
        "gaps": [name for name in SYSTEMS if name not in blocks],
    }
    trace_id = _trace_id("briefing")
    _store_trace(
        db,
        trace_id=trace_id,
        kind="briefing",
        source_systems=list(blocks.keys()),
        target_system="paperclip",
        request={"focus": focus, "include_sources": include_sources},
        result=result,
        status="completed",
        rollback_hint="Re-run briefing with the same focus after state changes.",
    )
    result["trace_id"] = trace_id
    return result


def route_task(db: Session, task: str, preferred_system: Literal["paperclip", "hermes", "pi", "opencode", "auto"] = "auto", context: dict[str, Any] | None = None, allow_execution: bool = True) -> dict[str, Any]:
    context = context or {}
    target_system = _select_system(task, preferred_system)
    trace_id = _trace_id("route")
    plan = ADAPTERS[target_system].plan(db, {"task": task, "trace_id": trace_id, **context})
    result = {
        "task": task,
        "target_system": target_system,
        "recommended_system": target_system,
        "plan_summary": plan.summary,
        "plan": plan.payload,
        "allow_execution": allow_execution,
        "fallback": plan.fallback,
    }
    _store_trace(
        db,
        trace_id=trace_id,
        kind="route",
        source_systems=[target_system],
        target_system=target_system,
        request={"task": task, "preferred_system": preferred_system, "context": context, "allow_execution": allow_execution},
        result=result,
        status="completed",
        rollback_hint="Re-route the task if the preferred system changes or fresh evidence arrives.",
    )
    result["trace_id"] = trace_id
    return result


def execute_task(
    db: Session,
    task: str,
    target_system: Literal["paperclip", "hermes", "pi", "opencode", "auto"] = "auto",
    approved: bool = True,
    context: dict[str, Any] | None = None,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    context = context or {}
    details = details or {}
    blocked_reason = _blocked_reason(task)
    trace_id = _trace_id("exec")
    selected = _select_system(task, target_system)
    if blocked_reason:
        result = {
            "task": task,
            "target_system": selected,
            "approved": approved,
            "status": "blocked",
            "blocked_reason": blocked_reason,
        }
        _store_trace(
            db,
            trace_id=trace_id,
            kind="execute",
            source_systems=[selected],
            target_system=selected,
            request={"task": task, "target_system": target_system, "approved": approved, "context": context},
            result=result,
            status="blocked",
            blocked_reason=blocked_reason,
            rollback_hint="No action was taken; remove the denylisted term or change the request.",
        )
        return {**result, "trace_id": trace_id}

    if not approved:
        approval = ApprovalRequest(
            title=f"Approval required: {task[:180]}",
            action=task,
            risk_level="high",
            rationale="Execution requested without approval flag; recorded for review.",
        )
        db.add(approval)
        db.commit()

    request_payload = {**details, "task": task, "approved": approved, "context": context, "trace_id": trace_id}
    result_block = ADAPTERS[selected].execute(db, request_payload)
    trace_request = {key: value for key, value in request_payload.items() if key != "trace_id"}
    result = {
        "task": task,
        "target_system": selected,
        "approved": approved,
        "status": result_block.status,
        "summary": result_block.summary,
        "result": result_block.payload,
        "fallback": result_block.fallback,
    }
    _store_trace(
        db,
        trace_id=trace_id,
        kind="execute",
        source_systems=[selected],
        target_system=selected,
        request=trace_request,
        result=result,
        status="completed",
        rollback_hint="Revert by closing the created task, journal entry, or code request.",
    )
    result["trace_id"] = trace_id
    return result


def recent_traces(db: Session, limit: int = 25) -> dict[str, Any]:
    rows = db.query(FederationTrace).order_by(FederationTrace.created_at.desc()).limit(min(max(limit, 1), 200)).all()
    return {
        "limit": limit,
        "traces": [
            {
                "trace_id": row.trace_id,
                "kind": row.kind,
                "source_systems": row.source_systems,
                "target_system": row.target_system,
                "status": row.status,
                "blocked_reason": row.blocked_reason,
                "rollback_hint": row.rollback_hint,
                "request": row.request,
                "result": row.result,
                "created_at": row.created_at,
            }
            for row in rows
        ],
    }
