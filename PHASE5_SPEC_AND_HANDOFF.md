# du Sales Cockpit — Phase 5+ Data Model Spec & Claude Code Handoff

Status as of this doc: Phases 1–4 complete (foundation, lead management, scripts w/ approval,
products & pricing). Follow-up buckets and activity log already exist on the Dashboard —
treat the old "Phase 5: Follow-ups & Activity Trail" as **done**, not pending.

This doc defines the next real phase of work: turning the app from a single sales-pipeline
tool into a two-department workflow (Sales → Backend) with proper client/company reporting.

Written to be **extended, not replaced** — Ashok expects to keep adding scope on top of this,
so every design choice below favors generality (a `department` field instead of a hardcoded
role, snapshotted data instead of live references, reused patterns instead of new ones) over
the fastest thing to ship today.

---

## 0. The one blocking decision: Company as a real entity

Right now `leads.company` is a free-text string. Two agents typing the same client's name
slightly differently ("Al Futtaim Trading LLC" vs "Al-Futtaim Trading") produces two
unrelated records. **Any "what products does this client use" report is unreliable until
this is fixed.** Everything else in this doc assumes this is built first.

---

## 1. New / changed collections

### `companies` (NEW)
```
{
  id,
  name,                    // display name
  normalizedName,          // lowercase, trimmed, punctuation-stripped — used for dedup matching
  industry, city,
  hasDuAccount: boolean,   // NEW — drives whether a submission skips the Account Creation stage
  createdBy, createdAt,
  mergedInto: null | companyId,   // if this doc was merged into a survivor company
  lastEditedBy, lastEditedAt
}
```
- `mergedInto` lets you soft-merge duplicates later without deleting history — any code
  reading a company should follow `mergedInto` if set (one level, no chains).
- A manager-only "Merge Companies" tool is needed eventually (pick survivor, migrate all
  `leads.companyId` and `submissions.companyId` pointing at the loser). Not urgent for v1 —
  flag duplicates, don't force merging on day one.

### `leads` (MODIFIED)
- Add `companyId` (required going forward).
- Keep `company` string as a display cache, kept in sync with `companies.name` — don't make
  every read do a join.
- Everything else unchanged (`stage`, `followup`, `history[]`, etc.)

### `teams` (MODIFIED)
```
{
  id, name,
  department: 'sales' | 'backend',   // NEW
  ...
}
```

### `users` (MODIFIED)
```
{
  id, name, email,
  role: 'manager' | 'team_lead' | 'agent',   // role stays generic — do NOT add role:'backend_agent'
  department: 'sales' | 'backend' | null,    // NEW — null/omitted for manager (sees both)
  teamId, tlId, monthlyTarget, targetSource, active, ...
}
```
**Why generalize instead of adding a 4th role:** the codebase already has `role==='manager'`
/`'team_lead'`/`'agent'` checks in 30+ places. A `department` field lets permission logic stay
`role + department` (two small checks) instead of every future department multiplying the
number of role strings and every `if` branch that checks them. This is the difference between
adding one field vs. touching the whole file every time a new department is added — and
Ashok has said more changes are coming, so this matters more than usual.

### `submissions` (NEW) — the agent → backend handoff

**Decided:** one submission can bundle multiple products for the same company. Rather than
literal "split into separate records" (expensive — has to decide what happens to shared files,
history, IDs), each bundled product is a **line item with its own pipeline position** inside
one submission. This gets nearly all the value of splitting — backend can move product A to
Activated while sending product B back for correction — without the record-breaking
complexity. True splitting into separate documents is a clean future add if this ever proves
insufficient; do not build it now.

**Each item moves through a real multi-stage pipeline, not a binary approve/reject:**
```
SUBMISSION_STAGES = ['Account Creation', 'Financial Approval', 'Activity', 'Work Order', 'Activated']
```
- `Account Creation` is **skipped** if `companies.hasDuAccount === true` at submit time — the
  item starts at `Financial Approval` instead. Reuse the existing `STAGES`/`stagePill` pattern
  from the lead pipeline for this UI — same visual language, proven component.
- At any stage, backend can set `blocked: 'needsCorrection'` (sent back to the agent with a
  note, resumes at `pausedAtStage` once refixed and resubmitted — **does not restart the
  pipeline from the beginning**) or `blocked: 'rejected'` (terminal, no resubmission).
- **Activity and Work Order require a reference number to advance past them** — the UI should
  not let backend mark either stage complete without `activityRef`/`workOrderRef` filled in.
  Financial Approval and Account Creation stay free-text-note-only for now; tell me if either
  needs a structured field too once you know more about what backend actually records there.

```
{
  id,
  leadId, companyId,                          // denormalized company for direct queries
  agentId, agentName,
  teamId, tlId,                               // sales team/TL credit, snapshotted at submit time
  items: [
    {
      itemId,                                 // short id, unique within this submission
      productId, productName, category,       // SNAPSHOT, not a live reference — a later
                                                 catalog price/name change must not rewrite history
      subType,                                 // e.g. chosen pricing option / plan label
      dealValue,
      stage: 'Account Creation' | 'Financial Approval' | 'Activity' | 'Work Order' | 'Activated',
      activityRef: null | string,              // reference number captured when Activity stage completes
      workOrderRef: null | string,              // reference number captured when Work Order stage completes
      blocked: null | 'needsCorrection' | 'rejected',
      pausedAtStage: null | stageName,         // set when blocked, so correction resumes here
      correctionNote,                          // populated when blocked = 'needsCorrection'
      stageHistory: [ { ts, actorId, actorName, stage, note } ],  // same pattern as leads.history[]
      assignedBackendAgent: userId | null,
      activatedAt: null | timestamp            // set when stage reaches 'Activated' — this is
                                                 // what drives the agent's target update, not
                                                 // the lead's 'Closed' stage (see section 2b)
    }
  ],
  requiredDocs: [ docType, ... ],              // computed at submit time: MANDATORY_DOC_TYPES
                                                 // + this item set's product-specific requirements
  files: [ { docType, name, storagePath, uploadedAt, uploadedBy, size, type } ],  // docType is
                                                 // required on every file so completeness can be
                                                 // checked at a glance — shared across items for now,
                                                 // per-item files are a future add if needed
  submittedAt, submittedBy,
  createdAt, lastEditedBy, lastEditedAt
}
```
**Stage lives on the item, not the submission.** A submission's overall status (open vs.
fully resolved) is just derived by checking whether every item is Activated/Rejected — compute
it at render time like the follow-up buckets already do, don't store it as a field that can
drift out of sync.

### Document requirements

Two tiers, both needed for the "3 of 3 universal docs present, missing: Emirates ID (Back)"
completeness check to work. **Corrected per Ashok:** only Trade License and Emirates ID are
truly universal — everything else (Ejari, Establishment Card, etc.) depends on the specific
product/connection and belongs in the per-product list, not the baseline.
```
MANDATORY_DOC_TYPES = ['Trade License', 'Emirates ID (Front)', 'Emirates ID (Back)']
// required on EVERY submission, regardless of product
```
- `products.requiredDocuments: [ { docType, label } ]` — per-product extra requirements.
  Ejari and Establishment Card are examples of what goes here, not baseline — they apply to
  some connections, not all. Empty/TBD for now, Ashok defines these later per product — the
  field exists so adding them later is just data entry, not a schema change.
- At submit time, `requiredDocs` = `MANDATORY_DOC_TYPES` + the product-specific list for every
  item's product (deduplicated). The submit UI checks uploaded `files[].docType` against this
  list and **blocks submission** if anything mandatory is missing — catch it at the agent's
  desk, not after it reaches backend.
- Because per-product requirements aren't defined yet, week one's gate is effectively just the
  3 universal docs. Nothing about the gating logic needs to change when Ashok adds per-product
  lists later — it already reads from `products.requiredDocuments`, empty or not.
- **Future extension, not week one:** once document expiry tracking (section 1, `documents`
  subcollection) exists, Trade License and Emirates ID could be pulled from a reusable
  per-company document vault instead of re-uploaded on every submission — they don't change
  often, and expiry tracking would flag when they're stale. Duplicate upload per submission is
  fine for now.

**Status pipeline is deliberately not just approve/reject.** `needsCorrection` sends an item
back to the agent with a reason and resumes where it paused — otherwise submissions rot in
limbo with nobody accountable, the same trap the script-approval workflow could fall into if
turnaround isn't visible.

### Backend agent assignment model

**Decided:** needs both manual and automated assignment, with product-type specialization and
failover when a specialist is unavailable. A fully automated engine with load balancing is not
a week-one build — here's the pragmatic version that still satisfies the requirement, with a
clean upgrade path later.

- `users` (backend agents) get two new fields: `specialties: [category]` (empty/omitted =
  generalist, handles anything) and `available: true|false` (manual toggle for "I'm out today").
- `teams` (backend department) get `assignmentMode: 'auto' | 'manual'`, set by the TL.
- **Auto mode, v1 logic** (runs per item, since a bundled submission can span categories):
  1. Find available backend agents in the team whose `specialties` include this item's category.
  2. If exactly one match → assign to them.
  3. If multiple matches → alternate between them (simple rotation, not a load-balancer).
  4. If zero matches (no specialist available) → leave `assignedBackendAgent: null`, item sits
     in a shared queue visible to the whole backend team, and the TL gets a badge to assign
     it manually.
- **Manual mode:** every item starts unassigned; TL assigns by hand. Same UI either way — auto
  mode just pre-fills the assignment, TL/manager can always override it regardless of mode.
- **Future upgrade path (not week one):** replace step 3's simple rotation with "assign to
  whichever specialist currently has the fewest open items" — a small change once you have
  real usage data to know if simple rotation is actually causing imbalance.

### Data Import Tool (NEW) — bringing existing records into the app

**Decided:** primarily a one-time bulk load of pre-existing data before the team fully moves
onto the app, but built as a **persistent manager-only screen**, not a disposable script — so
it stays available if more outside data needs to come in later. Covers all three: companies,
leads, and historical (already-closed/activated) deals for reporting continuity.

- Manager-only tab. CSV upload → parse → preview table → confirm → write. Same shape as the
  existing `seedLeads()`/`seedProducts()` pattern already in the codebase (manager-triggered
  bulk write), just reading from an uploaded file instead of hardcoded seed data.
- **Import order matters — companies first, then leads, then historical submissions** — each
  later type links to the one before it (`leads.companyId`, `submissions.leadId`/`companyId`).
- Company rows reuse the exact same normalization/dedup logic as the company backfill script
  (section 3) — an imported "Al Futtaim Trading" and an already-existing "Al-Futtaim Trading"
  should match, not create a duplicate. Building the backfill script and the import tool's
  company-matching logic as one shared function, not two, avoids the two ever drifting apart.
- **Historical submissions are a special case — they do NOT go through the live pipeline.**
  A deal that was already closed and activated before this system existed should be imported
  directly with `stage: 'Activated'` and an explicit historical `activatedAt` date the
  importer sets (not "now") — it should never re-enter Account Creation → Financial Approval
  etc. This also means it's safe for the target auto-update logic (section 2a): since
  attainment is computed per calendar month from `activatedAt`, an old import date naturally
  won't affect the *current* month's numbers unless it genuinely belongs there.
- **Scope reality check:** this is real extra surface in an already tight week. If Day 1 runs
  long, the safe thing to cut first is the historical-submissions import specifically — it's
  for reporting continuity, not for the workflow to function. Companies + leads import is more
  urgent (it's what makes the app usable with real data at all) and should not be the part
  that slips.


```
{
  id, companyId,
  type,                     // e.g. Trade License, Emirates ID, VAT Certificate
  fileRef: { storagePath, name },
  issueDate, expiryDate,
  uploadedBy, uploadedAt,
  lastEditedBy, lastEditedAt
}
```
`status` (valid / expiring-soon / expired) is **computed client-side from `expiryDate`**, same
pattern as the existing follow-up buckets — don't store a status field that can go stale.

---

## 2a. Agent target auto-update — this changes EXISTING dashboard code, not just new code

Today, `renderDashboardTab()` derives current-month attainment from `leads.history[]` entries
containing `'→ Closed'`. Going forward, target attainment must be driven by **Activation**,
not by the lead being marked Closed — because activation is confirmed by backend, later, and
can still be rejected after an agent believes they've won the deal.

- Keep `lead.stage = 'Closed'` exactly as it works today — it's still the agent's own
  pipeline milestone and should keep showing up in their pipeline view unchanged.
- Add a **second, separate calculation** for the dashboard's target/attainment numbers: scan
  `submissions[].items[]` for `activatedAt` falling in the current month, filtered by
  `agentId`/`teamId` the same way leads are scoped today, sum `dealValue` from there instead.
- This means the Dashboard needs a new data fetch (`submissions`) alongside the existing
  `leads` fetch, and the `closeMonthKey()`/attainment logic needs a second version keyed off
  `activatedAt` instead of the `history[]` string-match. Don't try to unify these into one
  function — Closed (sales pipeline signal) and Activated (finance/ops confirmation) are
  genuinely different milestones and conflating them is how a rejected-after-Closed deal ends
  up silently still counted.

---

## 2b. Reports — how they should be computed

Keep the existing pattern (fetch scoped collection, reduce client-side) rather than
introducing Cloud Functions — it's consistent with how Dashboard/Pipeline already work and
you don't have a backend server. Slicing by department/team/agent/company all becomes
filtering `submissions` by the denormalized `teamId`/`tlId`/`agentId`/`companyId` fields —
no joins needed at read time because they were captured at submission time.

**Open question — needs your answer before this gets built:** what does "projection report"
actually mean? Two common definitions, pick one (or define your own):
- **Pipeline-based**: open leads × historical win rate × average deal value = forecasted revenue
- **Submission-based**: submitted-but-not-yet-activated value = near-term expected activations

This changes what data the report reads, so it needs to be nailed down before that screen
gets built — not a coding question, a business-definition one.

---

## 3. Migration plan for existing data

1. Ship `companies` collection + Firestore/Storage rules (additive, no risk to existing data).
2. Run a one-time backfill (manager-triggered button, same UX pattern as the existing
   `repairLeadTeamData()` function): group existing leads by normalized company name, create
   one `companies` doc per unique group, write `companyId` back onto each lead.
3. New leads require `companyId` going forward (pick existing company or create new, with a
   fuzzy-match warning if the typed name is close to an existing one — cheap way to reduce
   future duplicates without blocking data entry).
4. Merge-duplicates tool comes later, once you can see how bad the duplication actually is.

---

## 4. One-week prototype plan

Goal: a working end-to-end demo of the NEW loop — agent closes a lead → submits it (possibly
bundling multiple products, gated on mandatory documents) → it's assigned to backend (auto or
manual) → each item moves through Account Creation → Financial Approval → Activity → Work
Order → Activated, with a correction loop back to the agent at any stage → on Activation, the
agent's target updates automatically.

**Explicitly cut from week one** (not abandoned — just not blocking a working prototype):
- Document expiry tracking and the reusable per-company document vault — fully decoupled,
  add later. Week one: agents re-upload mandatory docs per submission, duplication is fine.
- Company merge/dedup tooling — build the entity + backfill, skip the merge UI. Live with
  occasional duplicates for now.
- Product-specific document requirements — the `products.requiredDocuments` field exists in
  the schema, but only the 5 mandatory baseline doc types need to be enforced this week.
  Per-product extras get added later as Ashok defines them, no code change needed then.
- Sliced reports (department/team/agent/client breakdowns) — skip until "projection report"
  is defined and there's real submission data to report on. A basic status-count view is
  enough for week one, if time allows.
- Load-balanced auto-assignment — ship the simple rotation version (see assignment model
  above), not the fewest-open-items version.
- The pre-existing small polish items (product search, per-lead history view, mobile card
  layout, real-time sync) — none of them block this demo. Don't touch them this week.

**Day-by-day:**
1. **Day 1:** Companies collection + Firestore rules + backfill script (group existing leads
   by normalized name, create company docs, write `companyId` back, default `hasDuAccount:
   false`) + the Data Import Tool's company/lead import, built on the same normalization logic
   as the backfill so there's one shared matching function, not two. Bulk-assign leads
   (isolated, quick, ships same day). Split `index.html`'s single script block into ES modules
   before writing new feature code on top of it. **This is now the heaviest day in the plan —
   if it runs long, cut the import tool's historical-submissions path first (see note above),
   not the company backfill itself.**
2. **Day 2:** `teams`/`users` schema additions (`department`, `specialties`, `available`,
   `assignmentMode`) + Firestore/Storage rules for the backend department and file access.
   This is the same class of rule-writing that needed a fix once before — go slowly here.
3. **Day 3:** Submission creation — agent-side "Submit to Backend" action from a closed lead
   (multi-product line items, docType-tagged file upload, submit blocked until the 3 universal
   `MANDATORY_DOC_TYPES` are present), assignment logic (auto v1 + manual) running per item.
4. **Day 4:** Backend-side stage pipeline — queue view, per-item stage advancement through
   Account Creation (conditionally skipped) → Financial Approval → Activity (requires
   `activityRef`) → Work Order (requires `workOrderRef`) → Activated, plus the
   `needsCorrection`/`rejected` branch with resume-at-`pausedAtStage`.
5. **Day 5:** Target auto-update wiring (section 2a — new `submissions` fetch on Dashboard,
   attainment computed off `activatedAt`, kept separate from the existing Closed-based logic)
   + basic backend dashboard (open queue, assigned-to-me, simple stage counts) + the Data
   Import Tool's historical-submissions path, if it didn't already happen on Day 1.
6. **Day 6:** End-to-end test with real accounts (one sales agent, one backend TL, one backend
   specialist, one generalist) — walk a real submission through every stage, including a
   correction round-trip, a bundled multi-product submission, reference numbers on Activity
   and Work Order, and confirm the agent's target only updates once an item actually reaches
   Activated. Also run a real import of actual historical data through the Import Tool.
7. **Day 7:** Buffer. Something in a scope this size will slip — this day exists so "day 6
   testing found a bug" doesn't eat into "day 7 was supposed to be the demo."

**After the prototype works:** revisit sliced reports, document expiry + vault, company merge
tooling, product-specific document requirements, and the old polish backlog as their own
follow-up passes — not squeezed into week one.

## 5. Other things worth deciding now, cheap to design in / expensive to retrofit
- Submission files should be visible to: submitting agent, their TL, backend team, manager —
  not other sales agents. Needs its own Storage security rule audit, same care as the
  Firestore `tlId` rule bug you already caught once.
- Restrict submission/document uploads to PDF + image types — no executables. Client-side
  code cannot virus-scan; this is a hard limitation of the stack, not a gap to "fix."
- Backend needs a visible unread/queue badge for new submissions — same visibility lesson as
  the follow-up buckets: if it's not on the screen they land on, it won't get acted on.
- At 3,163 lines already, everything (CSS/HTML/JS) still lives in one `<script>` block in one
  `index.html`. This phase will likely add 1,500+ lines. Strongly recommend splitting into a
  few ES module files (`leads.js`, `submissions.js`, `companies.js`, `reports.js` etc.) via
  proper `import`/`export` before this build starts — no build step required, just multiple
  `<script type="module">` files. Doing this now is much cheaper than doing it after the file
  doubles again.

---

## 6. Claude Code handoff prompt

Paste this as the opening message in a new Claude Code session in the project folder.

```
I'm continuing work on the du Sales Cockpit — a Firebase-backed B2B sales management web app
(single index.html, vanilla JS ES modules, Firebase Auth + Firestore, no build step).

CURRENT STATE:
- Phases 1–4 complete: foundation, lead management, scripts with approval workflow,
  products & pricing (19-product catalog with pricingOptions[], discounts, monthlyWaivers[]).
- Three roles today: manager, team_lead, agent. "Model B" structure — each team_lead owns an
  isolated sub-group of agents via a tlId field on the agent's user doc.
- Follow-up buckets (overdue/today/this-week) and a global activity feed already exist on the
  Dashboard tab, built from history[] arrays already present on lead documents.
- Firestore security rules were previously audited and fixed once already (a fragile
  secondary tlId lookup was replaced with a direct teamId comparison) — treat rules changes
  with the same level of care going forward, they're easy to get subtly wrong.

WORKING CONVENTIONS (do not deviate):
- Surgical modifications only, via clearly labelled replace blocks — never full-file
  rewrites, never regenerate index.html from scratch.
- Maintain PROJECT_SPEC.md as the continuity doc across sessions — update it as you go.
- Read PHASE5_SPEC_AND_HANDOFF.md (in the project folder) in full before writing any code —
  it defines the data model for everything below and the reasoning behind each choice.

GOAL: a working prototype in one week — agent closes a lead, submits it to a new backend
department (possibly bundling multiple products, with files), backend assigns and processes
each item, corrections loop back to the agent. See section 4 of PHASE5_SPEC_AND_HANDOFF.md
for the exact day-by-day plan and what's explicitly cut from this week's scope (document
expiry, report slicing, company merge tooling, load-balanced assignment, and all pre-existing
polish items like product search/mobile layout/real-time sync — none of that this week).

WORKFLOW DECISIONS ALREADY MADE (do not re-derive, just implement):
- A submission can bundle multiple products for one company. Each bundled product is a line
  item moving through its OWN pipeline position — not a separate submission record.
- The item pipeline is: Account Creation (skipped if companies.hasDuAccount is true) →
  Financial Approval → Activity → Work Order → Activated. This is a real multi-stage pipeline,
  not a binary review — reuse the existing STAGES/stagePill pattern from the lead pipeline for
  the UI, don't invent new components for it.
- Backend can block an item at any stage as 'needsCorrection' (sent back to the agent with a
  note, resumes at the paused stage on resubmit — never restarts from the beginning) or
  'rejected' (terminal).
- Documents need types, not a flat file list — every uploaded file is tagged with a docType.
  MANDATORY_DOC_TYPES = Trade License, Emirates ID (Front), Emirates ID (Back) — ONLY these
  three are required on every submission regardless of product. Ejari, Establishment Card, and
  anything else are per-product requirements (products.requiredDocuments field, empty/TBD for
  now, Ashok adds these later — no schema change needed then). The Submit button on the agent
  side must be blocked until the 3 universal doc types are present — catch missing docs before
  backend ever sees the submission, don't rely on the correction loop for something
  preventable at entry.
- Activity and Work Order stages each require a reference number (`activityRef`,
  `workOrderRef`) before backend can advance past them. Financial Approval and Account
  Creation are free-text-note-only for now.
- A persistent (not disposable) manager-only Data Import Tool is needed: CSV upload → preview
  → confirm → write, for companies, leads, and historical (already-activated) submissions, in
  that order. Historical submissions import directly as stage='Activated' with an explicit
  historical activatedAt date — they must never re-enter the live pipeline. Reuse the same
  company normalization/dedup function for both the import tool and the backfill script — one
  shared function, not two. See section 1, "Data Import Tool", for the full spec and what to
  cut first (historical-submissions import) if Day 1 runs long.
- Backend assignment needs both manual and automated modes, with product-category
  specialization and failover when a specialist is unavailable. Build the v1 logic exactly as
  specified in section 1 ("Backend agent assignment model") — simple rotation among available
  specialists, shared queue + TL badge when nobody matches. Do not build load-balancing yet.
- Agent's monthly target updates automatically when an item reaches Activated — NOT when the
  lead is marked Closed. This requires a change to the EXISTING renderDashboardTab() logic,
  not just new code — see section 2a for exactly what changes and why Closed vs. Activated
  must stay two separate calculations, not merged into one.

NEXT STEPS — in this order, do not skip ahead:
1. Bulk-assign multiple leads to one agent/team_lead in a single action (isolated, ship first).
2. Companies as a real Firestore collection, decoupled from the free-text company field
   currently on leads — see section 0 and 1 of PHASE5_SPEC_AND_HANDOFF.md, plus the exact
   schema and migration approach (section 3). Include hasDuAccount on the company doc. Build
   the Data Import Tool's company-matching logic as the same shared function used by the
   backfill, not a separate one.
3. Before writing further feature code, split index.html's single inline <script type="module">
   block into a few real ES module files (see section 5) — the file is 3,163 lines already
   and this phase adds substantially more.
4. Then follow the day-by-day plan in section 4: teams/users schema + rules for the backend
   department, then submission creation with document gating, then the backend stage
   pipeline, then target auto-update wiring, then end-to-end testing with real accounts.
5. Do NOT start on report slicing, document expiry/vault, company merge tooling, or
   product-specific document requirements this week — those are explicitly deferred to after
   the prototype is validated.

Start by reading PHASE5_SPEC_AND_HANDOFF.md and PROJECT_SPEC.md in full, then propose the
exact Firestore rule changes and migration script for the companies collection before writing
any UI code.
```
