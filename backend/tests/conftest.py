from pathlib import Path
from dotenv import load_dotenv

# The native test file also works when run directly rather than via manage.py.
load_dotenv(Path(__file__).resolve().parents[2] / '.env')
