"""One running review, with at most one replacement pending UCI stop cleanup."""
import asyncio
from collections import OrderedDict
from dataclasses import dataclass, field
import logging
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .latest import LatestJob
from .review import counts_for_moves
from .review_pgn import MAX_PGN_BYTES, ReviewGame, parse_pgn

logger = logging.getLogger(__name__)
ACTIVE = {"queued", "running"}
RETAINED_JOBS = 4


class ReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    pgn: str = Field(max_length=MAX_PGN_BYTES)
    preset: Literal["quick", "deep"] = "quick"
    replace: str | None = Field(default=None, max_length=32)


@dataclass
class ReviewJob:
    game: ReviewGame
    preset: str
    settings: dict
    id: str = field(default_factory=lambda: uuid4().hex)
    status: str = "queued"
    moves: list = field(default_factory=list)
    positions: list = field(default_factory=list)
    accuracy: dict | None = None
    error: str | None = None

    async def checkpoint(self):
        await asyncio.sleep(0)
        if self.status != "running":
            raise asyncio.CancelledError

    def snapshot(self, after=0, position_after=0, include_game=True):
        return {"id": self.id, "status": self.status, "settings": self.settings,
                "error": self.error, "game": {"root_fen": self.game.root_fen, "headers": self.game.headers,
                                              "moves": self.game.moves, "terminal": self.game.terminal}
                if include_game else None,
                "analyzed": len(self.moves), "total": len(self.game.moves), "moves": self.moves[after:],
                "positions": [{"score": line["score"], "depth": line["depth"], "search": line["search"],
                               "terminal": line.get("terminal")} for line in self.positions[position_after:]],
                "classification_counts": counts_for_moves(self.moves),
                "accuracy": self.accuracy if self.status == "complete" else None}


class ReviewJobs:
    def __init__(self, analyzer):
        self.analyzer = analyzer
        self.jobs = OrderedDict()
        self.active = None
        self.runner = None

    def open(self):
        self.runner = LatestJob(self.run)

    async def close(self):
        if self.active:
            self.cancel(self.active)
        await self.runner.close()

    def submit(self, request):
        if self.active and request.replace != self.active.id:
            raise HTTPException(409, "A review is already running. Wait for it to finish or cancel it in its tab.")
        try:
            game = parse_pgn(request.pgn)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        if self.active:
            self.cancel(self.active)
        job = ReviewJob(game, request.preset, self.analyzer.metadata(request.preset))
        self.jobs[job.id] = self.active = job
        if len(self.jobs) > RETAINED_JOBS:
            self.jobs.popitem(last=False)
        self.runner.replace(job)
        return job

    def get(self, job_id):
        job = self.jobs.get(job_id)
        if job is None:
            raise HTTPException(404, "This review is no longer available. Run it again from your PGN.")
        return job

    def cancel(self, job):
        if job is self.active and job.status in ACTIVE:
            job.status = "cancelled"
            self.active = None
            self.runner.stop()
        return job

    async def run(self, token, job):
        job.status = "running"
        try:
            await self.analyzer.run(job)
            if self.runner.is_current(token):
                job.status = "complete"
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            if self.runner.is_current(token):
                logger.exception("Review failed")
                job.status = "failed"
                job.error = str(exc) if isinstance(exc, RuntimeError) else "Review could not finish. Retry the PGN."
        finally:
            if job is self.active:
                self.active = None


def review_routes(jobs, allowed_origins):
    router = APIRouter(prefix="/api/reviews")

    def check_origin(request):
        origin = request.headers.get("origin")
        if origin is not None and origin not in allowed_origins:
            raise HTTPException(403, "Local origin required.")

    @router.post("", status_code=202)
    async def submit(request: Request):
        check_origin(request)
        if request.headers.get("content-type", "").split(";")[0].strip() != "application/json":
            raise HTTPException(415, "Send the review request as JSON.")
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_PGN_BYTES * 6 + 1024:
                raise HTTPException(413, "Review import is limited to 100 KB.")
        try:
            payload = ReviewRequest.model_validate_json(body)
        except ValidationError as exc:
            raise HTTPException(422, "Invalid review request. Supply a PGN of at most 100 KB and select a preset.") from exc
        return jobs.submit(payload).snapshot()

    @router.get("/{job_id}")
    async def status(job_id: str, request: Request, after: int | None = None, position_after: int = 0):
        check_origin(request)
        if (after is not None and after < 0) or position_after < 0:
            raise HTTPException(422, "Invalid review progress offset.")
        return jobs.get(job_id).snapshot(after or 0, position_after, include_game=after is None)

    @router.delete("/{job_id}")
    async def cancel(job_id: str, request: Request):
        check_origin(request)
        return jobs.cancel(jobs.get(job_id)).snapshot()

    return router
