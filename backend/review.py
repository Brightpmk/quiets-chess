"""Bounded, history-aware engine analysis of a PGN mainline."""
from collections import OrderedDict
from dataclasses import asdict, dataclass

import chess
import chess.engine

from .accuracy import VERSION, game_accuracy, move_accuracy, mover_win, white_win
from .classification import LABELS, RULES, base_quality, sacrifice, special_quality
from .protocol import info_payload, pv_payload, score_payload, terminal_score


@dataclass(frozen=True)
class Preset:
    position_nodes: int
    alternative_nodes: int
    comparison_nodes: int
    verification_nodes: int
    special_depth: int


PRESETS = {
    "quick": Preset(45_000, 45_000, 70_000, 300_000, 14),
    "deep": Preset(200_000, 180_000, 300_000, 1_200_000, 16),
}
ANALYSIS_DEPTH = 26
CACHE_SIZE = 512
CLASSIFICATION_VERSION = "quiet-chess-labels-v1"


class ReviewAnalyzer:
    def __init__(self, engine, settings):
        self.engine = engine
        self.settings = settings
        self.cache = OrderedDict()

    def metadata(self, preset):
        return {"preset": preset, **asdict(PRESETS[preset]), "depth_limit": ANALYSIS_DEPTH,
                "threads": self.settings.threads, "hash_mb": self.settings.hash_mb,
                "engine": self.engine.name, "methodology": VERSION,
                "classification": CLASSIFICATION_VERSION, "thresholds": asdict(RULES)}

    async def search(self, board, nodes, multipv=1, roots=None):
        root_names = tuple(move.uci() for move in roots) if roots else ()
        key = (self.engine.name, self.settings.threads, self.settings.hash_mb, VERSION,
               CLASSIFICATION_VERSION, board.root().fen(), tuple(move.uci() for move in board.move_stack),
               nodes, ANALYSIS_DEPTH, multipv, root_names)
        if key in self.cache:
            self.cache.move_to_end(key)
            return self.cache[key]
        raw = await self.engine.review_search(board, nodes, multipv, roots, depth=ANALYSIS_DEPTH)
        if not raw:
            return ()
        lines = tuple({**info_payload(board, line), "rank": line["multipv"],
                       "search": {"nodes_limit": nodes, "depth_limit": ANALYSIS_DEPTH,
                                  "multipv": multipv, "root_moves": root_names}}
                      for line in raw)
        key = (self.engine.name, *key[1:])
        self.cache[key] = lines
        if len(self.cache) > CACHE_SIZE:
            self.cache.popitem(last=False)
        return lines

    async def position(self, board, preset):
        outcome = board.outcome(claim_draw=False)
        if outcome:
            return {"score": terminal_score(board, outcome), "pv": [], "best_move": None, "depth": 0,
                    "terminal": outcome.termination.name.lower().replace("_", " "), "search": None}
        lines = await self.search(board, preset.position_nodes)
        if not lines:
            lines = await self.search(board, preset.verification_nodes)
        if not lines:
            raise RuntimeError("Stockfish did not return an exact evaluation for a game position. Retry the review.")
        return lines[0]

    @staticmethod
    def adjudicate(board, line):
        """Apply known rules outcomes at the end of the first move, including historical draws."""
        move = chess.Move.from_uci(line["best_move"])
        child = board.copy()
        child.push(move)
        outcome = child.outcome(claim_draw=False)
        if outcome is None:
            return line
        value = chess.engine.Cp(0) if outcome.winner is None else chess.engine.Mate(1)
        score = score_payload(chess.engine.PovScore(value, board.turn), board.turn)
        return {**line, "score": score, "pv": pv_payload(board, [move]),
                "terminal": outcome.termination.name.lower().replace("_", " ")}

    async def compare(self, board, best, played, after, color, preset, *, required=True):
        roots = (chess.Move.from_uci(best["best_move"]), chess.Move.from_uci(played))
        comparison = ()
        for nodes in (preset.comparison_nodes, preset.verification_nodes):
            lines = await self.search(board, nodes, 2, roots)
            by_move = {line["best_move"]: self.adjudicate(board, line) for line in lines}
            if set(by_move) != {move.uci() for move in roots}:
                continue
            alternative, chosen = (by_move[move.uci()] for move in roots)
            comparison = alternative, chosen
            loss = mover_win(alternative["score"], color) - mover_win(chosen["score"], color)
            adjacent_loss = mover_win(best["score"], color) - mover_win(after["score"], color)
            thresholds = (RULES.excellent_below, RULES.good_below, RULES.inaccuracy_below, RULES.mistake_below)
            if (loss > 1 and abs(loss - adjacent_loss) < 4 and
                    all(abs(loss - boundary) > 1 for boundary in thresholds)):
                break
        if not comparison and required:
            raise RuntimeError(f"Stockfish did not complete the comparison for {board.san(roots[1])}. Retry the review.")
        return comparison

    async def candidates(self, board, best, played, color, preset):
        lines = await self.search(board, preset.alternative_nodes, 2)
        if not lines:
            lines = await self.search(board, preset.verification_nodes, 2)
        if not lines:
            raise RuntimeError("Stockfish did not complete the alternative search. Retry the review.")
        lines = tuple(self.adjudicate(board, line) for line in lines)
        gap = mover_win(lines[0]["score"], color) - mover_win(lines[1]["score"], color)
        ranking_changed = lines[0]["best_move"] != played and (
            lines[1]["best_move"] != played or gap >= RULES.excellent_below)
        special = None
        evidence = ()
        if ranking_changed or sacrifice(board, best["pv"]) or gap >= RULES.great_gap - 4:
            deeper = await self.search(board, preset.verification_nodes, 2)
            if deeper:
                lines = tuple(self.adjudicate(board, line) for line in deeper)
                evidence = lines
                special = special_quality(board, played, best, lines, min_depth=preset.special_depth)
        alternative = next(line for line in lines if line["best_move"] != played)
        return alternative, special, evidence

    async def grade(self, board, move, best, after, preset):
        color, played = move["color"], move["uci"]
        forced = board.legal_moves.count() == 1
        engine_best = forced or played == best["best_move"]
        best = self.adjudicate(board, best)
        chosen, alternative, special, evidence = best, None, None, ()
        if not engine_best:
            alternative, chosen = await self.compare(board, best, played, after, color, preset)
        elif not forced:
            alternative, special, evidence = await self.candidates(board, best, played, color, preset)
            if evidence and evidence[0]["best_move"] != played and alternative["depth"] >= preset.special_depth:
                rescored = next((line for line in evidence if line["best_move"] == played), None)
                if rescored is None:
                    pair = await self.compare(board, alternative, played, after, color, preset, required=False)
                    if pair:
                        alternative, rescored = pair
                if rescored and rescored["depth"] >= preset.special_depth:
                    confirmed_loss = mover_win(alternative["score"], color) - mover_win(rescored["score"], color)
                    if confirmed_loss >= RULES.excellent_below:
                        chosen, engine_best = rescored, False

        # When grading a difference, the lines share a root and completed depth.
        after_win = mover_win(chosen["score"], color)
        recommendation = chosen
        if not engine_best and mover_win(alternative["score"], color) > after_win:
            recommendation = alternative
        before_win = mover_win(recommendation["score"], color)
        loss = before_win - after_win
        base = base_quality(loss, engine_best=engine_best)
        if special:
            label, explanation = special
        elif forced:
            label, explanation = base, "This was the only legal move."
        elif engine_best:
            label, explanation = base, "This matched Stockfish’s main search recommendation."
        elif loss == 0:
            label, explanation = base, "The same-position comparison found no loss in winning chances."
        else:
            label = base
            explanation = f"The engine comparison estimates a loss of {loss:.1f} winning-chance points."
        return {**move, "classification": label, "base_quality": base, "explanation": explanation,
                "forced": forced, "accuracy": move_accuracy(before_win, after_win), "win_loss": loss,
                "accuracy_inputs": {"before": before_win, "after": after_win},
                "played_line": chosen, "best_alternative": alternative,
                "recommendation": recommendation, "verification": evidence}

    async def run(self, job):
        board = chess.Board(job.game.root_fen)
        preset = PRESETS[job.preset]
        if job.game.moves or job.game.terminal:
            # Terminal starts need no engine. PGNs with moves need a verified engine identity.
            if job.game.moves:
                # The initial position search initializes the engine under the shared UCI lock.
                job.positions.append(await self.position(board, preset))
                job.settings = self.metadata(job.preset)
            else:
                job.positions.append(await self.position(board, preset))
        for index, move in enumerate(job.game.moves):
            await job.checkpoint()
            child = board.copy()
            child.push_uci(move["uci"])
            after = await self.position(child, preset)
            grade = await self.grade(board, move, job.positions[-1], after, preset)
            job.positions.append(after)
            job.moves.append({"ply": index + 1, **grade})
            board = child
        if job.moves:
            job.accuracy = game_accuracy([white_win(position["score"]) for position in job.positions],
                                         [(move["color"], move["accuracy"]) for move in job.moves])


def counts_for_moves(moves):
    counts = {color: dict.fromkeys(LABELS, 0) for color in ("white", "black")}
    for move in moves:
        counts[move["color"]][move["classification"]] += 1
    return counts
