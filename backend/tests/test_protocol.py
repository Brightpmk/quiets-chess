import chess
import chess.engine
import pytest
from backend.protocol import AnalyzeRequest, info_payload, score_payload


def request(root=chess.STARTING_FEN, moves=None):
    return AnalyzeRequest(type='analyze', request_id='test', root_fen=root, moves=moves or [])


def test_legal_move_and_illegal_move_rejection():
    board = request(moves=['e2e4', 'e7e5']).board()
    assert board.piece_at(chess.E4) == chess.Piece(chess.PAWN, chess.WHITE)
    with pytest.raises(ValueError, match='Illegal'): request(moves=['e2e5']).board()
    with pytest.raises(ValueError): request(moves=['0000']).board()


@pytest.mark.parametrize('fen', ['garbage', '8/8/8/8/8/8/8/8 w - - 0 1', '4k3/8/8/8/8/8/8/4K3 w K - 0 1'])
def test_invalid_positions_never_reach_engine(fen):
    with pytest.raises(ValueError): request(fen).board()


def test_repetition_history_retained():
    board = request(moves=['g1f3', 'g8f6', 'f3g1', 'f6g8'] * 2).board()
    assert board.is_repetition(3)
    assert len(board.move_stack) == 8


def test_black_to_move_score_and_bound_are_converted_to_white():
    payload = score_payload(chess.engine.PovScore(chess.engine.Cp(125), chess.BLACK), chess.BLACK, lowerbound=True)
    assert payload == dict(cp=-125, mate=None, winner=None, stm_cp=125, stm_mate=None, bound='upper')


@pytest.mark.parametrize('turn,mate,winner,white_mate', [
    (chess.WHITE, 3, 'white', 3), (chess.BLACK, 3, 'black', -3),
    (chess.WHITE, -2, 'black', -2), (chess.BLACK, -2, 'white', 2),
    (chess.BLACK, 0, 'white', 0), (chess.WHITE, 0, 'black', 0),
])
def test_mates_and_mate_zero(turn, mate, winner, white_mate):
    payload = score_payload(chess.engine.PovScore(chess.engine.Mate(mate), turn), turn)
    assert payload['mate'] == white_mate
    assert payload['winner'] == winner
    assert payload['cp'] is None


def test_pv_is_legal_san_and_does_not_mutate_position():
    board = chess.Board()
    payload = info_payload(board, {'score': chess.engine.PovScore(chess.engine.Cp(30), chess.WHITE),
                                  'pv': [chess.Move.from_uci(x) for x in ['e2e4', 'e7e5', 'g1f3']]})
    assert [m['san'] for m in payload['pv']] == ['e4', 'e5', 'Nf3']
    assert payload['best_move'] == 'e2e4'
    assert board.fen() == chess.STARTING_FEN


def test_pv_stops_before_an_illegal_move():
    board = chess.Board()
    payload = info_payload(board, {'score': chess.engine.PovScore(chess.engine.Cp(0), chess.WHITE),
                                  'pv': [chess.Move.from_uci('e2e5')]})
    assert payload['pv'] == []


def test_special_moves():
    board = request('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', ['e1g1']).board()
    assert board.piece_at(chess.F1).piece_type == chess.ROOK
    board = request('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', ['e5d6']).board()
    assert board.piece_at(chess.D5) is None
    board = request('7k/P7/8/8/8/8/8/7K w - - 0 1', ['a7a8n']).board()
    assert board.piece_at(chess.A8).piece_type == chess.KNIGHT
