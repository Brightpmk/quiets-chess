import asyncio
import logging
import re
from contextlib import suppress
import chess.engine
from .settings import Settings
from .search import Iterations, stream_search

logger = logging.getLogger(__name__)


def uci_position(board):
    """Keep PGN numbering in the app while honoring Stockfish 19's FEN limits."""
    root = board.root()
    if root.fullmove_number <= 100_000 and root.halfmove_clock <= 32_767:
        return board
    root.fullmove_number = min(root.fullmove_number, 100_000)
    root.halfmove_clock = min(root.halfmove_clock, 32_767)
    for move in board.move_stack:
        root.push(move)
    return root


class EngineManager:
    """One full-strength native engine, shared sequentially across connections."""
    def __init__(self, settings: Settings):
        self.settings = settings
        self.protocol = None
        self.transport = None
        self.name = None
        self.error = None
        self.owner = None
        self.search_lock = asyncio.Lock()

    async def ensure(self):
        if self.protocol is not None:
            return self.protocol
        try:
            self.transport, protocol = await asyncio.wait_for(
                chess.engine.popen_uci(self.settings.engine_path), 15)
            name = protocol.id.get("name", "Unknown UCI engine")
            if not re.search(r"\bStockfish\s+19\b", name, re.IGNORECASE):
                raise RuntimeError(f"Expected native Stockfish 19, got {name!r}. Set STOCKFISH_PATH.")
            options = {"Threads": self.settings.threads, "Hash": self.settings.hash_mb,
                       "UCI_LimitStrength": False, "Skill Level": 20}
            for key in options:
                if key not in protocol.options:
                    raise RuntimeError(f"Engine is missing required UCI option: {key}")
            # python-chess manages the MultiPV option per search.
            await asyncio.wait_for(protocol.configure(options), 5)
            await asyncio.wait_for(protocol.ping(), 5)
            self.protocol, self.name, self.error = protocol, name, None
            return protocol
        except asyncio.CancelledError:
            self.abort()
            raise
        except Exception as exc:
            self.error = f"Cannot start Stockfish 19: {exc}. Configure STOCKFISH_PATH in .env."
            self.abort()
            raise RuntimeError(self.error) from exc

    def abort(self):
        if self.transport:
            self.transport.close()
        self.protocol = self.transport = None

    async def close(self):
        if self.protocol:
            with suppress(Exception):
                await asyncio.wait_for(self.protocol.quit(), 3)
        self.abort()

    async def _search(self, board, limit, emit, *, multipv, roots=None, game=None, timeout):
        async with self.search_lock:
            protocol = await self.ensure()
            try:
                async with asyncio.timeout(timeout):
                    await stream_search(
                        protocol.analysis(uci_position(board), limit, multipv=multipv, root_moves=roots, game=game,
                                          info=chess.engine.INFO_ALL),
                        emit, self.abort,
                    )
            except (TimeoutError, chess.engine.EngineError) as exc:
                self.abort()
                raise RuntimeError("Stockfish did not finish the search. Check the executable and retry.") from exc

    async def stream(self, board, seconds, emit, *, multipv=1):
        await self._search(board, chess.engine.Limit(time=seconds), emit,
                           multipv=multipv, timeout=seconds + 5)

    async def review_search(self, board, nodes, multipv, roots, *, depth=None):
        expected = min(multipv, len(roots) if roots else board.legal_moves.count())
        iterations = Iterations(expected)

        async def emit(info, done):
            if not done:
                iterations.feed(info)

        # A fresh UCI game clears hash and search history for reproducible bounded samples.
        await self._search(board, chess.engine.Limit(nodes=nodes, depth=depth), emit,
                           multipv=multipv, roots=roots, game=object(), timeout=45)
        return iterations.latest
