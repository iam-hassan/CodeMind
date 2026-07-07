# CodeMind FYP — Deep Analysis

> Comprehensive structured understanding of the CodeMind FYP proposal, produced before any implementation begins.
> Source: `CodeMind_FYP_Main_Features.docx`
> Date of analysis: 2026-07-07
> Status: Analysis complete; awaiting developer go-ahead before any code is written.

---

## Project Summary

CodeMind is a VS Code fork that transforms AI-assisted software development from a session-bound, single-pipeline experience into a continuously learning, project-aware, multi-model-collaborative platform. Its three core innovations are: a Persistent Project Brain that extracts structured engineering knowledge from every developer conversation into a queryable knowledge graph that survives across sessions and projects; an Adaptive AI Agent that intercepts every request, classifies intent, routes it through the right combination of internal and external tools executing in parallel, and compresses the resulting context before forwarding it to Claude Code; and a Multi-Agent Planning Mode that convenes multiple heterogeneous AI models under a deterministic Moderator Agent to debate, normalize, and converge on an implementation plan with a fully audited Decision Matrix. The platform's stack is unusually heavy for an IDE (Neo4j + PostgreSQL/pgvector + Redis + BGE-M3 embeddings + Anthropic + several other model providers) and its architecture is intentionally modular so that the Agent layer never needs to change as new tools, models, or memories are added.

---

## Table of Contents

- [Analysis Task 1 — Core Problem Statement](#analysis-task-1--core-problem-statement)
- [Analysis Task 2 — The Three Core Features in Full Depth](#analysis-task-2--the-three-core-features-in-full-depth)
  - [Feature 1: Persistent Project Brain (PPB)](#feature-1-persistent-project-brain-ppb)
  - [Feature 2: CodeMind Agent](#feature-2-codemind-agent-adaptive-ai-agent-orchestration-engine)
  - [Feature 3: Multi-Agent Planning Mode (MAPM)](#feature-3-multi-agent-planning-mode-mapm)
- [Analysis Task 3 — Complete Feature Integration](#analysis-task-3--complete-feature-integration)
- [Analysis Task 4 — Secondary Features](#analysis-task-4--secondary-features)
- [Analysis Task 5 — Unified Technical Stack](#analysis-task-5--unified-technical-stack)
- [Analysis Task 6 — VS Code Fork Base](#analysis-task-6--vs-code-fork-base)
- [Analysis Task 7 — Headroom Compression Layer](#analysis-task-7--headroom-compression-layer)
- [Analysis Task 8 — Research Contributions](#analysis-task-8--research-contributions)
- [Analysis Task 9 — Dependency and Integration Map](#analysis-task-9--dependency-and-integration-map)
- [Analysis Task 10 — Risk and Complexity Assessment](#analysis-task-10--risk-and-complexity-assessment)
- [Analysis Task 11 — Proposed Implementation Phases](#analysis-task-11--proposed-implementation-phases)
- [Readiness Declaration](#readiness-declaration)

---

## Analysis Task 1 — Core Problem Statement

### The four specific problems with current AI-powered IDEs (Cursor, Copilot, Windsurf, Claude Code)

1. **No persistent project memory.** Every chat window starts from zero. Developers must re-explain their stack, architecture, and constraints each time.
2. **Single pipeline request handling.** Every request — whether it is a "what database are we using" lookup, a multi-file refactor, or an `npm test` — is treated identically and forwarded to a single LLM with no routing, no tool selection, and no cost/latency optimisation.
3. **Single model planning.** Implementation plans come from one model, reflecting that model's specific strengths and blind spots — a single point of intellectual failure for high-stakes architectural decisions.
4. **No cross-session architectural reasoning.** Even tools that retain conversation history cannot answer questions about a *different* project opened in a different workspace, because the memory is not project-isolated and not project-structured.

### Why "session-based memory" is architecturally insufficient

Session-based memory is a chronological, unstructured log. It has at least three structural defects:

- It does not separate engineering signal from casual chatter, so retrieval returns noise along with substance.
- It has no notion of *project*, so opening a different workspace either retrieves irrelevant prior work or requires manual switching.
- It cannot answer relational or causal questions ("why was X chosen?", "what would break if we changed Y?") because those questions require a *graph* of decisions, alternatives, and rationale — not a transcript.

The pain this causes is real and recurring: developers waste the first 5–10 minutes of every new chat rebuilding context, AI assistants contradict decisions made in earlier sessions, and rejected alternatives are silently re-suggested because the system never recorded *that they were rejected and why*.

### The fundamental architectural shift CodeMind proposes

CodeMind shifts from "remember the conversation" to "remember the project." It converts every engineering-relevant utterance into a structured *fact* (with metadata: timestamp, confidence, source, author) and a *relationship* in a knowledge graph, instead of storing raw chat text. Memory is project-scoped (not session-scoped), and it is *event-driven* — the graph records not just current state but the chronological history of decisions, migrations, and rejections. The retrieval layer is hybrid (graph traversal + vector similarity), and injection is automatic, ranked, and intent-aware.

### Why CodeMind must be a VS Code fork, not an extension, plugin, or standalone tool

A conventional VS Code extension runs inside the extension host with a constrained API surface and no ability to modify the editor's chat pipeline, lifecycle, or extension host. Several of the CoreMind capabilities require deep integration that the public extension API does not permit:

- Intercepting *every* AI request before it leaves the editor and re-routing it through a custom orchestration engine.
- Hooking into chat rendering, sidebar panels, and the editor's own memory of the active workspace/file in ways that are not exposed.
- Hosting a sidebar/panel that presents multi-model debate rounds and the Decision Matrix UI natively.
- Owning the IDE's identity (logo, splash, default keybindings) so that "CodeMind" is recognisably a product, not an extension inside someone else's product.

A standalone tool would force the developer to context-switch away from the editor — defeating the goal of injecting Project Brain knowledge into *active* editing. Forking is the only option that gives the level of control needed.

### Competing products and differentiation axes

- **Cursor** — has a sophisticated agent and inline editing, but no persistent cross-session knowledge graph, no multi-model planning, and no project-isolated architectural memory.
- **GitHub Copilot** — strong autocompletion, weak memory (only repository indexing and ephemeral chat); no intelligent request routing, no multi-model planning.
- **Claude Code** — strong agentic coding but session-scoped; no project-level knowledge persistence, no collaborative planning.
- **Windsurf** — agentic flows and "Cascade" memory, but no multi-model consensus planning and no graph-backed context injection.

CodeMind's differentiation axes are: (1) *project-scoped, graph-backed, event-sourced memory*; (2) *intent-driven, modular, parallel-tool orchestration* with adaptive compression; (3) *deterministic multi-model consensus planning* with an auditable Decision Matrix; (4) a *self-reinforcing lifecycle* in which the planning output becomes memory, and the memory guides all future execution.

---

## Analysis Task 2 — The Three Core Features in Full Depth

### Feature 1: Persistent Project Brain (PPB)

**Definition.** The PPB is a continuously evolving, project-scoped knowledge graph of every engineering decision, technology choice, architectural rationale, rejected alternative, and developer preference. Unlike a chat history, it is *structured* (typed nodes + typed relationships), *project-scoped* (zero cross-contamination between workspaces), and *event-sourced* (the temporal evolution is preserved, not collapsed into the latest state).

#### The 11 detailed steps

1. **Project Identification.** Every conversation is tagged with a project ID computed from one or more of: repository path on disk, Git repository ID, workspace folder name, and a generated UUID. Output: a project tag attached to the conversation. Component: a lightweight identification service that runs at session start.
2. **Conversation Processing.** Every developer↔AI message passes through the Conversation Processing Engine. The extraction model separates engineering-relevant content from casual discussion. Input: raw message stream. Output: a candidate set of structured knowledge items.
3. **Knowledge Extraction.** Extracted knowledge is categorised into six types (Technology Stack, Architecture Patterns, Business Rules, Engineering Standards, Constraints, Developer Preferences) and tagged with metadata: unique ID, timestamp, confidence score, source conversation reference, importance score, author. Output: typed fact records with metadata.
4. **Project Knowledge Graph.** Each fact becomes a node; relationships between facts are also first-class stored. Examples of relationships: `Authentication USES Clerk`, `Database HOSTED_ON Supabase`, `Frontend DEPENDS_ON Authentication`. Output: a queryable graph in Neo4j.
5. **Decision Memory.** Decisions are stored with *reason* and *alternative* fields, plus a status (Accepted/Rejected/Superseded). The graph can answer "why did we choose X?" and "what was rejected and when?"
6. **Conflict Detection.** Newly extracted facts are compared against the graph. If a contradiction is detected (e.g. Database = MongoDB yesterday, Database = PostgreSQL today), the developer is asked to confirm. On confirmation, the old node is archived (not deleted), and the new node becomes active. Full history is preserved.
7. **Memory Ranking.** Each memory carries a dynamic relevance score recalculated at retrieval time. The signal set enumerated in the document comprises seven: Recency, Importance, Frequency, Current task, Current file, Developer intent, Project module. (Implementation should use all seven; the "six" phrasing in the prompt is a wording discrepancy in the document, not a substantive disagreement.)
8. **Automatic Context Injection.** Before any Claude Code call, the Agent queries the PPB; the top-ranked memories are injected into the prompt without any developer action. The developer never re-explains the stack.
9. **Multi-Project Memory.** Each project owns an independent PPB. Switching workspaces swaps the active brain. Global developer preferences (formatting style, conventions) remain available across projects without polluting project-specific knowledge.
10. **Continuous Learning.** Every new conversation updates the brain. New endpoints, refactors, dependency changes, business logic additions, and convention updates all become new graph nodes.
11. **Long-Term Reasoning.** Because the graph preserves full decision history with temporal context, the system can answer questions that no transcript-based system can: "Why did we choose Clerk?", "When did we migrate from MongoDB to PostgreSQL?", "Who suggested JWT and when was it rejected?", "Show all deployment decisions since project start."

#### Knowledge Graph structure

Nodes are typed engineering facts (and the project itself as a root). Relationships are typed (USES, HOSTED_ON, DEPENDS_ON, REPLACED, REJECTED_BECAUSE, etc.) and directional. This is fundamentally different from a chat log: a chat log is a sequence of strings; a graph is a queryable, traversable, reason-over structure.

#### Conflict Detection — why it is architecturally important

Silent overwriting of prior memory destroys the very thing PPB is supposed to provide — the *evolutionary history* of decisions. By surfacing the conflict, the system forces explicit developer intent and preserves the prior state as archived, supporting later causal questions ("when did we switch from X to Y and why?").

#### Memory Ranking — the seven signals

Recency, Importance, Frequency, Current task relevance, Current file context, Developer intent, Project module. These are combined at query time into a single relevance score; only the highest-ranked items are injected.

#### Automatic Context Injection

Decides what to inject by: (a) classifying the current request's intent, (b) computing the open files / active module, (c) querying the PPB with a hybrid retrieval (graph traversal from the project root + vector similarity over node embeddings), (d) ranking the results with the seven signals, (e) trimming to fit the headroom budget. All transparent to the developer.

#### Multi-Project Memory — isolation

Each project gets a discrete graph namespace; cross-project queries are gated through a "global preferences" overlay that contains only cross-cutting developer preferences, not project-specific facts.

#### Continuous Learning

Automatic, end-of-conversation extraction. The longer a developer works on a project in CodeMind, the more accurate and richer the brain becomes.

#### Long-Term Reasoning

Enables classes of question that are impossible to answer from chat transcripts: causal ("why was X chosen?"), temporal ("when did we switch?"), comparative ("what alternatives were considered?"), and counterfactual ("what would have happened if we had picked Y?").

#### Novel Research Contribution

First production implementation of an event-driven, conflict-aware, project-scoped knowledge graph that extracts structured engineering knowledge from natural language conversations, preserves the full evolutionary history of every decision, and feeds only ranked, relevant context back into AI inference.

#### Full technical stack for Feature 1

- **IDE Frontend:** VS Code Fork (TypeScript)
- **Backend:** Node.js
- **Knowledge Graph DB:** Neo4j
- **Relational Memory DB:** PostgreSQL
- **Vector Embeddings:** pgvector extension
- **Embedding model:** BGE-M3
- **Extraction model:** LLM with structured output mode
- **Retrieval strategy:** Hybrid (graph traversal + vector similarity)
- **Caching:** Redis

### Feature 2: CodeMind Agent (Adaptive AI Agent Orchestration Engine)

**Definition.** The CodeMind Agent is *not* a model — it is a deterministic orchestration engine that sits between the developer and Claude Code. Every request first enters the Agent; the Agent classifies intent, dynamically selects tools, runs them in parallel, aggregates and optimises context, compresses via Headroom, and only then forwards the optimised prompt to Claude Code.

#### The 8 detailed steps

1. **Developer Request.** Any request inside CodeMind (chat, inline command, slash action) enters the Agent first. Example intents already classified differently: code generation, web search, debugging, memory retrieval, terminal execution, documentation generation.
2. **Intent Detection Engine.** A lightweight fine-tuned classification model categorises the request. Twelve categories: Code Generation, Project Memory Retrieval, Architecture Discussion, Web Search, Git Operations, Terminal Execution, Documentation Generation, Debugging, Code Review, Testing, Project Analysis, Multi-Tool Workflow. The detected intent drives tool selection.
3. **Tool Selection Engine.** Dynamic selection from a registry. Internal tools: Persistent Project Brain, Knowledge graph query engine, Context optimization engine, Terminal interface, Repository analyzer, Git manager, Dependency analyzer. External tools: Web search, GitHub APIs, Package registries (npm, PyPI), Documentation providers, future MCP servers (as registered adapters). New tools are added by registration; the Claude Code backend does not change.
4. **Tool Execution Layer (parallel).** Selected tools run independently and, where independent, concurrently. Example: "Implement authentication using our existing architecture" triggers the Project Brain query, repository analysis, dependency analysis, and current-file analysis to run in parallel.
5. **Context Aggregation Engine.** Tool outputs are merged into a single structured engineering snapshot of the current request — project knowledge, repo state, tool outputs, and current file context.
6. **Context Optimization Engine.** Six pruning/restructuring operations: (1) remove duplicate information across tool outputs, (2) remove information irrelevant to the current request, (3) rank/order by task importance, (4) prioritise files/modules close to the developer's current focus, (5) remove redundant documentation, (6) condense conversation history to key decisions. Goal: maximum information density per token.
7. **Headroom Compression Layer.** Adaptive compression based on prompt size. Three modes: small (forwarded unchanged), medium (light compression), large (aggressive compression). Compresses: lengthy terminal outputs, repetitive conversation history, verbose documentation, structured project files — while preserving essential engineering information.
8. **Claude Code Engine.** The optimised, compressed prompt is sent to Claude Code as the primary reasoning and code generation engine. It receives a clean, information-dense, context-aware prompt.

#### Intent Detection Engine

A *lightweight fine-tuned classification model* (not a large LLM) — chosen for low latency and cost on a per-request basis. Twelve intent categories, listed above. Output is a label + confidence, which drives tool selection.

#### Tool Selection Engine

Internal vs external is a logical separation: internal tools run inside the IDE's process (no network hop, can read local files, can query local PPB/Neo4j/PostgreSQL); external tools are network-callable (web search, GitHub APIs, package registries). The Agent has a registry; adding a tool is a registration event, not a Claude Code change.

#### Parallel Tool Execution

Means wall-clock time for an N-tool request approaches the slowest single tool rather than the sum. For an "implement authentication" request with four independent tools, latency is ~max(tool_i) instead of ~Σ(tool_i).

#### Context Aggregation Engine

Builds a structured object that the rest of the pipeline can reason about: typed sections (project_knowledge, repo_state, file_context, tool_outputs, intent, ranked_relevance).

#### Context Optimization Engine

Six operations, as listed. The objective is "information density," not raw token reduction.

#### Headroom Compression Layer

Three modes triggered by prompt size thresholds. Sits after Context Optimization, before Claude Code. The document treats Headroom and the Context Optimization Engine as sequential (the latter prunes/restructures; the former compresses the survivors).

#### Relationship to Feature 1

Feature 1 is the *memory authority*; Feature 2 is the *request router* that decides when, whether, and how much of Feature 1 to use. For a memory-only request ("what database are we using"), Feature 2 short-circuits the pipeline and returns directly from the PPB. For multi-tool requests, it combines PPB with repository, dependency, file, and web context. The two are cleanly separated: PPB owns *what* is true about the project, Agent owns *what to do* with each request.

#### Novel Research Contribution

The first modular, intent-driven, parallel-tool orchestration engine for AI-assisted software development — turning the IDE from a model interface into an extensible intelligent orchestration platform.

#### Full technical stack for Feature 2

- **IDE Frontend:** VS Code Fork (TypeScript)
- **Backend:** Node.js
- **Primary AI engine:** Claude Code (Anthropic)
- **Compression backend:** Headroom
- **Intent classifier:** Lightweight fine-tuned classification model
- **Database:** PostgreSQL
- **Vector search:** pgvector
- **Knowledge graph:** Neo4j
- **Caching:** Redis

### Feature 3: Multi-Agent Planning Mode (MAPM)

**Definition.** MAPM is a dedicated planning sub-mode of CodeMind in which multiple heterogeneous AI models collaboratively design, evaluate, refine, and converge on a single unified implementation plan under the coordination of a deterministic Moderator Agent. After developer approval, the plan is stored in the PPB and used to constrain all subsequent code generation.

#### Why only in Plan Mode (Section 5.2 reasoning)

Planning benefits from multiple independent perspectives. Implementation benefits from consistency and a single voice. If multiple models independently generated production code, the codebase would fragment into inconsistent styles, naming, and architectural philosophy. So collaboration is bounded to planning; once the plan is approved, Claude Code is the sole implementation engine and follows the agreed roadmap through the Agent pipeline.

#### The 10 detailed steps (Section 5.6)

1. **Developer Request in Plan Mode.** The developer activates Plan Mode and submits a planning request (e.g. "Design a scalable authentication system for our SaaS platform"). The Multi-Agent Planning Engine dispatches to all models in the active Consensus Profile simultaneously.
2. **Parallel Prompt Distribution.** The same planning request is sent to every model in the profile concurrently. Each model independently generates its own strategy. Parallelism means N-model consultation is no slower than single-model consultation.
3. **Response Normalization.** Heterogeneous model outputs (narrative, bullet, table, diagram) are converted into a standardized engineering representation with sections: recommended architecture, technology stack (with versions), folder structure, authentication strategy, database design, API design, security approach, testing strategy, deployment approach, estimated complexity, advantages/disadvantages/risks.
4. **Moderator Agent.** A *deterministic* (not LLM) component implemented in CodeMind itself. Responsibilities: collect/compare normalized responses, detect conflicting decisions, group similar recommendations into consensus areas, identify uncovered aspects, generate concise discussion summaries, prepare prompts for the next round. Deterministic → reproducible, auditable, low-cost, no hallucination.
5. **Consensus Evaluation.** The Moderator evaluates against multiple metrics: architecture agreement, tech stack agreement, security coverage, scalability assessment, maintainability, implementation completeness, overall confidence, conflict severity. Rather than majority vote, it identifies strong-agreement areas (no further discussion), remaining-conflict areas (next round), and equally-valid alternatives (developer chooses).
6. **Iterative Planning Rounds.** If disagreement remains, another round runs. The Moderator sends only the *conflicting decisions* and a focused summary of the arguments to each model (not the full prior responses). Each model updates its proposal. Repeats until: threshold met, max rounds reached, or developer stops.
7. **Handling Model Failures.** API failures (network, rate limit, outage, timeout) are expected. The engine monitors health. A failed model is removed from subsequent rounds. If fewer than three active models remain, CodeMind switches to Comparison Mode (presents both responses for manual comparison) rather than terminating.
8. **Unified Implementation Plan.** Once sufficient agreement is reached, the Moderator emits a single roadmap containing: recommended architecture, tech stack (with versions), folder structure, implementation phases, auth/database/API decisions, security requirements, testing strategy, deployment strategy, risks/mitigations, alternative approaches considered and rejected.
9. **Decision Matrix Generation.** A structured artefact documenting every architectural choice, which model recommended it, and why alternatives were rejected. The Decision Matrix is stored in the PPB.
10. **Developer Approval.** Four actions: Approve (plan stored in PPB and becomes authoritative), Modify (developer edits specific decisions before approval), Reject (entire plan discarded, no trace), Request additional round (specific sections back to consensus), Switch Consensus Profile (different models, fresh perspective). Only approved plans enter the PPB.

#### The Moderator Agent — not an LLM

This is deliberate and architecturally important. Using another LLM as the moderator would (a) introduce hallucination risk into the consensus process, (b) be non-reproducible, (c) be expensive (LLM call per round per dimension), and (d) blur the auditability of the Decision Matrix. A deterministic moderator ensures the consensus process is a transparent algorithm, not an opaque model.

#### The Decision Matrix

A structured JSON stored in the PPB. It contains: every architectural decision, the model that recommended it, the rationale, the rejected alternatives, and the consensus score. This becomes part of the project's permanent memory and a primary input to all future code generation.

#### Consensus Profiles (Section 5.4)

Named, reusable bundles of AI models configured for a specific scenario. Four built-in:

- **Architecture Profile:** Claude + GPT + Gemini
- **Backend Profile:** Claude + DeepSeek + GPT
- **Frontend Profile:** Claude + Gemini + Qwen
- **Budget Profile:** DeepSeek + Qwen + Kimi

Developers can also create custom profiles. Supported providers: Anthropic, OpenAI, Google, OpenRouter, Azure OpenAI, and any future provider with a standard chat completion API.

#### Minimum Consensus Requirements (Section 5.5)

Dynamic based on model count:

- 1 model: standard single-model response, no consensus
- 2 models: Comparison Mode (both responses presented for manual comparison)
- 3+ models: full MAPM with automatic consensus

#### The "7 = 3(2)+1" formula

This is the document's consensus formula, partially annotated in Section 5.1. The diagram shows: prompt → 7, round 1: Good×4, Bad×3; round 2: Good×5, Bad×2; the formula n ≥ 3(F)+1 and the requirement n ≥ 66.67%. Read with the second formula at the end of Step 9: "n ≥ 3f+1; 4 ≥ 3(1)+1" — the formula expresses the minimum number of *agreement points* needed to close a round given f flaws. With f=1, you need at least 4 agreement points. The 66.67% threshold aligns with a 2/3 supermajority for cross-model consensus. The exact semantics are partially implicit in the document (the formula is shown graphically but not fully prose-explained) and should be considered an ambiguity to resolve during design.

**Architecturally, the formula determines:** the minimum number of model responses (out of N) that must converge on a given decision before it is treated as consensus and removed from the next round's discussion set.

#### Relationship to Feature 1

The approved plan is extracted into the PPB as nodes and relationships (architecture, tech stack, rejected alternatives) and as a Decision Matrix record. The PPB then serves as the authoritative context for all future code generation.

#### Relationship to Feature 2

When development begins, the developer switches from Plan Mode to Code Mode. The Agent (Feature 2) automatically retrieves the approved plan from the PPB, combines it with repository and dependency context, optimises and compresses, and forwards to Claude Code. All generated code follows the previously approved roadmap, preventing architectural drift.

#### Novel Research Contribution

First automated framework for collaborative implementation planning across multiple heterogeneous AI models, using a deterministic Moderator Agent, parallel execution, standardised response normalisation, iterative focused discussion, and a full Decision Matrix — producing higher-quality plans with auditable rationale.

#### Full technical stack for Feature 3

- **IDE Frontend:** VS Code Fork (TypeScript)
- **Backend:** Node.js
- **Model providers:** Any OpenAI-compatible API (Anthropic, OpenAI, Google, OpenRouter, Azure)
- **Parallel execution:** Concurrent API calls with health monitoring
- **Normalization Engine:** Custom TypeScript module
- **Moderator Agent:** Deterministic orchestration component (no LLM)
- **Decision Matrix:** Structured JSON stored in Project Brain
- **Plan storage:** Neo4j knowledge graph via Feature 1

---

## Analysis Task 3 — Complete Feature Integration

### The four-phase lifecycle (Section 6.1)

1. **PLANNING** — Feature 3 (MAPM) runs. Multiple AI models collaboratively produce the best implementation plan. Developer approves the roadmap.
2. **STORAGE** — Feature 1 (PPB) takes the approved plan and stores every architectural decision, technology choice, rejected alternative, and Decision Matrix entry in the Project Knowledge Graph permanently.
3. **IMPLEMENTATION** — Feature 2 (Agent) routes every code generation request through the orchestration engine, retrieves relevant PPB knowledge, optimises context, compresses via Headroom, and forwards to Claude Code. All generated code follows the approved plan automatically.
4. **CONTINUOUS LEARNING** — Feature 1 (PPB) updates. Every new conversation is processed; new decisions, refactors, and dependency changes are extracted and stored. The knowledge graph grows more accurate over time. Then the cycle repeats.

This is self-reinforcing because each phase produces the input to the next: planning produces memory, memory guides implementation, implementation produces new facts, facts update memory.

### What each feature contributes (Section 6.2)

- **Feature 1 (PPB):** Permanent project memory — all decisions, rationale, history, and relationships in a structured graph that persists across every session, chat window, and conversation.
- **Feature 2 (Agent):** Intelligent execution — routes every developer request through the correct pipeline, retrieves knowledge from PPB when needed, delivers optimised context to Claude Code efficiently.
- **Feature 3 (MAPM):** Collaborative planning — ensures every major architectural decision is made by consensus across multiple AI models with full reasoning documented in the Decision Matrix.

### Why no existing IDE offers the combination (Section 6.3)

- Cursor has no persistent cross-session project knowledge graph and no multi-model planning.
- GitHub Copilot has no persistent architectural memory and no intelligent request routing.
- Claude Code has no project-level knowledge persistence and no collaborative planning mode.
- Windsurf has no multi-model consensus planning and no knowledge-graph-backed context injection.

The document's claim is that no single product has *all three*: persistent project memory, intent-driven orchestration, *and* multi-model consensus planning. The combination — and the lifecycle that emerges from it — is the novelty.

---

## Analysis Task 4 — Secondary Features

The document lists fifteen secondary features in Section 7 and provides a deeper treatment only for F14 (Security Scanner / Semgrep). For the other fourteen, the document says they are "documented in detail in the supplementary features specification." That specification is not in the current working directory — it is referenced but not present. The following analysis is therefore based on the *names* of the features as listed and on reasonable inferences about their implementation given the Core architecture.

### Feature matrix

| # | Feature | Plain description | Depends on / benefits from core | Relative complexity | External deps |
|---|---|---|---|---|---|
| F1 | Intelligent Inline Code Review | Inline comments or annotations on code as the developer writes, identifying issues in real time | PPB (project conventions), Agent (routes review requests), MAPM (consensus on what "good" means for the project) | Medium — needs a code-aware inference path, possibly an LSP hook | Claude Code; possibly a second opinion model |
| F2 | Context-Aware Code Autocompletion | Copilot-style completions, but informed by PPB project context | PPB (project stack/conventions), Agent (intent classification for "completion" vs "generation") | Low–Medium — completion engine can leverage existing VS Code completion infrastructure, augmented by project-aware context | Claude Code; BGE-M3 for similarity over recently-edited code |
| F3 | Automated Documentation Generator | Generate docstrings, READMEs, API docs from code | PPB (terminology consistency), Agent (intent = Documentation Generation), MAPM (doc style as a planning decision) | Medium — needs AST/code parsing + structured generation | Claude Code; possibly a docs tool like TypeDoc/JSDoc |
| F4 | Smart Refactoring Engine | Cross-file refactors with verification | PPB (project structure), Agent (intent = Refactor; multi-file tools) | High — multi-file edits are intrinsically hard; need safe edit/verify loops | Claude Code; tree-sitter or language servers |
| F5 | Intelligent Error Diagnosis and Fix | When an error appears, diagnose root cause and propose a fix | PPB (project history of similar errors), Agent (intent = Debugging), MAPM (consensus on diagnosis approach) | Medium | Claude Code; terminal interface for runtime errors |
| F6 | Multi-File Contextual Edit | Edit multiple files in one coherent operation | PPB (relationship graph tells which files are coupled), Agent (intent = Code Generation, parallel tool execution) | High — must maintain transactional safety | Claude Code; file watchers, git |
| F7 | Semantic Codebase Search | Search the codebase by meaning, not just text | PPB (embeddings), Agent (intent = Project Analysis) | Low–Medium — vector search over code chunks | BGE-M3; pgvector |
| F8 | AI-Powered PR Description Writer | (Note: this appears duplicated as F12) | PPB (commit history context), Agent | Low | GitHub API; Claude Code |
| F9 | Automated Test Generation | Generate unit/integration tests | PPB (testing framework choice), Agent (intent = Testing), MAPM (testing strategy as a planning decision) | Medium | Claude Code; existing test framework |
| F10 | Code Performance Analyzer | Identify hot paths and inefficiencies | PPB (perf requirements), Agent (intent = Project Analysis) | Medium–High | Claude Code; profiling tools (Node.js inspector, etc.) |
| F11 | Code Intelligence Suite | Umbrella for go-to-definition, find-references, type-info, etc. — VS Code already has this; "suite" implies augmentation | PPB, Agent | Low (most of this is built into VS Code) | Language servers |
| F12 | PR Description Writer | Same as F8 — likely a documentation refinement | PPB, Agent | Low | GitHub API; Claude Code |
| F13 | Diagram Generator | Generate architecture/flow/sequence diagrams | PPB (architecture), Agent (intent = Documentation Generation), MAPM (architecture as planning output) | Medium | Claude Code; possibly Mermaid/PlantUML renderers |
| F14 | Security Scanner (Semgrep) | Static security analysis with inline diagnostics | Agent (intent = Security), MAPM (security as a planning decision) | Medium — Semgrep LSP integration is well-documented | **Semgrep / OpenGrep** |
| F15 | Concept Explainer | Explain a concept in context (e.g. "explain this function") | PPB (terminology), Agent (intent = Architecture Discussion) | Low | Claude Code |

### Observations from the secondary list

- F8 and F12 appear to be duplicates (both "PR Description Writer"). This is likely a documentation artefact and should be reconciled before implementation.
- The fifteen features are heavily dependent on the three core features. F2 (Autocompletion), F7 (Semantic Search), and F15 (Concept Explainer) are the lowest-effort, highest-leverage features for an FYP demo because they reuse PPB infrastructure directly.
- F14 is the only feature with a *deep-dive* section in the document, indicating it is the most thoroughly specified secondary feature.

### F14 — Security Scanner (Semgrep) Deep Dive

**How Semgrep integrates via LSP.** Semgrep publishes a Language Server Protocol implementation, `semgrep lsp`. When CodeMind opens a workspace, it spawns the `semgrep lsp` binary as a child process and speaks LSP to it over stdin/stdout. The LSP server advertises diagnostics on every file the developer opens or saves. CodeMind's VS Code fork already speaks LSP natively, so the integration is mostly: spawn process, register the server, route diagnostics to the editor's Problems panel and gutter underlines.

**`semgrep lsp` (live mode) vs `semgrep scan --json` (CLI mode).**

- **`semgrep lsp`:** live, in-editor, debounced feedback as the developer types or saves. Findings appear as underlines, hover tooltips, and Problems panel entries in real time. Designed to not block the editor.
- **`semgrep scan --json`:** batch mode. Scans the whole project, emits JSON. Used for pre-commit/CI-style checks. CodeMind would expose this as a "Run Security Scan" command that surfaces all findings project-wide in a dedicated panel.

**Bundled rulesets.** The document specifies: injection flaws, insecure deserialisation, hardcoded credentials, path traversal. These map to the OWASP Top Ten baseline. CodeMind will ship a curated Semgrep ruleset bundle rather than depending on Semgrep Registry network access (which can require authentication on paid tiers).

**OpenGrep and why it is preferred.** OpenGrep is an LGPL-2.1 fork of Semgrep, maintained by the same core team, that removes dependency on Semgrep's paid tier. Because CodeMind's value proposition is "fully local, no source code leaves the machine," using OpenGrep eliminates any risk of telemetry or paid-tier feature gates appearing. LGPL-2.1 is compatible with CodeMind's closed-source distribution (with dynamic-linking-style boundaries), making it the legally and operationally cleanest choice.

**How findings surface in the editor.**

- **Inline underlines** in the editor gutter for each finding.
- **Hover tooltips** explaining the rule and showing suggested remediation (a small code fix or a link to the rule docs).
- **Problems panel** lists all findings across the project, grouped by severity (Critical, Warning, Info).
- The Security Scanner operates as one of the Agent's registered tools — the Agent's intent classifier routes "scan for vulnerabilities" requests to the Semgrep tool, and the Agent can combine Semgrep output with PPB context (e.g. "this file is part of the auth module, which the PPB has flagged as security-critical") to prioritise findings.

---

## Analysis Task 5 — Unified Technical Stack

| Component | Technology | Why chosen | Role in CodeMind | Setup complexity / gotchas |
|---|---|---|---|---|
| **IDE Base** | VS Code Fork (microsoft/vscode) | The only way to get the level of UI/integration control required (sidebar, panel, chat, lifecycle, identity) | The host application; the entire IDE shell, extension host, chat panel, sidebar, terminal, language services | **High.** VS Code is a large monorepo (~3M LOC). Building requires Yarn, native dependencies, Gulp/esbuild, and platform-specific build steps. First build is slow (10–30 minutes). Requires Node.js 18+. macOS/Linux/Windows all supported but the build matrix is heavy. |
| **Primary Language** | TypeScript | Same language as VS Code; one type system across the fork and the new CodeMind modules | All of CodeMind's new code | None — already part of the toolchain |
| **Backend Runtime** | Node.js | VS Code's own runtime; no second runtime to ship | All agent, agent servers, MCP-style adapters, extraction engine | Already present; ensure Node 18+ |
| **Primary AI Engine** | Claude Code via Anthropic API | The document names it as the primary reasoning and code generation engine | Receives the final, optimised, compressed prompt and returns the response | **External dependency** — requires `ANTHROPIC_API_KEY`; rate limits apply; cost per token must be budgeted |
| **Multi-Model Planning** | OpenAI-compatible APIs (Anthropic, OpenAI, Google, OpenRouter, Azure) | Needed for MAPM; allows the developer to plug in their preferred providers | Each model in the active Consensus Profile | **External dependencies** — multiple API keys. OpenRouter simplifies multi-provider access to one key. Health monitoring and per-provider rate-limit handling are required. |
| **Intent Classification** | Lightweight fine-tuned classification model | Needs to be fast and cheap on every request; a large LLM is overkill | Per-request intent labelling | The document doesn't specify the model architecture. Inferred: a small fine-tuned model (e.g. a 100M–1B parameter text classifier) hosted locally or via a cheap API. Training data would be (request, intent) pairs derived from labelled examples or distilled from a larger LLM. |
| **Knowledge Graph Database** | Neo4j | Best-of-breed graph DB with Cypher query language; ideal for project relationships and traversals | Stores the PPB; queried by Feature 1 and Feature 2 | **High setup.** Neo4j must run as a local service (Docker, system install, or embedded). Requires Java. Default port 7687 (Bolt) and 7474 (HTTP). For FYP dev: a single-node Neo4j Docker container is simplest. |
| **Relational Memory Database** | PostgreSQL | Stores structured memory records, fact metadata, extraction logs, and (via pgvector) embeddings | All persistent state except the graph | **High setup.** PostgreSQL 14+ required. The `pgvector` extension must be installed (CREATE EXTENSION vector). Single-node local install is fine for dev. |
| **Vector Embeddings** | pgvector extension | Vector search integrated with the relational store, avoiding a separate vector DB | Embedding similarity search during retrieval | Adds an extension step to PostgreSQL setup; index type (HNSW vs IVFFlat) must be chosen |
| **Embedding Model** | BGE-M3 | A strong, multilingual, open-source embedding model (BAAI) — high quality, local-runnable | Generates embeddings for memory nodes and for semantic search (F7) | Runs locally or via API. BGE-M3 produces 1024-dim vectors. If local, GPU optional but recommended. ~2.3GB model. |
| **Extraction Model** | LLM with structured output mode | Produces typed fact records from raw conversation | Conversation Processing + Memory Extraction | Could be Claude Code itself, a separate Claude call, or a cheaper model. Structured output mode (JSON schema constrained) is required for reliable fact extraction. |
| **Retrieval Strategy** | Hybrid: graph traversal + vector similarity search | Pure vector search misses structural relationships; pure graph misses semantic similarity. Hybrid is the current SOTA for RAG | Feature 1 retrieval; Feature 2's PPB query path | Combines Cypher queries against Neo4j with vector search against pgvector. The orchestration of "graph first then vector" vs "parallel and merge" is a design decision. |
| **Context Compression** | Headroom compression layer | The document's adaptive compression layer for Feature 2 | Reduces token cost; enables more context per request | Custom-built. Sits inside the Agent. Three modes based on prompt size thresholds. |
| **Caching Layer** | Redis | Standard fast key-value cache | Caches: extraction results, frequent PPB queries, model responses for identical prompts, rate-limit counters | Runs as a local service. Redis 7+ recommended. |
| **Security Scanning** | Semgrep / OpenGrep | Mature, fast, LSP-capable static analysis with strong rule ecosystem | F14 Security Scanner | Spawned as LSP child process (`semgrep lsp`); also as CLI (`semgrep scan --json`) for batch. OpenGrep preferred (LGPL-2.1, no paid tier). |

---

## Analysis Task 6 — VS Code Fork Base

### What `microsoft/vscode` contains

VS Code is a large TypeScript/Node.js monorepo. Subsystems relevant to CodeMind:

- **Extension Host:** A separate Node.js process that runs extensions in isolation. CodeMind's own extensions (if any) would live here, but the *core* CodeMind logic must be inside the main process to intercept requests at the chat layer.
- **Language Server Protocol (LSP):** Built-in LSP client. Used for Semgrep, TypeScript, Python, etc. Already speaks JSON-RPC.
- **Chat Panel:** VS Code has a built-in chat UI (Copilot Chat). CodeMind's chat must be a *replacement* (or a deeply customised fork of this panel), because intercepting "every AI request" requires ownership of the request lifecycle.
- **Copilot Integration Points:** VS Code's Copilot extension is itself a TypeScript extension that registers chat participants, slash commands, and inline editors. CodeMind can study these as integration patterns, but to truly intercept every request, the fork must own the chat pipeline.
- **Webview:** VS Code's webview hosts rich HTML/JS UIs inside the editor. CodeMind can use webviews for the Decision Matrix UI, the Plan Mode debate panel, and the Memory Inspector.
- **Sidebar:** A native sidebar container. CodeMind's "Memory," "Plan Mode," and "Security" views would be sidebar panels registered with `vscode.window.createTreeView` or as webview views.
- **Terminal:** A full PTY-based terminal inside the editor. The Agent's "Terminal Execution" intent can dispatch through this.
- **Diagnostics API:** `vscode.languages.createDiagnosticCollection` — the API used to surface Semgrep findings as inline underlines and in the Problems panel.

### Fork vs Extension — why CodeMind must fork

- Extensions are sandboxed in the extension host. They can register commands, views, and chat participants, but they *cannot*: rewrite VS Code's identity, deeply modify the chat pipeline, intercept every request before it leaves the editor, or replace the Copilot chat panel wholesale.
- The "every request" interception requirement of the Agent and the "every conversation" extraction requirement of the PPB demand hooks that the public extension API does not expose.
- A fork also gives CodeMind its own branding, splash, and product identity — important for an FYP demo.

### Where each feature's modifications will live in the fork

#### Feature 1 (PPB)

- The Conversation Processing Engine and Memory Extraction Engine would be a new module under `src/vs/workbench/contrib/codemind/brain/` (a new "contrib" contribution).
- The extraction trigger would hook into the chat panel's response lifecycle (every assistant response is passed to the extraction engine before being shown).
- The Conflict Detection and Memory Ranking engines live in the same module but are invoked both at extraction time and at retrieval time.
- The Context Retrieval Engine is invoked by the Agent (Feature 2) before each Claude Code call.
- The PPB's storage adapters (Neo4j driver, PostgreSQL/pgvector client) live in `src/vs/workbench/contrib/codemind/storage/`.
- The "Memory Inspector" sidebar view is a `TreeView` showing the current project's key facts and decisions.

#### Feature 2 (Agent)

- The Agent intercepts requests inside the chat panel's `requestHandler` (in the modified Copilot-like code).
- The Intent Detection Engine is a small inference call (local classification model or cheap API).
- The Tool Selection Engine is a registry; tools are registered at IDE startup.
- The Tool Execution Layer is a parallel-execution coordinator (Promise.all over independent tool invocations).
- The Context Aggregation, Context Optimization, and Headroom Compression layers are sequential transforms.
- The final call to Claude Code uses the existing chat backend, but with the Agent's optimised prompt substituted for the raw request.

#### Feature 3 (MAPM)

- The Plan Mode UI lives in a new webview view in the sidebar (e.g. `codemind.planModeView`).
- The Plan Mode toggle is a status-bar item or a chat command (`/plan`).
- The Multi-Agent Planning Engine is a new service in `src/vs/workbench/contrib/codemind/planning/`.
- The Consensus Profile manager is a settings UI.
- The Moderator Agent is a deterministic TypeScript module (no LLM call).
- The Decision Matrix is a structured JSON view rendered in a webview.
- Approved plans are written to the PPB via the same storage path as Feature 1.

### Language Server Protocol (LSP) for Semgrep

LSP is a JSON-RPC-based protocol where a *client* (the editor) and a *server* (the language tool) communicate over stdin/stdout, TCP, or named pipes. The server advertises capabilities (diagnostics, hover, code actions, completion). The client sends `textDocument/*` notifications when files open, change, or save. The server pushes `textDocument/publishDiagnostics` with findings. VS Code has a built-in LSP client; CodeMind can use it to host Semgrep by spawning `semgrep lsp` as a child process and registering it via `vscode.languages.registerLanguageClient` (or by forking the LSP client code if customisation is needed).

### Relevant VS Code APIs

- `vscode.workspace` — workspace folders, file watchers, configuration, text documents, onDidChange events.
- `vscode.window` — webview panels, tree views, status bar, terminals, output channels, information messages.
- `vscode.languages.registerCodeActionsProvider` — register quick fixes / refactor actions (used for F4, F6).
- `vscode.languages.createDiagnosticCollection` — surface Semgrep findings (F14).
- `vscode.chat.createChatParticipant` — the modern API for contributing to the chat panel (used for `/plan`, `/review`, etc.).
- `vscode.commands.registerCommand` — register slash commands and keybindings.
- `vscode.ExtensionContext` — passed to every extension; provides secrets storage, globalState, workspaceState, subscriptions.

### Build tools

- **Yarn** — VS Code uses Yarn 1.x workspaces for monorepo dependency management. CodeMind's fork will inherit this.
- **Gulp** — VS Code's task runner for source compilation, asset bundling, and platform packaging.
- **esbuild** — Used internally by VS Code for fast TypeScript bundling.
- **Node.js 18+** — required to build and run.
- **Mono-repo layout** — `src/` (main process), `extensions/` (built-in extensions), `src/vs/workbench/contrib/` (the place to add new "contrib" modules for CodeMind).
- **Out-of-source build** — VS Code's source is in `src/`; the build emits to `out/` and the launched binary loads from there. Watch mode (`yarn watch`) is supported.

### OS / runtime constraints

- macOS, Linux, and Windows all supported.
- Building on Windows requires Visual Studio Build Tools (for native modules like `node-pty`, `spdlog`, `keytar`).
- For FYP dev, Linux or macOS is the path of least resistance; Windows works but native-build setup is more involved.
- Node.js 18+ is required (VS Code dropped Node 16 in 1.80+).

---

## Analysis Task 7 — Headroom Compression Layer

### Purpose

Headroom is the document's name for the adaptive context-compression layer that sits between the Context Optimization Engine and the Claude Code engine in the Agent pipeline. Its purpose is to ensure that the prompt sent to Claude Code is information-dense, fits the available context window, and is cost-efficient.

### The three compression modes

- **Small prompts** — Forwarded unchanged. If the optimised context is already small, compression is unnecessary and would only lose detail.
- **Medium prompts** — Light compression applied. The system removes redundancy, condenses verbose documentation, and trims long terminal outputs without losing essential engineering information.
- **Large prompts** — Aggressive compression applied. The system summarises conversation history, compresses structured project files, distils terminal output to errors+warnings+summary, and condenses repetitive patterns. Engineering-essential information is preserved.

The trigger is *prompt size*, not *prompt type*. The thresholds are not numerically specified in the document (a design ambiguity to resolve).

### What Headroom compresses

- Lengthy terminal outputs (truncate to errors, warnings, and a final summary).
- Repetitive conversation history (extract decisions only).
- Verbose documentation (condense to API surface + usage examples).
- Structured project files (keep type definitions, drop implementations; or keep high-level architecture, drop low-level details).

### Interaction with the Context Optimization Engine

The two are *sequential*, not the same thing. The Context Optimization Engine *prunes and restructures* — it removes duplicates, removes irrelevance, ranks by importance, and prioritises by focus. The output is a still-information-complete but smaller snapshot. Headroom then *compresses* the survivors — it transforms verbose representations into dense ones (summarisation, tokenisation-aware truncation, structured compression). The two are complementary: pruning decides *what* to keep, Headroom decides *how to say* what is kept.

### Conceptual TypeScript/Node.js implementation shape

A Headroom module would expose a `compress(context: AggregatedContext, options: CompressionOptions): CompressedContext` function. Internally:

- A `Tokenizer` (using a model-specific tokenizer like `@anthropic-ai/tokenizer` or `tiktoken`) to count tokens.
- A `SizeClassifier` that labels the input as small/medium/large against configurable thresholds.
- A set of `Compressor` strategies per content type: `TerminalOutputCompressor`, `ConversationHistorySummarizer`, `DocumentationCondenser`, `ProjectFileCompressor`.
- A `CompressionPipeline` that runs the strategy for each section of the aggregated context, then assembles the final compressed prompt.
- A `TokenBudgetGuard` that fails safe (returns the original) if compression would lose more than a configurable amount of essential content.

The key design property: Headroom is *content-aware*. It does not blindly truncate; it knows that a terminal output is compressible to errors+summary, that documentation is compressible to API surface, and that architecture decisions are not compressible at all.

### Where Headroom sits in the request pipeline

After Context Aggregation, after Context Optimization, before Claude Code. The order is:

```
Developer → Agent (intent detect) → Tool Selection → Parallel Tool Execution
→ Context Aggregation → Context Optimization → HEADROOM → Claude Code → Developer
```

Headroom is the *last* transformation before the LLM call. It is the final gatekeeper of token cost.

---

## Analysis Task 8 — Research Contributions

### Contribution 1 — Persistent Project Brain

- **Novelty:** The first production implementation of a continuously evolving project knowledge graph that extracts structured engineering facts from natural language developer conversations, detects conflicts, preserves full evolutionary history, and injects only ranked, relevant knowledge into future AI interactions.
- **Improves upon:** Existing AI IDEs that retain raw chat history (no structure, no project scoping, no ranking, no event-sourcing).
- **Verification:** Demo: open a project, have a conversation that records "we use Clerk," close the IDE, reopen a week later, ask "what authentication are we using" — receive the correct answer from memory. Counter-demo: ask a competing IDE the same question — receive "I don't have context for this project."
- **Tests:** Conflict detection tests (e.g. MongoDB → PostgreSQL migration); ranking tests (top-N relevance); multi-project isolation tests; extraction schema compliance tests.

### Contribution 2 — Event-Driven Project Memory

- **Novelty:** Beyond storing facts about the current state, the PPB stores *events* — dated records of when each decision was made, when alternatives were rejected, when migrations occurred. This enables causal and historical reasoning no current memory system supports.
- **The difference between storing facts and storing events:** A fact is a present-tense statement ("we use Clerk"). An event is a temporal record ("on Day 1 we added Clerk, on Day 10 we rejected Auth.js, on Day 24 we migrated to Better Auth, on Day 31 we moved to AWS"). With facts alone you know the state; with events you know the trajectory. The trajectory is what enables "why did we choose X?" and "when did we switch from Y to Z?"
- **Verification:** Ask a 6-month-old project "who suggested JWT and when was it rejected?" — receive a precise date and rationale.
- **Tests:** Event chronological ordering; event provenance; event retrieval queries.

### Contribution 3 — Adaptive AI Agent Orchestration

- **Novelty:** The first modular, intent-driven orchestration engine for AI-assisted software development. Rather than forwarding every request through a single pipeline, the CodeMind Agent classifies intent, selects tools dynamically, runs them in parallel, optimises the aggregated context, and compresses it adaptively before Claude Code inference. New tools are added as registered adapters without changing the AI backend.
- **Improves upon:** Existing AI IDEs that have a single, static, request-handling pipeline.
- **Verification:** Demo: for a "what database are we using" request, the Agent bypasses most of the pipeline and returns in <1s from PPB alone. For a "search Clerk pricing and update auth module" request, the Agent runs three tools in parallel and delivers an integrated result. Show that adding a new tool is a 10-line registration change, not a Claude Code change.
- **Tests:** Intent classification accuracy; parallel-execution latency benchmarks; cost-per-request benchmarks vs baseline; tool registration round-trip.

### Contribution 4 — Multi-Model Consensus Planning

- **Novelty:** The first automated framework for collaborative implementation planning across multiple heterogeneous AI models. Uses a deterministic Moderator Agent, parallel execution, standardised response normalisation, iterative focused discussion rounds, and a full Decision Matrix — producing higher-quality plans than any single model can achieve alone.
- **Improves upon:** The current developer workflow of manually pasting the same question into multiple model UIs and synthesising the answers.
- **Verification:** Demo: submit a planning request with 4 models; show three rounds; show the final unified plan and the Decision Matrix; show that one architecture was rejected with a specific reason recorded.
- **Tests:** Moderator determinism (same inputs → same outputs); Decision Matrix schema compliance; failure-handling (one model down → system continues); consensus threshold correctness.

### Contribution 5 — Unified Intelligent Development Lifecycle

- **Novelty:** The *combination* of persistent memory, intelligent orchestration, and collaborative planning into a single integrated platform. The lifecycle (Planning → Storage → Implementation → Continuous Learning → repeat) is itself the contribution.
- **Improves upon:** No existing tool provides all three; tools are piecemeal. The lifecycle emerges only from the integration.
- **Verification:** End-to-end demo: a developer activates Plan Mode, three models plan a feature, the developer approves, the plan is stored, the developer switches to Code Mode and asks for an implementation, the Agent retrieves the plan from PPB, Claude Code generates code that follows the approved architecture. Close the IDE. Reopen it months later. The plan is still in the brain; the architecture is still respected.

---

## Analysis Task 9 — Dependency and Integration Map

### Which feature must be built first

The document makes this explicit in Section 6.1's lifecycle and Section 5.7's integration note: **Feature 1 (PPB) is the foundation.** Both Feature 2 and Feature 3 depend on it. Feature 2 uses PPB as one of its tools. Feature 3 stores its output in PPB. Building PPB first means everything else has a place to write to and read from.

### External services CodeMind will communicate with at runtime

- **Anthropic API** (Claude Code) — primary LLM.
- **OpenAI API** (GPT) — used in MAPM Consensus Profiles.
- **Google AI API** (Gemini) — used in MAPM Consensus Profiles.
- **OpenRouter API** — optional unified gateway for multiple providers.
- **Azure OpenAI Service** — optional alternative for OpenAI models.
- **DeepSeek, Qwen, Kimi APIs** — used in Budget Profile; details not in the document but inferable.
- **Web search provider** (e.g. Tavily, SerpAPI, Bing) — for the Agent's Web Search tool.
- **GitHub API** — for Git Operations and PR Description Writer.
- **Package registries (npm, PyPI)** — for the Dependency analyzer and documentation lookup.
- **Documentation providers** — various; details not specified.

### Databases and services that need to be running locally for the IDE to function

- **Neo4j** — Knowledge graph storage.
- **PostgreSQL with pgvector** — Relational memory + vector embeddings.
- **Redis** — Caching.
- **BGE-M3** — either a local model server or a remote API.
- **Semgrep / OpenGrep** (for F14) — spawned as a child process; no separate service.

### Processes that need to run alongside the IDE

- Neo4j (Bolt + HTTP).
- PostgreSQL with pgvector.
- Redis.
- (Optional) BGE-M3 inference server if not bundled.
- Semgrep LSP child process per workspace.

### API keys / credentials needed

- `ANTHROPIC_API_KEY` — required for Claude Code.
- `OPENAI_API_KEY` — required if any Consensus Profile uses GPT.
- `GOOGLE_API_KEY` — required if any Consensus Profile uses Gemini.
- `OPENROUTER_API_KEY` — optional, simplifies multi-provider access.
- `AZURE_OPENAI_*` — optional.
- Provider keys for DeepSeek / Qwen / Kimi — optional, only needed for Budget Profile.
- Web search provider key.
- GitHub token (for PR features).
- (Local-only credentials for Neo4j, PostgreSQL, Redis if auth is enabled — typically not required for local dev).

### Circular dependencies

None strictly circular, but there is a tight coupling: Feature 2 calls Feature 1 for context retrieval; Feature 3 stores its output in Feature 1; Feature 1's extraction is fed by Claude Code (Feature 2's downstream). The "extraction uses Claude Code" detail is *inferred* (the document says "extraction model" is "an LLM with structured output mode" but does not name it explicitly). If extraction uses the same Claude Code instance, there is a runtime concern: the extraction call must not block the developer's main interaction. This is solvable by running extraction as a background job on conversation completion.

### Minimum viable setup for Feature 1 to work

1. Clone the VS Code fork (not yet done).
2. Install Node.js 18+, Yarn, build tools.
3. Stand up Neo4j (Docker: `docker run -p 7474:7474 -p 7687:7687 -e NEO4J_AUTH=none neo4j`).
4. Stand up PostgreSQL with pgvector (Docker: `pgvector/pgvector:pg16`).
5. Stand up Redis (Docker: `redis:7`).
6. Implement the smallest possible Conversation Processing → Memory Extraction → Knowledge Graph write path.
7. Implement a chat-panel interceptor that triggers extraction on every assistant response.
8. Implement a basic Memory Inspector sidebar that lists the extracted nodes.
9. Wire a `/recall <query>` slash command that queries the graph and displays the result.

This is the absolute minimum to "open CodeMind, have a conversation, see memory grow, and retrieve it later."

---

## Analysis Task 10 — Risk and Complexity Assessment

### Per-feature risks

#### Feature 1 (PPB) — Risks

- **Highest-risk technical challenge:** **Extraction quality.** The extraction model must reliably separate engineering signal from casual chatter, classify facts into the six categories, and assign accurate confidence scores. If extraction is noisy, the brain fills with junk. If extraction is too conservative, the brain stays empty. There is no way to "tune" this in real time — it is a quality bar set by the prompt design of the extraction model and the labelling of training data.
- **Most complex data flow:** Hybrid retrieval. Graph traversal from the project root + vector similarity over node embeddings + ranking across seven signals + result assembly, all on a per-request hot path.
- **What could break silently:** Conflict detection false negatives (a subtle contradiction is missed and the brain becomes inconsistent). Memory ranking drift (a memory that was highly relevant yesterday becomes a permanent context-bleeder today).
- **Most external dependency:** The extraction LLM (Anthropic or other) and the BGE-M3 embedding model.
- **Testing strategy:** Unit tests for the extraction schema compliance; integration tests for the graph write/read round-trip; replay tests that run extraction against recorded conversations and verify the resulting graph state; property-based tests for ranking stability.

#### Feature 2 (Agent) — Risks

- **Highest-risk technical challenge:** **Intent classification accuracy.** A wrong intent label routes the request to the wrong pipeline and degrades the response. A "what database are we using" request mislabelled as "code generation" would trigger a full Claude Code call instead of a fast PPB lookup.
- **Most complex data flow:** Parallel tool execution with timeout/health handling, followed by aggregation, optimization, and compression, all on a per-request critical path.
- **What could break silently:** A new tool registered with the wrong schema silently degrades tool selection. A bug in the Context Optimization Engine silently drops the most relevant information.
- **Most external dependency:** All the registered tools (PPB, web search, GitHub, package registries, Semgrep).
- **Testing strategy:** Unit tests for the registry; integration tests for each tool with a mock backend; golden tests for the optimization pipeline (given fixed tool outputs, the optimised context should be deterministic); latency benchmarks vs baseline.

#### Feature 3 (MAPM) — Risks

- **Highest-risk technical challenge:** **Deterministic Moderator Agent correctness.** The Moderator must reliably identify conflicts, group consensus, and prepare focused discussion summaries. A bug here silently leads to wrong consensus or runaway round counts.
- **Most complex data flow:** Parallel model execution with per-model health monitoring + response normalisation + iterative round management + Decision Matrix generation.
- **What could break silently:** Two models converging on the wrong consensus because the Moderator's conflict detection is too lenient. A model provider silently returning cached/stale responses (defeating the "fresh perspective" of each round).
- **Most external dependency:** Multiple model providers, each with their own rate limits, latency, and response-format quirks. If one provider has an outage, MAPM must degrade gracefully.
- **Testing strategy:** Unit tests for the Moderator (deterministic, exhaustive over synthetic response sets); integration tests for each provider with mock APIs; round-trip tests for the Decision Matrix schema; failure-injection tests (kill a provider mid-round, verify the system degrades to Comparison Mode).

#### F14 (Semgrep) — Risks

- **Highest-risk technical challenge:** **LSP lifecycle management.** Spawning `semgrep lsp` correctly, recovering from crashes, handling workspace reopens, debouncing diagnostics.
- **What could break silently:** A Semgrep rule that fires false positives, drowning the Problems panel in noise. Slow scans on large codebases.
- **Most external dependency:** OpenGrep binary availability and version compatibility with bundled rulesets.
- **Testing strategy:** Unit tests for the LSP bridge; integration tests on sample vulnerable code; false-positive rate measurement against a labelled corpus.

### Team-relative complexity

**Two-person student team over an FYP timeline.** Realistic order:

1. **Phase 0:** Fork + build + infrastructure (1–2 weeks). Pair: one on fork/build, one on infrastructure.
2. **Phase 1:** PPB (4–6 weeks). Pair: one on extraction + graph storage, one on context retrieval + UI.
3. **Phase 2:** Agent (3–4 weeks). Most of the work is integration; pair: one on intent classification + tool registry, one on optimization + Headroom.
4. **Phase 3:** MAPM (3–4 weeks). Pair: one on moderator + normalisation, one on Consensus Profiles + UI.
5. **Phase 4:** Secondary features (3–4 weeks). Parallelise: one on Semgrep + F7, one on F2/F3/F15.
6. **Phase 5:** Polish + demo + documentation (2–3 weeks).

Total: 16–23 weeks. FYP timelines are typically one academic year (two semesters), so this is feasible with a buffer.

### FYP milestones mapping to demonstrable features

- **Milestone 1 (end of Phase 1):** Demo: open CodeMind on a sample project, have a multi-turn conversation about the project, close the IDE, reopen, ask a question, get the correct answer from memory.
- **Milestone 2 (end of Phase 2):** Demo: a complex multi-tool request (e.g. "search Clerk pricing and update our auth module") completes with parallel tool execution, optimised context, and the response follows the project's existing architecture from PPB.
- **Milestone 3 (end of Phase 3):** Demo: a planning session with 3+ models produces a unified plan + Decision Matrix; the plan is stored in PPB; subsequent code generation follows the plan.
- **Milestone 4 (end of Phase 4):** Full demo of all features including Semgrep inline findings, semantic search, autocompletion with project context, and a Concept Explainer.
- **Final submission:** All documentation, recorded demo video, codebase.

---

## Analysis Task 11 — Proposed Implementation Phases

### Phase 0: Environment and Base Fork Setup

**Goal:** A building, launching, identifiable CodeMind IDE binary on a developer machine.

**Steps:**

- Verify Node.js 18+, Yarn, Git, Docker are installed.
- Clone `https://github.com/microsoft/vscode` into a working directory.
- Rename the product, change the application name, splash, and product.json to "CodeMind."
- Verify `yarn` and `yarn watch` work; verify the resulting binary launches.
- Stand up infrastructure via Docker Compose:
  - Neo4j (ports 7474, 7687).
  - PostgreSQL 16 + pgvector (port 5432).
  - Redis 7 (port 6379).
- Create a `src/vs/workbench/contrib/codemind/` directory for all new CodeMind modules.
- Define the connection configuration UI (settings) for Neo4j, PostgreSQL, Redis, and provider API keys. Use VS Code's SecretStorage API for keys.
- Define the high-level module skeleton: `src/vs/workbench/contrib/codemind/{brain, agent, planning, security, storage, common}/`.

**Exit criteria:** Launching the fork shows the CodeMind identity; an internal "CodeMind: Check Connection" command reports all three services reachable.

### Phase 1: Persistent Project Brain (Core Foundation)

**Goal:** A working PPB that extracts, stores, retrieves, and injects structured knowledge from chat conversations.

**Steps:**

- Define the data model: Fact, Relationship, Event, Project, DeveloperPreference, Conflict, DecisionMatrixEntry. Define Cypher schema for Neo4j and SQL schema for PostgreSQL.
- Implement the Project Identification service (workspace → project ID).
- Implement the Conversation Processing Engine: hook into the chat panel's response lifecycle; on each assistant turn, send the message pair to the extraction model with a structured-output prompt.
- Implement the Memory Extraction Engine: extraction model produces typed facts with metadata; pass to the storage layer.
- Implement the Knowledge Graph writer (Neo4j driver).
- Implement the Conflict Detection Engine: on each new fact, query the graph for contradictions; if found, surface a `vscode.window.showInformationMessage` confirmation; on confirmation, archive old + activate new.
- Implement the Memory Ranking engine: the seven signals combined into a relevance score; recomputed on every retrieval.
- Implement the Context Retrieval Engine: hybrid query (graph traversal + vector similarity) with ranking; result is a top-N list of facts.
- Implement the Memory Inspector sidebar (TreeView): shows current project's key facts, decisions, and recent events.
- Implement the `/recall <query>` chat command: queries the brain, displays the result inline.
- Wire automatic context injection: on every Claude Code call, the Agent calls the retrieval engine and injects the top-N facts into the prompt.
- Tests: extraction schema, conflict detection, ranking stability, multi-project isolation, round-trip retrieval.

**Minimum working version:** A conversation in CodeMind extracts at least three facts (framework, database, auth) into the graph; the `/recall` command retrieves them; the memory inspector shows them; the next chat session (after restart) auto-injects them.

**APIs to define before coding:**

- `IProjectBrain.extract(conversation: Conversation): Promise<ExtractionResult>`
- `IProjectBrain.retrieve(query: RetrievalQuery): Promise<RankedFacts>`
- `IProjectBrain.recordEvent(event: Event): Promise<void>`
- `IProjectBrain.detectConflict(fact: Fact): Promise<ConflictReport | null>`

### Phase 2: CodeMind Agent (Orchestration Layer)

**Goal:** Every developer request is intercepted, classified, routed, optimised, and compressed before reaching Claude Code.

**Steps:**

- Implement the Intent Detection Engine. Start with a small fine-tuned classifier (e.g. distilled from Claude on labelled examples, or a hosted small model); fall back to a regex/heuristic baseline during early dev.
- Implement the Tool Selection Engine and the tool registry. Each tool implements a common interface: `name`, `description`, `intents[]`, `execute(input): Promise<output>`. The registry stores the set.
- Register the first tools: Project Brain query, Repository analyzer (file lister + head reader), Terminal interface, Git manager (status/diff/log).
- Implement the Tool Execution Layer: Promise.all over independent tools, with per-tool timeouts and error handling.
- Implement the Context Aggregation Engine: builds a typed AggregatedContext.
- Implement the Context Optimization Engine: the six operations.
- Implement Headroom: the three-mode adaptive compression layer.
- Wire the Agent into the chat panel: every chat request first goes through Agent; the optimised, compressed prompt is what reaches Claude Code.
- Add observability: a debug panel showing the detected intent, selected tools, optimization actions, and Headroom mode for each request.
- Tests: intent classification accuracy on a labelled set; tool selection on a synthetic intent set; latency benchmarks; cost benchmarks; tool registration round-trip.

**Minimum working version:** "What database are we using?" is answered in <500ms from PPB without calling Claude Code. "Implement authentication" runs 4 tools in parallel and delivers an architecture-aware response. The debug panel shows the routing decisions.

### Phase 3: Multi-Agent Planning Mode

**Goal:** A working Plan Mode that convenes multiple models, normalises responses, runs moderator-driven consensus, and produces an approved plan stored in PPB.

**Steps:**

- Implement the Consensus Profile manager (settings UI + active profile selector).
- Implement the Multi-Agent Planning Engine: dispatches the same prompt to all models in the profile in parallel; collects responses with health monitoring.
- Implement the Response Normalization Engine: parses heterogeneous model outputs into a standardised engineering representation with the ten sections.
- Implement the Moderator Agent: deterministic TypeScript module. Implements: collect responses, detect conflicts, group consensus, identify gaps, prepare focused discussion summaries, compute consensus scores against the eight metrics.
- Implement the round-management loop: send focused summary to all models, collect updated proposals, re-evaluate, repeat until threshold met / max rounds / developer stops.
- Implement failure handling: if a model fails, remove from round; if fewer than 3 active, switch to Comparison Mode.
- Implement the Decision Matrix generator: structured JSON, rendered in a webview panel.
- Implement the developer approval flow: Approve / Modify / Reject / Request additional round / Switch profile.
- On approval, write the plan and Decision Matrix into the PPB (extracted as nodes + relationships + Decision Matrix record).
- Implement the Code Mode integration: when the developer switches from Plan Mode to Code Mode, the Agent automatically retrieves the approved plan and injects it into the context.
- Tests: Moderator determinism; Decision Matrix schema; round-trip; failure injection; consensus threshold correctness.

**Minimum working version:** A 3-model planning session completes in ≤3 rounds; the final plan is approved; the Decision Matrix is stored; the next code generation request in Code Mode uses the plan as authoritative context.

**Architectural formula note:** The "7 = 3(2)+1" formula in the document is partially implicit. The exact semantics — likely "a decision requires at least n = 3f + 1 votes where f is the number of remaining conflicts at that decision" — should be re-derived during the design phase, since the document presents it graphically but not in full prose.

### Phase 4: Secondary Features

**Goal:** Complement the core with high-value, low-effort secondary features.

**Order (lowest effort to highest):**

- F7 (Semantic Codebase Search) — low effort; reuses BGE-M3 + pgvector from PPB.
- F15 (Concept Explainer) — low effort; Agent intent = Architecture Discussion.
- F2 (Context-Aware Autocompletion) — medium effort; augments VS Code's completion provider with PPB context.
- F3 (Documentation Generator) — medium effort; uses Agent + Claude Code with intent = Documentation.
- F13 (Diagram Generator) — medium effort; uses Claude Code to produce Mermaid/PlantUML; renders in webview.
- F5 (Error Diagnosis) — medium effort; integrates with terminal output.
- F9 (Test Generation) — medium effort; uses Claude Code with intent = Testing.
- F4 (Smart Refactoring) — high effort; multi-file coordinated edits; consider deferring to post-FYP.
- F6 (Multi-File Contextual Edit) — high effort; share infra with F4; consider deferring.
- F10 (Code Performance Analyzer) — high effort; requires profiling integration; consider deferring.
- F11 (Code Intelligence Suite) — largely inherited from VS Code; low incremental effort.
- F1 (Inline Code Review) — medium effort; hook into editor's review surface.
- F8/F12 (PR Description Writer) — low effort; GitHub API + Claude Code; resolve the F8/F12 duplication before implementation (likely a single feature).

**Semgrep/OpenGrep integration (F14):**

- Add OpenGrep as a build dependency; bundle a curated ruleset (OWASP Top Ten: injection, insecure deserialisation, hardcoded credentials, path traversal).
- Implement an LSP client that spawns `semgrep lsp` (OpenGrep binary) as a child process when a workspace opens.
- Register Semgrep findings as `Diagnostic[]` via `vscode.languages.createDiagnosticCollection`.
- Surface findings as inline underlines, hover tooltips, and in the Problems panel grouped by severity.
- Expose a "Run Full Security Scan" command that uses `semgrep scan --json` and presents a project-wide report.
- Add Semgrep as a registered Agent tool: when the developer asks "scan this file for security issues," the Agent routes to Semgrep and combines findings with PPB context.
- Tests: LSP round-trip; ruleset application; false-positive rate; CLI batch mode.

### Phase 5: Integration, Polish, and FYP Submission

**Goal:** A complete, demoable, documented CodeMind.

**End-to-end demo session:**

1. Developer opens a sample e-commerce SaaS project in CodeMind.
2. Developer activates Plan Mode; submits "Design a scalable authentication system."
3. Three models propose architectures; the Moderator runs two rounds; the developer approves the plan with Clerk.
4. The plan is stored in PPB; the Decision Matrix is rendered in the sidebar.
5. Developer switches to Code Mode; asks "Implement login with our approved architecture."
6. Agent runs Project Brain + repository + dependency tools in parallel; injects the approved plan; Claude Code returns architecture-consistent code.
7. Developer saves the file; Semgrep highlights no findings (because the implementation followed the plan).
8. Developer closes the IDE; reopens it two weeks later; asks "Why did we choose Clerk?" — receives the answer from PPB with date and rationale.
9. Developer opens a *different* project; the previous project's memory is not retrieved.
10. Developer returns to the original project; types `npm test`; the Agent's terminal tool runs it.

**Documentation as FYP submission:**

- Project Report (PDF): problem statement, literature review, architecture, implementation, evaluation, future work.
- Architecture Decision Records (ADRs) for each major design choice.
- API reference for the public CodeMind extension/contrib interfaces.
- User manual with screenshots.
- Recorded demo video.
- Source code on GitHub.
- Test suite report with coverage metrics.
- Performance benchmarks: latency, cost, accuracy, memory growth over time.

**Open ambiguities to resolve during Phase 5 (and design before that):**

- The exact "n ≥ 3f + 1" consensus formula semantics.
- The Headroom mode thresholds (small/medium/large token boundaries).
- The F8/F12 duplication.
- The "six vs seven" memory ranking signals (the document lists seven in prose; the implementation should use all seven).
- Which embedding model to host locally vs call as a managed API (cost, latency, privacy trade-off).
- The exact extraction model choice (use Claude Code? a cheaper Claude model? a non-Anthropic model?).

---

## Readiness Declaration

### What I now understand

I have read the full proposal document and built a complete mental model of CodeMind. Specifically:

- The **problem** CodeMind addresses is the four-fold failure mode of session-based AI IDEs: no persistent memory, no intelligent routing, no multi-model planning, and no cross-session architectural reasoning.
- The **architecture** is a three-layer system: a Persistent Project Brain (Feature 1, the knowledge substrate), an Adaptive AI Agent (Feature 2, the request orchestrator), and a Multi-Agent Planning Mode (Feature 3, the consensus planner). The lifecycle is Planning → Storage → Implementation → Continuous Learning, and is self-reinforcing.
- The **technical stack** is concrete: VS Code fork + TypeScript + Node.js; Claude Code (Anthropic) as the primary LLM; OpenAI-compatible providers (Anthropic, OpenAI, Google, OpenRouter, Azure, DeepSeek, Qwen, Kimi) for MAPM; a lightweight fine-tuned intent classifier; Neo4j for the knowledge graph; PostgreSQL with pgvector for relational memory and vector search; BGE-M3 for embeddings; Redis for caching; OpenGrep (Semgrep fork) for F14; Headroom as the custom adaptive compression layer.
- The **dependency order** is unambiguous: Feature 1 (PPB) must be built first, because both Feature 2 and Feature 3 depend on it for storage and retrieval.
- The **research contributions** are five well-defined claims: Persistent Project Brain, Event-Driven Project Memory, Adaptive AI Agent Orchestration, Multi-Model Consensus Planning, and the Unified Intelligent Development Lifecycle.
- The **secondary features** are fifteen productivity features that complement the core. F14 (Security Scanner / Semgrep / OpenGrep) is the only one deeply specified; the rest are listed by name and depend on a supplementary features specification not present in the current working directory.
- The **risks** are identifiable: extraction quality (PPB), intent classification accuracy (Agent), moderator determinism and multi-provider health (MAPM), LSP lifecycle management (Semgrep).
- The **team implications** are realistic: a two-person team can build this in one FYP year with a phased delivery (Phase 0–5) that maps cleanly to demonstrable milestones.

### Questions and ambiguities that remain in the document

The document is detailed but not exhaustive. The following items are either ambiguous, partially specified, or referenced but not included:

1. **The "7 = 3(2)+1" formula in Section 5.1 / 5.6** is presented graphically but not fully prose-explained. The formula `n ≥ 3f + 1` (with `4 ≥ 3(1)+1` shown) appears to be a consensus threshold formula relating the required number of agreement votes to the number of remaining conflicts, but the exact semantics should be re-derived in the design phase.
2. **The supplementary features specification** for F1–F13 and F15 is referenced ("documented in detail in the supplementary features specification") but not present in the working directory. Without it, only F14 has a deep specification; the other fourteen are understood at the level of their names.
3. **F8 (AI-Powered PR Description Writer) and F12 (PR Description Writer)** appear to be duplicates in the secondary features list. This is most likely a documentation artefact and should be reconciled (likely a single feature).
4. **Memory Ranking signals** — the document lists seven signals in prose (Recency, Importance, Frequency, Current task, Current file, Developer intent, Project module), while a summary might compress this to six. Implementation should use all seven.
5. **Headroom mode thresholds** — the document describes small/medium/large modes but does not specify the token boundaries. These need to be chosen during design.
6. **The intent classification model** is described as "a lightweight fine-tuned classification model" but the model family, training data source, and hosting (local vs API) are not specified.
7. **The extraction model** is described as "LLM with structured output mode" but is not named. The most natural choice is Claude Code itself (or a cheaper Claude variant), but the document does not say so explicitly.
8. **Web search provider, GitHub API access, package registry clients** are listed as Agent tools but the document does not specify which provider to use or how to handle the API key surface.
9. **BGE-M3 hosting** — local model server vs remote API is a design choice not specified.
10. **F11 (Code Intelligence Suite)** is underspecified. It is likely a wrapper over VS Code's existing go-to-definition/find-references, possibly augmented with PPB context, but this is inferred from the name.
11. **The relationship between F8 and F12** (already noted) suggests the supplementary spec may have additional features not enumerated here, or the list is a working draft.

### What the next concrete action will be when given the go-ahead

When the developer explicitly approves proceeding, the next concrete actions are:

1. **Resolve the open ambiguities** in a single design-decisions document before any code is written — particularly the consensus formula, the Headroom thresholds, the extraction model choice, and the intent classifier architecture.
2. **Request the supplementary features specification** for the fourteen secondary features that are not deeply specified. If unavailable, write a one-page design note for each before implementation.
3. **Begin Phase 0:** clone `microsoft/vscode`, set up the build environment, rename the product to CodeMind, and stand up the Docker-based infrastructure (Neo4j, PostgreSQL/pgvector, Redis).
4. **Verify Phase 0 exit criteria:** a launching CodeMind binary with a working "Check Connection" command.
5. **Then begin Phase 1** (PPB) with the data model and Conversation Processing Engine as the first concrete deliverables.

No code will be written, no files created, no repositories cloned, and no dependencies installed until the developer explicitly gives the go-ahead and the ambiguities above are either resolved or marked as deferred design decisions.

---

**Status:** Analysis complete. Awaiting developer go-ahead.
