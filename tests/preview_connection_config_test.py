"""Non-sensitive config regression. Never reads real credentials or simulates a TTY."""
import importlib.util
import pathlib
import subprocess
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/show-preview-connection.py"
spec = importlib.util.spec_from_file_location("preview_connection", SCRIPT)
assert spec is not None and spec.loader is not None
show = importlib.util.module_from_spec(spec)
spec.loader.exec_module(show)


def fixture():
    return {
        "TJ_SUPABASE_URL": "https://fixture.supabase.co",
        "TJ_SUPABASE_ANON_KEY": "TEST_ONLY_ANON_PLACEHOLDER",
        "TJ_ACK_SCHEMA": "tj_preview",
        "TJ_ACK_RPC": "tj_po_ack_ingest",
        "TJ_ACK_WORKER_EMAIL": "fixture@example.invalid",
        "TJ_ACK_WORKER_PASSWORD": "TEST_ONLY_PASSWORD_PLACEHOLDER",
    }


class ConfigRegression(unittest.TestCase):
    def test_existing_tj_fields_resolve_without_queue_in_env(self):
        source = fixture()
        before = source.copy()
        result = show.resolve_config(source)
        expected = dict(zip(
            ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SCHEMA", "ACK_RPC", "WORKER_EMAIL", "WORKER_PASSWORD"],
            source.values(),
        ))
        self.assertTrue(all(result[k] == v for k, v in expected.items()), "field mapping mismatch")
        self.assertTrue(result["QUEUE_ROOT"] == r"C:\Users\Administrator\Desktop\operation\PO_Queue")
        self.assertTrue(source == before, "input must not be mutated")

    def test_canonical_fields_still_supported(self):
        values = show.resolve_config(fixture())
        self.assertTrue(show.resolve_config(values) == values)

    def test_schema_rpc_and_missing_field_errors_do_not_echo_values(self):
        for key, replacement in [("TJ_ACK_SCHEMA", "TEST_ONLY_BAD_SCHEMA"),
                                 ("TJ_ACK_RPC", "TEST_ONLY_BAD_RPC"),
                                 ("TJ_ACK_WORKER_PASSWORD", "")]:
            with self.subTest(key=key):
                values = fixture()
                values[key] = replacement
                with self.assertRaises(ValueError) as caught:
                    show.resolve_config(values)
                message = str(caught.exception)
                self.assertFalse(any(v and v in message for v in values.values()), "error must not echo values")

    def test_conflicting_aliases_fail_closed_without_echo(self):
        values = fixture()
        values["WORKER_PASSWORD"] = "TEST_ONLY_CONFLICT_PLACEHOLDER"
        with self.assertRaises(ValueError) as caught:
            show.resolve_config(values)
        self.assertIn("WORKER_PASSWORD", str(caught.exception))
        self.assertNotIn("TEST_ONLY", str(caught.exception))

    def test_parser_quotes_equals_crlf_and_empty_values(self):
        parsed = show.parse_env('# comment\r\n TJ_ACK_RPC = "tj_po_ack_ingest"\r\nTEST_VALUE=\'a=b\'\r\nEMPTY=\r\n')
        self.assertTrue(parsed == {"TJ_ACK_RPC": "tj_po_ack_ingest", "TEST_VALUE": "a=b", "EMPTY": ""})

    def test_noninteractive_show_cannot_bypass_tty_gate(self):
        result = subprocess.run([sys.executable, str(SCRIPT)], input="SHOW\n", text=True,
                                capture_output=True, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("REFUSED:", result.stderr)
        self.assertNotIn("连接信息（仅本次终端显示）", result.stdout)
        self.assertNotIn("确认请输入", result.stdout)

    def test_tty_and_manual_confirmation_remain_before_file_read(self):
        source = SCRIPT.read_text()
        main = source[source.index("def main()") :]
        self.assertLess(main.index("sys.stdin.isatty()"), main.index("input("))
        self.assertLess(main.index("sys.stdout.isatty()"), main.index("input("))
        self.assertLess(main.index("answer.strip() != CONFIRM_WORD"), main.index("open(ENV_PATH"))
        self.assertIn('CONFIRM_WORD = "SHOW"', source)
        self.assertNotIn("--yes", source.replace("不提供 --yes 等非交互开关。", ""))


if __name__ == "__main__":
    unittest.main()
