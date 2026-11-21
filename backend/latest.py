"""A latest-only serial worker. No chess/network dependency; independently tested."""
import asyncio
from typing import Awaitable, Callable, Any


class LatestJob:
    def __init__(self, work: Callable[[int, Any], Awaitable[None]]):
        self.work = work
        self.generation = 0
        self.pending = None
        self.event = asyncio.Event()
        self.active: asyncio.Task | None = None
        self.closed = False
        self.worker = asyncio.create_task(self._run())

    def replace(self, payload):
        self.generation += 1
        self.pending = (self.generation, payload)
        if self.active and not self.active.cancelling():
            self.active.cancel()
        self.event.set()
        return self.generation

    def stop(self):
        self.generation += 1
        self.pending = None
        if self.active and not self.active.cancelling():
            self.active.cancel()

    def is_current(self, token):
        return not self.closed and token == self.generation

    async def _run(self):
        while not self.closed:
            await self.event.wait()
            self.event.clear()
            item, self.pending = self.pending, None
            if item is None:
                continue
            self.active = asyncio.create_task(self.work(*item))
            try:
                await self.active
            except asyncio.CancelledError:
                if self.closed:
                    return
            finally:
                self.active = None

    async def close(self):
        self.closed = True
        self.stop()
        self.event.set()
        # Let the active task finish its UCI stop/bestmove cleanup before exiting.
        await self.worker
