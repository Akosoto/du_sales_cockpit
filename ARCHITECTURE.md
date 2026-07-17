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

Still open from audit: db.js mutation gateway + orgId stamping +
sameOrg() rules (Session 2); rollups replace full-collection scans
(Phase C); string-derived close-month analytics → structured closedAt
(Session 2); product soft-delete (Session 2); backup-export button
(Session 2, BEFORE orgId migration); hygiene one-liners (item 12).

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
                      **status: pendingVerification|submittedToDu|
                        inProgress|activated|rejected** (coarse),
                      **events[]** (append-only timeline — see §5),
                      items[] {productId, qty, mrc, **typeOfRequest**,
                        **contractTerm**, **categoryFields** (gaid /
                        msisdn / simSerial / passcode — optional),
                        **sprFlag + sprNote**},
                      **accTransfer** {flag, fromPartner} (also writes
                        company partnerHistory),
                      **verification** {done, method:call|email, ts, or
                        auto-mark "proceeded without verification"},
                      requiredDocs[] {type, status, expiryDate,
                        storageRef}, assignedBackendAgent
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

## 5. Submissions — Status + Event Timeline (replaces 5 fixed stages)

Coarse status: pendingVerification → submittedToDu → inProgress →
activated | rejected. hasDuAccount = informational badge (no skip
logic). Append-only typed events (actor, ts, payload):

docsVerified · verificationCall {ts} · verificationEmail {ts} ·
submittedToDu (auto-marks "proceeded without verification" if no
verification event exists) · activityNo {value} · workOrderNo {value} ·
appointment {date, time, person} · biometric · sprObtained {note} ·
correction {note} (backend trivial fixes) · note · activated {ts} ·
rejected {reason from org list + note}

Rejected → returns to submitting agent (fix + resubmit). Timeline
read-only to submitting agent + their TL + manager; whole backend dept
read/write per assignment. Doc-expiry warning at agent's desk when any
document expires < 15 days (establishment card highlighted — SIM
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

## 10. Build Phases (revised)

- **Session 2 (next, prompt ready)**: backup-export button FIRST →
  merge wip-submissions → db.js gateway (orgId, audit fields, closedAt,
  history cap, auditLog) → product soft-delete → orgId migration →
  sameOrg() rules (migration runs BEFORE rules publish).
- **Phase B — schema + submissions v2**: company enrichment (contacts,
  address, accountCode, segment, expiries) + dedup by accountCode;
  status+timeline replaces stages; per-category item fields (GAID…);
  typeOfRequest; SPR; accTransfer; verification gate; rejection
  reasons; doc-expiry warnings; StorageAdapter + b64 driver + pdf.js;
  backend queue UI + event logging; copy/export tools.
- **Phase C — stats engine** (rollups incl. AED values + families).
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
