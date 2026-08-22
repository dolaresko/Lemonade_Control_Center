from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.routers.metrics import (
    clear_metrics,
    export_tasks_csv,
    get_hardware_series,
    get_tasks,
    get_tasks_series,
)
from app.services.metrics.store import MetricsStore, TaskRow
from app.services.metrics.task_history import task_history


@pytest.fixture
def empty_store(tmp_path, monkeypatch):
    """Point the shared history at a throwaway database for one test."""
    original = task_history.store
    store = MetricsStore(tmp_path / "lcc_metrics.db")
    task_history.use_store(store)
    # No journal means no ingestion side effects on read endpoints.
    monkeypatch.setattr(
        "app.services.metrics.task_history.capabilities.cmd_journalctl", False
    )
    yield store
    task_history.use_store(original)


def recent_row(minutes_ago: float, gen_tps: float, ttft: float = 1.0) -> TaskRow:
    moment = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    return TaskRow(
        timestamp=moment.isoformat(),
        model="Gemma-4-12B-it-MTP-GGUF",
        input_tokens=91,
        output_tokens=61,
        prompt_tps=73.39,
        gen_tps=gen_tps,
        ttft_seconds=ttft,
        total_seconds=5.6,
        finish_reason="stop",
        finish_confidence="inferred",
    )


# ── Empty database ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_tasks_endpoint_on_an_empty_database(empty_store):
    assert await get_tasks(n=100, since=None, until=None) == {"tasks": []}


@pytest.mark.asyncio
async def test_tasks_series_endpoint_on_an_empty_database(empty_store):
    for window in ("1h", "24h", "7d", "30d"):
        payload = await get_tasks_series(range=window)

        assert payload["range"] == window
        assert payload["buckets"] == []
        assert payload["start"] < payload["end"]


@pytest.mark.asyncio
async def test_hardware_series_endpoint_on_an_empty_database(empty_store):
    for window in ("1h", "24h", "7d", "30d"):
        payload = await get_hardware_series(range=window)

        assert payload["range"] == window
        assert payload["buckets"] == []


@pytest.mark.asyncio
async def test_tasks_csv_endpoint_on_an_empty_database(empty_store):
    response = await export_tasks_csv(since=None, until=None, range=None)

    assert response.status_code == 200
    assert response.media_type == "text/csv"
    assert response.body.decode().strip() == (
        "timestamp,model,input_tokens,output_tokens,prompt_tps,gen_tps,"
        "ttft_seconds,total_seconds,finish_reason,finish_confidence"
    )


# ── Populated database ─────────────────────────────────────


@pytest.mark.asyncio
async def test_tasks_endpoint_keeps_its_response_shape(empty_store):
    empty_store.insert_tasks([recent_row(5, 13.84)])

    payload = await get_tasks(n=20, since=None, until=None)

    assert set(payload) == {"tasks"}
    assert set(payload["tasks"][0]) == {
        "timestamp", "model", "input_tokens", "output_tokens", "prompt_tps",
        "gen_tps", "ttft_seconds", "total_seconds", "finish_reason",
        "finish_confidence",
    }


@pytest.mark.asyncio
async def test_tasks_endpoint_honours_since_and_until(empty_store):
    empty_store.insert_tasks([recent_row(120, 10.0), recent_row(5, 20.0)])
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat()

    payload = await get_tasks(n=100, since=cutoff, until=None)

    assert [task["gen_tps"] for task in payload["tasks"]] == [20.0]


@pytest.mark.asyncio
async def test_tasks_endpoint_rejects_a_malformed_boundary(empty_store):
    with pytest.raises(HTTPException) as raised:
        await get_tasks(n=10, since="not-a-timestamp", until=None)

    assert raised.value.status_code == 400


@pytest.mark.asyncio
async def test_tasks_series_aggregates_recorded_runs(empty_store):
    empty_store.insert_tasks([
        recent_row(3, 10.0, ttft=1.0),
        recent_row(2, 20.0, ttft=3.0),
    ])

    payload = await get_tasks_series(range="1h")

    assert payload["bucket_seconds"] == 60
    assert sum(bucket["count"] for bucket in payload["buckets"]) == 2
    assert all(bucket["gen_tps_p95"] >= bucket["gen_tps_p50"] for bucket in payload["buckets"])


@pytest.mark.asyncio
async def test_tasks_series_buckets_carry_every_aggregate(empty_store):
    # Anchor both runs inside one 15-minute bucket so the assertion below does
    # not depend on where "now" happens to sit relative to a bucket boundary.
    anchor = datetime.now(timezone.utc) - timedelta(minutes=5)
    floor = anchor - timedelta(
        seconds=anchor.timestamp() % (15 * 60), microseconds=anchor.microsecond
    )
    minutes_ago = (datetime.now(timezone.utc) - floor).total_seconds() / 60
    empty_store.insert_tasks([
        recent_row(minutes_ago - 1 / 60, 10.0),
        recent_row(minutes_ago - 2 / 60, 20.0),
    ])

    bucket = (await get_tasks_series(range="24h"))["buckets"][0]

    assert set(bucket) == {
        "t", "count", "gen_tps_mean", "gen_tps_p50", "gen_tps_p95",
        "ttft_mean", "input_tokens", "output_tokens", "total_tokens",
    }
    assert bucket["gen_tps_mean"] == 15.0
    assert bucket["total_tokens"] == 304


@pytest.mark.asyncio
async def test_series_falls_back_to_the_default_range(empty_store):
    assert (await get_tasks_series(range="nonsense"))["range"] == "24h"
    assert (await get_hardware_series(range=""))["range"] == "24h"


@pytest.mark.asyncio
async def test_hardware_series_reads_the_persisted_rollups(empty_store):
    minute = (
        datetime.now(timezone.utc) - timedelta(minutes=3)
    ).replace(second=0, microsecond=0)
    empty_store.upsert_hardware_minute({
        "timestamp": minute.isoformat(), "sample_count": 12, "ram_used_gb": 10.0,
        "ram_total_gb": 32.0, "ram_percent": 31.25, "ram_percent_min": 30.0,
        "ram_percent_max": 33.0, "cpu_percent": 18.0, "swap_used_gb": 0.0,
        "gpu_load_percent": 42.0, "gpu_temp_c": 61.0,
        "temperatures": {"k10temp/Tctl": 55.0},
    })

    payload = await get_hardware_series(range="1h")

    assert len(payload["buckets"]) == 1
    bucket = payload["buckets"][0]
    assert bucket["count"] == 12
    assert bucket["ram_percent_max"] == 33.0
    assert bucket["temps"] == {"k10temp/Tctl": 55.0}


@pytest.mark.asyncio
async def test_tasks_csv_honours_the_range_parameter(empty_store):
    empty_store.insert_tasks([recent_row(60 * 40, 10.0), recent_row(5, 20.0)])

    everything = await export_tasks_csv(since=None, until=None, range="7d")
    last_hour = await export_tasks_csv(since=None, until=None, range="1h")

    assert len(everything.body.decode().strip().splitlines()) == 3
    assert len(last_hour.body.decode().strip().splitlines()) == 2


@pytest.mark.asyncio
async def test_clear_endpoint_empties_the_persisted_history(empty_store):
    empty_store.insert_tasks([recent_row(5, 13.84)])

    assert await clear_metrics() == {"cleared": True}
    assert empty_store.count_tasks() == 0


@pytest.mark.asyncio
async def test_tasks_series_carries_a_window_summary(empty_store):
    empty_store.insert_tasks([recent_row(10, 10.0), recent_row(5, 20.0)])

    summary = (await get_tasks_series(range="24h"))["summary"]

    assert summary["count"] == 2
    assert summary["gen_tps_mean"] == 15.0
    assert summary["gen_tps_p95"] == 20.0


@pytest.mark.asyncio
async def test_tasks_series_summary_is_empty_not_absent(empty_store):
    payload = await get_tasks_series(range="7d")

    assert payload["summary"]["count"] == 0
    assert payload["summary"]["gen_tps_p95"] == 0.0
