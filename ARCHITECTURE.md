# Sales Cockpit — Product Architecture Spec v1.1

Working spec for converting the du Sales Cockpit into a white-label, sellable
B2B sales management product. Zero infrastructure cost to the vendor at all
client sizes. This document is the source of truth for all build phases.

v1.1: validated against the actual repo (`main` @ b7c11a1). Section 0 records
the audit findings; Phase A rewritten to match the real codebase state.

---

## 0. Current-State Audit (repo `main` @ b7c11a1, July 2026)

What exists:
- `index.html` (329-line shell, CSS + entry script only) + 11 ES modules in
  `js/` (~4,000 lines). **The module split is already done** (Phase 5).
- `state.js` is the single point for Firebase init, config, constants, and
  shared mutable state — good extraction point for `config.js`.
- Permission-grant scaffolding (`permissions[]` + `hasPermission()` catalog)
  shipped — reusable substrate for org-level capability config.
- `companies` collection live with dedup/fuzzy-match/backfill;
  `hasDuAccount` already anticipates pipeline-stage skipping.

Critical gaps found (each mapped to a phase):
1. **Unpushed work**: remote has only `main`, ending at Phase 5. The
   submissions pipeline (Phase 6/7 Claude Code sessions: line items, doc
   gating, backend assignment) exists only locally. Also
   `PHASE5_SPEC_AND_HANDOFF.md` is referenced by the spec but not committed.
   → Push immediately; commit all spec/handoff docs. (Pre-Phase-A)
2. **No mutation gateway**: 57 direct Firestore mutation call sites across
   7 modules. Blocks clean `orgId` stamping and rollup hooks. (Phase A)
3. **No `orgId` anywhere** — zero occurrences in the codebase. (Phase A)
4. **Full-collection scans**: `dashboard.js:17`, `leads.js:28` (all leads,
   manager path), `org.js:141-143` (teams+users+leads at once). Breaks the
   50K-read quota and UX at 200+ agent scale. (Phases C/D replace with
   rollups + paginated scoped queries.)
5. **`in`-query cap bug**: `leads.js:34` fetches TL leads via
   `where('assignedTo','in',agIds)` — Firestore caps `in` at 30 values, so
   a TL with 31+ agents silently loses leads. Replace with a
   `where('tlId','==',uid)` query (field already written on leads).
   (Phase A quick fix)
6. **Security rules not version-controlled** — Firebase Console is the
   source of truth. Unacceptable for multi-client reproducibility.
   → `/rules/firestore.rules` in repo, Console updated only from repo.
   (Phase A)
7. Spec staleness: `PROJECT_SPEC.md` "Planned/Future" still lists the
   module split as pending. Clean up so future sessions don't act on it.
8. **PII exposure (URGENT — Phase A0)**: the 115 seed leads in `org.js`
   (L1/L2 arrays) are real prospects — real names, business emails, and
   personal phone numbers — committed to a PUBLIC repo, and present in git
   history. Remediation: delete the L1/L2 arrays and `seedLeads()` (data
   already lives in Firestore; a productized app seeds via CSV import, not
   hardcoded data), then rewrite history with `git filter-repo` to purge
   `org.js`'s old versions, and force-push. Sequence: push all pending
   work FIRST, then purge, then force-push all branches.
9. **TL visibility inconsistency (functional bug)**: `dashboard.js` fetches
   TL leads via `where('teamId','==',CP.teamId)` but `leads.js` (Pipeline)
   via `where('assignedTo','in',agentIds)`. Unassigned-in-team leads —
   which member-removal deliberately creates — show in Dashboard counts
   but are invisible in the TL's Pipeline, so TLs can never rescue
   orphaned leads despite bulk-assign supporting "unowned". Fix together
   with item 5: Pipeline TL query becomes `teamId ==`, matching Dashboard
   and the security-rule scope.
10. **String-derived analytics**: `dashboard.js closeMonthKey()` detects
   close month by scanning `history[]` text for `'→ Closed'`. Fragile —
   any stage rename or history-format change silently corrupts monthly
   reporting. Interim: gateway writes a structured `closedAt` timestamp on
   stage→Closed. Proper fix: Phase C rollups.
11. **Product hard-delete**: products are `deleteDoc`-ed despite the
   `active` flag existing. Must become soft-delete (`active:false`) BEFORE
   submissions reference `productId` in line items (Phase B prerequisite).
12. Small hygiene (fix during gateway migration): `esc()` applied to values
   written INTO Firestore history in `org.js` (stores HTML entities as
   data — escape at render, never at write); `confirmModal(msg)` injects
   HTML unescaped (all current callers static — harden anyway); CSS token
   typo `--t3:#5050780` (7 hex digits, invalid).

Local (unpushed) code audit — submissions build, reviewed July 2026:
Status vs the handoff spec's day plan: Days 1–3 built (companies ✔ pushed;
department/specialties/assignmentMode schema ✔; submission creation with
line items, doc gating, rotation auto-assign ✔ local). Days 4–5 NOT built:
no backend queue/stage-advancement UI, no correction loop, no
Activated-based target calculation (dashboard.js unchanged).

13. **Storage integration point**: the Blaze-blocked code is the
   `uploadBytes` loop in `createSubmission()` (submissions.js). Replace
   with the StorageAdapter (Section 4). Bonus with the firestore-b64
   driver: document blobs join the SAME writeBatch as the submission doc —
   atomic submit, no orphaned files on failure (the current
   upload-then-commit sequence can orphan). Remove the firebase-storage
   SDK import from state.js when on the b64 driver.
14. **Rules — submission confidentiality hole**: read rule grants bare
   `teamId` match for ANY role, so fellow sales agents can read each
   other's submissions (and ID-document paths) — violates
   PHASE5_SPEC_AND_HANDOFF.md §5 (agent, their TL, backend, manager ONLY).
   Fix: teamId clause requires `role() == 'team_lead'`.
15. **Rules — deactivated backend staff keep access**: backend clauses
   check `department == 'backend'` only; soft-remove clears teamId/tlId
   but NOT department, and rules never check `active`. Fix both: clear
   `department` in the remove flow, and add `&& data.active != false` to
   backend clauses (same get(), no extra read).
16. **Rules — correction loop blocked**: submissions update is
   manager/backend only, but Day 4's needsCorrection flow requires the
   submitting AGENT to update (refix + resubmit). Add a narrow agent
   update rule (own submission, blocked-item fields only) before building
   the Day 4 UI against it.
17. Known v1 tradeoffs (accepted, documented): assignmentCursor race
   (concurrent submits can double-assign + lose an increment — rotation
   skew only); cursor rule accepts any value/type from any auth user;
   showLeadModal assumes one submission per lead (docs[0], Submit hidden
   after first) — revisit for repeat orders.

Note on the Firebase API key in `state.js`: web API keys are public by
design (security lives in the rules), so this is not a leak — but the
config block still moves to per-deployment `config.js` for white-labeling.

---

## 1. Business & Deployment Model

**Model: White-label, per-client deployment.**

- One product codebase (this repo) = the licensed product core.
- Each client receives:
  - Their own Firebase project (created under their Google account, or
    created by vendor and ownership-transferred).
  - Their own static hosting deployment (GitHub Pages / Netlify / Cloudflare
    Pages — all free).
  - One `config.js` file: Firebase keys, `orgId`, branding, feature flags,
    storage driver selection.
- Cost structure:
  - Clients ≤ ~30 agents: Firebase Spark (free) is sufficient. Total infra
    cost: $0 for everyone.
  - Clients 50–300 agents: client upgrades *their own* project to Blaze
    (~$20–60/month at this scale). Vendor cost remains $0.
- Data custody: all client data, including ID documents (Emirates ID, Trade
  License, Ejari), lives in the client's own Google Cloud project. Vendor
  never stores or transports client PII. This is a core sales proposition.
- Future path: the `orgId`-scoped data model (Section 3) allows a later
  pivot to central multi-tenant SaaS without schema migration.

---

## 2. Codebase Structure

The ES module split already exists (see Section 0) — this section defines
the *target* structure, reached incrementally from the current `js/` layout,
not a rewrite. Native ES modules, **no build step** (must remain deployable
as static files on GitHub Pages). Current modules map as: `state.js` splits
into `config.js` + `db.js` + constants; `org.js` (860 lines, largest) splits
into `teams.js` + org admin; the rest keep their names.

```
/index.html          — shell: layout containers, module script tag only
/config.js           — PER-DEPLOYMENT file (gitignored template committed
                       as config.example.js): firebaseConfig, orgId,
                       branding {appName, logoUrl, primaryColor},
                       storageDriver: "firestore-b64" | "firebase-storage",
                       featureFlags {}
/src/
  app.js             — bootstrap, router, module loader
  auth.js            — Firebase Auth, session, role resolution
  authz.js           — role/permission helpers (manager, team_lead, agent,
                       backend)
  db.js              — Firestore init, shared query helpers, orgId injection
  storage/
    index.js         — StorageAdapter interface: put(), get(), delete(),
                       list(); driver chosen from config.storageDriver
    driver-firestore-b64.js   — Base64-in-Firestore driver (free tier)
    driver-firebase-storage.js — native Firebase Storage driver (Blaze)
  documents.js       — upload UI, client-side compression pipeline,
                       PDF→image conversion (pdf.js), retention policy
  leads.js           — leads CRUD, assignment, history
  submissions.js     — multi-stage pipeline, bundled products, doc gating,
                       backend auto-assignment
  companies.js       — Company entity CRUD
  products.js        — org-scoped product catalog CRUD
  scripts.js         — sales scripts feature
  teams.js           — teams, TL sub-groups, targets
  stats.js           — write-time rollup counter maintenance (Section 6)
  reports.js         — reports engine + report registry (Section 7)
  export.js          — SheetJS (xlsx) + print-CSS/jsPDF exporters
  ui/                — shared components, modals, tables, toasts
/rules/
  firestore.rules    — versioned security rules
  storage.rules      — versioned Storage rules (Blaze deployments only)
```

Rules for Claude Code sessions:
- Surgical edits only, per existing convention. Modules are small enough
  that labelled replace blocks stay reviewable.
- Every Firestore mutation goes through `db.js` helpers so `orgId` stamping
  and rollup-counter updates (Section 6) cannot be bypassed.

---

## 3. Tenancy & Data Model

Every document in every collection carries `orgId: string`. Non-negotiable,
including in single-tenant deployments.

```
orgs/{orgId}
  name, branding {}, departments [], commissionRules {},
  featureFlags {}, docRetentionDays (default 90),
  requiredDocsByProductCategory {}      // doc-gating config

users/{uid}         orgId, role, tlId, teamId, department, active, targets
teams/{teamId}      orgId, tlId, name, target
companies/{id}      orgId, name, trn, tradeLicenseNo, expiry dates,
                    contacts [], accountOwnerUid
leads/{id}          orgId, companyId?, stage, assignedTo, tlId, teamId,
                    history []
submissions/{id}    orgId, companyId, agentUid, tlId, stage,
                    lineItems [{productId, qty, term, mrc}],
                    requiredDocs [{type, status: attested|uploaded|verified,
                                   storageRef?}],
                    backendAssignee, sla {enteredStageAt}, history []
submissions/{id}/documents/{docId}      // firestore-b64 driver only
                    orgId, type, pageIndex, mime, b64, bytes, uploadedBy,
                    createdAt
products/{id}       orgId, category, name, mrc, otc, specs {}, active
scripts/{id}        orgId, channel, status, authorUid
stats/{statId}      orgId, period, scope, counters {}   // Section 6
```

Security rule pattern (Spark-compatible — no custom claims / Cloud
Functions):

```
function userDoc()  { return get(/databases/$(database)/documents/users/$(request.auth.uid)).data; }
function sameOrg()  { return userDoc().orgId == resource.data.orgId; }
function isRole(r)  { return userDoc().role == r; }
```

Every `allow` clause requires `sameOrg()` plus the existing role logic.
Writes additionally validate `request.resource.data.orgId == userDoc().orgId`
so a client cannot write into another org even with a modified client.

---

## 4. Document Storage Subsystem

### 4.1 Upload pipeline (all drivers)

1. Accept: JPEG/PNG/HEIC images and PDF files.
2. Images → canvas resize (max edge 1200px) → JPEG quality 0.72 →
   target ≤ 300KB per image.
3. PDFs → pdf.js renders each page to canvas at ~150 DPI → same JPEG
   compression → one stored object per page. Page cap: 10 (configurable).
   Rationale: verification is visual; page images are equivalent to the
   original for backend checking, and this keeps PDFs inside the free
   pipeline.
4. Output of pipeline: array of {pageIndex, mime, blob, bytes} handed to
   the StorageAdapter.

### 4.2 Driver A — `firestore-b64` (free tier, default)

- Each page stored as Base64 string in
  `submissions/{id}/documents/{docId}` (one Firestore doc per page,
  ≤ ~400KB after Base64 inflation; hard ceiling 900KB per doc).
- Security: inherited from Firestore rules — same auth, same role scoping
  as the submission itself. No public URLs exist. This is enforced access
  control, not obscurity.
- Capacity math: 1GB free ≈ ~3,000–4,000 stored pages. With retention
  (below), effectively indefinite for clients ≤ ~30 agents.
- Retention policy: when a submission reaches a terminal stage
  (activated/rejected), a client-side sweep (runs on manager login) deletes
  `documents/*` blobs older than `org.docRetentionDays`, leaving
  `requiredDocs[].status = "verified"` as the permanent attestation record.

### 4.3 Driver B — `firebase-storage` (Blaze deployments)

- Path: `orgs/{orgId}/submissions/{subId}/{docId}/{page}.jpg`.
- Storage rules mirror Firestore access logic via `firestore.get()`
  cross-service lookups (the rules already drafted in Phase 7 — must be
  live-tested before any client deployment relies on them).
- Same StorageAdapter interface; switching drivers is a one-line config
  change and requires no changes in feature code.

### 4.4 Sizing guidance per client

| Client size    | Plan   | Driver            | Est. client cost |
|----------------|--------|-------------------|------------------|
| ≤ 30 agents    | Spark  | firestore-b64     | $0               |
| 30–100 agents  | Blaze  | firebase-storage  | ~$5–25 /mo       |
| 100–300 agents | Blaze  | firebase-storage  | ~$20–60 /mo      |

---

## 5. Quota Discipline (Spark survival rules)

Spark limits: 50K reads / 20K writes per day, 1GB storage.

- No unbounded collection reads. Every list query is scoped: date range +
  role scope (agent sees own, TL sees sub-group, manager sees org) + limit
  with pagination.
- Reports never scan raw collections by default — they read rollup docs
  (Section 6). Drill-downs query raw data only on explicit user action,
  date-scoped.
- Cache immutable reference data (products, org config) in memory per
  session; subscribe with `onSnapshot` only where live updates matter
  (queues, pipelines).

---

## 6. Rollup Counters (stats engine)

Write-time aggregation so reports cost ~10 reads instead of ~10,000.

- Every mutation that changes reportable state (lead stage change,
  submission stage change, activation, rejection, activity log) also
  updates counter docs in the same batched write via `stats.js`:

```
stats/{orgId}_{YYYY-MM}_{scope}
  scope ∈ org | team:{teamId} | agent:{uid} | product:{productId}
  counters: {
    leadsNew, leadsQualified, submissions, activations, rejections,
    mrcSubmitted, mrcActivated, unitsByCategory {},
    stageEntries {stage: count}, stageDurationsMs {stage: totalMs},
    rejectionReasons {reason: count}, activityCounts {type: count}
  }
```

- Daily docs (`YYYY-MM-DD`) for flash/leaderboard reports; monthly docs for
  everything else. Increments via `FieldValue.increment()` — idempotency
  guarded by writing counter updates in the same batch as the state change.
- Stage TAT: on every stage transition, add `(now - enteredStageAt)` to
  `stageDurationsMs[previousStage]` and increment `stageEntries`; average =
  duration / entries.

---

## 7. Reports Catalog (registry in reports.js)

Each report = {id, audience, source: rollup|raw, filters, columns,
exporters}. Ship in this order.

**Manager**
1. Target vs Achievement — agent/TL/team; MTD, QTD, YTD; rollups.
2. Leaderboard Flash — daily/weekly; rollups (daily docs).
3. Product Mix — units + MRC by product/category, bundle attach rate; rollups.
4. Funnel Conversion — lead→qualified→submitted→activated, per-stage
   drop-off %; rollups.
5. Pipeline Forecast — weighted open pipeline vs target gap; raw
   (date-scoped) + rollups.
6. Rejection & Doc-Deficiency Analysis — reasons, deficiency rate by agent;
   rollups.

**Team Lead**
7. Daily Activity per Agent — calls/visits/follow-ups/new leads; rollups.
8. Lead Aging — untouched > X days; raw, scoped to sub-group.
9. Agent Pacing — run-rate vs month-end target; rollups.

**Backend/Ops**
10. Queue Status — pending by stage, workload per backend agent; raw
    (live onSnapshot, tightly scoped).
11. SLA / TAT Report — avg time per stage, aging buckets, breach list;
    rollups + raw for breach detail.

**Retention (product differentiator)**
12. Contract Expiry Pipeline — renewals due 30/60/90 days; raw over
    `companies`/`submissions` term data.
13. Churn Report — lost accounts, reasons, MRC value; rollups.
14. At-Risk Accounts — no activity ≥ N days, complaint flag; raw, scoped.
15. Upsell Radar — single-product companies → bundle candidates; raw.

**Finance**
16. Commission Statement — per agent from org commissionRules × activated
    MRC; rollups.
17. Activation Report — submitted vs activated vs billed; rollups.

All reports export via `export.js`: Excel (SheetJS) and PDF (print CSS /
jsPDF). Client-side only, free.

Note: validate this catalog against the real report samples and
B2B-telecom-specific documents when provided; adjust registry, not
architecture.

---

## 8. Build Phases

**Phase A0 — Repo hygiene + PII purge (do first, same day)**
1. Push all local work (submissions pipeline) to `wip-submissions`; commit
   `PHASE5_SPEC_AND_HANDOFF.md`, `ARCHITECTURE.md`, and any local-only docs.
2. Delete the L1/L2 seed arrays + `seedLeads()` + the seed banner from
   `org.js` (audit item 8) and commit.
3. Rewrite git history (`git filter-repo` on `org.js` blobs, or BFG) to
   purge the PII from all history, then force-push all branches. Verify on
   github.com that old `org.js` versions no longer contain the data.
4. Pull current Firestore rules from the Console into
   `/rules/firestore.rules` verbatim.
5. Fix the stale "Planned/Future" section of `PROJECT_SPEC.md`.

**Phase A — Foundation refactor**
1. Extract `config.js` from `state.js` (firebaseConfig, orgId, branding,
   storageDriver, feature flags); commit `config.example.js`, gitignore the
   real one per deployment.
2. Build the `db.js` mutation gateway and migrate all 57 direct mutation
   call sites (org.js, leads.js, scripts.js, products.js, companies.js,
   auth.js, state.js) through it. Gateway responsibilities: `orgId`
   stamping, audit fields, and (Phase C) rollup hooks.
3. `orgId` migration: one-off manager-session script stamps `orgId` on all
   existing docs across users/teams/leads/companies/channels/scripts/
   products; then rules updated with `sameOrg()` and republished from the
   now-version-controlled rules file.
4. Quick fixes while touching these files: replace the `leads.js:34`
   `in`-query with `where('teamId','==',CP.teamId)` — one change fixes
   both the 30-item `in` cap (item 5) AND the TL orphaned-lead visibility
   bug (item 9), and matches Dashboard + the security-rule scope; make
   product delete soft (`active:false`, item 11); gateway writes
   structured `closedAt` on stage→Closed (item 10); the hygiene
   one-liners from item 12; add `limit()` + pagination to manager
   full-collection lead scans as a stopgap until Phase C.
5. Regression pass on all role flows (manager / TL / agent) — the Phase 5
   permission-audit checklist is the test script.

**Phase B — Documents + submissions completion**
1. StorageAdapter + firestore-b64 driver; image compression; pdf.js
   page-to-image. Integration point: replace the `uploadBytes` loop in
   `createSubmission()` (audit item 13) — blobs join the submission's own
   writeBatch (atomic submit). `files[].storagePath` becomes a generic
   `storageRef` the adapter resolves per driver.
2. Rule fixes from audit items 14–16 (submission read scoping, active
   check + department clearing, agent correction-loop update rule) —
   publish from /rules/, live-test with real accounts per role.
3. Build Days 4–5 from the handoff spec: backend queue tab +
   per-item stage advancement (activityRef/workOrderRef gates,
   needsCorrection/rejected branch, resume at pausedAtStage), then
   Activated-based target calculation on the Dashboard (second
   calculation keyed off items[].activatedAt — kept separate from
   Closed-based numbers, per handoff spec §2a).
4. Retention sweep for document blobs (terminal-stage purge after
   org.docRetentionDays, attestation record kept).
Completes the blocked Phase 7 work with zero cost.

**Phase C — Stats engine**
`stats.js` rollups wired into every existing mutation path; backfill
script for historical data.

**Phase D — Reports v1**
Registry + manager reports 1–6 + exports.

**Phase E — Reports v2**
TL, Backend, Retention, Finance reports (7–17).

**Phase F — Productization proof**
Second Firebase project + second deployment from same repo with only a new
`config.js`; seed a demo org; this deployment doubles as the sales demo
environment. Write the client-onboarding runbook (create project → enable
Auth/Firestore → paste config → deploy → seed org + manager account).

**Phase G — Blaze track (first large client)**
firebase-storage driver + live-test storage.rules; quota load check.

---

## 9. Commercial Packaging (sketch)

- Tiered license by agent count (e.g., Starter ≤15 / Growth ≤50 /
  Enterprise ≤300), priced as setup fee + monthly license & support.
- Client owns their Firebase project and data; vendor licenses software +
  provides updates (git pull / release tags) and support.
- Demo environment = Phase F deployment.
