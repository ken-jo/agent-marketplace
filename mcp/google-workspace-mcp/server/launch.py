"""Run the pinned Workspace server with Ave-provisioned, memory-only credentials."""
import json
import os
import sys


def read_secret():
    try:
        value = json.loads(os.environ.pop("GOOGLE_WORKSPACE_CREDENTIALS", ""))
        fields = ("email", "client_id", "client_secret", "refresh_token")
        if not isinstance(value, dict) or not all(
            isinstance(value.get(key), str) and value[key].strip() for key in fields
        ):
            raise ValueError()
        return value
    except (ValueError, TypeError):
        sys.exit("Enter JSON with email, client_id, client_secret and refresh_token in Ave’s secret prompt.")


def main():
    secret = read_secret()
    from google.oauth2.credentials import Credentials
    from auth.credential_store import CredentialStore, set_credential_store

    class HostCredentialStore(CredentialStore):
        def __init__(self):
            self.credentials = Credentials(
                token=None,
                refresh_token=secret["refresh_token"],
                token_uri="https://oauth2.googleapis.com/token",
                client_id=secret["client_id"],
                client_secret=secret["client_secret"],
                scopes=[
                    "https://www.googleapis.com/auth/gmail.readonly",
                    "https://www.googleapis.com/auth/calendar.readonly",
                    "https://www.googleapis.com/auth/drive.readonly",
                    "https://www.googleapis.com/auth/documents.readonly",
                    "https://www.googleapis.com/auth/spreadsheets.readonly",
                ],
            )

        def get_credential(self, user_email):
            return self.credentials if user_email == secret["email"] else None

        def store_credential(self, user_email, credentials):
            if user_email != secret["email"]:
                return False
            self.credentials = credentials
            return True

        def delete_credential(self, user_email):
            if user_email != secret["email"]:
                return False
            self.credentials = None
            return True

        def list_users(self):
            return [secret["email"]] if self.credentials else []

    set_credential_store(HostCredentialStore())
    os.environ["GOOGLE_OAUTH_CLIENT_ID"] = secret["client_id"]
    os.environ["GOOGLE_OAUTH_CLIENT_SECRET"] = secret["client_secret"]
    os.environ["USER_GOOGLE_EMAIL"] = secret["email"]

    # The adapter owns persistence. Do not start a fallback OAuth flow (which
    # otherwise persists state), or attach the upstream file logger.
    import auth.oauth21_session_store as sessions
    import core.log_formatter as log_formatter

    def require_host_secret(*args, **kwargs):
        raise RuntimeError("Interactive login is disabled. Update OAuth credentials in Ave’s secret prompt.")

    sessions.OAuth21SessionStore.store_oauth_state = require_host_secret
    log_formatter.configure_file_logging = lambda *args, **kwargs: False
    import main as workspace

    sys.argv = ["workspace-mcp", "--transport", "stdio", "--single-user", "--read-only",
                "--tool-tier", "core", "--tools", "gmail", "calendar", "drive", "docs", "sheets",
                "--disabled-tools", "start_google_auth"]
    workspace.main()


if __name__ == "__main__":
    main()
