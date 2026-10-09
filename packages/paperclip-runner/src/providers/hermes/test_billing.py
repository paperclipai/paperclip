import asyncio
import json
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from anthropic import Anthropic
from openai import OpenAI
from billing import MAX_FRAME, TurnBilling, TokenBilling, close_turn, fence_background_dispatch, install_billing_capture, start_turn


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


class DirectTokens(unittest.TestCase):
    def test_anthropic_chunk_boundaries_merge_final_usage_without_double_counting(self):
        wire = b''.join(b'data: ' + json.dumps(event).encode() + b'\n\n' for event in [
            {"type": "message_start", "message": {"usage": {"input_tokens": 12, "output_tokens": 1,
                "cache_read_input_tokens": 30, "cache_creation_input_tokens": 20}}},
            {"type": "content_block_delta", "delta": {"text": "private text is not retained"}},
            {"type": "message_delta", "usage": {"output_tokens": 4}}, {"type": "message_stop"}])
        for boundary in range(len(wire) + 1):
            ledger = TokenBilling("anthropic", "claude-haiku-4-5-20251001", "messages")
            receipt = ledger.begin(); receipt.feed(wire[:boundary]); receipt.feed(wire[boundary:])
            accounting, tokens = ledger.finish()
            self.assertTrue(accounting['complete']); self.assertEqual(tokens, (12, 4, 30, 20))
            self.assertEqual(accounting['source'], 'provider_wire'); self.assertNotIn('amountUsd', accounting)
            self.assertNotIn('private', json.dumps(accounting))

    def test_openai_chat_and_responses_keep_cached_and_reasoning_tokens_disjoint(self):
        for protocol, body in [('chat_completions', sse(document())), ('responses', b'data: ' + json.dumps({
            'type': 'response.completed', 'response': {'status': 'completed', 'service_tier': 'default',
                'usage': {'input_tokens': 20, 'output_tokens': 5, 'input_tokens_details': {'cached_tokens': 3},
                    'output_tokens_details': {'reasoning_tokens': 4}}}}).encode() + b'\n\n')]:
            ledger = TokenBilling('openai', 'gpt-6-luna', protocol)
            receipt = ledger.begin(); receipt.feed(body)
            accounting, tokens = ledger.finish()
            self.assertTrue(accounting['complete'])
            self.assertEqual(tokens, (15, 5, 3, 2) if protocol == 'chat_completions' else (17, 5, 3, 0))
            self.assertNotIn('amountUsd', accounting)

    def test_unfinished_retry_background_and_wrong_route_remain_unknown(self):
        for fail in ['retry', 'truncated', 'background', 'wrong_route', 'long_context', 'fast_tier']:
            ledger = TokenBilling('openai', 'gpt-6-luna', 'chat_completions')
            receipt = ledger.begin(fail != 'wrong_route')
            body = document()
            if fail == 'long_context': body = body.replace(b'"prompt_tokens":20', b'"prompt_tokens":128006')
            if fail == 'fast_tier': body = body[:-1] + b',"service_tier":"priority"}'
            receipt.feed(sse(body) if fail != 'truncated' else b'data: ' + body + b'\n\n')
            if fail == 'truncated': receipt.eof()
            if fail == 'retry': ledger.begin().failed()
            if fail == 'background': ledger.incomplete()
            accounting, tokens = ledger.finish()
            self.assertFalse(accounting['complete'], fail); self.assertIsNone(tokens, fail)

    def test_authority_binds_exact_credential_endpoint_protocol_model_and_standard_request(self):
        ledger = TokenBilling('anthropic', 'fixture-model', 'messages')
        environment = {'ANTHROPIC_API_KEY': 'synthetic'}
        def request(url='https://api.anthropic.com/v1/messages', key='synthetic', **body):
            return httpx.Request('POST', url, headers={'x-api-key': key}, json={'model': 'fixture-model', **body})
        self.assertTrue(ledger.authorized_request(request(), environment))
        for wrong in [request(key='foreign'), request(url='https://custom.example/v1/messages'),
                      request(url='https://api.anthropic.com/v1/messages?route=other'), request(model='other'),
                      request(speed='fast'), request(inference_geo='us'), request(tools=[{'type':'web_search_20250305'}])]:
            self.assertFalse(ledger.authorized_request(wrong, environment))

    def test_failed_response_and_missing_anthropic_final_usage_do_not_certify_tokens(self):
        ledger = TokenBilling('openai', 'fixture-model', 'responses')
        ledger.begin().json(b'{"status":"failed","usage":{"input_tokens":20,"output_tokens":5}}')
        self.assertFalse(ledger.finish()[0]['complete'])
        ledger = TokenBilling('anthropic', 'fixture-model', 'messages')
        ledger.begin().feed(b'data: {"type":"message_start","message":{"usage":{"input_tokens":20,"output_tokens":1}}}\n\n'
            b'data: {"type":"message_stop"}\n\n')
        self.assertFalse(ledger.finish()[0]['complete'])

    def test_real_pinned_anthropic_and_openai_clients_supply_complete_wire_receipts(self):
        install_billing_capture()
        for provider, mode in [('anthropic', 'anthropic_messages'), ('openai', 'chat_completions')]:
            key_name = 'ANTHROPIC_API_KEY' if provider == 'anthropic' else 'OPENAI_API_KEY'
            model = 'claude-haiku-4-5-20251001' if provider == 'anthropic' else 'fixture-model'
            ledger = start_turn(SimpleNamespace(provider=provider, api_mode=mode, model=model), token_accounting=True)
            try:
                if provider == 'anthropic':
                    body = b''.join(b'data: ' + json.dumps(value).encode() + b'\n\n' for value in [
                        {'type':'message_start','message':{'id':'fixture','type':'message','role':'assistant','model':'fixture-model','content':[],
                            'stop_reason':None,'stop_sequence':None,'usage':{'input_tokens':20,'output_tokens':1,'service_tier':'standard','inference_geo':'not_available'}}},
                        {'type':'message_delta','delta':{'stop_reason':'end_turn','stop_sequence':None},'usage':{'output_tokens':5}},
                        {'type':'message_stop'}])
                else:
                    body = sse(document())
                with patch.dict('os.environ', {key_name:'synthetic-fixture-only'}), httpx.Client(transport=httpx.MockTransport(
                    lambda request: httpx.Response(200, headers={'content-type':'text/event-stream'}, stream=httpx.ByteStream(body)))) as client:
                    if provider == 'anthropic':
                        with Anthropic(http_client=client, api_key='synthetic-fixture-only') as sdk:
                            with sdk.messages.stream(model=model, messages=[], max_tokens=8) as stream:
                                list(stream)
                    else:
                        with OpenAI(http_client=client, api_key='synthetic-fixture-only') as sdk:
                            list(sdk.chat.completions.create(model='fixture-model', messages=[], stream=True, stream_options={'include_usage':True}))
                accounting, totals = ledger.finish()
                self.assertTrue(accounting['complete'], provider)
                self.assertEqual(totals, (20, 5, 0, 0) if provider == 'anthropic' else (15, 5, 3, 2))
            finally:
                close_turn(ledger)

    def test_haiku_geography_sentinel_does_not_admit_unknown_models_or_premium_usage(self):
        for model, geography, tier, speed, accepted in [
            ('claude-haiku-4-5-20251001', 'not_available', 'standard', 'standard', True),
            ('claude-sonnet-4-6', 'not_available', 'standard', 'standard', False),
            ('claude-haiku-4-5-20251001', 'us', 'standard', 'standard', False),
            ('claude-haiku-4-5-20251001', 'not_available', 'priority', 'standard', False),
            ('claude-haiku-4-5-20251001', 'not_available', 'standard', 'fast', False),
        ]:
            ledger = TokenBilling('anthropic', model, 'messages')
            receipt = ledger.begin()
            for frame in [
                {'type':'message_start','message':{'usage':{'input_tokens':10,'output_tokens':1,
                    'inference_geo':geography,'service_tier':tier,'speed':speed}}},
                {'type':'message_delta','usage':{'output_tokens':4}}, {'type':'message_stop'},
            ]:
                receipt.feed(b'data: '+json.dumps(frame).encode()+b'\n\n')
            self.assertEqual(ledger.finish()[0]['complete'], accepted, (model, geography, tier, speed))


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
