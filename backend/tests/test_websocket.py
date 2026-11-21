import asyncio
import chess
import chess.engine
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
import pytest
from backend.app import create_app
from backend.settings import Settings

ORIGIN = {'origin': 'http://127.0.0.1:5173'}
SETTINGS = Settings('unused', 1, 16, frozenset([ORIGIN['origin']]))


class SimulatedManager:
    """Transport contract tests only. This is never used by the application."""
    def __init__(self):
        self.protocol, self.owner = object(), None
        self.name, self.error = 'Test engine', None
        self.events = []
    async def ensure(self): return self.protocol
    async def close(self): pass
    async def stream(self, board, seconds, emit, *, multipv=1):
        fen = board.fen()
        self.events.append(('start', fen))
        try:
            for depth in range(1, 6):
                for index, move in enumerate(list(board.legal_moves)[:multipv], 1):
                    await emit({'score': chess.engine.PovScore(chess.engine.Cp(40 - 10 * index), board.turn),
                                'pv': [move], 'depth': depth, 'multipv': index}, False)
                await asyncio.sleep(.04)
            if multipv == 3:  # Interrupted before ranks 2 and 3 reach depth six.
                await emit({'score': chess.engine.PovScore(chess.engine.Cp(99), board.turn),
                            'pv': [next(iter(board.legal_moves))], 'depth': 6, 'multipv': 1}, False)
            await emit({'score': chess.engine.PovScore(chess.engine.Cp(30), board.turn), 'depth': 5}, True)
        finally: self.events.append(('stop', fen))


def analyze(ws, id, moves=None, fen=chess.STARTING_FEN, multipv=1):
    ws.send_json({'type': 'analyze', 'request_id': id, 'root_fen': fen, 'moves': moves or [],
                  'mode': 'fast', 'multipv': multipv})


def receive_type(ws, kind):
    for _ in range(100):
        message = ws.receive_json()
        if message['type'] == kind: return message
    raise AssertionError('Message not received')


def test_stream_cancellation_and_final_request_identity():
    manager = SimulatedManager()
    with TestClient(create_app(SETTINGS, manager)) as client:
        with client.websocket_connect('/ws/analysis', headers=ORIGIN) as ws:
            assert ws.receive_json()['type'] == 'hello'
            analyze(ws, 'old')
            assert receive_type(ws, 'analysis')['request_id'] == 'old'
            analyze(ws, 'new', ['e2e4'])
            # Already-sent packets may still be queued. Once new starts, old must never recur.
            while True:
                message = ws.receive_json()
                if message['type'] == 'started' and message['request_id'] == 'new': break
            while True:
                message = ws.receive_json()
                assert message['request_id'] == 'new'
                if message['type'] == 'analysis': assert message['score']['cp'] == -30
                if message['type'] == 'complete': break
    assert manager.events[0][0] == 'start'
    assert manager.events[1][0] == 'stop'
    assert manager.events[2][0] == 'start'


def test_invalid_position_and_recovery():
    with TestClient(create_app(SETTINGS, SimulatedManager())) as client:
        with client.websocket_connect('/ws/analysis', headers=ORIGIN) as ws:
            ws.receive_json(); analyze(ws, 'bad', ['e2e5'])
            error = ws.receive_json()
            assert error['code'] == 'invalid_request' and error['request_id'] == 'bad'
            analyze(ws, 'good'); assert receive_type(ws, 'analysis')['request_id'] == 'good'


def test_terminal_checkmate_and_stalemate():
    with TestClient(create_app(SETTINGS, SimulatedManager())) as client:
        with client.websocket_connect('/ws/analysis', headers=ORIGIN) as ws:
            ws.receive_json()
            analyze(ws, 'mate', fen='7k/6Q1/6K1/8/8/8/8/8 b - - 0 1')
            result = receive_type(ws, 'analysis')
            assert result['score']['mate'] == 0 and result['score']['winner'] == 'white'
            receive_type(ws, 'complete')
            analyze(ws, 'draw', fen='7k/5Q2/6K1/8/8/8/8/8 b - - 0 1')
            result = receive_type(ws, 'analysis')
            assert result['terminal'] == 'stalemate' and result['score']['cp'] == 0


def test_other_origins_rejected():
    with TestClient(create_app(SETTINGS, SimulatedManager())) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect('/ws/analysis', headers={'origin': 'https://example.com'}): pass


def test_second_tab_is_rejected_without_interrupting_first():
    with TestClient(create_app(SETTINGS, SimulatedManager())) as client:
        with client.websocket_connect('/ws/analysis', headers=ORIGIN) as first:
            first.receive_json()
            with client.websocket_connect('/ws/analysis', headers=ORIGIN) as second:
                assert second.receive_json()['code'] == 'busy'
            analyze(first, 'still-alive')
            assert receive_type(first, 'analysis')['request_id'] == 'still-alive'


def test_three_candidates_complete_as_a_batch_and_switch_to_one_at_same_fen():
    with TestClient(create_app(SETTINGS, SimulatedManager())) as client:
        with client.websocket_connect('/ws/analysis', headers=ORIGIN) as ws:
            ws.receive_json()
            analyze(ws, 'three', multipv=3)
            while True:
                result = receive_type(ws, 'analysis')
                assert result['request_id'] == 'three' and result['multipv'] == 3
                assert [line['rank'] for line in result['candidates']] == [1, 2, 3]
                assert [line['score']['cp'] for line in result['candidates']] == [30, 20, 10]
                assert all(line['depth'] == result['depth'] for line in result['candidates'])
                if result['done']:
                    assert result['depth'] == 5
                    break
            analyze(ws, 'one')
            assert receive_type(ws, 'analysis')['request_id'] == 'one'
            analyze(ws, 'forced', fen='7k/6Q1/4K3/8/8/8/8/8 b - - 0 1', multipv=3)
            while True:
                result = receive_type(ws, 'analysis')
                if result['request_id'] == 'forced':
                    assert [line['pv'][0]['san'] for line in result['candidates']] == ['Kxg7']
                    break


@pytest.mark.parametrize(('fen', 'error'), [
    ('8/8/8/8/8/8/8/8 w - - 0 1', 'white king'),
    ('4k3/8/8/8/8/8/8/3KK3 w - - 0 1', 'exactly one king'),
    ('8/8/8/8/8/8/4k3/4K3 w - - 0 1', 'adjacent'),
    ('4k3/8/8/8/8/8/8/P3K3 w - - 0 1', 'ranks 1 or 8'),
    ('4k3/8/8/8/8/8/8/4K3 w K - 0 1', 'Castling requires'),
    ('4k3/8/8/3p4/8/8/8/4K3 b - d6 0 31', 'en passant'),
    ('4k3/8/8/3p4/8/8/8/4K3 w - d6 1 31', 'halfmove clock'),
    ('4k3/8/8/8/8/8/4R3/4K3 w - - 0 1', 'side that just moved'),
])
def test_editor_rejects_invalid_positions_without_search(fen, error):
    manager = SimulatedManager()
    with TestClient(create_app(SETTINGS, manager)) as client:
        response = client.post('/api/positions/validate', json={'fen': fen}, headers=ORIGIN)
        assert response.status_code == 422
        assert error in response.json()['detail']
    assert not manager.events


def test_editor_keeps_castling_and_fen_en_passant_target():
    manager = SimulatedManager()
    fen = 'r3k2r/8/8/3p4/8/8/8/R3K2R w KQkq d6 0 31'
    with TestClient(create_app(SETTINGS, manager)) as client:
        response = client.post('/api/positions/validate', json={'fen': fen}, headers=ORIGIN)
        assert response.status_code == 200
        assert response.json() == {'fen': fen}
    assert not manager.events
