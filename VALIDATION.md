# Validation report

Verified on 2026-11-21 on Windows with Python 3.13.9, Node.js 24.7.0,
Playwright Chromium and native Stockfish 19. The local engine was configured
with 8 threads and 1,024 MiB of hash.

| Check | Result | Coverage |
| --- | --- | --- |
| `python manage.py setup` | Passed | Python dependencies, locked npm install and production build |
| `.venv\Scripts\python.exe scripts/check_engine.py` | Passed | Native Stockfish 19 identity and live UCI search |
| `python manage.py test --engine` | 56 Python tests and 23 frontend unit tests passed | Candidate batching, stale-result rejection, game rules, score perspective, accuracy, special classifications, review lifecycle, caching and shared engine coordination |
| `npm run build` | Passed | TypeScript checks and Vite production bundle |
| Live `npm run test:e2e` | 8 passed | Windows Chromium against FastAPI and native Stockfish, including 375-pixel layout, candidate changes and arrows, PGN file import, graph navigation, JSON export, cancellation, retry, replacement and return to live analysis |
| Manual Deeper review | Completed 33 of 33 plies | The Opera Game played through checkmate, with both accuracy scores and 34 graph evaluations. The review was inspected at desktop and mobile widths in Edge. |
| `npm audit --audit-level=high` | 0 reported vulnerabilities | Updated the existing Vite dependency from 8.2.1 to 8.2.4 and refreshed its lockfile |

The backend suite included four tests with native Stockfish, including a custom
FEN whose move number exceeds the native parser’s limit. Contract tests use
simulated engine timing or scores where appropriate. The packaged frontend was
served from a local FastAPI test instance on port 8001. Browser test variables
were `RUN_STOCKFISH_TESTS=1` and `QUIET_CHESS_TEST_URL=http://127.0.0.1:8001`.

Linux, macOS, Firefox, Safari and the 600-ply maximum were outside this
verification run. Vite’s built application was tested through FastAPI.

## Phase 1 review reliability

Verified on 2026-11-22 on Windows with Chromium and native Stockfish 19.

| Check | Result |
| --- | --- |
| `python manage.py test --engine` | 74 backend tests (5 native), 27 frontend tests, and production build passed |
| Focused backend rerun | 25 tests passed after the final engine-state and import test changes, including a legal 604-ply import |
| Final frontend rerun | 27 unit tests and production build passed |
| Live Playwright suite | 11 passed, including a complete 33-ply Opera Game review and an export with 34 position records |
| Direct native API check | A custom Black-to-move game completed with legal castling and a recorded resignation. The final board remained playable. |

The large annotated PGN and 604-ply mainline exercises validate import. The
33-ply game was the end-to-end native browser test. Browser and platform
coverage was Windows Chromium. The local test server ran on port 8001.
