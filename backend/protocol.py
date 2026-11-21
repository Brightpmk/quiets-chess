import re
from typing import Literal
import chess
import chess.engine
from pydantic import BaseModel, ConfigDict, Field

MODES = {"fast": 1.0, "strong": 3.0, "deep": 10.0}

POSITION_ERRORS = (
    (chess.STATUS_NO_WHITE_KING, "Add a white king."),
    (chess.STATUS_NO_BLACK_KING, "Add a black king."),
    (chess.STATUS_TOO_MANY_KINGS, "Use exactly one king per color."),
    (chess.STATUS_PAWNS_ON_BACKRANK, "Pawns cannot be on ranks 1 or 8."),
    (chess.STATUS_TOO_MANY_WHITE_PAWNS | chess.STATUS_TOO_MANY_BLACK_PAWNS, "Use at most eight pawns per color."),
    (chess.STATUS_TOO_MANY_WHITE_PIECES | chess.STATUS_TOO_MANY_BLACK_PIECES, "Use at most sixteen pieces per color."),
    (chess.STATUS_BAD_CASTLING_RIGHTS, "Castling requires the king and the corresponding rook on their starting squares."),
    (chess.STATUS_INVALID_EP_SQUARE, "The en passant target must match a pawn that just advanced two squares."),
    (chess.STATUS_OPPOSITE_CHECK, "The side that just moved cannot be in check."),
    (chess.STATUS_TOO_MANY_CHECKERS | chess.STATUS_IMPOSSIBLE_CHECK, "The checking pieces are inconsistent with a legal last move."),
)


def position_board(fen):
    board = chess.Board(fen)
    status = board.status()
    if status != chess.STATUS_VALID:
        white, black = board.king(chess.WHITE), board.king(chess.BLACK)
        if white is not None and black is not None and chess.square_distance(white, black) == 1:
            raise ValueError("The kings cannot be adjacent.")
        for flag, message in POSITION_ERRORS:
            if status & flag:
                raise ValueError(message)
        raise ValueError("FEN is not a valid standard-chess position.")
    return board


class PositionValidationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    fen: str = Field(min_length=15, max_length=120)

    def board(self) -> chess.Board:
        fields = self.fen.split()
        if len(fields) != 6 or not re.fullmatch(r"-|(?=[KQkq])K?Q?k?q?", fields[2]):
            raise ValueError("Enter six FEN fields with standard castling rights.")
        if not re.fullmatch(r"[0-9]+", fields[4]) or not re.fullmatch(r"[1-9][0-9]*", fields[5]):
            raise ValueError("Use a nonnegative halfmove clock and a positive fullmove number.")
        board = position_board(self.fen)
        if board.ep_square is not None and board.halfmove_clock != 0:
            raise ValueError("The halfmove clock must be zero after the pawn move that sets an en passant target.")
        return board


class AnalyzeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    type: Literal["analyze"]
    request_id: str = Field(min_length=1, max_length=80)
    root_fen: str = Field(min_length=15, max_length=120)
    moves: list[str] = Field(default_factory=list, max_length=2000)
    mode: Literal["fast", "strong", "deep"] = "fast"
    multipv: Literal[1, 3] = 1

    def board(self) -> chess.Board:
        board = position_board(self.root_fen)
        for uci in self.moves:
            if not re.fullmatch(r"[a-h][1-8][a-h][1-8][qrbn]?", uci):
                raise ValueError(f"Invalid UCI move: {uci[:12]}")
            move = chess.Move.from_uci(uci)
            if move not in board.legal_moves:
                raise ValueError(f"Illegal move: {uci}")
            board.push(move)
        return board


def score_payload(score, turn, *, lowerbound=False, upperbound=False):
    white = score.white()
    stm = score.pov(turn)
    # UCI bounds are relative to the side to move; negate swaps upper/lower.
    if turn == chess.BLACK:
        lowerbound, upperbound = upperbound, lowerbound
    mate = white.mate()
    return {
        "cp": white.score(), "mate": mate,
        "winner": ("white" if white > chess.engine.Cp(0) else "black") if mate is not None else None,
        "stm_cp": stm.score(), "stm_mate": stm.mate(),
        "bound": "lower" if lowerbound else "upper" if upperbound else None,
    }


def terminal_score(board, outcome):
    if outcome.winner is None:
        value = chess.engine.Cp(0)
    else:
        value = chess.engine.MateGiven if outcome.winner else chess.engine.Mate(0)
    return score_payload(chess.engine.PovScore(value, chess.WHITE), board.turn)


def pv_payload(board, moves):
    copy = board.copy()
    result = []
    for move in moves:
        if move not in copy.legal_moves or copy.is_seventyfive_moves() or copy.is_fivefold_repetition() or copy.is_insufficient_material():
            break
        result.append({"uci": move.uci(), "san": copy.san(move),
                       "number": copy.fullmove_number, "color": "white" if copy.turn else "black"})
        copy.push(move)
    return result


def info_payload(board, info):
    score = info.get("score")
    if score is None:
        return None
    pv = pv_payload(board, info.get("pv", []))
    return {
        "score": score_payload(score, board.turn, lowerbound=info.get("lowerbound", False),
                               upperbound=info.get("upperbound", False)),
        "pv": pv, "best_move": pv[0]["uci"] if pv else None,
        "depth": info.get("depth", 0), "seldepth": info.get("seldepth", 0),
        "nodes": info.get("nodes", 0), "nps": info.get("nps", 0),
        "time": info.get("time", 0), "hashfull": info.get("hashfull", 0),
    }
