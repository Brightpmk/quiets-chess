"""Opt in: RUN_STOCKFISH_TESTS=1 python -m pytest -m engine -v."""
import asyncio
import os
import time
import chess
import pytest
from backend.engine import EngineManager
from backend.protocol import info_payload
from backend.review import ReviewAnalyzer
from backend.review_jobs import ReviewJob
from backend.review_pgn import parse_pgn
from backend.search import Iterations
from backend.settings import Settings

pytestmark = [pytest.mark.engine, pytest.mark.skipif(os.getenv('RUN_STOCKFISH_TESTS') != '1', reason='Set RUN_STOCKFISH_TESTS=1 and configure Stockfish 19')]


async def test_native_uci_stream_cancellation_and_process_reuse():
    manager = EngineManager(Settings.from_env())
    try:
        protocol = await manager.ensure()
        pid = manager.transport.get_pid()
        assert 'Stockfish 19' in manager.name
        assert protocol.config['UCI_LimitStrength'] is False
        assert protocol.config['Skill Level'] == 20
        seen = asyncio.Event()
        packets = []
        async def emit(info, done):
            if info.get('score'): seen.set()
            packets.append((info, done))
        search = asyncio.create_task(manager.stream(chess.Board(), 10, emit))
        await asyncio.wait_for(seen.wait(), 5)
        start = time.monotonic(); search.cancel()
        with pytest.raises(asyncio.CancelledError): await search
        assert time.monotonic() - start < 2.5
        assert not any(done for _, done in packets)
        assert manager.transport.get_pid() == pid
        board = chess.Board(); board.push_uci('e2e4')
        packets.clear()
        await asyncio.wait_for(manager.stream(board, 1, emit), 5)
        assert manager.transport.get_pid() == pid
        assert packets[-1][1]
        assert protocol.config['MultiPV'] == 1
        pv = packets[-1][0]['pv']
        for move in pv:
            assert move in board.legal_moves; board.push(move)
    finally: await manager.close()


async def test_native_finds_mate_in_one():
    manager = EngineManager(Settings.from_env())
    packets = []
    async def emit(info, done): packets.append(info)
    try:
        board = chess.Board('7k/5Q2/6K1/8/8/8/8/8 w - - 0 1')
        await manager.stream(board, 1, emit)
        assert packets[-1]['score'].white().mate() == 1
        board.push(packets[-1]['pv'][0])
        assert board.is_checkmate()
    finally: await manager.close()


async def test_native_multipv_and_review_share_one_uci_process():
    settings = Settings.from_env()
    manager = EngineManager(settings)
    board = chess.Board()
    first_packet = asyncio.Event()
    iterations = Iterations(3)
    analyzer = ReviewAnalyzer(manager, settings)
    job = ReviewJob(parse_pgn('1. f3 e5 2. g4 Qh4# 0-1'), 'quick', {}, status='running')

    async def emit(info, done):
        if not done and iterations.feed(info):
            first_packet.set()

    try:
        await manager.ensure()
        pid = manager.transport.get_pid()
        interactive = asyncio.create_task(manager.stream(board, 8, emit, multipv=3))
        await asyncio.wait_for(first_packet.wait(), 5)
        assert [line['multipv'] for line in iterations.latest] == [1, 2, 3]
        assert len({line['depth'] for line in iterations.latest}) == 1
        assert len({line['pv'][0] for line in iterations.latest}) == 3
        assert manager.protocol.config['MultiPV'] == 3
        review = asyncio.create_task(analyzer.run(job))
        await asyncio.sleep(.03)
        assert manager.protocol.config['MultiPV'] == 3 and job.positions == []
        interactive.cancel()
        with pytest.raises(asyncio.CancelledError):
            await interactive
        await asyncio.wait_for(review, 20)
        assert manager.transport.get_pid() == pid
        assert [move['san'] for move in job.moves] == ['f3', 'e5', 'g4', 'Qh4#']
        assert job.positions[-1]['score']['winner'] == 'black'
        assert job.moves[-1]['base_quality'] == 'Best'
        assert job.accuracy['white'] < job.accuracy['black']
    finally:
        await manager.close()


async def test_native_search_handles_large_custom_fullmove_number():
    manager = EngineManager(Settings.from_env())
    board = chess.Board(chess.STARTING_FEN.replace('0 1', '0 999999'))
    board.push_san('e4')
    before = board.fen()
    try:
        lines = await manager.review_search(board, 50_000, 1, None)
        payload = info_payload(board, lines[0])
        assert payload['pv'][0]['number'] == 999999
        assert chess.Move.from_uci(payload['best_move']) in board.legal_moves
        assert board.fen() == before and len(board.move_stack) == 1
    finally:
        await manager.close()


async def test_native_engine_is_restarted_after_it_exits_while_idle():
    manager = EngineManager(Settings.from_env())
    try:
        previous = await manager.ensure()
        await asyncio.wait_for(previous.quit(), 5)
        lines = await manager.review_search(chess.Board(), 40_000, 1, None)
        assert manager.protocol is not previous
        assert len(lines) == 1 and lines[0]['pv'][0] in chess.Board().legal_moves
    finally:
        await manager.close()
