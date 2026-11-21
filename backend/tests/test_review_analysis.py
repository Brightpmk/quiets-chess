import asyncio
from collections import Counter
from random import Random
from types import SimpleNamespace

import chess
import chess.engine
import chess.pgn
import pytest

from backend.accuracy import game_accuracy, move_accuracy, mover_win, white_win
from backend.classification import ClassificationRules, base_quality, sacrifice, special_quality
from backend.engine import EngineManager
from backend.protocol import info_payload, pv_payload, score_payload, terminal_score
from backend.review import PRESETS, ReviewAnalyzer
from backend.review_pgn import parse_pgn
from backend.search import Iterations
from backend.settings import Settings


def sample(board, cp, san, depth=18, multipv=1):
    pv = []
    copy = board.copy()
    for token in san.split():
        pv.append(copy.push_san(token))
    return {"score": chess.engine.PovScore(chess.engine.Cp(cp), board.turn),
            "pv": pv, "depth": depth, "multipv": multipv}


def test_accuracy_curve_black_and_mate_zero():
    score = score_payload(chess.engine.PovScore(chess.engine.Cp(100), chess.BLACK), chess.BLACK)
    assert white_win(score) == pytest.approx(40.898, abs=.002)
    assert mover_win(score, "black") == pytest.approx(59.102, abs=.002)
    assert move_accuracy(70, 50) == pytest.approx(41.0138, abs=.01)
    assert move_accuracy(50, 70) == 100
    assert move_accuracy(100, 0) == 0
    mate = chess.Board('7k/6Q1/6K1/8/8/8/8/8 b - - 0 1')
    score = terminal_score(mate, mate.outcome())
    assert score['mate'] == 0 and score['winner'] == 'white'
    assert white_win(score) == pytest.approx(97.545, abs=.002)
    assert mover_win(score, 'black') == pytest.approx(2.455, abs=.002)
    with pytest.raises(ValueError, match='exact'):
        white_win({**score, "bound": "upper"})


def test_game_aggregation_matches_independently_weighted_values():
    # Pair standard deviations are 0, 15, 10, 0, yielding weights .5, 12, 10, .5.
    # White's weighted and harmonic means are 300/7 and 400/7. Black's are 4 and 200/101.
    wins = [50, 50, 80, 60, 60]
    moves = [("white", 100), ("black", 0), ("white", 40), ("black", 100)]
    assert game_accuracy(wins, moves) == pytest.approx({"white": 50, "black": 2 + 100/101})
    assert game_accuracy([50, 50], [("black", 100)]) == {"white": None, "black": 100}


def test_game_aggregation_left_pads_the_first_three_position_window():
    wins = [50, 70, 50] + [50] * 28
    moves = [("white" if ply % 2 == 0 else "black", 100 if ply else 25) for ply in range(30)]
    # White's first two moves use the windows [50, 70, 50] and [70, 50, 50].
    # The remaining 13 have unchanging evals, giving a clamped weight of .5.
    weight = 20 * 2**.5 / 3
    white_weighted = (125 * weight + 13 * 50) / (2 * weight + 6.5)
    white_harmonic = 15 / (.04 + .14)
    assert game_accuracy(wins, moves)["white"] == pytest.approx((white_weighted + white_harmonic) / 2)


def test_iterations_discard_bounds_duplicate_roots_and_incomplete_depth():
    board = chess.Board()
    batch = Iterations(3)
    assert batch.feed(sample(board, 3, 'd4', depth=8, multipv=2)) is None
    for rank, move in enumerate(('e4', 'd4', 'Nf3'), 1):
        batch.feed(sample(board, 20 - rank, move, depth=8, multipv=rank))
    original = batch.latest
    assert [line['multipv'] for line in original] == [1, 2, 3]
    batch.feed(sample(board, 30, 'd4', depth=9))
    batch.feed({**sample(board, 5, 'Nf3', depth=9, multipv=2), "upperbound": True})
    batch.feed(sample(board, 3, 'e4', depth=8, multipv=3))
    batch.feed(sample(board, 3, 'd4', depth=9, multipv=2))
    batch.feed(sample(board, 2, 'e4', depth=9, multipv=3))
    assert batch.latest is original


def test_thresholds_and_special_precedence_with_legal_lines():
    assert [base_quality(loss, engine_best=False) for loss in (0, 1.999, 2, 5, 10, 20)] == [
        "Excellent", "Excellent", "Good", "Inaccuracy", "Mistake", "Blunder"]
    assert base_quality(3, engine_best=False, rules=ClassificationRules(excellent_below=4)) == "Excellent"
    board = chess.Board()
    first = info_payload(board, sample(board, 100, 'e4 e5'))
    second = info_payload(board, sample(board, -150, 'd4 d5'))
    assert base_quality(0, engine_best=True) == "Best"
    assert special_quality(board, 'e2e4', first, [first, second], min_depth=16)[0] == "Great"
    assert special_quality(board, 'e2e4', first, [first, second], min_depth=19) is None
    assert special_quality(board, 'd2d4', first, [first, second], min_depth=16) is None


def test_sacrifice_requires_net_loss_and_verified_compensation():
    balanced = chess.Board('r6k/8/8/7q/8/8/8/R2Q2K1 w - - 0 1')
    offered = info_payload(balanced, sample(balanced, 150, 'Qe2 Qxe2 Rf1 Rb8 Rf2'))
    weaker = info_payload(balanced, sample(balanced, -180, 'Qd2'))
    assert sacrifice(balanced, offered['pv']) == ('queen', 'Qxe2')
    assert special_quality(balanced, 'd1e2', offered, [offered, weaker], min_depth=16)[0] == "Brilliant"
    unsound = info_payload(balanced, sample(balanced, -400, 'Qe2 Qxe2 Rf1 Rb8 Rf2'))
    assert special_quality(balanced, 'd1e2', unsound, [unsound, weaker], min_depth=16) is None
    exchanged = chess.Board('r6k/8/8/7q/8/8/8/3QR1K1 w - - 0 1')
    trade = info_payload(exchanged, sample(exchanged, 150, 'Qe2 Qxe2 Rxe2 Rb8 Kg2'))
    assert sacrifice(exchanged, trade['pv']) is None
    forced = chess.Board('7k/6Q1/4K3/8/8/8/8/8 b - - 0 1')
    only = info_payload(forced, sample(forced, 0, 'Kxg7'))
    assert special_quality(forced, 'h8g7', only, [only, weaker], min_depth=16) is None


@pytest.mark.parametrize("fen, movetext, expected, terminal", [
    ('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 31', '31. exd6 *', ['e5d6'], None),
    ('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', '1. O-O O-O-O *', ['e1g1', 'e8c8'], None),
    ('7k/P7/8/8/8/8/8/7K w - - 0 1', '1. a8=N 1/2-1/2', ['a7a8n'], 'insufficient material'),
    ('7k/6Q1/6K1/8/8/8/8/8 b - - 0 20', '1-0', [], 'checkmate'),
])
def test_pgn_import_special_positions(fen, movetext, expected, terminal):
    game = parse_pgn(f'[SetUp "1"]\n[FEN "{fen}"]\n\n{movetext}')
    assert game.root_fen == fen
    assert [move["uci"] for move in game.moves] == expected
    assert game.terminal == terminal


def test_pgn_annotations_variations_repetition_and_invalid_mainline():
    moves = ' '.join(f'{i}. Nf3 Nf6 {i+1}. Ng1 Ng8' for i in (1, 3, 5, 7))
    game = parse_pgn(f'[White "Test"]\n\n{moves} {{draw}} 1/2-1/2')
    assert len(game.moves) == 16 and game.terminal == 'fivefold repetition'
    assert len(parse_pgn('1.e4! (1. d4 (1. c4)) 1...e5 $3 *').moves) == 2
    for pgn in ('1.e4 fake', '1. e4 * 1. d4 *', '1. e4 (1. d4'):
        with pytest.raises(ValueError):
            parse_pgn(pgn)


async def test_same_depth_same_root_comparison_rechecks_disagreeing_black_scores():
    board = chess.Board()
    board.push_san('e4')
    preset = PRESETS['quick']
    calls = []

    async def search(original, nodes, multipv, roots, *, depth):
        assert original.move_stack == [chess.Move.from_uci('e2e4')]
        assert {move.uci() for move in roots} == {'e7e5', 'c7c5'}
        assert multipv == 2
        calls.append(nodes)
        if nodes == preset.comparison_nodes:
            return sample(board, 0, 'e5', multipv=1), sample(board, -5, 'c5', multipv=2)
        return sample(board, 10, 'c5', multipv=1), sample(board, 0, 'e5', multipv=2)

    manager = SimpleNamespace(name="Test", review_search=search)
    analyzer = ReviewAnalyzer(manager, Settings('unused', 1, 16, frozenset()))
    best = info_payload(board, sample(board, 0, 'e5'))
    child = board.copy()
    child.push_san('c5')
    after = info_payload(child, sample(child, 200, 'Nf3'))
    grade = await analyzer.grade(board, {"color": "black", "uci": "c7c5"}, best, after, preset)
    assert calls == [preset.comparison_nodes, preset.verification_nodes]
    assert grade["accuracy"] == 100 and grade["classification"] == "Excellent"
    assert grade["recommendation"]["best_move"] == "c7c5"
    assert grade["best_alternative"]["best_move"] == "e7e5"
    assert grade["played_line"]["depth"] == grade["best_alternative"]["depth"] == 18
    assert grade["played_line"]["search"]["nodes_limit"] == preset.verification_nodes
    assert grade["comparison"]["paired_loss"] < 0 < grade["comparison"]["adjacent_loss"]
    assert grade["comparison"]["disagreement"]


async def test_review_cache_keys_include_history_and_search_budget():
    first, transposed = chess.Board(), chess.Board()
    for token in ('Nf3', 'Nf6', 'Nc3', 'Nc6'):
        first.push_san(token)
    for token in ('Nc3', 'Nc6', 'Nf3', 'Nf6'):
        transposed.push_san(token)
    assert first.fen() == transposed.fen() and first.move_stack != transposed.move_stack
    calls = []

    async def search(board, nodes, multipv, roots, *, depth):
        calls.append((tuple(board.move_stack), nodes))
        return (sample(board, 25, 'e4'),)

    analyzer = ReviewAnalyzer(SimpleNamespace(name='Test', review_search=search),
                              Settings('unused', 1, 16, frozenset()))
    await analyzer.search(first, 45_000)
    await analyzer.search(first.copy(), 45_000)
    await analyzer.search(transposed, 45_000)
    await analyzer.search(first, 200_000)
    assert calls == [(tuple(first.move_stack), 45_000), (tuple(transposed.move_stack), 45_000),
                     (tuple(first.move_stack), 200_000)]


async def test_main_choice_only_loses_credit_after_a_clear_deeper_reversal():
    board = chess.Board()
    preset = PRESETS['quick']
    main = info_payload(board, sample(board, 20, 'e4'))
    child = board.copy()
    child.push_san('e4')
    after = info_payload(child, sample(child, 0, 'e5'))
    calls = []

    async def search(board, nodes, multipv, roots, *, depth):
        assert not roots and multipv == 2
        calls.append(nodes)
        if nodes == preset.alternative_nodes:
            return sample(board, 55, 'd4', depth=8), sample(board, 0, 'e4', depth=8, multipv=2)
        return sample(board, 200, 'd4'), sample(board, 0, 'e4', multipv=2)

    analyzer = ReviewAnalyzer(SimpleNamespace(name='Test', review_search=search),
                              Settings('unused', 1, 16, frozenset()))
    grade = await analyzer.grade(board, {"color": "white", "uci": "e2e4"}, main, after, preset)
    assert calls == [preset.alternative_nodes, preset.verification_nodes]
    assert grade["classification"] == "Mistake"
    assert grade["recommendation"]["best_move"] == "d2d4"
    assert grade["played_line"]["depth"] == grade["best_alternative"]["depth"] == 18


def test_shared_fixture_moves_round_trip_and_recorded_endings_stay_playable(review_games):
    for name, pgn in review_games.items():
        game = parse_pgn(pgn)
        board = chess.Board(game.root_fen)
        for move in game.moves:
            played = board.parse_uci(move["uci"])
            assert move == {"uci": played.uci(), "san": board.san(played), "number": board.fullmove_number,
                            "color": "white" if board.turn else "black"}, name
            board.push(played)
        assert bool(board.outcome()) == (game.ending["kind"] == "position"), name
    black = parse_pgn(review_games["black_underpromotion"])
    assert black.moves == [{"uci": "a2a1n", "san": "a1=N", "number": 32, "color": "black"}]
    for result, reason in [("0-1", "Resignation"), ("1/2-1/2", "Draw agreement")]:
        game = parse_pgn(f'[Termination "{reason}"]\n\n1. e4 {result}')
        assert game.ending == {"kind": "recorded", "reason": reason}
        assert game.headers["Result"] == result and game.terminal is None
    uncapturable = parse_pgn('[FEN "4k3/8/8/3p4/8/8/8/R3K3 w - d6 0 31"]\n\n31. Ra2 *')
    assert uncapturable.root_fen.split()[3] == "d6"


def test_pv_stops_at_draw_using_the_game_history(review_games):
    game = parse_pgn(review_games["fivefold"])
    board = chess.Board(game.root_fen)
    for move in game.moves[:-1]:
        board.push_uci(move["uci"])
    continuation = [chess.Move.from_uci(uci) for uci in ("f6g8", "e2e4")]
    assert [move["uci"] for move in pv_payload(board, continuation)] == ["f6g8"]
    assert len(board.move_stack) == 15


def test_import_accepts_a_legal_mainline_beyond_the_old_move_limit():
    board = chess.Board("7k/8/8/8/8/8/1PP5/K7 w - - 0 1")
    random = Random(17)
    visits = Counter({(board.board_fen(), board.turn): 1})
    for _ in range(604):
        pawn_move = board.turn == chess.WHITE and board.halfmove_clock >= 100
        piece = chess.PAWN if pawn_move else chess.KING
        options = [move for move in board.legal_moves if board.piece_type_at(move.from_square) == piece
                   and not move.promotion and not board.is_capture(move)
                   and (pawn_move or (chess.square_file(move.to_square) < 4) == board.turn)]
        random.shuffle(options)
        for move in options:
            board.push(move)
            key = (board.board_fen(), board.turn)
            if visits[key] < 3:
                visits[key] += 1
                break
            board.pop()
        else:
            pytest.fail("Synthetic game could not continue without an automatic outcome")
    game = parse_pgn(str(chess.pgn.Game.from_board(board)))
    assert [move["uci"] for move in game.moves] == [move.uci() for move in board.move_stack]


async def test_position_retries_bad_engine_sample_and_keeps_exact_provenance():
    board = chess.Board()
    attempts = []

    async def search(original, nodes, multipv, roots, *, depth):
        attempts.append(nodes)
        try_number = len(attempts)
        line = {**sample(board, 30, 'e4 e5'), "nodes": 5000, "time": 0.015}
        if try_number == 1:
            return ({**line, "upperbound": True},)
        return (line,)

    analyzer = ReviewAnalyzer(SimpleNamespace(name='Test', review_search=search),
                              Settings('unused', 1, 16, frozenset()))
    result = await analyzer.position(board, PRESETS["quick"])
    assert attempts == [45_000, 300_000]
    assert result["source"] == "engine" and result["complete"] and result["score"]["bound"] is None
    assert result["nodes"] == 5000 and result["time"] == 0.015
    assert result["search"]["nodes_limit"] == 300_000


async def test_rejects_an_exact_sample_with_an_illegal_root_move():
    board = chess.Board()

    async def search(*args, **kwargs):
        return ({**sample(board, 240, 'e4'), "pv": [chess.Move.from_uci('e2e5')]},)

    analyzer = ReviewAnalyzer(SimpleNamespace(name='Test', review_search=search),
                              Settings('unused', 1, 16, frozenset()))
    with pytest.raises(RuntimeError, match="exact evaluation"):
        await analyzer.position(board, PRESETS["quick"])


async def test_board_search_can_be_cancelled_while_queued_behind_review():
    manager = EngineManager(Settings('unused', 1, 16, frozenset()))
    queued = asyncio.Event()
    states = []

    async def state(name):
        states.append(name)
        queued.set()

    async def emit(*args):
        pytest.fail("A queued search should emit no evaluation")

    async with manager.search_lock:
        request = asyncio.create_task(manager.stream(chess.Board(), 1, emit, on_state=state))
        await asyncio.wait_for(queued.wait(), 1)
        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request
        assert states == ["queued"] and manager.protocol is None and manager.search_lock.locked()
