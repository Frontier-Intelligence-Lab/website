"""valcairn-runner: `check` prints what this machine reports; `run` links to Valcairn and serves jobs."""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

from .api import Api, AuthError
from .machine import capabilities
from .runner import RunnerHalted, Settings, serve


def read_key() -> str:
    """The key comes from VALCAIRN_RUNNER_KEY_FILE (preferred) or VALCAIRN_RUNNER_KEY, never from the command line."""
    path = os.environ.get("VALCAIRN_RUNNER_KEY_FILE")
    key = Path(path).read_text(encoding="utf-8").strip() if path else os.environ.get("VALCAIRN_RUNNER_KEY", "").strip()
    if not key:
        raise SystemExit("Set VALCAIRN_RUNNER_KEY_FILE (or VALCAIRN_RUNNER_KEY) to the key Valcairn showed when you linked this runner.")
    return key


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="valcairn-runner")
    parser.add_argument("command", choices=["check", "run"])
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    settings = Settings(
        ollama_host=os.environ.get("OLLAMA_HOST_URL", Settings.ollama_host),
        probe_image=os.environ.get("VALCAIRN_PROBE_IMAGE", Settings.probe_image),
    )
    if args.command == "check":
        print(json.dumps(capabilities(settings.ollama_host), indent=2))
        return 0
    url = os.environ.get("VALCAIRN_URL")
    if not url:
        raise SystemExit("Set VALCAIRN_URL to your Valcairn site, for example https://frontierintelligencelab.com")
    try:
        serve(Api(url, read_key()), settings)
    except AuthError:
        return 2
    except RunnerHalted as err:
        logging.getLogger("valcairn_runner").error("%s", err)
        return 3
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
