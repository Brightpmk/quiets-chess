"""Conservative defaults; explicit overrides are bounded to avoid accidents."""
from dataclasses import dataclass
import os
import shutil


def bounded_int(name: str, default: int, low: int, high: int) -> int:
    value = int(os.getenv(name, str(default)))
    if not low <= value <= high:
        raise ValueError(f"{name} must be between {low} and {high}")
    return value


@dataclass(frozen=True)
class Settings:
    engine_path: str
    threads: int
    hash_mb: int
    origins: frozenset[str]

    @classmethod
    def from_env(cls):
        try:
            import psutil
            available_mb = psutil.virtual_memory().available // (1024 * 1024)
            cpus = psutil.cpu_count(logical=False) or os.cpu_count() or 1
        except ImportError:
            available_mb, cpus = 1024, os.cpu_count() or 1
        defaults = [f"http://{host}:{port}" for host in ("localhost", "127.0.0.1", "[::1]")
                    for port in (5173, 4173, 8000)]
        return cls(
            os.getenv("STOCKFISH_PATH") or shutil.which("stockfish") or "stockfish",
            bounded_int("STOCKFISH_THREADS", max(1, min(4, cpus // 2)), 1, 64),
            bounded_int("STOCKFISH_HASH_MB", max(16, min(256, available_mb // 16)), 16, 8192),
            frozenset(os.getenv("ALLOWED_ORIGINS", ",".join(defaults)).split(",")),
        )
