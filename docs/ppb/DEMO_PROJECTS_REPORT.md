# Demo Projects - real run against real databases

Built the Group H demo projects on disk, drove the **real** Part 1 pipeline over each one
(real extraction model, real PostgreSQL, real Neo4j), and then inspected both databases.
No mocks.

## 1. Files

| Path | What |
|---|---|
| `demo-projects/taskflow` | Next.js 14 + TS + Express + PostgreSQL + AWS (project #1) |
| `demo-projects/blogplatform` | Next.js 14 + MDX + Prisma + PostgreSQL + Vercel (project #2) |
| `demo-projects/realestate-api` | Express + MongoDB + JWT + Lambda + OpenAPI (project #3) |
| `demo-projects/mobileapp-bff` | GraphQL/Apollo + Prisma + Redis + JWT 15m (project #4) |
| `demo-projects/inventory-system` | NestJS + PostgreSQL/TypeORM + Kafka + K8s (project #5) |
| `demo-projects/aistartup-landing` | Next.js + Tailwind + Framer Motion, no backend (project #6) |
| `scripts/demo-projects/projects.mjs` | project specs + scenario turns/decisions/events |
| `scripts/demo-projects/scaffold.mjs` | writes the projects to disk |
| `scripts/demo-projects/run.mjs` | drives the real pipeline over all projects + inspects |
| `scripts/demo-projects/inspect.mjs` | read-only PostgreSQL + Neo4j inspector |
| `scripts/demo-projects/run-report.json` | machine-readable result |

## 2. How to run

```powershell
docker compose -f infra/ppb/docker-compose.yml up -d
node scripts/demo-projects/scaffold.mjs          # write the projects

# provider env (see DEMO_RUNBOOK section 2), then:
node scripts/demo-projects/run.mjs               # real extraction + DB writes + inspection
node scripts/demo-projects/inspect.mjs           # re-inspect any time
```

## 3. Real results (actual output)

**Extraction** - the live model produced facts per project (nothing scripted):

| project | facts stored |
|---|---|
| taskflow | 6 |
| blogplatform | 7 |
| realestate-api | 7 |
| mobileapp-bff | 6 |
| inventory-system | 9 |
| aistartup-landing | 6 |

**PostgreSQL totals:** `memories=42, decisions=4, events=2, embeddings=41,
memory_versions=43, conflict_reports=1, outbox_pending=0`.

**S-168 conflict + versioning (TaskFlow PostgreSQL -> MySQL):**

```
existing memory : The project uses PostgreSQL as its database.
IF-3 conflict   : severity=genuine
IF-4 outcome    : accept_migration
old memory      : archived   (superseded_by -> new id)
new memory      : active
```

**S-174 isolation:** in `blogplatform` the answer mentions PostgreSQL and not MySQL; in `taskflow`
it mentions MySQL - no cross-contamination.

**Reasoning (IF-8 -> IF-9), real answers with citations:**

- `taskflow` "Why did we choose Prisma?" -> decision + "better TypeScript support" + event, cited.
- `taskflow` "When did we migrate from PostgreSQL to MySQL?" -> 2026-01-28 migration event, cited.
- `mobileapp-bff` "What query language...?" -> GraphQL decision + Redis fact, cited.

## 4. Database inspection (the important part)

**PostgreSQL stores everything expected** - facts by project/category/status, decisions, events,
embeddings, version audit rows and the conflict report all present. See `inspect.mjs`.

### Before the fix (first run) - the finding
```
nodes:         Constraint 6, Decision 4, Event 2, Preference 1, Standard 4, Technology 34
relationships: REJECTED 3   <-- that was ALL
Project nodes: 0
```
A bag of disconnected nodes: `expandFromSeeds` (§15.3/§6.8) and `impactAnalysis` had nothing to
walk, so hybrid retrieval behaved as vector-only.

### After Tier 1 + Tier 2 (current, verified)
```
nodes:         Project 6, Technology 38, Constraint 6, Decision 4, Standard 3, Event 2, Preference 1
relationships: USES 32, PART_OF 15, HOSTED_ON 4, DECIDED_ON 4, REJECTED 3, DEPENDS_ON 2, SUPERSEDES 2, AFFECTS 1
Project nodes: 6
```
Real entity-to-entity edges now exist, e.g. `Prisma DEPENDS_ON PostgreSQL`, `Vercel HOSTED_ON`,
`(Decision)-[:DECIDED_ON]->(Technology)`. The 15 extraction-inferred edges are stored in the
PostgreSQL `graph_relationships` table (source of truth) and mirrored to Neo4j.

Verified with:
```powershell
docker exec ppb-neo4j cypher-shell -u neo4j -p codemindppb "MATCH (a)-[r]->(b) RETURN type(r) AS rel, count(*) AS n ORDER BY rel;"
docker exec ppb-postgres psql -U postgres -d codemind_ppb -c "SELECT project_id, relationship_type, count(*) FROM graph_relationships GROUP BY 1,2;"
```

| Doc scenario | Expected | Status |
|---|---|---|
| S-051 Technology node | yes | ✅ 38 nodes |
| S-052 `USES` relationship | yes | ✅ 32 (Project→Technology + entity-to-entity) |
| S-053 `DEPENDS_ON` | yes | ✅ 2 (`Prisma DEPENDS_ON PostgreSQL`, ...) |
| S-054 `DECIDED_ON` (decision→technology) | yes | ✅ 4 |
| S-055 `REJECTED` | yes | ✅ 3 |
| S-056 `SUPERSEDES` on migration | yes | ✅ 2 (replacement → archived memory) |
| S-057 impact-analysis traversal | needs edges | ✅ traverses Project↔nodes + entity edges |
| Project node (`(Project)`) | implied | ✅ 6 |

Minor: one benign `pg` deprecation warning (`client.query()` while a query is in flight) during
the multi-project run - output was correct; worth wrapping the sink's embedding path in a single
connection-safe flow later.

## 5. Bottom line

- **Extraction, storage, embeddings, conflict/versioning, isolation and reasoning all work on
  real projects and real data.** You can open the databases and see it.
- **The graph is connected and structured (Tier 1 + Tier 2 done):** `Project` hub per project,
  `USES`/`PART_OF`/`REJECTED`/`SUPERSEDES` plus extraction-inferred `DEPENDS_ON`/`HOSTED_ON`/
  `DECIDED_ON`/`AFFECTS`.
- **How Tier 2 works:** extraction optionally emits `relationships` between the facts it extracted
  (endpoints are names, grounded to fact ids; ungrounded ones are dropped), persisted in
  `graph_relationships` and projected to Neo4j. Decisions gained `decidedOn` → `DECIDED_ON`.

Tested: `165` unit passing, `26` live passing.

### Still out of scope
`Module` nodes and `PART_OF` between modules are not produced because the six knowledge categories
have no "module" category; that would need an extraction taxonomy change. The current six
categories plus the relationship set cover S-051…S-057.
