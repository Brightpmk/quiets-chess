import asyncio
import time

import chess
import chess.engine
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.settings import Settings

SETTINGS = Settings('unused', 1, 16, frozenset({'http://127.0.0.1:8000'}))
PGN = '[White "Ada"]\n[Black "Ben"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *'


class ReviewTestEngine:
    protocol = object()
    owner = None
    name = "Test engine"
    error = None

    def __init__(self):
        self.stops = 0
        self.fail_at = None

    async def ensure(self):
        return self.protocol

    async def close(self):
        pass

    async def review_search(self, board, nodes, multipv, roots, *, depth):
        try:
            await asyncio.sleep(.035)
        except asyncio.CancelledError:
            self.stops += 1
            raise
        if self.fail_at == len(board.move_stack):
            raise RuntimeError("Test search failed. Retry the review.")
        moves = list(roots or board.legal_moves)
        return tuple({"pv": [move], "depth": 12, "multipv": rank,
                      "score": chess.engine.PovScore(chess.engine.Cp(30 - 10 * rank), board.turn)}
                     for rank, move in enumerate(moves[:multipv], 1))


def submit(client, pgn=PGN, **options):
    response = client.post('/api/reviews', json={"pgn": pgn, **options})
    assert response.status_code == 202, response.text
    return response.json()


def wait_for(client, job, expected):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        status = client.get(f"/api/reviews/{job['id']}").json()
        if expected(status):
            return status
        time.sleep(.01)
    raise AssertionError(status)


def test_progress_cancel_retains_partial_then_retry_completes():
    manager = ReviewTestEngine()
    with TestClient(create_app(SETTINGS, manager)) as client:
        first = submit(client)
        assert first['status'] == 'queued'
        partial = wait_for(client, first, lambda job: job['analyzed'] >= 1)
        assert partial['status'] == 'running' and partial['accuracy'] is None
        cancelled = client.delete(f"/api/reviews/{first['id']}").json()
        assert cancelled['status'] == 'cancelled'
        assert 0 < cancelled['analyzed'] < cancelled['total']
        assert cancelled['accuracy'] is None
        retry = submit(client, replace=first['id'])
        assert retry['id'] != first['id']
        final = wait_for(client, retry, lambda job: job['status'] == 'complete')
        assert manager.stops == 1
        assert final['analyzed'] == final['total'] == 6
        assert len(final['positions']) == 7
        assert all(0 <= accuracy <= 100 for accuracy in final['accuracy'].values())
        for color in ('white', 'black'):
            assert sum(final['classification_counts'][color].values()) == 3
        assert final['settings']['engine'] == 'Test engine' and final['settings']['methodology']
        assert client.get(f"/api/reviews/{first['id']}").json() == cancelled
        delta = client.get(f"/api/reviews/{retry['id']}?after=5&position_after=6").json()
        assert delta['moves'] == final['moves'][5:]
        assert delta['positions'] == final['positions'][6:] and delta['game'] is None


def test_replacement_obsoletes_old_progress_and_other_clients_are_bounded():
    with TestClient(create_app(SETTINGS, ReviewTestEngine())) as client:
        first = submit(client)
        assert client.post('/api/reviews', json={'pgn': PGN}).status_code == 409
        assert client.post('/api/reviews', json={'pgn': '1. z9', 'replace': first['id']}).status_code == 422
        second = submit(client, '1. f3 e5 2. g4 Qh4# 0-1', preset='deep', replace=first['id'])
        assert client.get(f"/api/reviews/{first['id']}").json()['status'] == 'cancelled'
        final = wait_for(client, second, lambda job: job['status'] == 'complete')
        assert final['game']['terminal'] == 'checkmate'
        assert final['positions'][-1]['score']['winner'] == 'black'
        assert final['moves'][-1]['played_line']['score']['mate'] == -1
        assert final['settings']['preset'] == 'deep'


def test_engine_failure_reports_error_without_accuracy_then_retry():
    manager = ReviewTestEngine()
    manager.fail_at = 2
    with TestClient(create_app(SETTINGS, manager)) as client:
        first = submit(client)
        failed = wait_for(client, first, lambda job: job['status'] == 'failed')
        assert failed['analyzed'] == 1 and failed['accuracy'] is None
        assert 'Retry' in failed['error']
        manager.fail_at = None
        retry = submit(client)
        assert wait_for(client, retry, lambda job: job['status'] == 'complete')['analyzed'] == 6


def test_review_validates_local_origin_and_supplies_terminal_without_search():
    with TestClient(create_app(SETTINGS, ReviewTestEngine())) as client:
        rejected = client.post('/api/reviews', json={'pgn': PGN}, headers={'origin': 'https://example.com'})
        assert rejected.status_code == 403
        start = submit(client, '[FEN "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1"]\n\n1/2-1/2')
        result = wait_for(client, start, lambda job: job['status'] == 'complete')
        assert result['total'] == 0 and result['accuracy'] is None
        assert result['positions'][0]['terminal'] == 'stalemate'
