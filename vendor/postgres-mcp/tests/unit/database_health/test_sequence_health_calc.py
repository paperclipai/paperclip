"""Unit tests for SequenceHealthCalc, specifically _parse_sequence_name parsing."""

import pytest

from postgres_mcp.database_health.sequence_health_calc import SequenceHealthCalc


class TestParseSequenceName:
    """Tests for _parse_sequence_name method."""

    @pytest.fixture
    def calc(self):
        """Create a SequenceHealthCalc instance with a mock driver."""
        # We only need the instance for calling _parse_sequence_name
        # which doesn't use the sql_driver
        return SequenceHealthCalc(sql_driver=None)  # type: ignore[arg-type]

    def test_simple_sequence(self, calc):
        """Parse simple unquoted sequence name."""
        schema, name = calc._parse_sequence_name("nextval('my_seq'::regclass)")
        assert schema == "public"
        assert name == "my_seq"

    def test_sequence_with_schema(self, calc):
        """Parse sequence with explicit schema."""
        schema, name = calc._parse_sequence_name("nextval('myschema.my_seq'::regclass)")
        assert schema == "myschema"
        assert name == "my_seq"

    def test_uppercase_sequence(self, calc):
        """Parse uppercase sequence name (quoted in PostgreSQL)."""
        schema, name = calc._parse_sequence_name("nextval('\"UpperCaseSeq\"'::regclass)")
        assert schema == "public"
        assert name == "UpperCaseSeq"

    def test_uppercase_with_schema(self, calc):
        """Parse uppercase sequence with schema."""
        schema, name = calc._parse_sequence_name('nextval(\'"MySchema"."MySeq"\'::regclass)')
        assert schema == "MySchema"
        assert name == "MySeq"

    def test_text_cast_format(self, calc):
        """Parse sequence with text cast format."""
        schema, name = calc._parse_sequence_name("nextval(('my_seq'::text)::regclass)")
        assert schema == "public"
        assert name == "my_seq"

    def test_serial_sequence_naming(self, calc):
        """Parse auto-generated SERIAL sequence name."""
        schema, name = calc._parse_sequence_name("nextval('users_id_seq'::regclass)")
        assert schema == "public"
        assert name == "users_id_seq"

    def test_uppercase_table_serial(self, calc):
        """Parse sequence from uppercase table with SERIAL column."""
        # PostgreSQL generates: "TableName_column_seq"
        schema, name = calc._parse_sequence_name("nextval('\"UpperCaseOrders_id_seq\"'::regclass)")
        assert schema == "public"
        assert name == "UpperCaseOrders_id_seq"

    # Known limitation: sequence names containing dots
    # This test documents the current behavior (which is incorrect for this edge case)
    @pytest.mark.xfail(reason="Known limitation: dots in sequence names not supported")
    def test_sequence_name_with_dot(self, calc):
        """Sequence names containing dots are not correctly parsed.

        This is a known limitation. In PostgreSQL, you can have a sequence
        named "my.seq" (with a literal dot), which would be stored as:
        nextval('"my.seq"'::regclass)

        The current parser incorrectly splits this as schema="my", name="seq".
        """
        schema, name = calc._parse_sequence_name("nextval('\"my.seq\"'::regclass)")
        assert schema == "public"
        assert name == "my.seq"
