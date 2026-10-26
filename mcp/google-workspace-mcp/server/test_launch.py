"""Adapter checks; run with the same uvx environment as launch.sh."""
import contextlib
import io
import os
import sys
import types
import unittest
from unittest.mock import patch

import launch


class HostCredentialsTest(unittest.TestCase):
    def test_bad_secrets_fail_without_disclosing_the_value(self):
        for value in ("private-invalid-json", "null", "[]", '{"email":"private-email"}'):
            with self.subTest(value=value), patch.dict(os.environ, {"GOOGLE_WORKSPACE_CREDENTIALS": value}):
                with self.assertRaises(SystemExit) as error:
                    launch.read_secret()
                self.assertNotIn("private-", str(error.exception))
                self.assertNotIn("GOOGLE_WORKSPACE_CREDENTIALS", os.environ)

    def test_credentials_are_user_bound_and_refreshes_do_not_write_files(self):
        import json
        from auth.credential_store import get_credential_store
        from auth.oauth21_session_store import OAuth21SessionStore

        observed = []

        def inspect_server():
            store = get_credential_store()
            self.assertEqual(store.list_users(), ["test@example.invalid"])
            self.assertIsNone(store.get_credential("other@example.invalid"))
            self.assertFalse(store.store_credential("other@example.invalid", object()))
            with patch("builtins.open", side_effect=AssertionError("credential file access")):
                credential = store.get_credential("test@example.invalid")
                self.assertEqual(credential.refresh_token, "test-refresh")
                credential.token = "test-rotated-access-token"
                self.assertTrue(store.store_credential("test@example.invalid", credential))
                self.assertEqual(store.get_credential("test@example.invalid").token, "test-rotated-access-token")
                self.assertFalse(store.delete_credential("other@example.invalid"))
                with self.assertRaisesRegex(RuntimeError, "Interactive login is disabled"):
                    OAuth21SessionStore().store_oauth_state("state", {})
            self.assertIn("--read-only", sys.argv)
            self.assertIn("start_google_auth", sys.argv)
            self.assertNotIn("test-refresh", str(sys.argv))
            self.assertNotIn("GOOGLE_WORKSPACE_CREDENTIALS", os.environ)
            observed.append(True)

        fake_main = types.ModuleType("main")
        fake_main.main = inspect_server
        secret = json.dumps(dict(email="test@example.invalid", client_id="test-client", client_secret="test-secret", refresh_token="test-refresh"))
        with patch.dict(os.environ, {"GOOGLE_WORKSPACE_CREDENTIALS": secret}), patch.dict(sys.modules, {"main": fake_main}), patch.object(sys, "argv", []), contextlib.redirect_stderr(io.StringIO()):
            launch.main()
        self.assertEqual(observed, [True])


if __name__ == "__main__":
    unittest.main()
