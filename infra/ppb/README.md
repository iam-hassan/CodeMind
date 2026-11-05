# PPB local development infrastructure

Phase 1 Part 1 (PPB Knowledge Core) needs three backing services (spec §9/§14/§15):

| Service | Purpose | Spec |
|---|---|---|
| PostgreSQL + pgvector | relational + vector storage (embeddings, memories, versions, telemetry) | §9, §14 |
| Neo4j | project knowledge graph (nodes, relationships, constraints) | §6, §9 |
| Redis | ranked-retrieval cache (IF-12) | §15 |

All configuration values are **placeholders pending real measurement** (spec §26/§32) —
never treat the defaults here as requirements.

## Machine status (as of 2026-09-21)

**Route A is the chosen route.** Docker Desktop 29.8 (Compose v5.5.1) is installed and the PPB stack is
running and healthy — `docker compose -f infra/ppb/docker-compose.yml ps` shows ppb-postgres, ppb-neo4j and
ppb-redis as `healthy`, all three host ports are reachable, and pgvector **0.8.6** is available in PostgreSQL.
Integration tests are gated by `PPB_TEST_INFRA=1` and run against this stack.

The machine also has (unused by Route A):

- PostgreSQL 18 (service `postgresql-x64-18`, listening on `localhost:5432`) — **pgvector is NOT installed**
- Redis (service `Redis`, listening on `localhost:6379`)

Route B below remains documented as an alternative.

## Route A — Docker Compose (recommended, portable)

Requires Docker Desktop. Host ports are offset to avoid clashing with the native services
above (PG → 55432, Neo4j bolt → 57687, Redis → 56379):

```sh
docker compose -f infra/ppb/docker-compose.yml up -d
docker compose -f infra/ppb/docker-compose.yml ps
```

> **`docker compose … down -v` deletes all three volumes** (all PPB data). Use `stop`/`start` to pause the
> stack without data loss. All published ports are bound to `127.0.0.1` (localhost only) — the
> committed dev credentials are not reachable from the LAN.

Environment (PowerShell):

```powershell
$env:CODEMIND_PPB_ENABLED = '1'
$env:PPB_PG_URL    = 'postgres://postgres:postgres@localhost:55432/codemind_ppb'
$env:PPB_NEO4J_URL = 'bolt://localhost:57687'
$env:PPB_REDIS_URL = 'redis://localhost:56379'
```

## Route B — Native services (what this machine already has, partially)

- **PostgreSQL 18** @ `localhost:5432`: create a dedicated database and enable pgvector:

  ```sql
  CREATE DATABASE codemind_ppb;
  \c codemind_ppb
  CREATE EXTENSION vector;   -- requires the pgvector Windows build for PG18
  ```

  The `vector` extension is **not currently installed** in the local PG18; either install a
  pgvector build matching PG18, or use Route A for Postgres only.
- **Redis** @ `localhost:6379`: ready as-is.
- **Neo4j**: not installed. Install Neo4j Community 5.x locally (Java 17/21 required) or run
  only the Neo4j service from the compose file.

Environment (PowerShell) for Route B:

```powershell
$env:CODEMIND_PPB_ENABLED = '1'
$env:PPB_PG_URL    = 'postgres://postgres:postgres@localhost:5432/codemind_ppb'
$env:PPB_NEO4J_URL = 'bolt://localhost:7687'
$env:PPB_REDIS_URL = 'redis://localhost:6379'
```

## Status check

```powershell
Test-NetConnection localhost -Port 5432   # or 55432 for Route A
Test-NetConnection localhost -Port 7687   # or 57687 for Route A
Test-NetConnection localhost -Port 6379   # or 56379 for Route A
```

## Notes

- The engine degrades gracefully when services are absent (spec §24): retrieval falls back to
  the Null retriever and ingestion to the Noop sink; the chat turn is never broken.
- `CODEMIND_PPB_ENABLED=1` is required to enable any Part 1 runtime behavior; when unset the
  system is byte-for-byte inert.
