"""Read one standard-chess PGN mainline, retaining its original position and history."""
from dataclasses import dataclass
import re

import chess

TOKEN = re.compile(
    r'(?P<space>\s+|;[^\n]*|(?m:^%[^\n]*)|\{[^}]*\})'
    r'|(?P<tag>\[(?P<name>[A-Za-z0-9_]+)\s+"(?P<value>(?:\\["\\]|[^"\\\r\n])*)"\s*\])'
    r'|(?P<variation>[()])|(?P<result>1/2-1/2|1-0|0-1|\*)'
    r'|(?P<ignore>\d+\.+|\.\.\.|\$\d+|[!?]+)'
    r'|(?P<move>[^\s()[\]{};!?$*]+)'
)
RESULTS = {"1-0", "0-1", "1/2-1/2", "*"}


@dataclass
class ReviewGame:
    root_fen: str
    headers: dict
    moves: list
    terminal: str | None

    @property
    def ending(self):
        if self.terminal:
            return {"kind": "position", "reason": self.terminal}
        if self.headers["Result"] != "*":
            return {"kind": "recorded", "reason": self.headers.get("Termination")}
        return {"kind": "unfinished", "reason": None}


def starting_board(headers):
    if headers.get("Variant", "Standard").lower() not in {"standard", "chess", "normal"}:
        raise ValueError("Game Review supports standard chess PGNs.")
    if headers.get("SetUp") == "1" and "FEN" not in headers:
        raise ValueError("This PGN needs a FEN tag for its custom starting position.")
    try:
        board = chess.Board(headers.get("FEN", chess.STARTING_FEN))
    except ValueError as exc:
        raise ValueError("The PGN starting FEN is invalid.") from exc
    if not board.is_valid() or board.has_chess960_castling_rights():
        raise ValueError("The PGN starting FEN is not a valid standard-chess position.")
    return board


def parse_pgn(text):
    text = text.lstrip("\ufeff").strip()
    if not text:
        raise ValueError("Paste a PGN or open a PGN file first.")
    headers, moves = {}, []
    root_fen = result = board = None
    variations = offset = 0
    while offset < len(text):
        token = TOKEN.match(text, offset)
        if not token:
            raise ValueError(f"Invalid PGN syntax near {text[offset:offset + 25]!r}.")
        offset = token.end()
        kind = token.lastgroup
        if kind == "space":
            continue
        if kind == "tag":
            name, value = token["name"], token["value"]
            if board is not None or name in headers:
                raise ValueError("Import one PGN game at a time, with unique header tags.")
            headers[name] = re.sub(r'\\(["\\])', r'\1', value)
            continue
        if result is not None:
            raise ValueError("Unexpected text after the PGN result. Import one game at a time.")
        if board is None:
            board = starting_board(headers)
            root_fen = board.fen(en_passant="fen")
        if kind == "variation":
            variations += 1 if token[0] == "(" else -1
            if variations < 0:
                raise ValueError("Unexpected closing parenthesis in PGN variation.")
        elif variations or kind == "ignore":
            continue
        elif kind == "result":
            result = token[0]
        elif kind == "move":
            if board.outcome(claim_draw=False) is not None:
                raise ValueError("The PGN continues past an automatic game outcome.")
            try:
                move = board.parse_san(token[0])
                if not move:
                    raise ValueError("Null move")
            except ValueError as exc:
                raise ValueError(f"Invalid move {token[0][:30]!r} at ply {len(moves) + 1}.") from exc
            moves.append({"uci": move.uci(), "san": board.san(move), "number": board.fullmove_number,
                          "color": "white" if board.turn else "black"})
            board.push(move)
    if variations:
        raise ValueError("The PGN has an unclosed variation.")
    if not (headers or moves or result):
        raise ValueError("No PGN game was found.")
    if board is None:
        board = starting_board(headers)
        root_fen = board.fen(en_passant="fen")
    outcome = board.outcome(claim_draw=False)
    if "Result" in headers and headers["Result"] not in RESULTS:
        raise ValueError("The PGN Result tag is invalid.")
    if result and "Result" in headers and result != headers["Result"]:
        raise ValueError("The PGN header and movetext give different results.")
    headers["Result"] = result or headers.get("Result", "*")
    if outcome:
        if headers["Result"] not in {"*", outcome.result()}:
            raise ValueError("The PGN result disagrees with the final position.")
        headers["Result"] = outcome.result()
    return ReviewGame(root_fen, headers, moves, outcome.termination.name.lower().replace("_", " ") if outcome else None)
