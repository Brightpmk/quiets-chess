"""Independent move labels measured in mover winning-chance percentage points."""
from dataclasses import dataclass

import chess

from .accuracy import mover_win

LABELS = ("Best", "Excellent", "Good", "Inaccuracy", "Mistake", "Blunder", "Great", "Brilliant")
PIECE_VALUE = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5,
               chess.QUEEN: 9, chess.KING: 0}


@dataclass(frozen=True)
class ClassificationRules:
    excellent_below: float = 2
    good_below: float = 5
    inaccuracy_below: float = 10
    mistake_below: float = 20
    great_gap: float = 16
    great_floor: float = 42
    brilliant_floor: float = 55
    sacrifice_material: int = 2


RULES = ClassificationRules()


def base_quality(loss, *, engine_best, rules=RULES):
    if engine_best:
        return "Best"
    for cutoff, label in zip((rules.excellent_below, rules.good_below, rules.inaccuracy_below, rules.mistake_below),
                             LABELS[1:5]):
        if loss < cutoff:
            return label
    return "Blunder"


def material(board, color):
    return sum(value * (len(board.pieces(piece, color)) - len(board.pieces(piece, not color)))
               for piece, value in PIECE_VALUE.items())


def sacrifice(board, line, rules=RULES):
    """Look for an offered piece taken in the PV and a sustained net material loss."""
    if len(line) < 5:
        return None
    move, reply = [chess.Move.from_uci(item["uci"]) for item in line[:2]]
    piece = board.piece_type_at(move.from_square)
    if piece not in {chess.KNIGHT, chess.BISHOP, chess.ROOK, chess.QUEEN} or board.is_capture(move):
        return None
    if reply.to_square != move.to_square:
        return None
    board = board.copy(stack=False)
    color = board.turn
    opening_balance = material(board, color)
    if opening_balance > 1:
        return None
    board.push(move)
    for item in line[1:5]:
        board.push_uci(item["uci"])
        if material(board, color) > opening_balance - rules.sacrifice_material:
            return None
    return chess.piece_name(piece), line[1]["san"]


def special_quality(board, played, baseline, verified, *, min_depth, rules=RULES):
    if (board.legal_moves.count() < 2 or len(verified) < 2 or
            any(line["depth"] < min_depth or line["score"]["bound"] for line in verified) or
            baseline["best_move"] != played or verified[0]["best_move"] != played):
        return None
    color = "white" if board.turn else "black"
    best, second = verified[:2]
    first_win = mover_win(best["score"], color)
    gap = first_win - mover_win(second["score"], color)
    offer = sacrifice(board, best["pv"], rules)
    minimum_gap = rules.great_gap
    if offer and sacrifice(board, baseline["pv"], rules) == offer and gap >= minimum_gap:
        if min(first_win, mover_win(baseline["score"], color)) >= rules.brilliant_floor:
            piece, reply = offer
            return "Brilliant", (f"Stockfish confirmed the {piece} offer. After {reply}, the material loss "
                                 f"persists in the continuation, and the next candidate trails by {gap:.1f} points.")
    if (first_win >= rules.great_floor and gap >= minimum_gap
            and mover_win(second["score"], color) < rules.great_floor):
        return "Great", (f"Stockfish verified this as the only candidate to keep at least "
                         f"{rules.great_floor:g}% winning chances. {second['pv'][0]['san']} "
                         f"trails by {gap:.1f} points.")
    return None
