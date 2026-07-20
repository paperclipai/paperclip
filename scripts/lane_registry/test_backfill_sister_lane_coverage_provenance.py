#!/usr/bin/env python3
"""Unit tests for the sister lane-coverage provenance backfill.

Run: python3 test_backfill_sister_lane_coverage_provenance.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import backfill_sister_lane_coverage_provenance as bf

COMPANY = "c1"
WINDOWED = {COMPANY: {"id": COMPANY, "name": "TSMC", "activityWindow": {"startHour": 17, "endHour": 3}}}
ALWAYS_ON = {COMPANY: {"id": COMPANY, "name": "TSMC", "activityWindow": None}}

PRIMARY = "11111111-1111-4111-8111-111111111111"
SISTER = "33333333-3333-4333-8333-333333333333"
OTHER = "44444444-4444-4444-8444-444444444444"

ROWS = [{"company_id": COMPANY, "primary": PRIMARY, "sister": SISTER, "priority": 1}]


def agent(agent_id, runtime, name="GLaD0S-Codex"):
    return {"id": agent_id, "companyId": COMPANY, "name": name, "runtimeConfig": runtime}


def agents(*entries):
    return {a["id"]: a for a in entries}


class TestPlan(unittest.TestCase):
    def test_stamps_a_bare_sister_flag(self):
        found = bf.plan(
            agents(agent(PRIMARY, {}), agent(SISTER, {bf.IGNORE_KEY: True})),
            ROWS,
            WINDOWED,
        )
        self.assertEqual([c["agentId"] for c in found], [SISTER])

    def test_skips_a_sister_that_already_has_lane_coverage(self):
        runtime = {bf.IGNORE_KEY: True, bf.EXCEPTION_KEY: {"class": bf.LANE_COVERAGE_CLASS}}
        found = bf.plan(agents(agent(PRIMARY, {}), agent(SISTER, runtime)), ROWS, WINDOWED)
        self.assertEqual(found, [])

    def test_never_overwrites_an_operator_exception(self):
        runtime = {bf.IGNORE_KEY: True, bf.EXCEPTION_KEY: {"class": "market_24_7_operations"}}
        found = bf.plan(agents(agent(PRIMARY, {}), agent(SISTER, runtime)), ROWS, WINDOWED)
        self.assertEqual(found, [])

    def test_skips_a_sister_without_the_flag(self):
        found = bf.plan(agents(agent(PRIMARY, {}), agent(SISTER, {})), ROWS, WINDOWED)
        self.assertEqual(found, [])

    def test_skips_a_non_sister(self):
        # The primary carries a bare flag, but only sisters are lane residue.
        found = bf.plan(
            agents(agent(PRIMARY, {bf.IGNORE_KEY: True}), agent(SISTER, {})),
            ROWS,
            WINDOWED,
        )
        self.assertEqual(found, [])

    def test_skips_an_agent_absent_from_the_registry(self):
        found = bf.plan(
            agents(agent(PRIMARY, {}), agent(SISTER, {}), agent(OTHER, {bf.IGNORE_KEY: True})),
            ROWS,
            WINDOWED,
        )
        self.assertEqual(found, [])

    def test_skips_a_terminated_sister(self):
        # load_agents_with_runtime filters terminated/archived, so the row is absent.
        found = bf.plan(agents(agent(PRIMARY, {})), ROWS, WINDOWED)
        self.assertEqual(found, [])

    def test_skips_a_company_without_an_activity_window(self):
        found = bf.plan(
            agents(agent(PRIMARY, {}), agent(SISTER, {bf.IGNORE_KEY: True})),
            ROWS,
            ALWAYS_ON,
        )
        self.assertEqual(found, [])

    def test_skips_a_sister_that_is_also_a_primary_elsewhere(self):
        rows = ROWS + [{"company_id": COMPANY, "primary": SISTER, "sister": OTHER, "priority": 1}]
        found = bf.plan(
            agents(agent(PRIMARY, {}), agent(SISTER, {bf.IGNORE_KEY: True}), agent(OTHER, {})),
            rows,
            WINDOWED,
        )
        self.assertEqual(found, [])

    def test_is_idempotent_after_a_simulated_apply(self):
        live = agents(agent(PRIMARY, {}), agent(SISTER, {bf.IGNORE_KEY: True}))
        first = bf.plan(live, ROWS, WINDOWED)
        self.assertEqual(len(first), 1)
        for candidate in first:  # simulate the write
            live[candidate["agentId"]]["runtimeConfig"][bf.EXCEPTION_KEY] = {
                "class": bf.LANE_COVERAGE_CLASS,
                "source": bf.LANE_COVERAGE_SOURCE,
            }
        self.assertEqual(bf.plan(live, ROWS, WINDOWED), [])


class TestApplySql(unittest.TestCase):
    def test_refuses_non_uuid_ids(self):
        with self.assertRaises(ValueError):
            bf.apply_plan("postgres://unused", [{"agentId": "'; drop table agents; --"}], "now")

    def test_no_candidates_is_a_no_op(self):
        # No psql subprocess is spawned, so this passes with no DB present.
        self.assertEqual(bf.apply_plan("postgres://unused", [], "now"), 0)


if __name__ == "__main__":
    unittest.main()
