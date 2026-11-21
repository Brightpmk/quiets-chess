"""Cancellation-safe async search lifetime, independent of engine implementation."""
import asyncio
from contextlib import suppress


class Iterations:
    """Collect exact UCI lines from a single, ordered pass through the ranks."""

    def __init__(self, count):
        self.count = count
        self.pending = []
        self.depth = 0
        self.latest = ()

    def feed(self, info):
        rank = info.get("multipv", 1)
        depth = info.get("depth")
        if depth is None or "score" not in info or not 1 <= rank <= self.count:
            return None
        if rank == 1:
            self.pending = []
            self.depth = depth
        if depth != self.depth or rank != len(self.pending) + 1:
            return None
        pv = info.get("pv")
        if not pv or info.get("upperbound") or info.get("lowerbound"):
            return None
        if any(line["pv"][0] == pv[0] for line in self.pending):
            return None
        self.pending.append({**info, "multipv": rank})
        if len(self.pending) == self.count and (not self.latest or depth >= self.latest[0]["depth"]):
            self.latest = tuple(self.pending)
            return self.latest
        return None


async def stream_search(start_search, emit, abort, timeout=2.0):
    start = asyncio.ensure_future(start_search)
    analysis = None
    score_snapshot = {}
    try:
        analysis = await asyncio.shield(start)
        async for info in analysis:
            if 'score' in info:
                # python-chess's aggregate dict updates in place: absent bound flags
                # can otherwise survive from an earlier aspiration-search result.
                score_snapshot = {key: info[key] for key in ('score',) if key in info}
                score_snapshot.update(pv=info.get('pv', []),
                                      lowerbound=info.get('lowerbound', False),
                                      upperbound=info.get('upperbound', False))
            await emit(info, False)
        await analysis.wait()
        await emit({**analysis.info, **score_snapshot}, True)
    finally:
        try:
            if analysis is None:
                analysis = await asyncio.wait_for(start, timeout)
            analysis.stop()
            await asyncio.wait_for(analysis.wait(), timeout)
        except (Exception, asyncio.CancelledError):
            abort()
            if not start.done():
                start.cancel()
            with suppress(Exception, asyncio.CancelledError):
                await start
