# Sales Cockpit — Product Architecture Spec v2.0

White-label B2B sales management product for du channel partners (generic —
not Shaun Tech-specific). Zero infrastructure cost to the vendor at all
client sizes. This document is the source of truth for all build phases.

v2.0 incorporates the full role-discovery: sales agent modes, external
sources, backend event-timeline model, VAS service requests, KAM module
(portfolio, escalations, billing, handover), manager/TL targets,
commitments, and projections — plus the real report samples (daily team
report, master tracker workbook, escalation tracker).

---

## 0. Current-State Audit (repo `main`, July 2026) — CONDENSED

Full 17-finding audit lives in v1.1 history. Status after Claude Code
Session 1 (complete, verified):
- ✔ PII purge done (seed arrays deleted, git history rewritten with
  git-filter-repo across all branches, force-pushed, verified clean;
  old hashes submitted to GitHub Support for cache removal).
- ✔ wip-submissions branch pushed (Phase 6+7 local work rescued).
- ✔ /rules/firestore.rules = version-controlled source of truth.
- ✔ Rule fixes published: submission read scoping (item 14), backend
  active-check + department clearing (item 15).
- ✔ config.js extracted (gitignored) + config.example.js committed.
- ✔ TL Pipeline query = where('teamId'==) — fixes 30-item `in` cap +
  orphaned-lead invisibility (items 5+9).
- ✔ PROJECT_SPEC.md stale sections corrected.

Status after Session 2 (complete, verified — corrects v2.0's original
"still open" framing, which predated this session's actual work):
- ✔ db.js mutation gateway built; all direct Firestore mutation call
  sites migrated through it (orgId stamp, audit fields).
- ✔ orgId migration run live across all existing docs (0 missed);
  sameOrg()/sameOrgWrite() rules published — a bootstrap null-comparison
  bug that broke all logins was found and fixed live before declaring
  it safe.
- ✔ Structured closedAt on stage→Closed (replaces the string-scan);
  product soft-delete (active:false); hygiene one-liners (item 12).
- ✔ Pipeline tab pagination stopgap (server-side cursor pagination +
  getCountFromServer — rollups fix an aggregate's read cost, not a
  listing UI's, so this needed its own fix regardless of Phase C).

Still open: auditLog collection (gateway doesn't yet write a separate
audit-log doc per mutation) and the backup-export button (originally
scoped to precede the orgId migration; migration already ran and is
verified safe, so this is no longer a live risk gate, but the button
itself is still unbuilt and is a prerequisite for every future
migration/import). Both are this session's next two steps.

Infrastructure: Firestore region confirmed `me-central2` (Dammam) — no
latency issue. RULE: every client project must be created in
me-central1/me-central2 (region is immutable after creation).

---

## 1. Business & Deployment Model

White-label, per-client deployment. One product codebase; each client
gets their own Firebase project + static hosting + one config.js
(firebaseConfig, orgId, branding, storageDriver, featureFlags).

- ≤ ~30 agents: Spark (free) suffices → $0 for everyone.
- 50–300 agents: client upgrades THEIR project to Blaze (~$20–60/mo).
- Data custody: all client data (incl. Emirates ID / Trade License
  images) lives in the client's own Google Cloud project. Vendor never
  holds client PII — core sales proposition.
- Client-size variance is why central SaaS was rejected (shared 50K
  reads/day dies at one 300-agent client). orgId model keeps a later
  SaaS pivot open without schema migration.
- Onboarding runbook: create project in me-central1/2 → enable
  Auth+Firestore → publish rules from /rules/ → paste config.js →
  deploy → seed org + manager account. Phase F rehearses this.

## 2. Codebase Structure

Native ES modules, no build step (GitHub Pages-compatible). Current 11
modules + submissions.js. Target additions:

```
/config.js            per-deployment (gitignored)
/rules/firestore.rules
/js/
  db.js               mutation gateway: orgId stamp, audit fields,
                      rollup hooks, auditLog writes  [Session 2]
  storage/            adapter: driver-firestore-b64 | firebase-storage
  documents.js        compression, pdf.js page→image, expiry capture
  submissions.js      creation (exists) + timeline/status engine
  backendqueue.js     backend dept queue + event logging UI
  vas.js              VAS service-request tracker
  kam.js              portfolio, 360° company view, handover
  escalations.js      escalation tracker
  billing.js          bill-status log + reminders + risk flags
  sources.js          freelancer/subcontractor registry
  commitments.js      TL pledges vs actuals
  stats.js            rollup counters
  reports.js          filter-grid report engine + registry
  projections.js      run-rate / trend forecasts
  import.js           CSV/Excel import w/ mapping + preview (SheetJS)
  export.js           Excel (SheetJS) + PDF export; du order form
```

Convention: surgical labelled-replace edits only; one module per
commit; ARCHITECTURE.md + PROJECT_SPEC.md are sources of truth.

## 3. Tenancy & Data Model (additions in **bold**)

Every doc carries orgId (Session 2 migration). sameOrg() rule pattern
per v1.1 §3 (users-doc lookup; Spark-compatible).

```
orgs/{orgId}          config: branding, departments, docRetentionDays,
                      requiredDocsByProductCategory,
                      **typeOfRequestList** [NEW,FNP,MNP,Migration],
                      **rejectionReasons** [], **escalationTypes** [],
                      **vasRequestTypes** [], **vasStatuses** [],
                      **kamHandover** {mode:auto|manual, rule:
                        leastLoaded|roundRobin, rampCapPerWeek},
                      **itemFieldsByCategory** {mobile:[msisdn,simSerial,
                        passcode,commitmentPlan,handset], fiber:[gaid]},
                      **productFamilies** [BSP, Fixed, …] (Ashok to
                        finalize groupings)
users/{uid}           role, teamId, tlId, department, specialties,
                      available, monthlyTarget, **personalTarget**
                      (TL only, nullable), permissions[]
teams/{id}            department, assignmentMode, assignmentCursor,
                      permissions[]
companies/{id}        name, normalizedName, industry, city,
                      **accountCode**, **segment** (SOHO|SME),
                      **contacts** {authorizedPerson, phone, altPhone,
                        technicalName, email},
                      **addressBlock** {building, street, city, emirate,
                        poBox, full},
                      hasDuAccount (informational badge only),
                      **docExpiries** {tradeLicense, establishmentCard,
                        eid} (establishment card = SIM-suspension risk),
                      **partnerHistory** [{type:gained|lost, partner,
                        date, note}], **accountOwner** (KAM uid),
                      **billing** {lastConfirmedPaidMonth, status:
                        ok|pending|overdue, log:[{month, status,
                        reminders:[{date, channel}]}]},
                      **riskFlags** {docExpiry, billOverdue, churnList}
leads/{id}            + **sourceId** (external source), **commission**
                      {amount, paidTo, sourceRef?, note, enteredBy —
                      TL/manager entry only}, closedAt (structured)
sources/{id}          **type: freelancer|subcontractor, name, contact,
                      terms, active** (manager-only; never get logins)
submissions/{id}      leadId, companyId, agentId, teamId, tlId,
                      **bundleId** (links sibling submissions created
                        from the same Submit-to-Backend form — the
                        agent's view groups by this; du-facing reality
                        is one row per product order, so this is NOT
                        an items[] array — see §5),
                      productId, qty, mrc, **typeOfRequest**,
                      **contractTerm**, **categoryFields** (gaid /
                        msisdn / simSerial / passcode — optional),
                      **sprFlag + sprNote**,
                      **status: pendingVerification|submittedToDu|
                        inProgress|activated|rejected** (coarse, PER
                        SUBMISSION — a bundle activates partially in
                        the normal case, not an edge case),
                      **events[]** (append-only timeline — see §5),
                      **accTransfer** {flag, fromPartner} (also writes
                        company partnerHistory),
                      **verification** {done, method:call|email, ts, or
                        auto-mark "proceeded without verification"},
                      requiredDocs[] {type, status, expiryDate,
                        storageRef}, assignedBackendAgent (specialty-
                        matched per category, rotation advances per
                        SUBMISSION created, not per bundle)
serviceRequests/{id}  **VAS module**: companyId, accountNo, requestType,
                      activityNo, status, notes, events[], raisedBy
escalations/{id}      companyId, accountNo, **issueType** (configurable:
                      account merger, waiver, .ae domain, CNAP, email
                      change, prepaid…), **severity**, contactPerson,
                      contactNumber, status (Open|InProgress|
                      WaitingCustomer|WaitingDu|Resolved),
                      **updates[]** (dated log), vasActivityNo?,
                      openedAt, resolvedAt (→ resolution time)
commitments/{id}      **tlId, agentId, period, metric: revenueAED|units,
                      scope: product|family|category + ref, value**;
                      actuals computed from rollups
datasets/{id}         **manager-imported du data** (churn lists, cross-
                      sell): parsed rows, mapping, sharedWith
                      [kam, backend]; churn rows match companies by
                      accountCode → set riskFlags.churnList
stats/{...}           rollups — see §7
auditLog/{id}         who, what, docRef, ts (gateway-written)
```

## 4. Roles & Permissions

- **Sales agents** (telecaller / outdoor / hybrid / BD — mode is a
  label, ONE workflow): own leads, own pipeline, submit to backend,
  see own submissions' timelines read-only, own stats, own commissions.
- **Team lead (sales)**: full authority over assigned agents; team-
  scoped data ONLY (leads, reports, timelines of team submissions,
  commissions of own sub-group); records commitments; optional
  personalTarget (set by manager). Team target = Σ agent targets +
  personalTarget (if set). Team attainment counts ALL team closes incl.
  TL's own; personal attainment counts only TL-owned deals.
- **Backend**: whole dept sees all submissions; processes assigned
  cases (specialty match, fallback = any available backend agent;
  backend TL = coordinator, reassigns); verifies docs (call/email
  event) or rejects with reason; logs timeline events; trivial fixes
  logged as correction events; measured on submissions, activations,
  submission→activation time; sees sales performance data across all
  teams (data-keeper role — no restriction); generates all reports and
  projections.
- **KAM**: portfolio model (accountOwner); works existing clients
  (cross-/upsell via normal pipeline), handles escalations + VAS,
  tracks bills, monitors doc-expiry/churn risk; needs company 360°
  view (services active = activated submissions, contract expiry =
  activationDate + contractTerm, products in use, transfer history).
  Handover: on activation, account → unassigned KAM queue (manual) or
  auto-assign per org rule (leastLoaded default + rampCapPerWeek;
  roundRobin option); manager can always reassign; ownership changes =
  manager-only. No-KAM partners: backend or designated agent (via
  permission grant) covers escalations/VAS/billing.
- **Manager**: everything, everywhere; flexible report grid (scope ×
  product dimension × time); sets all targets incl. TL personal;
  enters/edits commissions; manages sources; imports du data + CSV
  leads; assigns outsourced leads (keep → "Outsourced Revenue" line;
  assign → counts to assignee's target; source tag per-lead only).
- **External sources**: data entities only, never logins.

## 5. Submissions — One Line Item Per Submission Doc (replaces 5 fixed
stages AND v2.0's original items[] array)

One submission document = one product line (with qty), not a bundle.
The agent's Submit-to-Backend form can carry multiple product lines in
one sitting; each line becomes its OWN submission doc, all sharing a
common bundleId. The agent's Pipeline/submissions view groups siblings
by bundleId into one visual package, but each submission underneath has
its own coarse status, its own events[] timeline, and its own
assignedBackendAgent. Rationale: the real master tracker is one row per
product order — du issues activity numbers, work orders, and
activation dates per order, and partial activation of a bundle (one
line activated, another still pending) is the normal case, not an edge
case.

Coarse status (per submission, not per bundle): pendingVerification →
submittedToDu → inProgress → activated | rejected. hasDuAccount =
informational badge (no skip logic). Append-only typed events (actor,
ts, payload), also per submission:

docsVerified · verificationCall {ts} · verificationEmail {ts} ·
submittedToDu (auto-marks "proceeded without verification" if no
verification event exists) · activityNo {value} · workOrderNo {value} ·
appointment {date, time, person} · biometric · sprObtained {note} ·
correction {note} (backend trivial fixes) · note · activated {ts} ·
rejected {reason from org list + note}

Rejected → returns to submitting agent (fix + resubmit) — that specific
submission only; siblings in the bundle are unaffected. Timeline
read-only to submitting agent + their TL + manager; whole backend dept
read/write per assignment (assignment is per submission — specialty-
matched per category, rotation cursor advances once per submission
created, not once per bundle). Doc-expiry warning at agent's desk when
any document expires < 15 days (establishment card highlighted — SIM
suspension). Backend tools: per-field copy + "Copy All" (du ticket
field order — TBD from backend), "Export du Order Form" (filled
Excel/PDF in the partner's format).

## 6. Document Storage

Unchanged from v1.1: StorageAdapter; firestore-b64 driver (free tier)
— client-side canvas compression ≤300KB/page, pdf.js renders PDF pages
→ JPEGs, blobs join the submission's writeBatch (atomic); retention
sweep after terminal status (org.docRetentionDays), attestation +
expiry dates kept forever. firebase-storage driver for Blaze clients.
Physical/NAS storage rejected (no server, security, breaks white-
label). du data files: not stored — parsed via import.js; extracted
rows are the asset.

## 7. Rollup Counters

Write-time increments via gateway, same batch as the mutation.
Dimensions per day + month, per scope (org | team | tl | agent |
source | backendAgent), per product + category + family:
submissionsCount, submissionsValueAED, activationsCount,
activationsValueAED, rejectionsCount, rejectionReasons{},
unitsByProduct/Family{}, inProgressCount/Value, stage-time sums
(submission→activation), escalations opened/resolved + resolution-time
sums, VAS counts. Blank metrics render as 0.

## 8. Reports Catalog v2 (registry; all views export Excel/PDF; scoped:
manager=all, TL=own team, agent=self, backend=all)

Validated against real samples:
1. **Live daily team table** (replaces the 5:51pm WhatsApp screenshot):
   per-agent MTD submissions/activations in AED + counts, team totals;
   share/export button (the ritual survives, the compiling dies).
2. **Master tracker view** (Sheet 1 as a live filterable grid; activity
   no. / WO columns auto-filled from timeline events — fixes the
   22/317 and 11/317 fill rates in the real file).
3. **Daily summary** (Sheet 2 automated): today's submissions +
   activations + in-progress pipeline, count + AED, split by product
   family (BSP/Fixed).
4. **Rejection analytics** — THE money report (62% rejection rate in
   real data): reasons × agent × doc type × time; deficiency rate.
5. Target vs achievement (agent/TL/team/dept; incl. TL personal
   tracker); leaderboards; product mix; funnel conversion.
6. **Commitments vs actuals** (per TL, per agent, per period).
7. **Projections**: month-end run-rate, 3-month weighted baseline,
   trend arrow (up/flat/down) per agent/TL/team/dept; methodology
   labeled on-report; TL=own scope, manager+backend=all.
8. Retention pack: contract-expiry pipeline (30/60/90d), churn/lost
   accounts, **expiring documents across activated accounts**
   (establishment cards first), **bill-risk list**, transfer
   won/lost by partner, upsell radar, **unassigned-accounts aging**
   (anti-hoarding), portfolio load per KAM.
9. Escalation reports: open by status/severity/type, resolution time,
   recurrence by company (training use).
10. VAS tracker view. 11. Outsourced revenue + per-source production +
   payout statements (commission ledger). 12. Backend ops: queue by
   status, workload per backend agent, TAT, SLA breaches.

## 9. Quota Discipline

Unchanged: no unbounded scans (reports read rollups; drill-downs
date-scoped + paginated); reference data cached per session; import
preview batches writes. Spark limits: 50K reads / 20K writes / 1GB.

**Fetch-all-companies patterns are banned.** Design assumption: a real
partner can carry 1,000-3,000+ company records — the same read-cost math
that forced the Pipeline tab's pagination stopgap applies here. Every
company picker (lead modal, and any future one) must use targeted
queries, never `fetchCompanies()`'s full scan:
- **Dedup** (`findOrCreateCompany`): two targeted reads, `limit(1)` each
  — `where('accountCode','==',code)` first (stronger identity signal
  than name), then `where('normalizedName','==',norm)`. Two reads
  regardless of collection size, vs. one read per existing company
  under the old pattern.
- **Type-ahead** (`searchCompanies`): debounced (300ms), min 2 chars, a
  single-field prefix-range query on `normalizedName`
  (`>=term`, `<=term+''`, `limit(10)`) plus a parallel exact
  `accountCode` lookup when the term contains a digit. No composite
  index needed for either — confirmed live, zero `failed-precondition`
  errors across all testing.
- **`fetchCompanies()`** (the raw full scan) still exists for exactly
  two deliberate exceptions, both documented in `js/companies.js`
  itself: `backfillCompanies()` (one-off, manager-only, safe to re-run)
  and the Org tab's Companies card listing (not yet paginated — same
  category of gap as the Pipeline tab was before its stopgap, not yet
  addressed).
- The Submit-to-Backend modal does NOT have its own company picker —
  its company is fixed from the lead's existing `companyId`, and
  `accTransfer.fromPartner` is a free-text competitor/reseller name,
  not a reference into `companies`. "Company picker per step 7b" from
  the session that built this was read as "if a picker is needed here,
  build it with the type-ahead pattern," not a mandate that one must
  exist — none was.

## 10. Build Phases (revised)

- **Session 2 (complete, verified)**: merge wip-submissions → db.js
  gateway (orgId, audit fields, closedAt, history cap) → product
  soft-delete → orgId migration → sameOrg() rules (migration ran
  BEFORE rules publish, as planned) → Pipeline pagination stopgap.
  Remaining from this list, done THIS session before any Phase B
  feature code: auditLog (gateway writes) and the backup-export button
  (originally scoped to precede the orgId migration — migration
  already ran and is verified safe, so this is now a forward-looking
  prerequisite for every future migration/import, not a live gate).
- **Phase B — schema + submissions v2 (COMPLETE).** Delivered across
  three chunks (B1/B2/B3 — session planning vocabulary, not a
  numbering this doc used before; recorded here so future sessions
  reference the same labels):
  - **B1 — submissions v2 core + company enrichment + scalable
    lookups**: company enrichment (contacts, address, accountCode,
    segment, expiries) + dedup by accountCode; status+timeline
    replaces stages (one submission = one product line, see §5);
    per-category item fields (GAID…); typeOfRequest; SPR; accTransfer;
    verification gate; rejection reasons; doc-expiry warnings.
  - **B2 — StorageAdapter + firestore-b64 + pdf.js + retention
    sweep**: free-tier document storage (client-side compression,
    pdf.js page rendering), manager-only retention sweep once a
    bundle's submissions are all terminal.
  - **B3 — backend queue UI + versioned resubmission + bundle PDF +
    copy tools + the 0-series UX fixes**: Queue tab, claim/
    reassignment, the submission action panel driving every
    appendEvent action, versioned Fix & Resubmit, combined-PDF export,
    backend document attachments, copy tools, plus the header team
    name / close-to-submit flow / stage-dropdown / pipeline badge /
    stale-team-data fixes found live alongside it.
- **Phase C — stats engine** (rollups incl. AED values + families). **Next up.**
- **Phase D — reports v1**: live team table, master tracker view,
  daily summary, rejection analytics, target/attainment incl. TL
  personal.
- **Phase E — KAM + ops modules**: portfolio + handover + 360° view;
  escalations; billing; VAS; sources + commissions; commitments;
  du-data import; retention/risk reports; projections.
- **Phase F — productization proof**: second project (me-central1/2),
  demo org, onboarding runbook. **Phase G**: Blaze track (firebase-
  storage driver live test) for first large client.
- Cross-cutting (from security/observability review): read-scoping
  overhaul + denormalized names (before first external sale), App
  Check, Sentry, diagnostics panel, version stamping, import preview.

## 11. Commercial Packaging

Tiered license by agent count (Starter ≤15 / Growth ≤50 / Enterprise
≤300): setup fee + monthly license & support. Client owns project +
data; vendor licenses software + updates + support. Differentiators to
lead the pitch: rejection analytics, suspension-risk early warning
(docs + bills), live daily numbers without compiling, du order-form
export, projections/commitments, escalation memory.

## 12. Session B4 — Manager's Cockpit (shipped)

Session-sequence label ("B4"), not a Phase-B feature — sits ahead of
§10's Phase C in delivery order but deliberately does NOT build Phase
C's rollup counters (see below). Delivered: (A) category identity
refactor + one-time migration + Products config panel (categories +
contract-term labels), (B) Manager's Cockpit dashboard — donuts +
role-based performance metrics, (C) target-remaining metrics with a
run-rate visibility toggle. Out of scope, unchanged: SOF template
library (deferred), escalation/KAM metrics (reserved placeholder slots
only), rollup counters (still Phase C, a later session — this
session's dashboard aggregates client-side behind a swappable
`getDashboardData(period)` module, `js/dashboardData.js`, whose
internals Phase C replaces with rollup reads, not its call signature
or output shape — verified: `js/dashboardCharts.js` and
`js/dashboardCards.js` only ever consume that module's output shape,
never a raw query).

**Category identity model (replaces name-string identity):**
Categories (`Starter`, `Essential`, `Ultimate`, `Mobile`, …) have
permanent immutable IDs in org-config (`orgs/{orgId}.categories: [{id,
label}]`); the display name is a label on the ID, editable via the
Products config panel (manager-only UI). Every LIVE-CONFIG reference
that used to store the name string directly — `products.category`,
`users.specialties[]`, `ORG_DEFAULTS.itemFieldsByCategory` keys —
migrated to store the ID instead, resolving the label at render time
via `categoryLabel()` (`js/orgConfig.js`), which falls back to the raw
value unchanged for anything not a known ID — makes the same call site
safe for both migrated and not-yet-migrated data. `submissions.category`
was deliberately left OUT of the migration: a submission is an
immutable point-in-time snapshot, not live config, and `categoryLabel()`'s
fallback already displays a pre-migration submission's raw legacy value
correctly with no code change needed. Rename = one label edit, reflects
everywhere immediately by construction (specialty checklists,
field-mapping lookups, Products display) — verified live. Category
delete is blocked while any product still references the ID, with the
blocking products listed to the manager. Contract-term labels
(`orgs/{orgId}.contractTermLabels: {term: label}`) are a parallel,
separate override — unlike categories, a pricingOption's own stored
label is NEVER migrated away; the override is optional and falls back
to each product's own label, so nothing breaks if it's never set.

**Manager's Cockpit dashboard** (`js/dashboard.js`'s `#mgr-cockpit`,
manager-only): period selector (This Month/Last Month/This
Quarter/Custom ≤92 days) + AED/Count mode toggle, shared by all three
sections below. "Share by Team" and "Share by Contributor" donuts
(`js/dashboardCharts.js`, dependency-free hand-rolled SVG arcs).
Donut/role-metric attribution rule: a normal line credits the
submitting agent (`agentId`); an `accTransfer`-flagged line (the only
existing schema signal for "brought in via an external partner, not
the funnel") credits that partner instead, falling back to the literal
"Outsourced Revenue" bucket when no partner name was recorded. A sales
agent's own `aedClosed`/`linesSubmitted` role-metric row is independent
of that attribution split — it's keyed on `agentId` directly (their
personal output), not on who the donut credits. Role metrics
(`js/dashboardCards.js`): sales agent = AED closed + lines submitted;
backend = submissions handled + queue wait (created→claimed) +
handling time (claimed→submittedToDu) + du turnaround
(submittedToDu→activated, explicitly labeled du's own clock, not the
backend agent's performance) — each duration is an average of raw
per-submission samples, rendered N/A (never a fabricated 0) when a
backend agent has no qualifying samples that period; KAM/escalations
is a reserved placeholder card only.

**Target-remaining + run-rate toggle:** AED remaining vs. the sum of
active agents' `monthlyTarget`, shown for This Month only — every
other period has no directly comparable target in this schema and
renders N/A rather than a guessed pro-rated figure. Days-left (calendar
days remaining in the month, today inclusive) and required daily
run-rate (AED remaining / days left) are gated behind a visibility
toggle, default OFF. Resolution: a per-user override
(`users/{uid}.runRateVisible`) always wins over the org-config default
(`orgs/{orgId}.runRateDefaultVisible`) in either direction — verified
live across all four combinations (org on/user null, org off/user
null, org off/user true, org on/user false), each producing the
correct effective value. The per-user override needs no dedicated rule
— it's already covered by the `users` collection's existing self-write
clause. The org-default toggle is manager-**and-team-lead**-writable at
the rule level (`orgs/{oid}`'s `hasOnly(['runRateDefaultVisible'])`
narrow exception, verified live: a TL can write that field alone, is
denied for `categories`/`contractTermLabels` alone, and is denied for
both together with no partial application) — **but no UI currently
exposes it to a TL**: the entire Manager's Cockpit section, including
the only "Set as Org Default" button in the app, is manager-only
(`role === 'manager'` gate in `js/dashboard.js`). This is intentionally
NOT built this session, and is not an open-ended gap: **the TL
org-default toggle UI ships with the TL/agent-facing target views
phase; rule-level support already live and verified.** Rationale: the
toggle governs a manager-only view today, so TL-facing UI for it is
meaningless until TL/agent-facing target views exist to put it in.

**Escalation attribution rule (recorded now, applied when the
escalations module itself ships in Phase E):** whoever RESOLVES an
escalation gets the credit for it, not who opened it and not the
account's KAM by default — this explicitly includes backend agents,
since backend already fields plenty of escalation-adjacent work today.
This session only reserves "coming with escalations module" placeholder
slots in the role-metrics cards; no escalation data model or UI ships
here.

**Rules (Step 8, published):** new `orgs/{oid}` collection —
authorized by KEY MATCH (`oid == userDoc().orgId`), not
`sameOrg()`/`sameOrgWrite()`, since the doc ID itself is the identity
(no bootstrap-window guard needed either — brand-new collection, no
pre-migration legacy data). Read: any same-org user. Write: manager
unrestricted; team_lead narrowed to `runRateDefaultVisible` only.
Separately, **a real privilege-escalation gap was found and fixed
during this step's review**: the `users` collection's self-write
clause previously let any user update ANY field on their own doc,
including `role`/`department` — an agent could self-promote to manager
or self-assign to backend and pass every `role()=='manager'`/
`isActiveBackend()` check in the whole rules file. Fixed by narrowing
self-write to exclude a blocklist of privileged/compensation/identity
fields (`role`, `department`, `orgId`, `teamId`, `tlId`, `active`,
`monthlyTarget`, `targetSource`, `autoTarget`, `permissions`,
`specialties`, `available`, `email`, `createdBy`, `createdAt`) — manager
stays unrestricted. Verified live, twice: the first publish attempt
turned out to be a stale pre-fix version (agent self-promotion to
manager briefly succeeded against live data, immediately reverted,
root-caused to a publish mismatch not a logic bug, republished and
reverified clean). One composite index: `submissions (status ASC,
activatedAt ASC)` for the dashboard's activated-in-period query — the
two other dashboard queries (`createdAt` range, `claimedAt` range) are
single-field ranges, already auto-indexed.

**Rules-engine finding (LIST-query provability):** a manager's list
query against `submissions` succeeds with NO `where('orgId',...)`
filter, even though the read rule's `sameOrg()` clause references
`resource.data.orgId` — `role()=='manager'` being a request-time-only
fact (one `get()` on the caller's own doc) is sufficient to satisfy the
whole conjunction, confirmed via `tools/rules-probe.html` (an
adversarial probe built specifically to settle this, independent of
the app's own Firebase module instance) run against both a manager
account (four query shapes, all succeeded) and a sales-agent control
(all four correctly denied, proving the probe isn't itself bypassing
rules). This is a property of THIS rule shape (a request-time-only
role escape ORed with resource.data-dependent branches), not a general
guarantee — **re-run `tools/rules-probe.html` as manager AND as a
non-privileged control account before merging any future change to
`sameOrg()`/`sameOrgWrite()` or any similarly-shaped rule.**

**Rules-engine finding (get-on-nonexistent-doc, extends the
existing gotcha):** `getDoc()` on a nonexistent document can be denied
even when the rule never references `resource.data` at all — observed
live on `orgs/{oid}`'s pure key-match read rule (`oid ==
userDoc().orgId`, no `resource` reference whatsoever) before that doc
existed; the identical read succeeded immediately after the doc was
created. `js/orgConfig.js`'s `loadOrgConfig()` and `js/org.js`'s
`computeCategoryMigrationPlan()` already wrapped this read in a
try/catch treating any failure as "doesn't exist" (originally written
defensively for "rule not published yet"), so this needed no code fix
— but it means the earlier-documented "denied get() on nonexistent
doc" pattern (submissionDocs, Phase B) is broader than first scoped:
it is not conditional on the rule touching `resource.data`.

**Regression:** donut totals, byTeam, byContributor (including both
the accTransfer-with-partner and accTransfer-without-partner
"Outsourced Revenue" fallback), sales-agent role metrics, and all
three backend timing averages were reconciled against a 6-line
hand-calculated fixture (one normal agent-attributed line, two
manager-kept/external-source lines, a 2-line partial-activation bundle,
and one activated line with no `claimedAt`) — every field matched the
hand calculation exactly, which also proves partial-bundle-activation
handling (the pending sibling's AED correctly excluded from totals)
and the queue-wait N/A mechanism (the no-`claimedAt` line correctly
excluded from the average, not fabricated as 0) in the same pass.

## 13. Session B5 — Sourcing & Transfer Tracking (shipped)

**Why this session exists:** B4's donut/contributor attribution used
`accTransfer.fromPartner` as a proxy for "sourced by an external
partner." Domain review after B4 shipped established that
`accTransfer` is actually an operational TAKEOVER marker — it records
du account custody moving from a losing partner to us, a transfer du
itself can reject — and is orthogonal to sourcing: a freelancer- or
subcontractor-sourced sale may still need an account transfer, and a
transfer may happen on a deal that was never externally sourced.
Crediting revenue to `fromPartner` (frequently the LOSING competitor
in a takeover) was wrong by design, not merely imprecise. Zero
submissions have ever had `accTransfer.flag == true` in production
(confirmed via a live data pull before this session started), so there
is no data to migrate — this is a pure go-forward correction.

Scope: (1) repoint donut/contributor attribution onto a new, separate
`sourcedBy` field instead of `accTransfer`; (2) capture `sourcedBy` on
the Submit-to-Backend modal, alongside (not replacing) the existing
`accTransfer` capture — both concepts are real and both stay; (3) add
manager/backend-driven transfer OUTCOME tracking
(`pending`/`completed`/`rejected`+reason) for `accTransfer`-flagged
lines, since a takeover request being rejected by du is a real
operational stall worth surfacing, distinct from and non-blocking to
the document-rejection lifecycle. No rules or index changes were
needed — `sourcedBy` rides the same agent-create path `accTransfer`
already used, `transferStatus` rides backend/manager's existing
unrestricted submissions update (confirmed live, both self-serve).

**Attribution repoint (`js/dashboardData.js`):** the `byContributor`
loop now reads `sourcedBy.flag`/`sourcedBy.partnerName` exclusively —
`accTransfer` is no longer read anywhere in the aggregation. A normal
line still credits the submitting agent; a `sourcedBy`-flagged line
credits `partnerName` (falling back to "Outsourced Revenue" when
empty). Verified with a synthetic 5-case logic check AND a live
4-line Firestore fixture (normal agent line, `sourcedBy` with a name,
`sourcedBy` with no name, and an `accTransfer`-flagged-but-not-
`sourcedBy` line) — every case matched, critically including proof
that the `accTransfer`-only line is credited to the agent exactly like
a normal line, not diverted to `fromPartner`.

**Sourcing capture (`js/leads.js` Submit-to-Backend modal,
`js/submissions.js createSubmissions`):** a second checkbox + name
input, `sourcedBy: {flag, partnerName}`, alongside the existing
`accTransfer` checkbox — same re-render-survival state handling,
same toggle-reveals-input UX, create-time-only and immutable
thereafter (mirrors `accTransfer` exactly). Each checkbox carries one
line of helper text so agents can't confuse the two: **"Account
custody is moving from another partner to us — du must approve the
transfer, and it can be rejected"** vs. **"This deal was brought to us
by an outside partner — separate from account transfer above; a
sourced deal may or may not also need a transfer."** Written onto
every line in the bundle via `sourcedByPayload` (same
normalize-to-`{flag,partnerName}` shape `accTransferPayload` already
used).

**Transfer outcome tracking:** a new `transferStatus` field
(`'pending' | 'completed' | 'rejected'`), completely separate from
the submission's own `status`/document-review lifecycle — enforced by
construction, not just convention: `appendEvent`'s new
`transferCompleted`/`transferRejected` event branches each set ONLY
`update.transferStatus`, structured as their own `else if` arms
mutually exclusive with every branch that touches `status`
(`submittedToDu`/`activated`/`rejected`/`resubmit`, and the generic
`submittedToDu`→`inProgress` bump). `transferStatus:'pending'` is
stamped at creation (`createSubmissions`) whenever `accTransfer.flag`
is true; absent entirely on non-flagged lines, so `accTransfer.flag`
remains the single source of truth for "is this a transfer at all."
`transferRejected` requires a free-text reason (distinct from
`ORG_DEFAULTS.rejectionReasons`, which governs document rejection
only) via its own validation branch in `appendEvent`. UI: the Queue
action panel (`js/queue.js`) shows Mark Transfer Completed / Mark
Transfer Rejected buttons only while `transferStatus==='pending'` and
only to backend or manager (`isBackendUser() || CP.role==='manager'`)
— no rule change needed, backend/manager already have unrestricted
submissions update. A rejected transfer renders a red "⚠ Transfer
Rejected" stall badge in three places: the Queue list's compact status
column, the action panel's transfer block, and the agent's own
Submission Timeline (`js/leads.js`) — all three read the same
`TRANSFER_STATUS_LABELS`/`TRANSFER_STATUS_COLORS` constants
(`js/submissions.js`) so they can't drift apart. Verified live end to
end as backend (`transferCompleted`, correctly attributed in the
timeline to the acting backend user, not the original agent) and as
manager (`transferRejected` with a reason, badge visible in the Queue
list and action panel, submission `status` and Quick Actions
confirmed completely unaffected — the lifecycle guarantee holds).

## 14. Session C0 — Product Family Layer (shipped)

**Purpose:** Phase C's rollup counters (§10) will be keyed by product
FAMILY, not category — a coarser grouping for reporting (e.g. every
fiber-plan category rolled into one "Fixed" line, mobile plans into
"SIM Cards"). This session builds the family layer FIRST, before any
rollup counter exists, so those counters are born with their final
keys and never need a re-bucketing migration later. Families use the
exact same permanent-id/editable-label identity pattern B4 already
established for categories (`ARCHITECTURE.md` §12) — every category
gets a permanent `familyId`, resolved to a label at render time, never
stored as a name string anywhere.

**Seeded families:** `fixed` → "Fixed", `sim` → "SIM Cards", `others`
→ "Others" (`orgs/{orgId}.families: [{id,label}]`, `js/orgConfig.js
DEFAULT_FAMILIES`).

**Default category→family mapping (existing four categories):**
`starter`, `essential`, `ultimate` → `fixed`; `mobile` → `sim`. No
existing category defaults to `others` — that bucket exists for
future categories a manager creates without picking a family, or an
explicit reassignment (`js/orgConfig.js DEFAULT_FAMILY_MAPPING`).

**Migration (`js/products.js`):** unlike B4's category migration
(many product/user documents), this touches ONE document
(`orgs/{orgId}`) — seeds `families` if missing, stamps `familyId` on
any category that doesn't have one yet. Both parts independently
idempotent. Dry-run preview shows the exact mapping before writing,
triggered by a banner in the existing Categories & Contract Terms
modal that disappears once nothing is left to migrate. Verified live:
dry-run matched the mapping above exactly; post-write `getDoc`
confirmed the correct `families` array and every category's
`familyId`, with unrelated org-config fields (`runRateDefaultVisible`,
`orgId`) untouched by the merge-then-set write; re-checking afterward
correctly reports already-migrated and the banner disappears.

**Manager UI (extends the Categories & Contract Terms modal):** a
"Product Families" section — mirrors the existing category CRUD
exactly (rename via label + Save, add via a new-label input,
id-slugified from the label). Delete is blocked while any category
still references the family id, with the blocking category names
listed — same "list the blockers, never a silent cascade" pattern
category delete already uses against products. Each category row
gained a family `<select>` that re-parents LIVE (saves on `change`,
no separate Save click needed — a dropdown choice is already a
discrete, complete action, unlike the label input's free text which
must not autosave per keystroke). New categories default to
`familyId:'others'` rather than landing unmapped. Verified live: full
add/rename/delete round-trip on a throwaway family, and moving a
category between families and back, both confirmed via `getDoc` (not
just optimistic UI state) — the blocking-reference list and the
delete-button's enabled/disabled state both updated correctly and
instantly in both directions.

**Product category move:** the existing Edit Product modal's category
`<select>` (built in B4, unchanged) already persists a category
change — verified live rather than assumed, moving a real product
between categories and back with a `getDoc` check after each
direction. No code change was needed here; this closes out the "move
products between categories" part of the manager requirement.

**Scope discipline:** grepped the whole codebase for hardcoded family
name-strings ("Fixed"/"SIM Cards"/"Others") outside `DEFAULT_FAMILIES`
itself, and for any `familyId`/`familyLabel`/`currentFamilies`/
`findFamilyIdByLabel` reference outside `js/orgConfig.js`/
`js/products.js` — zero hits on both, confirming labels resolve by id
everywhere and this session touched no dashboard or other file, per
the fixed decision that families surface in Phase C's reports, not
this session's UI.

No rules or index changes were needed — the `orgs` update path was
already manager-unrestricted for the sections this session touches,
and `products.category` was already manager-editable. No new queries
were added. B5 smoke (Submit-to-Backend's `accTransfer`/`sourcedBy`
checkboxes, Queue tab, Dashboard) re-verified with zero regressions —
this session's only shared surface, `js/orgConfig.js`, is not imported
by `js/queue.js` or `js/dashboard*.js` at all.
