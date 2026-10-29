"""Credential-free regressions executed in the real pinned hermetic SDK."""


def _paperclip_tool_lifecycle_regressions():
  import asyncio
  import contextlib
  import json
  import socket
  import subprocess
  import sys
  from pathlib import Path
  from types import SimpleNamespace
  from unittest import mock
  from acp import schema
  from google.antigravity import types as sdk_types
  from google.antigravity.connections.local.event_processor import LocalHarnessEventProcessor
  from google.antigravity.proto import localharness_pb2 as pb
  from google.antigravity.tools.tool_context import ToolContext
  from google.antigravity.tools.tool_runner import ToolRunner
  from google3.cloud.developer_experience.antigravity_extensions.acp_server import tools
  from google3.cloud.developer_experience.antigravity_extensions.acp_server.server import AgyAdapter, SessionInfo

  sid = "offline-tool-lifecycle"
  workspace = Path(os.environ["HOME"]) / "tool-workspace"
  workspace.mkdir(parents=True)

  class FileClient:
    def __init__(self):
      self.updates = []
      self.blocked = asyncio.Event()
      self.release = asyncio.Event()

    async def session_update(self, session_id, update):
      assert session_id == sid
      self.updates.append(update)

    async def write_text_file(self, session_id, path, content):
      assert session_id == sid
      Path(path).write_bytes(content.encode("utf-8"))

    async def read_text_file(self, session_id, path, line=None, limit=None):
      assert session_id == sid
      if Path(path).name == "blocked.txt":
        self.blocked.set()
        await self.release.wait()
      return schema.ReadTextFileResponse(content=Path(path).read_bytes().decode("utf-8"))

  class Adapter(AgyAdapter):
    async def _maybe_send_usage_update(self, session_id):
      pass

  def forbidden(*args, **kwargs):
    raise AssertionError("offline lifecycle regression reached network or process launch")

  async def run():
    client = FileClient()
    adapter = Adapter()
    adapter._client = client
    info = SessionInfo(agent=SimpleNamespace(), stack=contextlib.AsyncExitStack(), cwd=str(workspace), current_model_id="offline")
    adapter._sessions[sid] = info
    runner = ToolRunner(tools=[tools.make_client_view_file(client, str(workspace)), tools.make_client_create_file(client, str(workspace)), tools.make_client_edit_file(client, str(workspace))])
    runner.set_context(ToolContext(SimpleNamespace(conversation_id=sid)))
    wire = []

    async def send(event):
      assert event.HasField("tool_response")
      wire.append(event.tool_response)

    processor = LocalHarnessEventProcessor(send_input_event_fn=send, tool_runner=runner)
    opened = {}

    async def drain():
      steps = []
      while not processor.step_queue.empty():
        step = processor.step_queue.get_nowait()
        steps.append(step)
        await adapter._stream_live_step(sid, step, opened)
      return steps

    async def call(name, call_id, args, permission_frame=None):
      if permission_frame:
        info.pending_permission_frames[name] = [permission_frame]
      await processor.handle_tool_call(pb.ToolCall(id=call_id, name=name, trajectory_id=sid, arguments_json=json.dumps(args)))
      steps = await drain()
      assert len(steps) == 2, "actual client ToolResult must yield an ACTIVE and terminal step"
      assert [s.tool_calls[0].id for s in steps] == [call_id, call_id]
      assert all(s.id == call_id and s.tool_calls[0].step_id is None for s in steps), "preserve the callback protocol's real identity without inventing a step id"
      assert wire[-1].id == call_id
      frame = permission_frame or call_id
      terminals = [u for u in client.updates if u.tool_call_id == frame and u.status in ("completed", "failed")]
      assert len(terminals) == 1
      assert frame not in opened
      return steps[-1], terminals[0], wire[-1]

    proof = workspace / "proof.txt"
    exact = "  exact café 🧷\n"
    terminal, update, response = await call("client_create_file", "create-call", {"target_file": str(proof), "code_content": exact}, "create-permission")
    assert terminal.status == sdk_types.StepStatus.DONE and terminal.content == ""
    assert update.status == "completed" and update.raw_output == ""
    assert proof.read_bytes() == exact.encode("utf-8")
    assert json.loads(response.response_json) == {"result": None}
    terminal, update, response = await call("client_view_file", "read-call", {"absolute_path": str(proof)})
    assert terminal.content == exact and update.raw_output == exact
    assert json.loads(response.response_json) == {"result": exact}
    edited = "replacement\n"
    await call("client_edit_file", "edit-call", {"target_file": str(proof), "code_content": edited})
    assert proof.read_bytes() == edited.encode("utf-8")

    failed_path = workspace / "missing-parent" / "failed-write.txt"
    terminal, update, response = await call("client_create_file", "failed-write-call", {"target_file": str(failed_path), "code_content": "must not exist"})
    assert terminal.status == sdk_types.StepStatus.ERROR and update.status == "failed"
    assert update.raw_output == terminal.error == response.error_message
    assert not failed_path.exists()

    # A real pending callback overlaps a different callback's actual failure.
    (workspace / "blocked.txt").write_bytes(b"still independent\n")
    pending = asyncio.create_task(processor.handle_tool_call(pb.ToolCall(id="pending-call", name="client_view_file", trajectory_id=sid, arguments_json=json.dumps({"absolute_path": str(workspace / "blocked.txt")}))))
    await client.blocked.wait()
    await drain()
    assert "pending-call" in opened
    terminal, update, response = await call("client_view_file", "missing-call", {"absolute_path": str(workspace / "missing.txt")}, "missing-permission")
    assert terminal.status == sdk_types.StepStatus.ERROR and terminal.error
    assert update.status == "failed" and update.raw_output == terminal.error
    assert response.error_message == terminal.error
    assert "pending-call" in opened, "a genuine callback failure must not fail its concurrent sibling"
    assert not [u for u in client.updates if u.tool_call_id == "pending-call" and u.status == "failed"]
    client.release.set()
    await pending
    await drain()
    assert "pending-call" not in opened
    assert [u for u in client.updates if u.tool_call_id == "pending-call" and u.status == "completed"][0].raw_output == "still independent\n"

    # Native errors close only the failing call, including permission identity.
    def native_step(call_id, status, error="", calls=True):
      return sdk_types.Step(id="native-step", trajectory_id=sid, type=sdk_types.StepType.TOOL_CALL, status=status, error=error, tool_calls=[sdk_types.ToolCall(id=call_id, step_id="native-step", name="native_tool")] if calls else [])
    info.pending_permission_frames["native_tool"] = ["native-permission"]
    await adapter._stream_live_step(sid, native_step("native-execution", sdk_types.StepStatus.ACTIVE), opened)
    opened["unrelated"] = "native_other_tool"
    await adapter._stream_live_step(sid, native_step("native-execution", sdk_types.StepStatus.ERROR, "exact native failure"), opened)
    assert "native-permission" not in opened and "unrelated" in opened
    failures = [u for u in client.updates if u.status == "failed"]
    assert {u.tool_call_id for u in failures} == {"failed-write-call", "missing-permission", "native-permission"}
    assert failures[-1].raw_output == "exact native failure"
    before = len(client.updates)
    await adapter._stream_live_step(sid, native_step("unattributed", sdk_types.StepStatus.ERROR, "turn-only error", calls=False), opened)
    assert len(client.updates) == before and "unrelated" in opened, "an unattributed error has no authority to fail an unrelated tool"
    # The existing failed-turn cleanup still settles unresolved work, without
    # copying an unrelated step's error or fabricating completed callbacks.
    await adapter._close_open_tool_calls(sid, set(opened), "failed")
    assert client.updates[-1].tool_call_id == "unrelated" and client.updates[-1].status == "failed"
    assert client.updates[-1].raw_output is None

  with contextlib.ExitStack() as stack:
    for owner, name in ((socket, "create_connection"), (subprocess, "Popen"), (asyncio, "create_subprocess_exec")):
      stack.enter_context(mock.patch.object(owner, name, side_effect=forbidden))
    asyncio.run(run())
  sys.stderr.write("paperclip-tool-lifecycle-regressions: passed\n")


_paperclip_tool_lifecycle_regressions()
