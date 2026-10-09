import asyncio
import json
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from openai import OpenAI
from billing import MAX_FRAME, TurnBilling, close_turn, fence_background_dispatch, install_billing_capture, start_turn


def document(cost="0.0042"):
    return ('{"id":"fixture-response","model":"fixture-model","choices":[],"usage":'
            '{"prompt_tokens":20,"completion_tokens":5,"prompt_tokens_details":'
            '{"cached_tokens":3,"cache_write_tokens":2},"cost":' + cost + '}}').encode()


def sse(body):
    return b'data: {"choices":[{"delta":{"content":"private fixture text"},"index":0}]}\n\n' \
        + b"data: " + body + b"\n\ndata: [DONE]\n\n"


class Accounting(unittest.TestCase):
    def test_every_chunk_boundary_preserves_reported_cost_and_disjoint_cache_tokens(self):
        wire = sse(document())
        for boundary in range(len(wire) + 1):
            ledger = TurnBilling(); receipt = ledger.begin()
            receipt.feed(wire[:boundary]); receipt.feed(wire[boundary:])
            billed, tokens = ledger.finish()
            self.assertEqual(tokens, (15, 5, 3, 2))
            self.assertEqual(billed["amountUsdExact"], "0.004200000")
            self.assertTrue(billed["complete"])
            self.assertNotIn("private", json.dumps(billed))

    def test_auxiliary_and_concurrent_requests_are_included_once_each(self):
        ledger = TurnBilling()
        def call():
            receipt = ledger.begin(); receipt.json(document("0.000000001"))
            receipt.json(document("0.000000001"))  # a reread is not another wire request
        threads = [threading.Thread(target=call) for _ in range(12)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        billed, tokens = ledger.finish()
        self.assertEqual(billed["amountUsdExact"], "0.000000012")
        self.assertEqual(billed["requestCount"], 12)
        self.assertEqual(tokens, (180, 60, 36, 24))

    def test_pending_failed_retry_and_background_work_never_certify_a_subtotal(self):
        for scenario in ("pending", "failed", "background"):
            ledger = TurnBilling(); ledger.begin().json(document())
            if scenario != "background":
                pending = ledger.begin()
                if scenario == "failed": pending.failed()
            billed, tokens = ledger.finish(owned_work_complete=scenario != "background")
            self.assertFalse(billed["complete"])
            self.assertEqual(billed["amountUsdExact"], "0.004200000")
            self.assertIsNone(tokens)

    def test_explicit_zero_and_no_request_are_distinct_from_missing_price(self):
        ledger = TurnBilling(); ledger.begin().json(document("0"))
        billed, tokens = ledger.finish()
        self.assertTrue(billed["complete"])
        self.assertEqual(tokens, (15, 5, 3, 2))
        self.assertEqual(billed["amountUsdExact"], "0.000000000")
        billed, tokens = TurnBilling().finish()
        self.assertTrue(billed["complete"])
        self.assertEqual(tokens, (0, 0, 0, 0))
        ledger = TurnBilling(); ledger.begin().json(document("null"))
        billed, tokens = ledger.finish()
        self.assertFalse(billed["complete"])
        self.assertEqual(tokens, (15, 5, 3, 2))

    def test_invalid_costs_missing_usage_and_conflicting_receipts_are_unpriced(self):
        for body in [document(value) for value in ("-1", "true", '"0.1"', "NaN", "1e900", "1000001")]:
            ledger = TurnBilling(); ledger.begin().json(body)
            self.assertFalse(ledger.finish()[0]["complete"])
        for body in (b"{}", b"not-json", b'{"error":{"message":"private"}}'):
            ledger = TurnBilling(); ledger.begin().json(body)
            self.assertFalse(ledger.finish()[0]["complete"])
        ledger = TurnBilling(); receipt = ledger.begin()
        receipt.json(document()); receipt.json(document("0.01"))
        billed, _ = ledger.finish()
        self.assertFalse(billed["complete"])
        self.assertEqual(billed["reportedRequestCount"], 0)
        self.assertEqual(billed["amountUsdExact"], "0.000000000")

    def test_verified_frame_before_an_unfinished_response_is_a_known_subtotal(self):
        ledger = TurnBilling(); receipt = ledger.begin()
        receipt.feed(b"data: " + document() + b"\n\n")
        billed, tokens = ledger.finish()
        self.assertEqual(billed["reportedRequestCount"], 1)
        self.assertEqual(billed["amountUsdExact"], "0.004200000")
        self.assertFalse(billed["complete"])
        self.assertIsNone(tokens)

    def test_truncation_and_oversized_frames_are_unpriced(self):
        for wire in (b"data: " + document() + b"\n", b"data: " + b"x" * (MAX_FRAME + 1)):
            ledger = TurnBilling(); receipt = ledger.begin(); receipt.feed(wire); receipt.eof()
            billed, tokens = ledger.finish()
            self.assertFalse(billed["complete"])
            self.assertIsNone(tokens)


class Transport(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        install_billing_capture()
        install_billing_capture()  # idempotent, including the async fallback

    def setUp(self):
        self.env = patch.dict("os.environ", {"OPENROUTER_API_KEY": "synthetic-fixture-only"})
        self.env.start()
        self.ledger = start_turn(SimpleNamespace(provider="openrouter", api_mode="chat_completions"))

    def tearDown(self):
        close_turn(self.ledger)
        self.env.stop()

    def test_real_pinned_sdk_stream_keeps_text_and_cost_without_an_agent_callback(self):
        body = document().replace(b'"choices":[]', b'"choices":[{"delta":{},"index":0,"finish_reason":"stop"}]')
        transport = httpx.MockTransport(lambda request: httpx.Response(200, headers={"content-type": "text/event-stream"},
            stream=httpx.ByteStream(sse(body))))
        with httpx.Client(transport=transport) as client, OpenAI(http_client=client, api_key="synthetic-fixture-only", base_url="https://openrouter.ai/api/v1") as sdk:
            with sdk.chat.completions.create(model="fixture-model", messages=[{"role": "user", "content": "private fixture prompt"}], stream=True) as stream:
                chunks = list(stream)
        self.assertEqual(chunks[0].choices[0].delta.content, "private fixture text")
        self.assertEqual(self.ledger.finish()[0]["amountUsdExact"], "0.004200000")

    def test_sdk_retry_is_a_second_attempt_and_preserves_unknown_cost(self):
        calls = []
        def reply(request):
            calls.append(request)
            return httpx.Response(429, json={"error": {"message": "retry fixture"}}, headers={"retry-after-ms": "1"}) if len(calls) == 1 \
                else httpx.Response(200, content=document())
        with httpx.Client(transport=httpx.MockTransport(reply)) as client, OpenAI(http_client=client, api_key="synthetic-fixture-only", base_url="https://openrouter.ai/api/v1", max_retries=1) as sdk:
            sdk.chat.completions.create(model="fixture-model", messages=[])
        billed, tokens = self.ledger.finish()
        self.assertEqual(billed["requestCount"], 2)
        self.assertEqual(billed["reportedRequestCount"], 1)
        self.assertEqual(billed["amountUsdExact"], "0.004200000")
        self.assertFalse(billed["complete"])
        self.assertIsNone(tokens)

    def test_interrupted_stream_keeps_its_verified_charge_before_a_successful_retry(self):
        class InterruptedStream(httpx.SyncByteStream):
            def __iter__(self):
                yield b"data: " + document() + b"\n\n"
                raise httpx.ReadError("synthetic interrupted stream")

        calls = []
        def reply(request):
            calls.append(request)
            if len(calls) == 1:
                return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=InterruptedStream())
            return httpx.Response(200, content=document())

        with httpx.Client(transport=httpx.MockTransport(reply)) as client, OpenAI(http_client=client, api_key="synthetic-fixture-only", base_url="https://openrouter.ai/api/v1") as sdk:
            with self.assertRaises(httpx.ReadError):
                with sdk.chat.completions.create(model="fixture-model", messages=[], stream=True) as stream:
                    list(stream)
            sdk.chat.completions.create(model="fixture-model", messages=[])
        billed, tokens = self.ledger.finish()
        self.assertEqual(billed["requestCount"], 2)
        self.assertEqual(billed["reportedRequestCount"], 2)
        self.assertEqual(billed["amountUsdExact"], "0.008400000")
        self.assertFalse(billed["complete"])
        self.assertIsNone(tokens)

    def test_account_or_endpoint_changes_cannot_mint_billing_for_the_selected_account(self):
        for url, key in [("https://other.test/v1/chat/completions", "synthetic-fixture-only"),
                         ("https://openrouter.ai/api/v1/chat/completions", "another-fixture-account"),
                         ("http://openrouter.ai/api/v1/chat/completions", "synthetic-fixture-only")]:
            with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=document()))) as client:
                client.post(url, headers={"authorization": "Bearer " + key})
        billed, tokens = self.ledger.finish()
        self.assertEqual(billed["requestCount"], 3)
        self.assertFalse(billed["complete"])
        self.assertEqual(billed["reportedRequestCount"], 0)
        self.assertIsNone(tokens)

    def test_future_async_inference_is_unknown_instead_of_silently_free(self):
        async def call():
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=document()))) as client:
                await client.post("https://openrouter.ai/api/v1/chat/completions", headers={"authorization": "Bearer synthetic-fixture-only"})
        asyncio.run(call())
        billed, tokens = self.ledger.finish()
        self.assertEqual(billed["requestCount"], 1)
        self.assertFalse(billed["complete"])
        self.assertIsNone(tokens)

    def test_delayed_background_dispatch_is_fenced_before_a_child_can_start(self):
        calls = []
        dispatch = fence_background_dispatch(lambda value: calls.append(value) or "native dispatch result")
        self.assertEqual(dispatch("batch"), "native dispatch result")
        self.assertEqual(calls, ["batch"])
        billed, tokens = self.ledger.finish()
        self.assertFalse(billed["complete"])
        self.assertIsNone(tokens)


if __name__ == "__main__":
    unittest.main()
