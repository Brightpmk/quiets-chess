"""Runs without dependencies: python -m unittest backend.tests.test_core -v."""
import asyncio
import os
import unittest
from unittest.mock import patch
from backend.latest import LatestJob
from backend.search import stream_search
from backend.settings import Settings


class LatestTests(unittest.IsolatedAsyncioTestCase):
    async def test_new_position_waits_for_stop_and_drops_queued_intermediates(self):
        events, published = [], []
        started, latest_published = asyncio.Event(), asyncio.Event()
        async def work(token, value):
            events.append(('start', value))
            if value == 'old':
                started.set()
                try: await asyncio.Future()
                finally:
                    events.append(('stop', value))
                    await asyncio.sleep(.01)
            if runner.is_current(token):
                published.append(value)
                latest_published.set()
        runner = LatestJob(work)
        runner.replace('old')
        await asyncio.wait_for(started.wait(), 1)
        runner.replace('intermediate'); runner.replace('latest')
        await asyncio.wait_for(latest_published.wait(), 1)
        self.assertEqual(published, ['latest'])
        self.assertEqual(events, [('start', 'old'), ('stop', 'old'), ('start', 'latest')])
        await runner.close()

    async def test_repeated_changes_do_not_interrupt_stop_cleanup(self):
        started, cleaning, finish_cleanup, finished = (asyncio.Event() for _ in range(4))
        async def work(token, value):
            if value != 'old': return
            started.set()
            try: await asyncio.Future()
            finally:
                cleaning.set()
                await finish_cleanup.wait()
                finished.set()
        runner = LatestJob(work)
        runner.replace('old')
        await asyncio.wait_for(started.wait(), 1)
        runner.replace('second')
        await asyncio.wait_for(cleaning.wait(), 1)
        runner.replace('third'); runner.stop()
        finish_cleanup.set()
        await runner.close()
        self.assertTrue(finished.is_set())

    async def test_stop_invalidates_before_task_cleanup(self):
        events = []
        started = asyncio.Event()
        async def work(token, value):
            started.set()
            try: await asyncio.Future()
            finally: events.append(runner.is_current(token))
        runner = LatestJob(work)
        token = runner.replace('position')
        await asyncio.wait_for(started.wait(), 1)
        runner.stop(); self.assertFalse(runner.is_current(token))
        await runner.close(); self.assertEqual(events, [False])

    async def test_idle_close(self):
        async def work(*args): pass
        runner = LatestJob(work)
        await asyncio.wait_for(runner.close(), .2)


class FakeAnalysis:
    def __init__(self, hang=False, complete=False):
        self.stopped = asyncio.Event()
        self.hang, self.complete = hang, complete
        self.info = {'depth': 20}
    def stop(self): self.stopped.set()
    async def wait(self):
        if self.hang: await asyncio.Future()
        if not self.complete: await self.stopped.wait()
    def __aiter__(self): return self.iterate()
    async def iterate(self):
        yield {'depth': 1}
        if not self.complete: await asyncio.Future()


class SearchTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_during_startup_still_stops_engine(self):
        result, emitted, aborted = FakeAnalysis(), [], []
        starting, finish_startup = asyncio.Event(), asyncio.Event()
        async def start():
            starting.set()
            await finish_startup.wait()
            return result
        async def emit(info, done): emitted.append((info, done))
        task = asyncio.create_task(stream_search(start(), emit, lambda: aborted.append(True)))
        await asyncio.wait_for(starting.wait(), 1)
        task.cancel()
        finish_startup.set()
        with self.assertRaises(asyncio.CancelledError): await task
        self.assertTrue(result.stopped.is_set())
        self.assertEqual(emitted, []); self.assertEqual(aborted, [])

    async def test_cancel_stream_sends_stop_without_final_result(self):
        result, emitted, aborted = FakeAnalysis(), [], []
        first_packet = asyncio.Event()
        async def start(): return result
        async def emit(info, done):
            emitted.append((info, done))
            first_packet.set()
        task = asyncio.create_task(stream_search(start(), emit, lambda: aborted.append(True)))
        await asyncio.wait_for(first_packet.wait(), 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError): await task
        self.assertTrue(result.stopped.is_set())
        self.assertEqual(emitted, [({'depth': 1}, False)]); self.assertEqual(aborted, [])

    async def test_hung_stop_aborts_process(self):
        result, aborted = FakeAnalysis(hang=True), []
        first_packet = asyncio.Event()
        async def start(): return result
        async def emit(*args): first_packet.set()
        task = asyncio.create_task(stream_search(start(), emit, lambda: aborted.append(True), timeout=.01))
        await asyncio.wait_for(first_packet.wait(), 1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError): await task
        self.assertEqual(aborted, [True])

    async def test_final_aggregate_is_emitted(self):
        result, emitted = FakeAnalysis(complete=True), []
        async def start(): return result
        async def emit(info, done): emitted.append((info, done))
        await stream_search(start(), emit, lambda: None)
        self.assertEqual(emitted, [({'depth': 1}, False), ({'depth': 20}, True)])

    async def test_old_bound_flags_cannot_survive_final_exact_score(self):
        class BoundsAnalysis(FakeAnalysis):
            async def iterate(self):
                yield {'score': 50, 'lowerbound': True, 'pv': ['old']}
                yield {'score': 35, 'pv': ['new']}
        result = BoundsAnalysis(complete=True)
        result.info = {'score': 35, 'lowerbound': True, 'pv': ['new'], 'depth': 20}
        emitted = []
        async def start(): return result
        async def emit(info, done): emitted.append((info, done))
        await stream_search(start(), emit, lambda: None)
        final = emitted[-1][0]
        self.assertEqual(final['score'], 35)
        self.assertFalse(final['lowerbound'])
        self.assertFalse(final['upperbound'])
        self.assertEqual(final['pv'], ['new'])

    async def test_start_failure_propagates_and_aborts(self):
        aborted = []
        async def start(): raise RuntimeError('engine crashed')
        async def emit(*args): pass
        with self.assertRaisesRegex(RuntimeError, 'engine crashed'):
            await stream_search(start(), emit, lambda: aborted.append(True))
        self.assertEqual(aborted, [True])


class SettingsTests(unittest.TestCase):
    @patch.dict(os.environ, {}, clear=True)
    def test_conservative_defaults(self):
        config = Settings.from_env()
        self.assertTrue(1 <= config.threads <= 4)
        self.assertTrue(16 <= config.hash_mb <= 256)
        self.assertNotIn('*', config.origins)
    @patch.dict(os.environ, {'STOCKFISH_THREADS': '0'}, clear=True)
    def test_rejects_bad_cpu_override(self):
        with self.assertRaises(ValueError): Settings.from_env()
    @patch.dict(os.environ, {'STOCKFISH_HASH_MB': '999999'}, clear=True)
    def test_rejects_bad_memory_override(self):
        with self.assertRaises(ValueError): Settings.from_env()


if __name__ == '__main__': unittest.main()
