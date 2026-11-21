# Quiet Chess

A local chess analysis board and full-game PGN review powered by native
Stockfish 19, React, FastAPI, python-chess and WebSockets. Analysis runs on
your computer. See [VALIDATION.md](VALIDATION.md) for the checks run on this build.

## Installation

Use Python 3.11+, Node.js 22.13+ and the official native Stockfish 19 executable
for your operating system and CPU. Download the engine separately, extract it
and keep its accompanying files together. [Stockfish downloads](https://stockfishchess.org/download/).

1. Run `python manage.py setup` from the project folder. Use `py` on Windows
   or `python3` on Linux/macOS if that is your Python command. Setup creates
   `.venv`, installs the Python dependencies, installs the frontend from the
   npm lockfile, builds the frontend and creates `.env` if needed.
2. Set `STOCKFISH_PATH` in `.env` to the executable you extracted. For example:

   ```dotenv
   STOCKFISH_PATH="C:/chess/stockfish/stockfish-windows-x86-64.exe"
   ```

   Paths containing spaces are supported. When the setting is omitted, the
   server looks for `stockfish` on PATH. On macOS or Linux the executable
   needs execute permission. Restart the backend after changing `.env`.
3. Run `python manage.py check` to check the UCI engine, then
   `python manage.py start` and open **http://127.0.0.1:8000**. Ctrl+C stops
   the backend and its engine.

Run `python manage.py dev` for Vite and FastAPI together at
**http://127.0.0.1:5173**. Vite proxies `/ws` and `/api` to port 8000. Frontend
changes hot-reload. Restart for backend changes. The launcher uses one Uvicorn
worker and avoids Uvicorn's reload subprocess so Windows can spawn the UCI
engine on the running event loop. Keep the server bound to loopback.

## Analysis Board

- Drag a piece or click its source and destination. The board checks legality,
  including castling, en passant and promotion. Use **← / → / Home / End** to
  navigate. Making a move from an earlier position replaces the later line.
- **F** flips the board and evaluation bar. The numerical evaluation always
  stays in White’s perspective. `M3` means White mates in 3, and `−M3` means
  Black mates in 3. `M0` and `−M0` indicate completed checkmates.
- **Fast**, **Strong** and **Deep** search for 1, 3 and 10 seconds. **Stop**
  retains the current completed iteration. **Analyze** starts again.
- Set **Candidate lines** to **3 lines** for native MultiPV 3 or **1 line**
  for MultiPV 1. The rank badges match the board arrow colors. Each row shows
  SAN, White-relative evaluation, depth and principal variation. **Show
  best-move arrows** below the board hides only the overlay and remembers your
  choice in this browser. Promotions with the same source and destination
  share the highest-ranked arrow on that route and retain their own SAN and rank.
- The evaluation bar follows candidate #1. It uses a visual score scale.
  **Play move** applies that candidate, including its promotion piece.
  Positions with fewer legal moves show only available candidates. Terminal
  positions show the outcome.
- MultiPV 3 divides the same time budget among candidates and can reduce search
  strength per line. Each update contains exact lines from one completed depth.
  A search can end while Stockfish is still working on a deeper iteration.
- Paste or open a local FEN or PGN file and click **Load**. **Copy FEN**, **FEN**
  and **PGN** export through the selected position. The board accepts one
  game at a time, up to 100 KB and 2,000 plies. PGN import keeps the mainline
  and headers. Export your work before closing or refreshing.

### Set up a position

Click **Set up position** to edit a draft of the displayed board, even at an
earlier move. Drag pieces or select **Move pieces** and tap two squares. Use the
palette to place a piece, or choose **Remove piece** and tap a square. **Clear
board** empties the draft, and **Starting position** restores the standard setup.

Choose the side to move, castling rights, en passant target and move counters.
**Draft FEN** displays the current draft for copying. **Apply position** runs
local and backend validation and starts analysis from a new root. Export its
PGN to save the custom starting FEN. **Cancel** preserves the original line
and resumes analysis if it was running. Position checks cover standard chess
rules and cannot establish the full move history.

## Game Review

1. Open **Game Review**. Paste a PGN or click **Open PGN file**. Import one
   standard-chess game at a time. Game Review has no fixed file-size or move
   limit. Review follows the mainline and preserves the starting FEN, player
   names, result and PGN tags. A recorded result, such as a resignation or
   agreement, is shown separately from an automatic board outcome.
2. Choose **Quick review** or **Deeper review** and click **Run review**.
   **Cancel review** keeps the evaluated positions and finished grades. The
   progress display counts them separately. **Replace review** starts another
   job. **Retry previous review** resubmits the last PGN and preset and can
   reuse successful searches.
3. Select a move in the list or a point on the graph. The graph shows
   White-relative pawns and places mate scores at the edges. The selected move
   shows its classification, explanation, best alternative and recommended
   continuation. **Analyze position** opens that ply and its history in the
   Analysis Board. Switching workflows directly keeps the board you were using.
4. **Export JSON** saves the status, PGN metadata, position evaluations, grades,
   search provenance, engine settings and methodology versions. Each position
   records its ply, FEN, side to move and exact White-relative score. The
   recorded depth, nodes and elapsed time identify the search sample. Cancelled and
   failed exports retain partial results. Whole-game accuracy appears only
   after all plies have been assessed. Grades use mover-relative comparisons,
   and a material disagreement with adjacent position scores is flagged.

| Preset | Main search | Alternative | Same-root comparison | Verification |
| --- | ---: | ---: | ---: | ---: |
| Quick | 45,000 nodes | 45,000 | 70,000 | 300,000 |
| Deeper | 200,000 nodes | 180,000 | 300,000 | 1,200,000 |

Budgets are per search, with a depth cap of 26 and a 45-second timeout per
review search. Runtime depends on the game and hardware. Deeper reviews of
long games can take several minutes.

### Accuracy

Quiet Chess applies Lichess’s published winning-chance curve and current game
aggregation to local Stockfish scores. Quiet Chess uses same-position comparison
scores for the move accuracy input and the chronological evaluations for
volatility. Engine builds, search budgets and score inputs can change the
result. Scores can differ from Lichess and Chess.com.
[Lichess accuracy documentation](https://lichess.org/page/accuracy),
[Lichess implementation](https://github.com/lichess-org/lila/blob/master/modules/analyse/src/main/AccuracyPercent.scala).

- Clamp centipawns to ±1,000 and apply `100 / (1 + exp(-0.00368208 × cp))`.
  Use the winner’s sign at the ceiling for a mate score, including completed
  mate. An automatic draw is 0 cp. Black’s winning chances are 100 minus White’s.
  [Lichess score conversion](https://github.com/lichess-org/scalachess/blob/master/core/src/main/scala/eval.scala).
- For a mover loss of `d` winning-chance points, apply
  `103.1668100711649 × exp(-0.04354415386753951 × d) - 3.166924740191411 + 1`,
  clamped to 0–100. Ties, improvements and forced moves score 100. The main
  search’s first choice also scores 100 unless a deeper search confirms a
  clear reversal. For other moves, restrict a two-candidate search at the
  original position to the played move and discovered best alternative. The
  estimate uses exact lines from the same completed depth. Near-threshold
  losses, disagreements with adjacent evaluations and potential rank reversals
  get a larger search. JSON includes the inputs to each accuracy score.
- Calculate volatility from White’s chronological winning-chance series,
  including the starting position. The sliding window is
  `floor(plies / 10)` clamped to 2–8 positions. Pad the beginning by repeating
  the first window to align with adjacent position pairs. Clamp the population
  standard deviation to 0.5–12. For each player, average the volatility-weighted
  mean and the harmonic mean of their move accuracies. The harmonic denominator
  uses a per-move floor of 1. A player without moves has no accuracy.
  [Lichess aggregation source](https://github.com/lichess-org/lila/blob/master/modules/analyse/src/main/AccuracyPercent.scala),
  [Lichess statistics helpers](https://github.com/lichess-org/scalalib/blob/master/lila/src/main/scala/Maths.scala).

### Move classifications

The labels use engine scores and legal replay. Quiet Chess independently
implements the classifications and uses a review workflow inspired by Chess.com.

| Base label | Criterion |
| --- | --- |
| Best | Stockfish’s main-search choice that survives verification, or the only legal move |
| Excellent | Loss under 2 winning-chance points |
| Good | Loss from 2 to under 5 |
| Inaccuracy | Loss from 5 to under 10 |
| Mistake | Loss from 10 to under 20 |
| Blunder | Loss of 20 or more |

**Great** requires the played first choice to survive a deeper, unrestricted
two-candidate search. The best line must retain at least 42% winning chances
for the mover while the next choice falls below 42% and trails by at least 16
points. **Brilliant** requires a sustained sacrifice with confirmed compensation.
Both the main and verification searches must show a quiet non-pawn offer,
the opponent taking that piece, at least two net material points still lost
through the next four plies relative to the starting balance, and at least 55%
winning chances. The offer must start from a material lead of at most one point,
and the verified next-best option must trail by at least 16 points. Immediate
recaptures and routine trades that restore the balance fail this check.
Verification requires depth 14 in Quick review and 16 in Deeper review.

Primary label precedence is Brilliant, then Great, then base quality. Forced
moves receive the base label. Missing or inconclusive special-label evidence
leaves the base label in place. Conservative sacrifice criteria can miss some
sound sacrifices, including those beginning with a capture. Thresholds are
centralized in [backend/classification.py](backend/classification.py).

## Engine scheduling and resources

| Setting | Default or behavior |
| --- | --- |
| Engine | One persistent native Stockfish 19 process per server |
| Threads | Half physical CPU cores, clamped to 1–4 |
| Hash | Available memory divided by 16, clamped to 16–256 MiB |
| Playing strength | UCI_LimitStrength false and Skill Level 20 |
| Interactive streaming | Latest position only, at most about 12.5 updates per second plus the final batch |
| Review | MultiPV 1 for the main pass, MultiPV 2 for alternatives and comparisons |

Override resources with `STOCKFISH_THREADS` (1–64) or `STOCKFISH_HASH_MB`
(16–8192) in `.env`. A higher setting uses more resources. Each command
replays the starting FEN and complete move stack, preserving known repetition
history and draw rules. FEN records the starting state and counters. History
before an imported FEN is unavailable. Automatic draws and checkmate use
chess rules. The engine receives history for claimable draws. For extreme FEN
counters, the engine input respects Stockfish 19’s parser limits. The original
move numbers and game history remain available in the board and export.
[Stockfish FEN parser](https://github.com/official-stockfish/Stockfish/blob/sf_19/src/position.cpp#L383-L395).

The engine manager grants one search at a time across both workflows. A single
review job can run, with one latest replacement allowed to wait for cleanup.
Other review submissions receive a busy response. An interactive search can
take its turn between review searches. The board shows **Waiting for engine**
when another search holds the engine. Opening Game Review suspends the
current Analysis Board search. One browser tab at a time owns the live
analysis socket.

Cancellation invalidates the old request, sends UCI `stop` and waits for
`bestmove` before the engine accepts new work. If stop cleanup stalls for
2 seconds, the process is closed and can restart on the next request. The
browser checks request ID, FEN and candidate count for live updates. Review
progress is retrieved by job ID and includes queued, running, complete,
cancelled and failed states.

The server retains the last four jobs and a 512-entry in-memory search cache.
Keys include starting FEN, played UCI history, engine identity, resource
settings, limits, MultiPV, constrained roots and methodology versions.
Individual review searches use fresh UCI game state. Only exact completed
iterations are cached. A reload reconnects to a running review. Export
completed results before refreshing or shutting down.

## Verification

From the project folder, run `python manage.py test` for the backend suite,
frontend unit tests and the production build. Run `python manage.py test --engine`
to include native Stockfish tests. Contract tests use a simulated engine where
they need controlled timing, failures or scores.

Install Playwright’s browser with `npx playwright install chromium` from
`frontend`, then run `npm run test:e2e`. By default Playwright starts Vite.
To exercise native analysis and review, start FastAPI separately and enable
`RUN_STOCKFISH_TESTS=1`. Set `QUIET_CHESS_TEST_URL` to test a specific server
directly, for example with PowerShell:

```powershell
$env:RUN_STOCKFISH_TESTS = '1'
$env:QUIET_CHESS_TEST_URL = 'http://127.0.0.1:8000'
npm.cmd run test:e2e
```

For startup issues, run `python manage.py check`. Check the configured stockfish
executable, CPU compatibility and whether port 8000 is already occupied. If
Vite cannot start, check port 5173. The frontend remains usable for board editing
when the engine is offline.

## Licensing

Project source is provided under GPL-3.0-or-later. See [LICENSE](LICENSE).
Stockfish and python-chess have their own GPL obligations, and other dependencies
retain their upstream licenses. [Stockfish](https://stockfishchess.org/),
[python-chess](https://python-chess.readthedocs.io/).
