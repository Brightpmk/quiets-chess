"""Probe the configured executable through the same adapter used by the server."""
import asyncio
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dotenv import load_dotenv
import chess
from backend.engine import EngineManager
from backend.settings import Settings
from backend.protocol import info_payload


async def main():
    load_dotenv(Path(__file__).resolve().parents[1] / '.env')
    manager = EngineManager(Settings.from_env())
    try:
        await manager.ensure()
        print(f'{manager.name}: {manager.settings.threads} threads, {manager.settings.hash_mb} MiB hash')
        print('Full strength, MultiPV 1. Analyzing the starting position for 1 second…')
        board = chess.Board()
        async def emit(info, done):
            if done: print(info_payload(board, info))
        await manager.stream(board, 1, emit)
        print('Native UCI engine probe passed.')
    finally: await manager.close()


if __name__ == '__main__': asyncio.run(main())
