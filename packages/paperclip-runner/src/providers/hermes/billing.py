"""Turn-owned OpenRouter wire receipts for the pinned synchronous SDK transport.

Observe bytes without changing requests or Hermes's loop. Retry attempts,
compaction and delegated calls share the ledger; incomplete requests stay unknown.
No request headers, prompts, response text or credentials enter the receipt.
"""
from __future__ import annotations

import json
import threading
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

MAX_REQUESTS = 10000
MAX_FRAME = 1024 * 1024
MAX_BODY = 8 * MAX_FRAME
_active = None
_active_lock = threading.Lock()


def _count(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 9007199254740991 else None


def _usage(value):
    if not isinstance(value, dict):
        return None, None
    prompt, output = _count(value.get("prompt_tokens")), _count(value.get("completion_tokens"))
    details = value.get("prompt_tokens_details") or {}
    if not isinstance(details, dict):
        return None, None
    read, write = _count(details.get("cached_tokens", 0)), _count(details.get("cache_write_tokens", 0))
    tokens = None
    if None not in (prompt, output, read, write) and prompt >= read + write:
        tokens = (prompt - read - write, output, read, write)
    raw_cost = value.get("cost")
    cost = None
    if isinstance(raw_cost, (int, Decimal)) and not isinstance(raw_cost, bool):
        try:
            amount = Decimal(raw_cost)
            if amount.is_finite() and 0 <= amount <= 1000000:
                cost = int((amount * 1000000000).quantize(Decimal(1), rounding=ROUND_HALF_UP))
        except InvalidOperation:
            pass
    return tokens, cost


class TurnBilling:
    def __init__(self):
        self._lock = threading.RLock()
        self._requests = []
        self._closed = False
        self._overflow = False
        self._children = set()

    def child(self, identity, started):
        with self._lock:
            if started:
                self._children.add(identity)
                if len(self._children) > MAX_REQUESTS:
                    self._overflow = True
            else:
                if identity not in self._children:
                    self._overflow = True
                self._children.discard(identity)

    def incomplete(self):
        with self._lock:
            self._overflow = True

    def begin(self, authorized=True):
        with self._lock:
            if self._closed or len(self._requests) >= MAX_REQUESTS:
                self._overflow = True
                return None
            receipt = WireReceipt(self, authorized)
            self._requests.append(receipt)
            return receipt

    def finish(self, owned_work_complete=True):
        with self._lock:
            self._closed = True
            completed = [r for r in self._requests if r.valid and r.done]
            # A verified usage frame can precede a transport interruption.
            # Keep that known charge without certifying the request's totals.
            priced = [r for r in self._requests if r.cost_verified]
            tokenized = [r for r in completed if r.tokens is not None]
            scope_complete = owned_work_complete and not self._overflow and not self._children
            cost = sum(r.cost for r in priced)
            if cost > 1000000000000000:
                raise ValueError("Hermes reported turn cost exceeds its receipt bound")
            complete = scope_complete and len(completed) == len(self._requests) and len(priced) == len(self._requests)
            token_complete = scope_complete and len(tokenized) == len(self._requests)
            totals = tuple(sum(r.tokens[i] for r in tokenized) for i in range(4))
            if any(value > 9007199254740991 for value in totals):
                token_complete = False
            return {
                "schema": "paperclip.usage.billing/v1", "source": "provider_reported",
                "biller": "openrouter", "currency": "USD", "complete": complete,
                "requestCount": len(self._requests), "reportedRequestCount": len(priced),
                "amountUsd": cost / 1000000000,
                "amountUsdExact": f"{cost // 1000000000}.{cost % 1000000000:09d}",
            }, totals if token_complete else None


class WireReceipt:
    def __init__(self, owner, authorized):
        self.owner = owner
        self.valid = authorized
        self.done = False
        self.tokens = None
        self.cost = None
        self.cost_verified = False
        self._seen_usage = False
        self._buffer = bytearray()
        self._data = []
        self._frame_size = 0

    def _document(self, data):
        try:
            value = json.loads(data, parse_float=Decimal)
        except (ValueError, UnicodeError):
            self.valid = False
            self.cost_verified = False
            return
        if not isinstance(value, dict):
            self.valid = False
            self.cost_verified = False
            return
        usage = value.get("usage")
        if usage is not None:
            tokens, cost = _usage(usage)
            if self._seen_usage and (tokens != self.tokens or cost != self.cost):
                self.valid = False
            self._seen_usage = True
            self.tokens, self.cost = tokens, cost
            self.cost_verified = self.valid and cost is not None
        if value.get("error") is not None:
            self.valid = False
            self.cost_verified = False

    def json(self, body):
        with self.owner._lock:
            if len(body) > MAX_BODY:
                self.valid = False
                self.cost_verified = False
            else:
                self._document(body)
            self.done = True

    def feed(self, chunk):
        with self.owner._lock:
            if not self.valid or self.done:
                return
            self._buffer.extend(chunk)
            while b"\n" in self._buffer:
                line, _, rest = self._buffer.partition(b"\n")
                self._buffer = bytearray(rest)
                line = line.rstrip(b"\r")
                if not line:
                    data = b"\n".join(self._data)
                    self._data.clear()
                    self._frame_size = 0
                    if data == b"[DONE]":
                        self.done = True
                        self._buffer.clear()
                        return
                    if data:
                        self._document(data)
                elif line.startswith(b"data:"):
                    data = line[5:].lstrip(b" ")
                    self._frame_size += len(data)
                    if self._frame_size > MAX_FRAME:
                        self.valid = False
                        self._data.clear()
                        self._buffer.clear()
                        return
                    self._data.append(bytes(data))
            if len(self._buffer) > MAX_FRAME:
                self.valid = False
                self._buffer.clear()

    def eof(self):
        with self.owner._lock:
            # A truncated SSE frame is not a complete response, even when a
            # previous frame happened to contain usage.
            if not self._buffer and not self._data:
                self.done = True
            self._buffer.clear()
            self._data.clear()

    def failed(self):
        with self.owner._lock:
            self.valid = False
            self._buffer.clear()
            self._data.clear()


def start_turn(agent):
    global _active
    # Only the native selected OpenRouter Chat Completions route is qualified
    # for billed usage.cost. Custom protocols and model-price estimates are not.
    enabled = getattr(agent, "provider", None) == "openrouter" and getattr(agent, "api_mode", None) == "chat_completions"
    with _active_lock:
        if _active is not None:
            raise ValueError("Hermes billing already belongs to an active turn")
        _active = TurnBilling() if enabled else None
        return _active


def close_turn(ledger):
    global _active
    with _active_lock:
        if _active is ledger:
            _active = None


def fence_background_dispatch(dispatch):
    def run(*args, **kwargs):
        with _active_lock:
            ledger = _active
        if ledger is not None:
            # A background unit can start a child after the parent settles.
            # Keep its observed subtotal, but do not certify full settlement
            # before the per-turn process lifecycle has stopped that unit.
            ledger.incomplete()
        return dispatch(*args, **kwargs)
    return run


def install_billing_capture():
    import httpx
    import os
    if getattr(httpx.Client.send, "_paperclip_billing", False):
        return
    original_send, original_bytes = httpx.Client.send, httpx.Response.iter_bytes
    original_async_send = httpx.AsyncClient.send

    def inference_request(request):
        return request.method == "POST" and request.url.path.rstrip("/").endswith(("/chat/completions", "/responses", "/messages"))

    def send(client, request, *args, **kwargs):
        with _active_lock:
            ledger = _active
        # Include every real wire attempt, including retries beneath the SDK,
        # rather than only the final response accepted by the agent loop.
        receipt = None
        if ledger is not None and inference_request(request):
            key = os.environ.get("OPENROUTER_API_KEY")
            authorized = bool(key) and request.url.scheme == "https" and request.url.host == "openrouter.ai" \
                and request.url.port in (None, 443) and request.url.path == "/api/v1/chat/completions" \
                and not request.url.query and not request.url.username and not request.url.password \
                and request.headers.get("authorization") == "Bearer " + key
            receipt = ledger.begin(authorized)
        try:
            response = original_send(client, request, *args, **kwargs)
        except BaseException:
            if receipt is not None:
                receipt.failed()
            raise
        if receipt is not None:
            response.extensions["paperclip_billing"] = receipt
            if response.status_code != 200 or response.history or response.url != request.url:
                receipt.failed()
            elif response.is_stream_consumed:
                receipt.json(response.content)
        return response

    def iter_bytes(response, *args, **kwargs):
        receipt = response.extensions.get("paperclip_billing")
        stream = response.headers.get("content-type", "").split(";", 1)[0].strip() == "text/event-stream"
        try:
            for chunk in original_bytes(response, *args, **kwargs):
                if receipt is not None and stream:
                    receipt.feed(chunk)
                yield chunk
        except GeneratorExit:
            # The SDK stops at [DONE], before exhausting the HTTP iterator.
            # Only a fully observed final receipt can survive that close.
            raise
        except BaseException:
            if receipt is not None:
                receipt.failed()
            raise
        else:
            if receipt is not None:
                if stream:
                    receipt.eof()
                elif response.is_stream_consumed:
                    receipt.json(response.content)

    send._paperclip_billing = True
    httpx.Client.send, httpx.Response.iter_bytes = send, iter_bytes

    async def async_send(client, request, *args, **kwargs):
        # Native inference uses the pinned synchronous SDK. A new asynchronous
        # path must not silently turn an unobserved request into free work.
        with _active_lock:
            ledger = _active
        if ledger is not None and inference_request(request):
            ledger.begin(False)
        return await original_async_send(client, request, *args, **kwargs)

    httpx.AsyncClient.send = async_send
