"""Lichess winning chances, move curve, and volatility/harmonic game aggregation."""
from math import exp
from statistics import pstdev

VERSION = "lichess-curve-aggregation-root-scores-v1"


def white_win(score):
    if score["bound"] is not None:
        raise ValueError("Accuracy requires an exact score.")
    if score["mate"] is not None:
        cp = 1000 if score["winner"] == "white" else -1000
    else:
        cp = max(-1000, min(1000, score["cp"]))
    return 100 / (1 + exp(-0.00368208 * cp))


def mover_win(score, color):
    chance = white_win(score)
    return chance if color == "white" else 100 - chance


def move_accuracy(before, after):
    if after >= before:
        return 100.0
    return max(0.0, min(100.0, 103.1668100711649 * exp(-0.04354415386753951 * (before - after))
                        - 3.166924740191411 + 1))


def game_accuracy(position_wins, moves):
    """Moves are (mover color, accuracy) in game order, including forced moves."""
    if len(position_wins) != len(moves) + 1:
        raise ValueError("The evaluation series must include the start and every move.")
    window = min(len(position_wins), max(2, min(8, len(moves) // 10)))
    windows = [position_wins[:window]] * max(0, window - 2)
    windows.extend(position_wins[i:i + window] for i in range(len(position_wins) - window + 1))
    by_color = {"white": [], "black": []}
    for (color, accuracy), sample in zip(moves, windows):
        by_color[color].append((accuracy, max(0.5, min(12, pstdev(sample)))))
    result = {}
    for color, values in by_color.items():
        if not values:
            result[color] = None
            continue
        weighted = sum(a * w for a, w in values) / sum(w for _, w in values)
        harmonic = len(values) / sum(1 / max(1, a) for a, _ in values)
        result[color] = (weighted + harmonic) / 2
    return result
