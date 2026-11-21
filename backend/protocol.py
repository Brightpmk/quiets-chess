import re
from typing import Literal
import chess
import chess.engine
from pydantic import BaseModel, ConfigDict, Field

MODES = {"fast": 1.0, "strong": 3.0, "deep": 10.0}


class AnalyzeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    type: Literal["analyze"]
    request_id: str = Field(min_length=1, max_length=80)
    root_fen: str = Field(min_length=15, max_length=120)
    moves: list[str] = Field(default_factory=list, max_length=2000)
    mode: Literal["fast", "strong", "deep"] = "fast"
    multipv: Literal[1, 3] = 1

    def board(self) -> chess.Board:
        board = chess.Board(self.root_fen)
        if not board.is_valid():
            raise ValueError("FEN is not a valid standard-chess position")
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
    copy = board.copy(stack=False)
    result = []
    for move in moves:
        if move not in copy.legal_moves:
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
