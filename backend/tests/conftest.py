import json
from pathlib import Path

from dotenv import load_dotenv
import pytest

# The native test file also works when run directly rather than via manage.py.
load_dotenv(Path(__file__).resolve().parents[2] / '.env')


@pytest.fixture(scope="session")
def review_games():
    return json.loads((Path(__file__).parent / "fixtures" / "review_games.json").read_text(encoding="utf-8"))
