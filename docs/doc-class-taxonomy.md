# Doc Class Taxonomy

This taxonomy is the canonical reference for `doc_class` values. It aligns with the storage plan in `memento-enhanced-spec.md` and the tool contract in `packages/shared/src/schemas.ts`.

## Core principles

- `memory_kind` is a broad bucket (`spec`, `plan`, `architecture`, `decision`, etc.).
- `doc_class` is the precise artifact type.
- Canonical documents use `canonical.upsert` + stable `canonical_key` patterns.
- Non-canonical documents use `memory.commit` and can be promoted later.

## Doc class list

- `app_spec`
- `feature_spec`
- `design_doc`
- `architecture_doc`
- `implementation_plan`
- `migration_plan`
- `test_plan`
- `rollout_plan`
- `adr`
- `code_map`
- `environment_registry`
- `environment_fact`
- `operations_overview`
- `runbook`
- `troubleshooting`
- `postmortem`
- `meeting_notes`
- `research_spike`
- `onboarding_guide`
- `release_notes`
- `security_review`
- `performance_notes`
- `glossary`
- `other`

## Taxonomy table

| doc_class | Intended content | Recommended memory_kind | Canonical? | canonical_key pattern (if canonical) |
| --- | --- | --- | --- | --- |
| `app_spec` | app-level requirements, goals, NFRs | `spec` | Yes | `app` |
| `feature_spec` | per-feature requirements + acceptance criteria | `spec` | Yes | `feature/<name>/spec` |
| `design_doc` | tradeoffs, interfaces, component responsibilities | `architecture` | Yes | `feature/<name>/design` |
| `architecture_doc` | system/component architecture reference | `architecture` | Often | `arch/overview` or `arch/<topic>` |
| `implementation_plan` | milestone/task breakdown + testing + rollout hooks | `plan` | Yes | `feature/<name>/plan` or `plan/main` |
| `migration_plan` | DB/data migration steps + rollback | `plan` | Often | `plan/migrations/<topic>` |
| `test_plan` | unit/integration/e2e/perf + acceptance checklist | `plan` | Often | `feature/<name>/test` |
| `rollout_plan` | staged rollout, flags, monitoring, rollback | `plan` | Often | `feature/<name>/rollout` |
| `adr` | architecture decision record | `decision` | Optional | `adr/<NNNN>-<slug>` |
| `code_map` | module map, entrypoints, how code is organized | `environment_fact` | Optional | `code/map` or `code/<service>` |
| `environment_registry` | authoritative env/service registry | `environment_fact` | Yes | `env/registry` |
| `environment_fact` | one-off env/service fact | `environment_fact` | Usually no | (non-canonical) |
| `operations_overview` | ops posture: SLOs, alerts, dashboards, ownership | `runbook` | Often | `ops/overview` |
| `runbook` | step-by-step operational procedure | `runbook` | Often | `runbook/<service>/<task>` |
| `troubleshooting` | incidents, lessons learned, recurring issues | `troubleshooting` | Usually no | `troubleshooting/<topic>` (if canonical) |
| `postmortem` | structured incident analysis + actions | `troubleshooting` | Optional | `postmortem/<YYYY-MM-DD>-<slug>` |
| `meeting_notes` | meeting summaries | `note` | No | (non-canonical) |
| `research_spike` | explorations and findings | `note` | No | (non-canonical) |
| `onboarding_guide` | setup guide and mental model | `spec` | Often | `onboarding` |
| `release_notes` | what shipped, migrations | `note` or `plan` | Optional | `release/<version>` |
| `security_review` | threat model, controls, risks | `architecture` or `spec` | Optional | `security/<topic>` |
| `performance_notes` | benchmarks, tuning results | `architecture` or `note` | Optional | `perf/<topic>` |
| `glossary` | canonical terminology | `spec` | Optional | `glossary` |
| `other` | anything else | `note` | No | (avoid) |

## Tagging conventions

Use tags consistently to boost retrieval quality:

- `feature:<name>`
- `service:<name>`
- `component:<name>`
- `env:<dev|staging|prod|...>`
- `area:<auth|payments|infra|...>`
- `adr:<NNNN>`
- `error:<CODE>`
- `doc:<spec|design|plan|test|rollout|runbook|...>`

## Recommended section headings

Use these headings to keep outlines stable and retrievable:

- Spec (`app_spec`, `feature_spec`): Problem, Goals, Non-goals, Requirements, Acceptance criteria, Observability, Rollout
- Design (`design_doc`, `architecture_doc`): Context, Current state, Proposed design, Interfaces, Data model, Security, Alternatives, Tradeoffs
- Plans (`implementation_plan`, `test_plan`, `rollout_plan`, `migration_plan`): Milestones, Work breakdown, Testing, Rollout, Rollback
- Ops (`runbook`, `operations_overview`): Procedure, Preconditions, Steps, Monitoring, Rollback
- Troubleshooting (`troubleshooting`, `postmortem`): Symptoms, Root cause, Fix, Prevention, Follow-ups
- ADR (`adr`): Context, Decision, Alternatives, Rationale, Consequences

## Tool-call examples

### Canonical lifecycle docs

```json
{
  "idempotency_key": "canonical.upsert:feature/auth/spec:v1",
  "canonical_key": "feature/auth/spec",
  "doc_class": "feature_spec",
  "title": "Feature: Auth — Specification",
  "tags": ["doc:spec", "feature:auth", "area:auth"],
  "pinned": true,
  "content": {
    "format": "markdown",
    "text": "# Feature: Auth — Specification\n\n## Problem statement\n...\n"
  }
}
```

### Link a lifecycle graph

```json
{
  "idempotency_key": "link:feature/auth/plan->spec:v1",
  "from": { "canonical_key": "feature/auth/plan" },
  "to": { "canonical_key": "feature/auth/spec" },
  "relation": "implements",
  "weight": 1.0,
  "metadata": {}
}
```

### ADR via memory.commit

```json
{
  "idempotency_key": "memory.commit:adr-0001-auth-refresh:v1",
  "summary": "Record ADR for token refresh approach",
  "entries": [
    {
      "kind": "decision",
      "scope": "project",
      "doc_class": "adr",
      "title": "ADR 0001: Token Refresh Strategy",
      "tags": ["adr:0001", "feature:auth", "area:auth"],
      "metadata": { "status": "Accepted" },
      "content": {
        "format": "markdown",
        "text": "# ADR 0001: Token Refresh Strategy\n\n## Context\n...\n"
      }
    }
  ]
}
```
