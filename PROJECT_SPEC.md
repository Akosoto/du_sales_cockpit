# du Sales Cockpit — Project Spec
**Last updated:** July 2026 | **Session B5 (Sourcing & Transfer Tracking) shipped** — corrects a
B4 design mistake: donut/contributor attribution now reads a new `sourcedBy` field instead of
`accTransfer` (which is an operational account-takeover marker, not a sourcing signal — crediting
revenue to it was wrong by design), plus a new `transferStatus` tracker
(`pending`/`completed`/`rejected`+reason) for `accTransfer`-flagged lines, structurally isolated
from the submission's own document-review lifecycle. No rules or index changes needed. See the
Session B5 history entry below and `ARCHITECTURE.md` §13. Session B4 (Manager's Cockpit — category
identity refactor, Products config panel, the dashboard itself, a real users-collection
privilege-escalation fix found during its rules review) shipped in the prior session, unchanged
since except for the attribution repoint above — see `ARCHITECTURE.md` §12.
**`ARCHITECTURE.md` is the authoritative spec for all future work** — this file stays as
historical/reference documentation for what's already shipped.

---

## Overview

A Firebase-backed B2B sales management web app for Shaun Technologies Trading LLC (authorised du Business partner, Dubai). Built for a multi-role sales team to manage leads, track pipeline, standardise outreach scripts across channels, and reference du Business product pricing with discount and waiver management.

**Live URL:** https://akosoto.github.io/du_sales_cockpit
**Firebase project:** `du-sales-cockpit`
**Stack:** `index.html` (shell: HTML + CSS only) + `js/*.js` ES modules, Firebase Auth, Firestore, no build step
**Repo:** https://github.com/Akosoto/du_sales_cockpit (branch `main`)

**Deployment (NEW, Phase A — `.github/workflows/deploy.yml`):** GitHub Actions build, not the old
"deploy from branch" static mode. `config.js` is gitignored (per-deployment Firebase config +
`orgId` + branding + `storageDriver` + `featureFlags` — see `config.example.js` for the template);
the workflow writes it from a repository secret (`CONFIG_JS`, whole-file contents) via a shell-safe
`env:` block before uploading the Pages artifact. **One-time GitHub setup required:** Pages source
switched to "GitHub Actions" (Settings → Pages) and the `CONFIG_JS` repo secret populated from the
raw local `config.js` file — never paste it from a chat message, which may render/redact the API
key as bullet characters (this caused a real production outage this session, see Phase A0/A below).

### File structure (as of the Phase 5 module split)
```
index.html          — HTML shell + all CSS, loads js/main.js as the sole entry script
js/state.js          — Firebase init (db/auth/auth2), SEED_EMAILS, STAGES, SP, mutable CU/CP/TAB
                        (exported as live bindings; only state.js's own setUser()/setTab() may
                        reassign them — every other module just imports and reads)
js/db.js             — single Firestore mutation gateway: dbAdd/dbSet/dbUpdate/dbDelete/newBatch/
                        batchAdd/batchSet/batchUpdate/batchDelete/logBulkAudit. Every module's
                        direct addDoc/setDoc/updateDoc/deleteDoc/writeBatch call is migrated
                        through this file. Stamps `orgId` from config.js on every create,
                        centralises createdBy/createdAt/lastEditedBy/lastEditedAt, auto-writes a
                        structured `closedAt` on `stage`→`'Closed'`, caps `history[]` at 100
                        entries, writes one `auditLog` doc per mutation in the SAME batch.
                        `opts.skipAudit:true` skips BOTH the audit fields AND the auditLog write —
                        used for narrow `affectedKeys().hasOnly([...])`-bound call sites, the orgId
                        migration, auth.js's self-registration bootstrap (CU/CP still null there),
                        and every bulk-op loop (see `logBulkAudit()`'s own doc comment — N ops
                        would otherwise double to 2N writes and blow Firestore's 500-write batch
                        cap). `logBulkAudit(description, count)` writes ONE summary entry for an
                        entire bulk run in place of the per-op trail it can't afford.
js/helpers.js         — v, esc, now, fmtDate, disable, enable, toast, modal, closeModal,
                        confirmModal, stagePill, calculateTLTarget, buildMsFilter, wireMsFilter
js/auth.js            — login/logout, ensureProfile, onAuthStateChanged routing, change-password
js/org.js             — Org & Teams tab, team/user CRUD, seedLeads, repairLeadTeamData,
                        Companies card (list/edit/backfill), permission-checklist wiring,
                        runOrgIdMigration (one-off manager-triggered orgId backfill, banner+button
                        UX matching repairLeadTeamData, safe to re-run), runBackupExport
                        (manager-only, downloads one timestamped JSON of every org-scoped
                        collection), commitBulkOps (shared chunked-bulk-commit helper for this
                        file's 4 cascades — team delete, member removal, hard-delete,
                        department-change — CHUNK 200 + skipAudit + one summary logBulkAudit call),
                        runCategoryMigration (Session B4, one-off manager-triggered
                        products.category/users.specialties[] name-string→ID conversion + orgs
                        doc creation — dry-run preview modal before writing, same banner+button
                        pattern, safe to re-run, unmapped values flagged not guessed at)
js/leads.js           — Pipeline tab (incl. bulk-assign, submissionSummary badge on Closed rows),
                        lead modal (close-to-submit flow: saving into Closed transitions straight
                        into Submit to Backend), add-lead modal (type-ahead company picker via
                        companies.js's searchCompanies — see below), Submit to Backend modal
                        (bundle creation, one submission doc per product line), the read-only
                        Submission Timeline view (showSubmissionTimelineModal — also offers
                        Download bundle PDF and, on the submitting agent's own rejected line, Fix
                        & Resubmit — showFixResubmitModal). Pipeline tab is server-side paginated,
                        25 leads/page, numbered page buttons; requires 5 Firestore composite
                        indexes (created, see Firestore Security Rules below).
js/queue.js           — Backend Queue tab (manager + active backend department staff only):
                        Unassigned/My Queue/All views, claim/reassign, the submission action panel
                        (every appendEvent action, on-demand doc viewing with an older-versions
                        expander, backend document attachments, Download bundle PDF, copy tools —
                        COPY_ALL_FIELDS + per-field copy icons), transfer outcome buttons (Session
                        B5 — Mark Transfer Completed/Rejected, accTransfer-flagged lines only,
                        pending-state only) + the rejected stall badge in the list and action panel
js/pdfExport.js       — downloadBundlePdf: compiles a bundle's latest-version document pages into
                        one combined PDF via jsPDF (loaded from jsdelivr's `+esm` endpoint — the
                        package's own published ESM build has an unresolvable bare import)
js/documents.js       — captureFile: client-side capture pipeline (image canvas-resize + JPEG
                        recompression, PDF page-to-image via pdf.js) feeding the StorageAdapter
js/storage/index.js   — StorageAdapter façade over a driver registry (config.storageDriver);
                        feature code never imports a driver directly
js/storage/firestore-b64.js — the only driver today: one Firestore doc per PAGE in a top-level
                        submissionDocs collection, docId carries a version segment
                        ({bundleId}_{docType}_v{n}_{pageIndex}, falling back to the pre-versioning
                        id shape for old docs), 900KB-encoded hard ceiling, manager-only bulk
                        delete (retention sweep)
js/companies.js       — normalizeCompanyName, findFuzzyMatch (operates ONLY on an already-fetched
                        ≤10-doc candidate set, never a full scan), fetchCompanies (raw full scan —
                        ONLY for backfillCompanies + the Org tab Companies card, never a picker),
                        searchCompanies (type-ahead: debounced prefix-range query on
                        normalizedName + parallel accountCode check), findCompanyByAccountCode
                        (single targeted read), findOrCreateCompany (two targeted reads —
                        accountCode then normalizedName — never a full scan), backfillCompanies
js/permissions.js     — PERMISSIONS catalog, hasPermission(), searchable checklist
                        HTML/wiring for Edit Team/Edit User modals
js/submissions.js     — computeRequiredDocs, docExpiryWarnings (company docExpiries within 15
                        days, establishment card flagged specially), pickBackendAgent
                        (rotation-based auto-assign with a fallback to any available agent if no
                        specialty matches), createSubmissions (plural — one doc per product line,
                        shared bundleId, resolves teamId/tlId from the assigned agent's own live
                        profile, refuses the submission if both that and the lead's own fields are
                        empty), appendEvent (the event/status-transition engine — every timeline
                        write goes through this, runs inside a transaction, also recomputes +
                        stamps the bundle's collapsed submissionSummary onto the lead in the same
                        transaction; extraFields param merges additional field changes into the
                        same atomic write for claim/reassign/resubmit), collapseSubmissionSummary
                        (pure — the pipeline badge's collapse rule), claimSubmission (Session B4:
                        also stamps a queryable claimedAt on the unassigned->claimed transition
                        only, never on a later reassignSubmission — feeds the Manager's Cockpit's
                        queue-wait metric; pre-B4 claims and auto-assigned submissions have no
                        claimedAt and surface as N/A rather than a fabricated value)/
                        reassignSubmission, attachBackendDocument (backend-only additional
                        documents) — pure logic; the modal UI lives in leads.js and queue.js
js/dashboard.js       — Dashboard tab (all roles: leads/stage-based KPIs, agent performance,
                        monthly history, follow-ups, activity log) PLUS (Session B4, manager-only)
                        the Manager's Cockpit section: period/AED-count selector, donuts, role
                        metrics, target-remaining + run-rate toggle — see the three new files below
js/dashboardData.js   — getDashboardData(period): swappable client-side aggregation over
                        `submissions` (Phase C will later swap the internals for rollup reads, same
                        call signature/output shape); resolvePeriodRange (presets + custom ≤92-day
                        range)
js/dashboardCharts.js — renderDonutCard: dependency-free hand-rolled SVG donut (stroke-dasharray
                        arcs), AED/count mode, empty state
js/dashboardCards.js  — renderRoleMetricsSection: sales-agent + backend role-metrics cards, KAM/
                        escalations reserved placeholder
js/orgConfig.js       — orgs/{orgId} org-config doc (categories, contractTermLabels,
                        runRateDefaultVisible): loadOrgConfig, categoryLabel/termLabel (render-time
                        resolvers with graceful fallback-to-raw-value), findCategoryIdByLabel
                        (migration-only), currentCategories/currentTermLabels, saveOrgConfig/
                        withOrgConfigSave (shared merge-then-set write path + graceful
                        permission-denied handling, used by both Products' category/term config and
                        the Dashboard's run-rate default toggle)
js/scripts.js         — Scripts tab, channels, approval workflow
js/products.js        — Products tab, seed catalog, discounts, waivers, Categories & Contract Terms
                        config panel (manager-only — showCategoryConfigModal; category rename/add/
                        delete-if-unreferenced, contract-term label rename). Categories now resolved
                        via js/orgConfig.js (currentCategories/categoryLabel), not a local constant —
                        the old PRODUCT_CATEGORIES export was removed in Session B4's category
                        identity refactor.
js/main.js            — getTabs/renderNav/switchTab — the only place that imports every
                        render*Tab function and routes between them. Queue tab is gated to
                        manager or isBackendUser() (department:'backend' && active!==false,
                        independent of role — mirrors the submissions read rule's
                        isActiveBackend())
```
Dropped as confirmed-dead code during the split (verified via grep for call sites before removal): `renderTeamTab()` and its `switchTab` branch (orphaned once "My Team" was merged into the Dashboard), `renderPlaceholder()` (never called), and a `ct.getElementById` monkey-patch in the Pipeline tab (assigned, never read).

**Local testing:** `.claude/simple-server.ps1` is a dependency-free static file server (uses .NET's `HttpListener`, no Node/Python required) for local module testing before pushing — Chrome's module loader rejects `file://` origins, so a local HTTP server is required to test ES module changes before they go live. Run via the Preview tool's `static-server` config in `.claude/launch.json`.

---

## Roles

| Role | Access |
|---|---|
| `manager` | Full access — all teams, all leads, all scripts, all products, user management, org control |
| `team_lead` | Own sub-group — leads their assigned agents, sees team-wide pipeline (view only outside own sub-group), creates/suggests scripts, read-only products |
| `agent` | Own leads only — read-only scripts and products, no user/team management |

> **Model B architecture:** Multiple TLs per team. Each TL owns an isolated sub-group of agents via `tlId`. Agents belong to a team (`teamId`) AND a specific TL (`tlId`). TL **visibility** (Pipeline view) is team-wide; TL **write/reassign/delete** access is sub-group-scoped where noted below.

---

## Data Model

**Multi-tenancy (NEW, Phase A):** every collection below now carries an `orgId` field, stamped
automatically by `js/db.js` on every create from `config.js`'s `orgId` export (`"shauntech"` for
this deployment). All 259 pre-existing docs across every collection were backfilled live via the
one-off `runOrgIdMigration()` (see Phase A0/A). Firestore rules enforce `sameOrg()`/`sameOrgWrite()`
on every clause — see Firestore Security Rules below. Not restated per-collection in the schemas
below to avoid drift; assume `orgId: string` is present on every document in every collection.

### `users`
```
{
  name, email, role: 'manager' | 'team_lead' | 'agent',
  teamId,                          // null for manager
  tlId,                            // agent only — UID of their Team Lead
  monthlyTarget,
  autoTarget,                      // TL only — sum of assigned agents' targets
  targetSource: 'auto' | 'override' | 'manager',
  active: true | false,            // false = deactivated (soft-removed), still exists but locked out
  permissions: string[],           // individual permission grants, e.g. ['edit_companies'] — see
                                    // Permission System section. Schema + grant UI shipped; not
                                    // yet consumed by any Firestore rule or non-manager UI.
  department: 'sales' | 'backend' | null,  // NEW (Phase 6) — denormalized from the user's team.department,
                                    // null for manager and for anyone currently unassigned to a team.
                                    // Cascaded automatically if a team's department is later changed
                                    // (showEditTeamModal batch-updates every member's department).
  specialties: string[],           // NEW (Phase 6) — backend agents only; CATEGORY IDS as of Session
                                    // B4 (was product category name-strings pre-migration — see
                                    // js/orgConfig.js categoryLabel()); empty/omitted = generalist,
                                    // handles anything. Not set for sales agents or TLs.
  available: boolean,              // NEW (Phase 6) — backend agents only; manual "I'm out today"
                                    // toggle, default true. Not set for sales agents or TLs.
  runRateVisible: true | false | null  // NEW (Session B4) — per-user override for the Manager's
                                    // Cockpit's run-rate/days-left visibility; null/absent = no
                                    // override, defer to orgs/{orgId}.runRateDefaultVisible. Always
                                    // wins over the org default in either direction when set. Any
                                    // user may self-write ONLY this field (see Firestore Security
                                    // Rules below) — a self-write touching any other field is denied.
}
```

### `teams`
```
{
  name,
  teamLeadId: null,                // legacy field, kept for compatibility
  createdBy, createdAt,
  permissions: string[],           // team-wide permission grants — same caveat as users.permissions
  department: 'sales' | 'backend', // NEW (Phase 6) — no field on a doc means 'sales' (all pre-Phase-6
                                    // teams). Set via Add/Edit Team modal.
  assignmentMode: 'auto' | 'manual' // NEW (Phase 6) — only meaningful when department === 'backend';
                                    // absent/unused on sales teams. Drives future submission-item
                                    // auto-assignment (Phase 7) — not consumed by any code yet.
}
```

### `leads`
```
{
  company, contact, phone, email, industry, city,
  companyId,                       // link to companies collection — required on new leads via the
                                    // Add Lead picker (js/leads.js showAddLeadModal); existing leads
                                    // backfilled via the Org tab's "Backfill Companies" button
  stage,                           // Pipeline stage
  closedAt,                        // NEW (Phase A) — structured ISO timestamp, auto-stamped by
                                    // js/db.js whenever `stage` is set to 'Closed' (only if not
                                    // already set). Replaces the old fragile history[]-text-scan
                                    // the Dashboard used for monthly attainment.
  assignedTo, assignedBy,
  teamId,                          // team of the assigned agent (empty string if unassigned)
  tlId,                            // TL of the assigned agent (empty string if unassigned; written on create/reassign)
  dealValue, notes, followup,
  ownerLocked,                     // bool — manager-locked leads: TL/agent can edit stage/notes/followup but not delete directly
  deleteRequest: { requestedBy, requestedByName, requestedAt } | null,  // TL request to delete a locked lead, pending manager approval
  createdBy, createdByRole,
  lastEditedBy, lastEditedAt,
  history: [{ ts, actorId, actorName, change }],  // capped at 100 entries by js/db.js (keeps the
                                    // tail — entries are only ever appended, never reordered)
  submissionSummary: 'none' | 'submitted' | 'inProgress' | 'activated' | 'rejected'  // NEW —
                                    // denormalized pipeline badge (step 0d, see the submissions
                                    // section below for the collapse rule), stamped by
                                    // createSubmissions and appendEvent in the SAME batch/
                                    // transaction as the write that changes it, never a per-lead
                                    // query from the Pipeline list
}
```

> `assignedTo`/`teamId`/`tlId` can all be empty string `''` to represent "unassigned" — this is a valid, intentional state (e.g. after a team member is removed/deleted), not an error state. The lead modal shows an explicit "— Unassigned —" option in that case rather than defaulting the dropdown to whatever agent renders first.
>
> **Root-cause fix (found live in testing):** the New Lead modal's teamId/tlId resolution used to skip whenever `assignTo === CU.uid` — intended for a manager self-assigning (managers aren't on a team), but it fired for ANY self-assignment, including an agent creating and self-assigning their own lead (the single most common lead-creation path). That left every self-created agent lead permanently blank on teamId/tlId. Fixed to use the agent's own already-loaded profile (`CP.teamId`/`CP.tlId`) for that case, only reading another user's profile when actually assigning to someone else.

### `channels`
```
{
  name, createdBy, createdAt,
  active: true | false             // false = soft-deleted
}
```
**Seed defaults (manager-only, auto-created on first Scripts tab open):** WhatsApp, LinkedIn, Email, Cold Call

### `scripts`
```
{
  title, body, channel,
  scope: 'global' | 'team',
  teamId,                          // null for global (manager scripts); TL's teamId for team scripts
  createdBy, createdByName, createdByRole,
  createdAt, lastEditedBy, lastEditedAt,
  pendingApproval: {               // null when no edit pending
    submittedBy, submittedByName,
    submittedAt,
    originalBody, proposedBody
  } | null,
  approved: true | false
}
```

### `products`
```
{
  category: 'starter' | 'essential' | 'ultimate' | 'mobile',  // CATEGORY ID as of Session B4 (was
                                    // the display name pre-migration) — resolve the label via
                                    // js/orgConfig.js categoryLabel(), never read this raw for
                                    // display. See orgs below for where the id->label map lives.
  name,                            // e.g. "Ultimate 600 Mbps"
  pricingOptions: [                // at least one required
    { term, label, price }         // term in months (0 = no contract); label is the FALLBACK
                                    // display when no orgs/{orgId}.contractTermLabels[term]
                                    // override exists — resolve via js/orgConfig.js termLabel(),
                                    // never read this raw for display.
  ],
  activationFee,
  specs: { key: value },           // free-form key-value pairs, displayed on card
  sourceDoc,                       // rate sheet version reference e.g. "ENT-ULT-BTL-SEP-2025"
  notes,                           // freetext — add-on caveats, availability notes
  active: true | false,            // NEW (Phase A) — product "delete" is now a soft-delete
                                    // (sets active:false via js/db.js dbUpdate), never removes the
                                    // doc. Product list/picker UI already filtered on active!==false.
  discounts: [ { id, appliesToTerm, appliesToTermLabel, price, percentage, validFrom, validTo, conditions, createdBy, createdByName, createdAt } ],
  monthlyWaivers: [ { id, label, value, valueType: 'amount'|'percentage', conditions, createdBy, createdByName, createdAt } ],
  createdBy, createdByName, createdAt,
  lastEditedBy, lastEditedAt
}
```

### `orgs` (NEW, Session B4, ARCHITECTURE.md §12)
```
// One doc per deployment, doc ID == the org's own orgId constant (config.js) —
// not a field on it conceptually, though js/db.js's dbSet() gateway does stamp
// a redundant `orgId` field on every write as a side effect of the shared
// write path; the doc ID is what the Firestore rule actually keys off.
{
  categories: [ { id, label } ],   // permanent IDs, editable label — see js/orgConfig.js. Seeded
                                    // with DEFAULT_CATEGORIES (starter/essential/ultimate/mobile)
                                    // by the one-time category migration (js/org.js).
  contractTermLabels: { [term]: label },  // OPTIONAL override on top of each product's own
                                    // pricingOption.label — absent/partial is fine, never migrated.
  runRateDefaultVisible: true | false     // org-wide default for the Manager's Cockpit's run-rate
                                    // visibility toggle; absent = false. See users.runRateVisible
                                    // above for the per-user override that always wins over this.
}
```
Read: any same-org authenticated user (every role's `loadOrgConfig()` runs at login). Write:
manager unrestricted; team_lead narrowed to `runRateDefaultVisible` only. See Firestore Security
Rules below for the exact rule (key-matched, not `sameOrg()`-gated like every other collection).

**Seed data (19 products, auto-seeded by manager on first Products tab open):**

| Category | Plans seeded |
|---|---|
| Starter | Starter, Starter Pro |
| Essential | 80 / 120 / 175 / 275 / 500 Mbps |
| Ultimate | 200 / 400 / 600 / 800 Mbps / 1 Gbps |
| Mobile | BMP 100 Nat, BMP 200 Nat, BMP 100 Nat+Intl, BMP 200 Nat+Intl, BMP 325, BMP 600, BMP 900 |

### `companies`
```
{
  name,                            // display name
  normalizedName,                  // lowercase, diacritics/punctuation stripped, whitespace
                                    // collapsed — the SECOND dedup key (see normalizeCompanyName())
  accountCode,                     // NEW — the FIRST/stronger dedup key (exact du account
                                    // reference; two different companies could coincidentally
                                    // share a similar name, never a real account code)
  segment: 'SOHO' | 'SME' | null,
  contacts: { authorizedPerson, phone, altPhone, technicalName, email },
  addressBlock: { building, street, city, emirate, poBox, full },
  industry, city,
  hasDuAccount: boolean,           // informational badge ONLY — no longer drives any submission
                                    // skip logic (ARCHITECTURE.md §5)
  docExpiries: { tradeLicense, establishmentCard, eid },  // dates; establishment card expiry
                                    // triggers a SIM-suspension-risk warning at submit time
  partnerHistory: [ {type:'gained'|'lost', partner, date, note} ],  // append-only; an accTransfer
                                    // on a submission auto-appends a 'gained' entry here
  accountOwner: userId | null,     // KAM uid — KAM role/module doesn't exist yet (Phase E);
                                    // exposed as a plain user picker in the meantime
  billing: { lastConfirmedPaidMonth, status:'ok'|'pending'|'overdue', log:[] },  // skeleton only
                                    // — log[] isn't populated/managed by any UI yet
  riskFlags: { docExpiry, billOverdue, churnList },  // NOT exposed in any edit UI — system-computed
                                    // (doc-expiry proximity, billing status, churn-list import),
                                    // none of which is built yet
  createdBy, createdAt,
  mergedInto: null | companyId,    // soft-merge marker — not yet used, merge UI not built
  lastEditedBy, lastEditedAt
}
```
All the enrichment fields above (everything from `accountCode` through `riskFlags` except
`industry`/`city`) are **optional/nullable** — existing docs stay valid without them, only
populated once someone opens the Edit Company modal (Org tab, manager-only, `edit_companies`
permission-gated) and fills them in.

- **Dedup, two targeted reads, never a full scan** (`findOrCreateCompany`, ARCHITECTURE.md §9 —
  a real partner can carry 1,000-3,000+ companies): `where('accountCode','==',code) limit(1)`
  first (stronger identity signal), then `where('normalizedName','==',norm) limit(1)`. Neither
  needs a composite index.
- **Type-ahead search** (`searchCompanies`, every company picker): debounced (300ms), min 2 chars,
  a single-field prefix-range query on `normalizedName` (`limit(10)`, no composite index) plus a
  parallel exact `accountCode` lookup when the typed term contains a digit. The Add Lead modal
  surfaces two independent nudges — a fuzzy "did you mean X?" (operates ONLY on the ≤10 already-
  fetched suggestions, never a full scan) and an exact "this account code already exists" match.
- `fetchCompanies()` (the raw full scan) still exists for exactly two deliberate, documented
  exceptions: `backfillCompanies()` (one-off, manager-only, safe to re-run) and the Org tab's
  Companies card listing (not yet paginated — a known, not-yet-addressed gap, same category as
  the Pipeline tab was before its own pagination stopgap).
- One-time backfill (`backfillCompanies()`, triggered by the manager-only "🏢 Backfill
  Companies" button in the Org tab when any lead has `company` set but no `companyId`) groups
  existing leads by `normalizedName`, creates one company doc per unique group, writes
  `companyId` back onto each lead. Safe to re-run — skips names that already resolve to an
  existing company. Bulk writes use `skipAudit:true` + one summary `auditLog` entry (see Firestore
  Security Rules below) — CHUNK reduced to 200.
- Manager-only "Companies" card in the Org tab lists all companies (name, industry, city,
  du Account, linked lead count) with an Edit action exposing every enrichment field above. No
  merge tool yet — deliberately deferred until duplicate volume is visible in practice.
- Blocking prerequisite for the backend-department/submissions/reports/document-expiry work —
  see `PHASE5_SPEC_AND_HANDOFF.md`.

### `submissions` (v2, ARCHITECTURE.md §3/§5) — agent → backend handoff
**Schema amendment: one submission DOC = one product line, not an items[] array.** A single
Submit-to-Backend form composing N product lines creates N submission docs, all sharing a
client-generated `bundleId`. The agent's Pipeline/lead-modal view groups siblings by `bundleId`
into one visual package, but each doc has its own status, events[] timeline, and
`assignedBackendAgent` — matches the real master tracker's one-row-per-order shape and lets one
line activate while a sibling is still pending (the normal case, not an edge case).
```
{
  bundleId,                        // links sibling submissions from the same form — NOT itself a doc
  leadId, companyId,
  agentId, agentName,
  teamId, tlId,                     // sales team/TL credit, snapshotted at submit time
  productId, productName, category, // productName/category are SNAPSHOTS — a later catalog
                                     // change must not rewrite history
  qty, mrc,                         // mrc = monthly recurring charge (replaces the old dealValue)
  typeOfRequest,                    // one of ORG_DEFAULTS.typeOfRequestList (NEW/FNP/MNP/Migration)
  contractTerm,                     // months, from the selected pricingOption
  categoryFields: {},               // ORG_DEFAULTS.itemFieldsByCategory[category] — ALL optional
                                     // (fiber categories: gaid; Mobile: msisdn/simSerial/passcode/
                                     // commitmentPlan/handset)
  sprFlag, sprNote,                 // Special Pricing Request
  accTransfer: { flag, fromPartner }, // OPERATIONAL TAKEOVER marker (Session B5 clarification) —
                                     // du account custody moving from fromPartner to us, a request
                                     // du itself can reject (see transferStatus below). NOT a
                                     // revenue-attribution signal (that was B4's mistake, corrected
                                     // in B5 — see sourcedBy). When flagged, ALSO appends a
                                     // partnerHistory 'gained' event to the company (same batch,
                                     // atomic).
  sourcedBy: { flag, partnerName }, // NEW (Session B5) — deal ORIGIN: was this brought to us by an
                                     // external partner/freelancer/subcontractor? Orthogonal to
                                     // accTransfer above — a sourced deal may or may not need a
                                     // transfer, and vice versa. Captured on the same Submit-to-
                                     // Backend modal as accTransfer, own checkbox + name input,
                                     // create-time-only and immutable thereafter. Drives the
                                     // Manager's Cockpit's byContributor attribution
                                     // (js/dashboardData.js) — accTransfer is no longer read there.
  transferStatus: 'pending' | 'completed' | 'rejected',  // NEW (Session B5) — ONLY present when
                                     // accTransfer.flag is true (absent on every other line, so
                                     // accTransfer.flag stays the single source of truth for
                                     // "is this a transfer at all"). Defaulted to 'pending' at
                                     // creation, set via appendEvent's transferCompleted/
                                     // transferRejected events (backend or manager only,
                                     // js/queue.js). COMPLETELY SEPARATE from status below — never
                                     // altered by and never alters the document-review lifecycle.
                                     // 'rejected' here means du rejected the TAKEOVER REQUEST, not
                                     // a document rejection — requires a free-text reason (distinct
                                     // from ORG_DEFAULTS.rejectionReasons), rendered as a red
                                     // "⚠ Transfer Rejected" stall badge in the Queue list, the
                                     // action panel, and the agent's own Submission Timeline.
  status: 'pendingVerification' | 'submittedToDu' | 'inProgress' | 'activated' | 'rejected', // coarse, PER SUBMISSION
  events: [ { type, actorId, actorName, ts, payload } ],  // append-only timeline, see below
  verification: { done, method: 'call'|'email'|null, ts } | null,  // structured summary,
                                     // maintained alongside events[] so the UI doesn't need to
                                     // scan the timeline to show verified-or-not
  requiredDocs: [ { type, status:'attested'|'uploaded', expiryDate, storageRef } ],  // doc
                                     // checklist + expiry dates; storageRef ({bundleId, docType,
                                     // version, pageCount}) is present once a file is attached
                                     // (status becomes 'uploaded') — see the Document Storage
                                     // section below. Computed at submit time (union across the
                                     // whole bundle) and stored, not re-derived later. `version`
                                     // (added the session that built Fix & Resubmit) always points
                                     // at the LATEST replacement; older versions stay in storage as
                                     // evidence, never overwritten
  assignedBackendAgent: userId|null,
  claimedAt,                        // NEW (Session B4) — queryable, stamped ONLY on the
                                     // unassigned->claimed transition (claimSubmission), never on
                                     // a later reassignSubmission. Absent for pre-B4 claims and
                                     // auto-assigned submissions — the Manager's Cockpit's queue-
                                     // wait metric treats a missing value as N/A, never 0.
  submittedToDuAt, activatedAt, rejectedAt,  // queryable top-level timestamps, stamped by
                                     // appendEvent on the FIRST corresponding status transition
                                     // (see appendEvent below) — feed both reporting and the
                                     // Manager's Cockpit's period-range queries (js/dashboardData.js)
  createdAt, lastEditedBy, lastEditedAt
}
```
- `SUBMISSION_STATUSES` (replaces the old `SUBMISSION_STAGES`) and
  `MANDATORY_DOC_TYPES = ['Trade License','Emirates ID (Front)','Emirates ID (Back)']` live in
  `js/state.js`, alongside `ORG_DEFAULTS` (typeOfRequestList, rejectionReasons,
  itemFieldsByCategory — the last re-keyed to category IDs in Session B4) — still hardcoded, NOT
  moved into `orgs/{orgId}` (Session B4's new org-config doc only holds categories,
  contractTermLabels, and runRateDefaultVisible — see the `orgs` schema above).
- `hasDuAccount` skip logic is **gone** — every submission starts at `pendingVerification`
  regardless; `hasDuAccount` is purely an informational badge now.
- **Event engine (`js/submissions.js appendEvent`)** — every timeline entry goes through here,
  never a direct `dbUpdate`. Event types: `docsVerified`, `verificationCall`, `verificationEmail`,
  `submittedToDu`, `activityNo{value}`, `workOrderNo{value}`, `appointment{date,time,person}`,
  `biometric`, `sprObtained{note}`, `correction{note}`, `note{text}`, `activated`,
  `rejected{reason,note}`, `resubmit{note}`, **`transferCompleted`, `transferRejected{reason}`
  (Session B5)**. Status transitions ride the same call:
  `submittedToDu`/`activated`/`rejected`/`resubmit` set status directly; `submittedToDu` with no
  prior verification auto-appends a `proceededWithoutVerification` event; any other event bumps
  `submittedToDu` → `inProgress` (first real backend touch implies work has started); `rejected`
  requires `payload.reason` from `ORG_DEFAULTS.rejectionReasons`. **`transferCompleted`/
  `transferRejected` (Session B5) are structurally isolated from all of the above** — each sets
  ONLY `transferStatus`, in its own `else if` branch mutually exclusive with every status-setting
  branch, so a transfer outcome can never touch `status` by construction; `transferRejected`
  requires `payload.reason` (free text, NOT `ORG_DEFAULTS.rejectionReasons` — a different concept,
  du rejecting the takeover request rather than a document).
- **Assignment (`js/submissions.js pickBackendAgent`, per SUBMISSION not per bundle):** candidates
  are available backend-department agents in the team who either have no `specialties`
  (generalist) or list the item's category. **No match at all (not even a generalist) now falls
  back to ANY available backend agent** — a specialty mismatch should never leave a submission
  unassigned when staff exist to work it. Zero available agents (or no backend team) → unassigned
  (shared queue). Rotation cursor (`teams.assignmentCursor`) advances once per submission created.
- **v1 simplification, unchanged:** assignment only considers the first team with
  `department:'backend'` found in `teams` — multi-backend-team routing isn't designed yet.
- **Submit to Backend UI** (`js/leads.js showSubmitModal`) appears on a Closed lead with a
  `companyId`, for the assigned agent or manager, once no submission already exists for that lead
  (v1 tradeoff, unchanged — repeat orders on the same lead are a future revisit). Per-line product
  + term + qty + MRC + typeOfRequest + category fields + SPR; bundle-level account-transfer flag
  and document-expiry attestation (checklist + expiry date, no file). A doc-expiry warning banner
  (`docExpiryWarnings(company)`) surfaces the company's on-file `docExpiries` entries expiring
  within 15 days, establishment card flagged specially (SIM-suspension risk).
- **Read-only Submission Timeline** (`js/leads.js showSubmissionTimelineModal`) — groups a lead's
  submissions by `bundleId`, shows each line's status + full events[] history. Visible to the
  submitting agent, their TL, and manager (matches the submissions read rule's scoping). Also
  offers "Download bundle PDF" and, for the submitting agent's own rejected lines, "Fix & Resubmit"
  — both described below.
- **Backend Queue + action panel (shipped, Phase D)** — see the Phase D entry in Phase History
  below for the full writeup (Queue tab, claim/reassign, the action panel driving every
  `appendEvent` type, versioned Fix & Resubmit, combined-PDF export, backend document attachments,
  copy tools). Backend's own screen for logging events now exists — no more console calls.
- **Document Storage (ARCHITECTURE.md §6, shipped)** — real file bytes on the free tier via a
  `StorageAdapter` façade (`js/storage/index.js`) over a driver registry, so feature code never
  imports a driver directly. Only driver today is `firestore-b64` (`js/storage/firestore-b64.js`):
  one Firestore doc per PAGE in a top-level `submissionDocs` collection, keyed by
  `bundleId_docType_pageIndex` — files are shared PER BUNDLE (company docs attach once, not once
  per product line), with `agentId`/`teamId` denormalized onto every page doc so the read rule
  mirrors the `submissions` read rule exactly. Hard ceiling: 900KB per page, checked against the
  **encoded** base64 length (not raw bytes — base64 inflates size ~33%), rejected with a clear
  error if exceeded even after compression.
  - **Capture pipeline (`js/documents.js`)** — images: canvas resize to max edge 1200px + JPEG
    recompression stepping down from quality 0.72 to a 0.4 floor, targeting ≤300KB/page
    (best-effort, distinct from the 900KB hard ceiling). PDFs: pdf.js (pinned CDN version, ES
    module import) renders each page to canvas at ~150 DPI through the same JPEG pipeline — one
    stored page per PDF page, capped at 10 pages with a clear truncation message. No raw PDF bytes
    are ever stored.
  - **Submit to Backend UI**: each doc type gets an optional file input + thumbnail preview;
    attaching a file sets that `requiredDocs[]` entry to `status:'uploaded'` (files encouraged, not
    required — a doc with no file stays `'attested'`, backend rejects if actually missing). Upload
    batching: small uploads (≤4 doc types, ≤1.6MB raw, ≤20 pages) write document pages and
    submissions in ONE atomic `writeBatch`; larger ones write pages first, submissions after, with
    `storage.deleteByBundle()` cleanup if the submissions write then fails.
  - **Viewing**: the read-only Submission Timeline renders each uploaded doc's pages on demand
    (one `get()` call per page, never a list query — see the LIST-query gotcha below) for exactly
    the roles the submissions read rule already allows.
  - **Retention sweep (`js/org.js runDocumentRetentionSweep`, manager-only)** — "Clean up old
    documents" button in the Org tab. Finds bundles where every sibling submission is terminal
    (`activated`/`rejected`) and the SLOWEST sibling to go terminal has sat there past
    `ORG_DEFAULTS.docRetentionDays` (default 90); shows a page/bundle count via a cheap
    `getCountFromServer` aggregation before a confirm dialog, then bulk-deletes via
    `storage.deleteByBundles()` (skipAudit per page + ONE summary `auditLog` entry for the whole
    run). Leaves `requiredDocs` attestation/expiry-date fields completely untouched — only the
    stored page bytes go.
  - **`appendEvent` hardening (done alongside this work):** reworked to run inside a Firestore
    `runTransaction` (read + append + status-change atomic) after review found the old
    `getDoc`-then-`update` pattern could silently lose a concurrent event write. Status changes
    now also stamp queryable top-level `submittedToDuAt`/`activatedAt`/`rejectedAt` fields (first
    transition only) alongside `events[]`, so reports and the future contract-expiry pipeline can
    query directly instead of scanning the timeline.
  - **Full regression (manager identity + direct Firestore inspection, see rules note below for
    the cross-role read-check caveat):** submitted a bundle with a real JPG (Trade License) and a
    real 3-page PDF (Emirates ID Front), plus a 12-page PDF on Emirates ID Back to confirm the
    10-page cap truncates with the correct message; verified actual stored page sizes (~30-33KB
    each, well under both the 300KB target and the 900KB hard ceiling); viewed all three docs'
    pages back through the Submission Timeline; ran the sweep against a real bundle whose
    submission was transitioned to `activated` and backdated 120 days, confirmed it correctly
    identified the bundle (14 pages), deleted them, left `requiredDocs` untouched, and wrote one
    summary `auditLog` entry; cleaned up all test data back to baseline (115 leads, 0 submissions,
    0 submissionDocs).
- **Firestore LIST-query gotcha (found during regression):** Firestore rejects a `list` query
  outright unless it can prove every possible matched document satisfies the read rule — it does
  NOT filter per-document the way a single `get()` effectively does. The submissions read rule is
  an OR of role-scoped clauses (manager | `agentId==self` | team_lead+`teamId` match | backend); a
  bare `where('leadId','==',id)` query is only provable for manager, whose clause doesn't depend on
  `resource.data` at all. Every other role's query must ALSO include the same field the rule
  checks (`teamId==CP.teamId` for team_lead, `agentId==CU.uid` for agent) to match that specific
  OR-clause exactly. Cost this session a real regression bug (team_lead/agent got
  `permission-denied` reading their own data) before being caught and fixed.

---

## Pipeline Stages

Live `STAGES` constant: `New, Contacted, Interested, Proposal Sent, Closed, Lost`

---

## Visibility & Permission Rules

### Leads
| Role | Sees | Can reassign | Can delete directly | Can request deletion |
|---|---|---|---|---|
| Manager | All leads across all teams | Any active agent | Always | N/A (approves/rejects TL requests) |
| Team Lead | Leads where `teamId === TL.teamId` (team-wide view) | Only to own sub-group agents (`tlId===self`) | Only unlocked leads within own team | Locked leads within own team → sends approval request to manager |
| Agent | Own leads only (`assignedTo === agent.uid`) | No | Only own unlocked, self-created leads | No |

**Delete-approval workflow:** if a TL requests deletion of a manager-locked lead, a `deleteRequest` field is written (lead stays live). Manager sees a pending-requests banner at the top of the Pipeline tab plus inline Approve/Reject buttons in the lead modal. TL can withdraw their own pending request. Approve → hard delete. Reject → clears the request, lead unchanged.

**Bulk-assign** (Pipeline tab, manager + TL): checkbox column lets you select multiple leads and reassign them all to one agent in a single batched write. TL's checkboxes only appear on leads already in their own sub-group or unowned — a lead belonging to another TL's sub-group is excluded from selection entirely, since Firestore batches are all-or-nothing and would otherwise fail the whole batch on one out-of-scope lead.

### Scripts
| Role | Sees |
|---|---|
| Manager | All scripts |
| Team Lead | Global scripts (manager-created) + own scripts they created |
| Agent | Approved global scripts + approved scripts where `createdBy === agent.tlId` |

### Products
| Role | Sees |
|---|---|
| Manager | All products + Edit / Discounts / Waivers / Delete controls |
| Team Lead | All products, read-only |
| Agent | All products, read-only |

---

## Org & Team Management (Manager)

| Action | Effect |
|---|---|
| Remove member (soft) | Sets `active:false`, clears `teamId`/`tlId` on their own doc. Their leads become unassigned (`assignedTo/tlId` cleared, `teamId` kept) with a history entry. Reversible — reassigning them a team via Edit User shows a "Reactivate on save" checkbox (checked by default) that flips `active` back to `true`. |
| Delete Team Lead (hard) | Permanently deletes the TL's Firestore profile. Their remaining agents drop to "Unassigned Agents (no TL)" within the same team (kept, not removed from team) — their `tlId` is cleared. Any lead with `tlId` pointing at the deleted TL also gets `tlId` cleared. |
| Delete Agent (hard) | Permanently deletes the agent's Firestore profile. Their former TL's `autoTarget` recalculates. Their leads become unassigned, same as the soft-remove flow. |
| Delete Team | Existing — members become unassigned, leads untouched. |
| Backfill Companies | Manager-only button, shown whenever any lead has `company` set but no `companyId`. Groups those leads by `normalizedName`, creates one `companies` doc per unique group, writes `companyId` back onto each lead. Safe to re-run. |
| Edit Company | Manager-only, from the Companies card. Edits `industry`/`city`/`hasDuAccount`. No merge tool yet. |

**Hard-delete caveat:** this deletes the Firestore profile only, not the underlying Firebase Auth login (client SDK cannot delete other users' Auth accounts — needs Admin SDK/Cloud Functions, not part of this stack). In practice this is a full lockout: `ensureProfile()` returns null for a missing profile and the app immediately signs the user back out with "Account not set up. Contact your manager." **Exception:** the 4 seed demo accounts (`manager@`, `teamlead1@`, `agent1@`, `agent2@shauntech.app`) auto-recreate their profile on next login via `SEED_EMAILS` fallback — this only affects those 4 literal addresses, not real accounts created via "+ New Agent"/"+ New Team Lead".

---

## Scripts — Access & Approval Rules

| Action | Manager | Team Lead | Agent |
|---|---|---|---|
| Create script | ✓ Global scope | ✓ Team scope, auto-approved | ✗ |
| Edit own script | ✓ Direct | ✓ Direct, no approval needed | ✗ |
| Edit manager script | ✓ Direct | Suggest edit → approval queue | ✗ |
| Delete own script | ✓ | ✓ | ✗ |
| Delete manager script | ✓ | ✗ | ✗ |
| Approve / Reject edits | ✓ | ✗ | ✗ |
| Withdraw pending edit | N/A | ✓ (own submissions only) | ✗ |
| View scripts | ✓ | ✓ | Read-only |

## Products — Access Rules

| Action | Manager | Team Lead | Agent |
|---|---|---|---|
| View products | ✓ | ✓ | ✓ |
| Add / Edit / Delete product | ✓ | ✗ | ✗ |
| Add / Edit / Delete discounts / waivers | ✓ | ✗ | ✗ |

All product writes are Manager-only, enforced server-side.

---

## Permission-Grant System (scaffolding, shipped — not yet wired to a capability)

General mechanism so future non-manager capabilities can be granted without hardcoding role/team
checks: a manager grants a permission to a whole **team** (Edit Team modal) or to an individual
**team_lead/agent** (Edit User modal), stored as `permissions: string[]` on that doc. Both modals
render a searchable checklist (`js/permissions.js`: `permissionChecklistHtml`,
`wirePermissionSearch`, `getSelectedPermissions`) sourced from one catalog, `PERMISSIONS`.

```js
export function hasPermission(perm, profile, team){
  if(profile.role === 'manager') return true;
  if((profile.permissions||[]).includes(perm)) return true;
  if(team && (team.permissions||[]).includes(perm)) return true;
  return false;
}
```
User-level grant wins; falls back to the user's team-level grant. Manager always passes.

**Currently defined permissions:** `edit_companies` — only one so far. Checking it in the UI
**does not unlock anything yet**: the `companies` Firestore rule is still manager-only-write, and
the Companies card/Edit-Company UI only renders on the manager-only Org tab. To actually activate
a permission, both of these need to change together:
1. Extend the relevant Firestore rule to also allow `hasPermission(...)`, not just `role()=='manager'`.
2. Expose the corresponding UI somewhere a non-manager can reach it.
Add new capabilities by extending the `PERMISSIONS` array in `js/permissions.js` — nothing else
in that file needs to change.

---

## Dashboard Tab (all roles)

- KPI cards (Total/Open/Closed/Lost/Win Rate/Closed Value), Agent Performance table (manager/TL, positioned right after KPIs), This Month's Target progress bar, 6-month Monthly Performance History table, Follow-ups (overdue/today/this-week), Recent Activity feed.
- Recent Activity shows the latest 10 entries by default with a "Show More (N)" / "Show Less" toggle (pure CSS class toggle, no re-fetch) — activity log is capped at 50 entries client-side.
- Manager target = sum of all agent targets. TL target = `autoTarget` or manager override.

---

## Target Calculation

- **Agent target:** set by manager (`targetSource: 'manager'`)
- **TL auto-target:** sum of all active agents under that TL (`targetSource: 'auto'`), recalculated whenever an agent's target changes, or an agent is deactivated/reassigned/deleted
- **TL override:** manager can manually set a TL's target (`targetSource: 'override'`)

Helper: `calculateTLTarget(tlId, users)` — pure function, sums `monthlyTarget` where `tlId` matches and `role === 'agent'` and `active !== false`.

---

## Firestore Security Rules

**NEW (Phase A): rules are now version-controlled** at `rules/firestore.rules` in this repo — the
Console is still the actual deploy target (paste-and-publish, no CLI deploy set up), but the
repo file is the source of truth going forward, superseding the older "Console is the source of
truth, rules aren't in this repo" convention.

**Multi-tenancy (`sameOrg()`/`sameOrgWrite()`):** every collection's every clause now also requires
an org check — `sameOrg()` for read/update/delete (compares the actor's `orgId`, via a cached
`userDoc()` lookup, to the existing doc's `orgId`); `sameOrgWrite()` for create (compares against
the *incoming* doc's `orgId`, since `resource.data` doesn't exist yet pre-create).

> **Bootstrap bug fixed live in production (critical):** the first version of these helpers assumed
> a missing `orgId` field compares as `null == null → true` before the migration ran. That
> assumption was wrong in practice and broke `permission-denied` on every login (including a basic
> self-read of one's own `users/{uid}` doc) the moment the rules were first published — Firebase
> Auth sign-in succeeded but the app couldn't read anything. Fixed with explicit `'orgId' in ...`
> existence checks instead of relying on unverified null-comparison semantics:
> ```
> function sameOrg() {
>   return !('orgId' in userDoc()) || !('orgId' in resource.data) || userDoc().orgId == resource.data.orgId;
> }
> function sameOrgWrite() {
>   return !('orgId' in userDoc()) || userDoc().orgId == request.resource.data.orgId;
> }
> ```
> Once every doc has `orgId` (true today, post-migration), the bootstrap bypass clause is
> permanently dormant. Verified fixed via a live diagnostic (direct `getDoc` on the manager's own
> profile through the deployed app) before declaring it safe to log in again.

**Migration-ordering gotcha (caught before running, not a live failure):** `runOrgIdMigration()`
migrates collections in this exact order — `teams, leads, companies, channels, scripts, products,
submissions, users` — with **`users` deliberately last**. Migrating `users` first would stamp the
acting manager's own `orgId` immediately, and every subsequent collection's `sameOrg()` check would
then compare a real orgId against still-unmigrated docs and fail closed, silently locking the
migration out of everything after `users`.

All rules changes have been treated with extra care after one earlier bug (a fragile secondary `tlId` lookup was replaced with a direct `teamId` comparison). Current state, eleven collections:

| Collection | Read | Write |
|---|---|---|
| `users` | Any auth | Create: self or manager. Update: manager unrestricted; **self-write narrowed (Session B4 — fixes a real privilege-escalation gap found during review, see below) to exclude `role`, `department`, `orgId`, `teamId`, `tlId`, `active`, `monthlyTarget`, `targetSource`, `autoTarget`, `permissions`, `specialties`, `available`, `email`, `createdBy`, `createdAt`** — a self-write touching any of those is denied outright, even bundled with an otherwise-fine field. Delete: manager-only. |
| `orgs` (Session B4, ARCHITECTURE.md §12) | Any auth, same org (key match: `oid == userDoc().orgId`) | Manager unrestricted; team_lead narrowed to `runRateDefaultVisible` only (`hasOnly()`); create/delete: manager only. Authorized by KEY MATCH, not `sameOrg()`/`sameOrgWrite()` — the doc ID itself is the org identity. |
| `teams` | Any auth | Manager only, **plus** any auth may update ONLY the `assignmentCursor` field (`affectedKeys().hasOnly(['assignmentCursor'])`) — needed so an agent's own submission-create call can advance the rotation cursor without being manager |
| `companies` | Any auth | Create: any auth, must set `createdBy == request.auth.uid` (same pattern as `leads`/`scripts`); update/delete: manager only |
| `leads` | Any auth | Manager unrestricted; TL within own `teamId` for general edits, blocked from `ownerLocked`/`createdBy`/`createdByRole`/`teamId`; **`tlId` reassignment additionally gated** — a TL may only change `tlId` if the lead is currently unowned or already theirs, and the result must land back in their own sub-group; Agent own assigned leads, blocked from admin fields; delete guards on `ownerLocked`; **narrow exception (Phase D): active backend department staff may update ONLY `submissionSummary`** (`affectedKeys().hasOnly(['submissionSummary'])`, gated on `isActiveBackend()`) — the pipeline badge is stamped by `appendEvent` on a lead backend has no other write access to; agent/TL/manager don't need this exception since it was never in their own clauses' blocked-fields lists |
| `channels` | Any auth | Create: any auth (seed guard); update/delete: manager only |
| `scripts` | Any auth | Manager unrestricted; TL own scripts direct, manager scripts suggest-only via `pendingApproval` (`affectedKeys().hasOnly(['pendingApproval'])`) |
| `products` | Any auth | Manager only |
| `submissions` (v2 schema) | Manager; the submitting agent (`agentId`); their TL (`teamId` match); anyone in the backend department | Create: must set `agentId` to self; update: manager or backend-department unrestricted, OR the submitting agent ONLY when `status=='rejected'` moving to `'pendingVerification'` (the resubmit correction-loop, now built end-to-end as Fix & Resubmit — Phase D); **delete: manager-only, no exception even for the creator** (accountability — order records stay in the system for review, e.g. a suspected-fake document upload, rather than being quietly removable) |
| `submissionDocs` (firestore-b64 driver, ARCHITECTURE.md §6) | Same four parties as `submissions` — manager; `agentId==self`; their TL (`teamId` match); backend department (fields denormalized onto every page doc for exactly this reason) | Create: the uploading agent (`agentId==self`), a manager, **or (Phase D) active backend department staff** attaching an additional document to someone else's bundle (the page's `agentId` stays the ORIGINAL submitting agent's, not the backend uploader's — `isActiveBackend()` is what actually authorizes that write, since `agentId==self` can't); **no update at all** — pages are immutable, replacing a doc means writing the NEXT version as a new create (Fix & Resubmit, Phase D); delete: manager-only (matches the retention sweep's own gate) |
| `auditLog` | Manager only | Create: any auth, `sameOrgWrite()` (the gateway writes these on every mutation); update/delete: **never**, always `false` — append-only |

**Key implementation notes:**
- `role()` helper does a `get()` on `users/{auth.uid}` — cached within a single rule evaluation, so calling it multiple times across helper functions doesn't multiply read cost.
- `deleteRequest` field is intentionally **not** in the TL update rule's blocked-fields list — a TL writing a delete request, or a manager clearing one, needs no rule changes beyond what already exists.
- `companyId` needed no new `leads` rule — it's not an admin-locked field.
- The `companies` rule (like every other collection's) is handed to Ashok as a full-file paste-in for the Firebase Console from `rules/firestore.rules` (see the version-control note above) — confirm it's been published before relying on non-manager company creation working in production.
- **Caught during the submissions v1 rule review:** `createSubmission()` writes `teams.assignmentCursor` as part of the submitting agent's own batch — the existing manager-only `teams` write rule would have silently failed that update for any non-manager agent. Fixed by adding a narrowly-scoped `affectedKeys().hasOnly(['assignmentCursor'])` exception, the same pattern already used for `scripts.pendingApproval`.
- **Firebase Storage (Blaze-only SDK product) — still N/A, deliberately.** Document storage is
  built entirely on the free-tier `firestore-b64` driver (one Firestore doc per page in
  `submissionDocs`, see the Document Storage section above) — there is still no `uploadBytes`/
  Storage-bucket code path anywhere, and none is planned unless a future `firebase-storage` driver
  is added for Blaze-tier clients (ARCHITECTURE.md §6, not built).
- **Cross-role read verification (resolved, Phase D):** the earlier caveat here — that
  agent/team_lead/backend read paths for `submissionDocs` hadn't been independently re-verified
  with real distinct logins (the assistant never types credentials into a login form itself) — was
  closed out this session. The org's first-ever backend department + user were created, and the
  full backend flow (claim, verify, submit, activate, reject) plus the agent's own Fix & Resubmit
  were driven live across three real identities (manager, the new backend user, the existing
  agent), each logged in by the human, confirming the read/write rules behave correctly in
  practice, not just on paper. Genuine `permission-denied` bugs were found and fixed this way (see
  the Phase D history entry) that pure code review had missed.
- **Firestore LIST-query gotcha** (found across two sessions, see the submissions data model
  section above and the Phase D history entry for full detail): a `list` query is rejected
  outright unless Firestore can prove EVERY possible matched doc satisfies the read rule, unlike a
  single `get()`. A bare `where('leadId','==',id)` or `where('bundleId','==',id)` query is only
  provable for manager/backend (clauses that don't touch `resource.data` at all); every other
  role's query must ALSO include the same field their rule clause checks (`teamId`/`agentId`) to
  match that specific OR-branch. General lesson, not specific to any one collection — any future
  list query against a role-scoped OR-clause read rule needs the same query-side treatment.
- **Denied `get()` on a nonexistent document (found in Phase D):** a related but distinct gotcha —
  Firestore denies (throws `permission-denied`) rather than resolving with `exists()===false` when
  a SINGLE-document `get()` target doesn't exist and the rule's non-manager/backend clauses
  reference `resource.data` — those clauses error on a null `resource`, and an evaluation error
  denies the whole rule regardless of a later `||` branch that would have allowed it. Only clauses
  that don't touch `resource.data` (manager, `isActiveBackend()`) get a clean miss. Any code that
  "probes" a document that might not exist (e.g. trying a new id shape, falling back to a legacy
  one) needs to catch the thrown error and treat it as a miss, not rely on `.exists()`.
- **`getDoc()` on a nonexistent document can be denied even when the rule never references
  `resource.data` at all (Session B4)** — extends the gotcha above, which was scoped to rules that
  DO touch `resource.data`. Observed on `orgs/{oid}`'s pure key-match read rule (`oid ==
  userDoc().orgId`, no `resource` reference whatsoever) before that doc existed; the identical read
  succeeded immediately after creation. `js/orgConfig.js loadOrgConfig()` and `js/org.js
  computeCategoryMigrationPlan()` already wrapped this in a try/catch treating any failure as
  "doesn't exist" (written defensively before this was known), so no code fix was needed — but any
  new single-`get()` probe against a possibly-nonexistent doc should assume the same, regardless of
  whether its rule touches `resource.data`.
- **LIST-query provability re-litigated and confirmed correct (Session B4) — a real privilege-
  escalation bug was ALSO found and fixed in the same review pass, see the `users` row above.**
  A manager's list query against `submissions` succeeds with NO `where('orgId',...)` filter even
  though `sameOrg()` references `resource.data.orgId` — `role()=='manager'` is a request-time-only
  fact (one `get()` on the caller's own doc), sufficient to satisfy the whole conjunction
  regardless of what the resource.data-dependent branches would otherwise require. This does NOT
  contradict the LIST-query gotcha two notes above — that gotcha is about roles whose ONLY viable
  branch needs an unconstrained `resource.data` field; manager's branch needs none. Settled with a
  purpose-built, in-repo adversarial probe — **`tools/rules-probe.html`, deliberately NOT deleted
  as a throwaway** — run as manager (four query shapes, all succeeded) and a sales-agent control
  (all four correctly denied, proving the probe itself isn't bypassing rules). **Re-run this probe,
  as both a privileged and a non-privileged account, before merging any future change to
  `sameOrg()`/`sameOrgWrite()` or a similarly-shaped rule** — the result is a property of this
  specific rule shape, not a general Firestore guarantee.

---

## Helper Functions Reference

| Function | Purpose |
|---|---|
| `v(id)` | Get trimmed value of an input/select by element ID |
| `esc(s)` | HTML-escape a string (XSS-safe output) |
| `now()` | Returns current ISO timestamp string |
| `fmtDate(iso)` | Format ISO string to `DD MMM YYYY` (en-AE locale) |
| `disable(id, txt)` / `enable(id, txt)` | Disable/re-enable a button with loading text |
| `toast(msg, type)` | Floating notification |
| `modal(title, html, wide)` / `closeModal()` | Modal overlay control |
| `confirmModal(title, msg, onYes, danger)` | Confirmation dialog |
| `calculateTLTarget(tlId, users)` | Sum agent targets for a given TL |
| `stagePill(s)` | Colour-coded stage badge |
| `buildMsFilter(wrapId, label, opts)` / `wireMsFilter(wrapId, arr, onchange)` | Custom multi-select filter dropdown (Team/TL/Agent pickers) |
| `perfStats(uids)` / `perfHtml(st)` | Performance stat computation + rendering for Org tab accordion |
| `repairLeadTeamData(leads, byId)` | One-time manager-triggered backfill for leads missing `teamId`/`tlId` |
| `seedProducts()` / `seedChannels()` / `seedLeads()` | One-time manager-gated seed functions |

**Firestore imports in scope:** `doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, collection, query, where, getDocs, writeBatch`

---

## Working Convention

> **Strict: surgical modifications only.** Never rewrite the full file. Targeted replace blocks, verify syntax (brace/paren/backtick balance) after every change. Update this file as continuity doc across sessions.

---

## Phase History

### Phase 1 — Foundation
Firebase Auth + Firestore setup, three-role system, login UI, 115 seeded leads, basic app shell.

### Phase 2 — Lead Management
Role-scoped lead queries, "Mine" badge, assignment enforcement, `teamId`/`history[]` on mutation, delete guards, Model B `tlId` sub-group isolation, TL auto-target.

### Phase 3 — Scripts
`channels` + `scripts` collections, approval workflow, pending-state UI, manage-channels modal, audit trail.

### Phase 4 — Products & Pricing
`products` collection, seeded 19-plan catalog, discounts + monthly waivers, manager-only CRUD, Firestore rules overhaul across all 6 collections.

### Phase 5 (in progress)
- **Dashboard tab** — KPIs, target progress, monthly history, follow-ups, activity feed, agent performance (all roles)
- **Permission audit & fixes** — multi-select filter bug fix, TL sub-group assignment scoping (was leaking across TLs in the same team), orphaned-lead handling on member removal, silent-reassignment-to-first-option trap fixed with explicit "Unassigned" option, `teamId`/`tlId` backfill tool (`repairLeadTeamData`) for leads that predate those fields
- **TL delete-approval workflow** — request/withdraw/approve/reject for manager-locked leads
- **Permanent delete** — Team Lead and Agent hard-delete with correct cascades, added alongside existing soft-remove
- **Bulk-assign leads** — multi-select checkboxes + single-action reassignment in the Pipeline tab, sub-group-scoped for TL
- **ES module split** — `index.html`'s single inline script became 9 `js/*.js` modules (see File Structure above); no behavior change, verified via a full local live-Firestore pass before pushing
- **Companies collection** — `js/companies.js` (normalize/dedup/fuzzy-match/find-or-create/backfill), manager-only Companies card + Backfill button in the Org tab, and a searchable company picker (with inline "did you mean X?" fuzzy nudge) in the Add Lead modal. Verified live: backfill turned 115 seeded leads into 113 unique company docs with zero console errors.
- **Permission-grant scaffolding** — `js/permissions.js` catalog + `hasPermission()` + searchable checklist UI in Edit Team/Edit User. `edit_companies` defined but not yet wired to a rule or non-manager UI (see Permission-Grant System section above) — deliberately shipped as reusable infrastructure ahead of its first real consumer.
- **Next up:** backend-department/submissions workflow (`teams.department`, `users.department`, `submissions` collection — gated on the companies phase being confirmed solid in production, per Ashok's explicit hold) and reports (pending a business definition of "projection")

### Phase 6 — Backend department foundation
- `teams.department` (Sales/Backend) + `teams.assignmentMode` (Auto/Manual, backend teams only) —
  Add/Edit Team modal fields. Changing a team's department cascades to every member's
  `users.department` in the same batch write, so the denormalized field can't go stale.
- `users.department` denormalized from the assigned team (null if unassigned or manager) +
  `specialties`/`available` fields for backend-department agents specifically (Add/Edit User
  modals show a Specialties checklist + Available toggle only when the selected team's
  department is `backend` and the role is `agent`).
- **No Firestore rule changes needed for this phase** — `teams`/`users` writes were already
  manager-unrestricted, so these are just new fields on docs the manager already controls.
- Verified live: created/edited/deleted a real Backend team and backend agent (specialties +
  availability round-tripped correctly), zero console errors. Committed locally (1da7e34).

### Phase 7 (in progress) — Submission creation
- New `submissions` collection (`js/submissions.js` + Submit to Backend modal in `js/leads.js`) —
  see the Data Model section above for the full schema.
- Multi-product line items (product + pricing option → dealValue, editable), file upload tagged
  with a docType, submit blocked until every computed `requiredDocs` entry has a file and at
  least one item is added.
- v1 auto-assignment (`pickBackendAgent`): available + specialty-matching (or generalist) backend
  agents, simple rotation via `teams.assignmentCursor` when multiple candidates match. Manual-mode
  teams and zero-match cases leave the item unassigned for later manual triage.
- **Rule work resumed here** (Firestore `submissions` rule + Storage rules for file access) — see
  the Firestore Security Rules section. Caught and fixed one real bug during review: the
  submission-create batch also updates `teams.assignmentCursor`, which the existing manager-only
  `teams` write rule would have silently blocked for a non-manager agent.
- **Not built yet (Phase 8):** backend queue view, per-item stage advancement, the
  needsCorrection/rejected correction loop, and anything that reads files back out of Storage.
- **Next up:** Phase 8 — backend stage pipeline (queue view, Account Creation → Financial
  Approval → Activity → Work Order → Activated, correction loop).

### Phase A0/A (shipped) — Multi-tenancy foundation
Per `ARCHITECTURE.md`'s white-label pivot (Sections 0, 2, 3, 8).
- **Step 0:** merged `wip-submissions` into `main` (see header note above) — resolved conflicts in
  `PROJECT_SPEC.md`/`js/state.js`, verified the Submit to Backend modal and all tabs still work.
- **`js/db.js`** — new single Firestore mutation gateway, built and every module (`org.js`,
  `leads.js`, `scripts.js`, `products.js`, `companies.js`, `auth.js`, `submissions.js`) migrated
  through it one at a time, tested and committed individually. See File Structure above for what
  it centralises (orgId stamping, audit fields, `closedAt`, `history[]` cap, product soft-delete).
- **`runOrgIdMigration()`** (`js/org.js`) — one-off manager-triggered backfill, run live: stamped
  `orgId` on all 259 pre-existing docs across every collection, 0 missed. Same banner+button UX
  as `repairLeadTeamData`, safe to re-run.
- **`rules/firestore.rules`** rewritten with the `sameOrg()`/`sameOrgWrite()` multi-tenancy pattern
  across every collection — now version-controlled in this repo (see Firestore Security Rules
  section above for full detail, including the critical bootstrap bug found and fixed live).
- **GitHub Pages deploy switched to GitHub Actions** (`.github/workflows/deploy.yml`) — the old
  "deploy from branch" mode shipped a repo missing the gitignored `config.js`, breaking login on
  the live site entirely. Fixed with a build step that writes `config.js` from a `CONFIG_JS`
  repository secret. A second, separate outage (masked/bullet-character API key in the secret,
  from copy-pasting a chat-rendered value instead of the raw file) was diagnosed and fixed the
  same way — see Deployment note above.
- **Final all-roles regression pass** — verified live (manager/team_lead/agent) after the rules fix
  and migration: profile reads, dashboard/pipeline views, and a real create→update→delete cycle
  for the agent role, plus an edit-and-revert for the team_lead role. No permission errors, no
  orphaned test data left behind.
- **Pipeline tab pagination** (`js/leads.js`, the last piece of step 4's quick fixes) — the
  unbounded `getDocs(collection(db,'leads'))` full-collection scan (all roles) was replaced with
  real server-side cursor pagination: `orderBy('lastEditedAt','desc')` + `limit(PAGE_SIZE)` scoped
  by role (`teamId==`/`assignedTo==`) and the active stage tab, numbered page buttons (page size
  25), and per-page caching (both the Firestore cursor AND the rendered rows) so revisiting an
  already-seen page costs zero reads. Stage-tab counts and total-page count use
  `getCountFromServer()` (a cheap aggregation query, ~1 read per 1000 matched docs) instead of a
  full scan just to count. Team/TL/Agent multi-select filters and the free-text search box can't
  be pushed server-side without a paid full-text index, so they auto-load additional pages of the
  current stage+role query in the background (capped at 5,000 docs) and filter client-side over
  everything loaded so far — a warning banner shows if the cap is hit before finding everything.
  **Requires 5 Firestore composite indexes** (one per role×stage-shape combination: manager+stage,
  TL+all, TL+stage, agent+all, agent+stage — manager+all needs no index, pure single-field sort);
  created via the Console's auto-generated links this session, all confirmed `Enabled`. Verified
  live for manager and team_lead roles (pagination, stage tabs, search, team filter, page caching).
### Phase B (in progress) — Submissions v2 + scalable lookups
Per `ARCHITECTURE.md` v2.0's schema amendment (§3/§5) and quota-discipline section (§9).
- **Batch-chunking bug fix** — `auditLog` (built this session, see above) writes one doc per
  mutation IN THE SAME BATCH as the mutation itself, silently doubling writes-per-op. The old
  400-op chunk size across every bulk path (`backfillCompanies`, `leads.js` bulk-assign, org.js's
  4 cascades — team delete, member removal, hard-delete, department-change — plus
  `repairLeadTeamData` and the already-run `orgId` migration) would have committed 800 writes and
  thrown past Firestore's 500-write cap on any run over ~250 items. Two of the org.js cascades had
  NO chunking at all before this — a latent bug even pre-auditLog. Fixed everywhere: every bulk
  op now passes `skipAudit:true` per-op + writes ONE summary `auditLog` entry per run
  (`action:'bulk', count, description`) via a new shared `logBulkAudit()` helper; CHUNK reduced to
  200 across the board.
- **`js/submissions.js` rewritten** (dedicated rewrite, not a patch) — see the `submissions` data
  model section above for the full schema. `createSubmissions()` (plural) creates one doc per
  product line sharing a `bundleId`; `appendEvent()` is the event/status-transition engine;
  `pickBackendAgent()` gained a fallback-to-any-available-agent when no specialty matches;
  `docExpiryWarnings()` surfaces company doc-expiry risk at submit time. All Storage/`uploadBytes`
  code removed — deferred to the next session's StorageAdapter.
- **Rules**: `submissions` update rule now includes the agent correction-loop
  (`agentId==self && status=='rejected' → 'pendingVerification'` only) alongside manager/backend
  unrestricted; added a manager-only delete rule (explicit product decision: no exception for the
  creator, so a suspected-fake upload stays in the system for review rather than being
  self-deletable).
- **Company enrichment + scalable lookups** — see the `companies` data model section above for
  the full field list and the `findOrCreateCompany`/`searchCompanies` rework. `fetchCompanies()`'s
  full scan is banned from every company picker going forward (ARCHITECTURE.md §9); the two
  remaining deliberate exceptions (`backfillCompanies`, Org tab Companies card) are documented in
  `js/companies.js` itself.
- **Submit to Backend UI reworked** for bundle creation + a new read-only Submission Timeline view
  — see the `submissions` data model section above.
- **Real bugs found and fixed during live regression, not just written and assumed correct:**
  (1) two UI state-loss bugs in the Submit modal — selecting a product then triggering any other
  re-render (e.g. removing a line) reset the product picker and lost the populated term dropdown/
  category fields; the account-transfer partner name typed in was silently wiped by the next
  unrelated re-render (e.g. attesting a document's expiry date) — both traced to `render()` fully
  replacing the modal's innerHTML with no persisted state for those fields, both fixed by tracking
  them in closures instead of reading the DOM after the fact. (2) A genuine Firestore LIST-query
  gotcha (documented in the Firestore Security Rules section above) broke team_lead's and agent's
  own "View Timeline" button — worked fine for manager, `permission-denied` for everyone else,
  caught only because Step 8's regression pass tested with real non-manager identities instead of
  trusting the rule text.
- **Full regression, all three roles, real identities (not manager-only)**: create-submission
  through the actual UI (multi-line bundle, different product categories, SPR, account transfer,
  doc attestation) as manager and as agent; team_lead's and agent's own "View Timeline" access;
  the full agent correction-loop lifecycle as the actual agent — correctly denied rejecting their
  own submission, correctly denied jumping straight to `activated` on a rejected one, correctly
  allowed to resubmit (`rejected` → `pendingVerification`) their own. All test data cleaned up
  afterward, verified back at baseline (115 leads, 114 companies, 0 submissions).
- **Not started yet:** the backend queue/action UI (a real screen for verify/reject/activate,
  instead of console calls to `appendEvent`) — per `ARCHITECTURE.md` §10's Phase B scope. The
  StorageAdapter (real file bytes) shipped in the following session — see Phase C below.

### Phase C (shipped) — Document Storage on the free tier
Per `ARCHITECTURE.md` §5/§6. Full detail — schema, capture pipeline, retention sweep, rules, and
the regression pass — is in the `submissions` data model section above (Document Storage) and the
Firestore Security Rules section (`submissionDocs` row + cross-role caveat); not restated here.
Summary: `StorageAdapter` + `firestore-b64` driver, `js/documents.js` capture pipeline
(image/PDF → compressed JPEG pages, 10-page PDF cap), Submit-to-Backend file attachment wired in,
read-only page viewing in the Submission Timeline, a manager-only retention sweep in the Org tab,
and an `appendEvent` transaction/timestamp hardening fix done alongside it. Regression pass used
real synthetic JPG/PDF files and a real backdated bundle, all cleaned up back to baseline
afterward; the one gap is the cross-role read-rule check noted above, left for a human to verify
with real logins.

### Phase D (shipped) — Backend working UI + five UX/data fixes
Per `ARCHITECTURE.md` §4/§5. Two clusters of work, both fully regression-tested live with real
manager, backend, and agent identities (the org's first-ever backend department + user were
created during this session's testing).

**UX/data fixes (found live in earlier sessions' testing):**
- **Header team name** — agents and team leads now see their team in the header role badge (e.g.
  "Agent · Retention Team"), resolved from `teamId` at login. Manager is unscoped to one team, so
  unchanged. Cosmetic-only lookup — a failed fetch just leaves the role-only label.
- **Close-to-submit flow** — saving a lead into `Closed` (with a company linked, submit
  permission, and nothing already submitted) transitions the edit modal straight into Submit to
  Backend instead of just closing, with a "Submit later" button to dismiss without submitting.
- **Stage dropdown clipping** — the New Lead modal's stage select was filtering OUT Closed/Lost
  entirely (the more literal reading of "can't be seen or selected"); restored to the full
  `STAGES` list matching the edit modal, plus a focus-time `scrollIntoView` safeguard
  (`helpers.js fixSelectScrollClip`) on both modals' stage selects so a select near the bottom of
  a scrollable modal body always gets centered in the viewport before its native popup opens.
- **Pipeline submission badge** — `lead.submissionSummary` (see Data Model above), a small badge
  on Closed pipeline rows: none = "Not submitted" (attention-styled — the gap a TL needs to
  catch), else submitted/inProgress/activated/rejected each with their own style (rejected red).
  Collapse rule (`submissions.js collapseSubmissionSummary`): any rejected line wins regardless of
  siblings; all-activated only if EVERY line is; otherwise the furthest-along in-flight state.
  Stamped by `createSubmissions` and `appendEvent` in the SAME batch/transaction as the write that
  changes it — `appendEvent` enumerates the bundle's siblings via a plain query BEFORE its own
  transaction (Firestore transactions can't run queries) and re-reads them by ref inside it for a
  consistent collapse.
- **Stale denormalized team data (root cause + repair cascade)** — a lead created without
  `teamId` used to get that blank value frozen permanently onto every submission created from it
  (`createSubmissions` copied `lead.teamId||''` verbatim). Root cause: the New Lead modal's
  self-assign skip condition fired for an AGENT self-assigning their own lead (the most common
  creation path), not just a manager. Fixed at both ends — `createSubmissions` (and the document
  upload path, which had the identical bug) now resolves teamId/tlId from the ASSIGNED AGENT's
  live profile first, falls back to the lead's own fields, and refuses the submission outright if
  both are empty; the create-lead modal resolves from the agent's own already-loaded profile
  instead of skipping. `repairLeadTeamData` (Org tab) now cascades into already-created
  submissions with the same stale value (submissionDocs pages are left alone — deliberately
  immutable, see Phase C — counted and reported instead of a write the rules would reject).

**Backend working UI (all new, `js/queue.js` + `js/pdfExport.js`):**
- **Queue tab** — gated to managers and active backend-department staff (`department:'backend' &&
  active!==false`, independent of `role`, mirroring the submissions read rule's
  `isActiveBackend()`). Three views (Unassigned/My Queue/All), a status filter, oldest-first sort,
  activated/rejected hidden by default. Deliberately fetches the whole `submissions` collection
  once (bounded) rather than several narrower server-side queries, specifically to avoid needing
  new Firestore composite indexes — the manager/backend read clause doesn't reference
  `resource.data` at all, so a bare fetch is provable for any query shape; everything else
  filters/sorts client-side over that one fetch (same "manager/backend needs a full view"
  exception already used by the Org tab and `fetchCompanies()`).
- **Claim + reassignment** (`submissions.js claimSubmission`/`reassignSubmission`) — both just set
  `assignedBackendAgent`, logged as a `note` event atomic with it via a new `extraFields` param on
  `appendEvent` (internal-only — merges extra fields into the same transactional update, not a
  general escape hatch). Any active backend user can claim an unassigned submission; only a
  backend coordinator (`team_lead` + `department:'backend'`) or manager gets the reassign picker —
  a CLIENT-SIDE workflow policy only, since the rule already gives the whole backend department
  unrestricted submission-update rights.
- **Action panel** — opens from a Queue row. Full submission detail (company block with
  `hasDuAccount` badge + account code, product line, categoryFields, SPR, accTransfer,
  requiredDocs with on-demand page viewing), full events timeline, and every `appendEvent` action:
  quick one-click buttons for the no-payload events plus small inline forms for
  activityNo/workOrderNo/appointment/sprObtained/correction/note/rejected (reason dropdown from
  `ORG_DEFAULTS.rejectionReasons`). Only ever calls `appendEvent` — never sets status directly —
  and re-fetches the submission fresh after each action.
- **Versioned document resubmission (Fix & Resubmit)** — `submissionDocs` docIds gained a version
  segment (`{bundleId}_{docType}_v{n}_{pageIndex}`; `get()` falls back to the pre-versioning id
  shape when v1 isn't found, rather than migrating old docs). Reachable only by the submitting
  agent on their own rejected line (`js/leads.js`): editable categoryFields, optional per-doc-type
  re-upload that writes `v{n+1}` pages as a fresh CREATE (pages are immutable — this is the only
  replacement path), then a `resubmit` event; categoryFields + the updated requiredDocs pointer
  ride the SAME transaction via `extraFields`. Old versions are deliberately retained as evidence,
  never deleted individually — only the whole-bundle retention sweep clears them, once every
  sibling submission is terminal (the sweep's existing `bundleId`-field query already catches
  every version with no changes needed). Both the timeline viewer and the action panel show the
  latest version with an "older versions" expander (probes sequentially for pages, since an older
  version's page count isn't stored anywhere but the CURRENT `requiredDocs` pointer).
- **Combined-PDF export** (`js/pdfExport.js downloadBundlePdf`) — compiles every doc type's LATEST
  version pages for a bundle into one PDF via jsPDF, one stored page per PDF page, labeled header
  per doc type. Siblings each carry their own `requiredDocs` copy, so a partial rejection+fix can
  leave them pointing at different versions of the same docType — takes the highest version seen
  across all siblings. Available from both the agent's Submission Timeline (per bundle) and the
  backend action panel.
- **Backend document attachments** (`submissions.js attachBackendDocument`) — backend can attach
  an ADDITIONAL document (Affidavit/Email Extension/Other, distinct from the agent's required
  checklist) to a bundle through the same capture pipeline, fanned out to every sibling
  submission's `requiredDocs` (same duplication pattern as the agent's original upload). The
  page's `agentId`/`teamId` stay the ORIGINAL submitting agent's own values, not the backend
  uploader's, so the read rule's agent/TL-scoped clauses keep working; `uploadedBy` (already a
  separate field) records who actually attached it. Required a rules change — see below.
- **Copy tools** — a copy icon next to every copyable field on the action panel (company name,
  account code, contacts, address, product, qty, category fields incl. MSISDN/GAID) plus "Copy
  All" in a fixed field order (`COPY_ALL_FIELDS`, a const — TODO: make org-configurable later once
  du's actual ticket field order is known, hardcoded for now since there's no org-config UI yet).

**Rules changes (both published this session):**
- `leads` gained a narrow `submissionSummary`-only exception (same pattern as
  `teams.assignmentCursor`), scoped to `isActiveBackend()` only after review — the agent/manager/
  team_lead clauses already covered their own writes of that field without needing it.
- `submissionDocs` create now also allows `isActiveBackend()`, needed for backend document
  attachments (a backend upload's `agentId` never equals the uploader's own uid the way the
  existing `agentId==self` clause expects).

**Real bugs found and fixed during live regression, not just written and assumed correct:**
1. `storage/firestore-b64.js get()` — Firestore denies (throws `permission-denied`) rather than
   resolving with `exists()===false` when a read target doesn't exist and the rule's non-manager/
   backend clauses reference `resource.data` — those clauses error on a null `resource`, and an
   evaluation error denies the whole rule regardless of a later `||` branch that would have
   allowed it. That broke the new-id-then-legacy-id-fallback probe for any role whose OWN clause
   needs `resource.data` (agent, team_lead) — only manager/backend's `resource.data`-free clauses
   got a clean miss. Fixed by wrapping each `getDoc()` attempt so a denial is treated as "not
   found" and falls through to the next attempt.
2. `pdfExport.js` — jsPDF's own published ESM build (`dist/jspdf.es.min.js`) references internal
   Babel helpers via bare npm-style specifiers that only resolve inside a bundler; a raw browser
   `import()` throws. Switched to jsdelivr's `+esm` endpoint, which re-bundles the whole package
   with dependencies inlined.
3. `submissions.js appendEvent` — same LIST-query provability gotcha as the earlier f0c34bd fix:
   the sibling bundle enumeration query was a bare `where('bundleId','==',bundleId)`, only
   provable for manager/backend. For the SUBMITTING AGENT calling this (Fix & Resubmit's
   `resubmit` event), Firestore couldn't prove every result satisfies
   `resource.data.agentId==request.auth.uid` without that field in the query, and denied the
   whole call. Mirrored the query with the known `agentId` from the already-fetched single-doc
   read (every sibling in a bundle always shares one `agentId`, so this is correct for
   manager/backend's broader case too).
4. `leads.js showSubmissionTimelineModal` — the Fix & Resubmit success callback re-rendered the
   timeline using the stale `submissions` array captured when the modal first opened, instead of
   re-fetching; the just-completed resubmit's new status/requiredDocs never showed up without a
   manual reload.

**Full regression, real identities throughout (manager + a newly-created backend user + the
existing agent, not simulated):** claim, verify (call), submit to du, log activity number and
appointment, activate one submission; skip verification on another, confirmed
`proceededWithoutVerification` fired, then reject with a reason; as the agent, Fix & Resubmit the
rejected one with a real replacement image (new version recorded and viewable, old version still
separately viewable, confirmed via a genuinely-never-uploaded v1 slot correctly reporting "No
pages found" rather than erroring); downloaded the bundle PDF twice (before and after the
resubmit) and verified page count/order/labels both times via `pypdf`; verified the close-to-
submit flow, the stage dropdown fix, and the pipeline badge transitioning live through the whole
flow (submit → badge, reject → attention badge, resubmit → back to submitted, activate →
activated) on the agent's own real screen. Cleaned up all test data back to baseline (deleted
every test lead/company/submission/document page created, reverted the one pre-existing test
submission touched during regression back to its original pendingVerification/unclaimed state)
— the newly-created backend team and user were kept, since they're real org infrastructure, not
test data.

### Session B4 (shipped) — Manager's Cockpit
Per `ARCHITECTURE.md` §12. Session-sequence label, not a Phase-A–G item — sits ahead of Phase C's
rollup counters in delivery order but deliberately doesn't build them (see below).

**Category identity refactor + migration (`js/orgConfig.js`, `js/org.js`):** categories
(`Starter`/`Essential`/`Ultimate`/`Mobile`) moved from name-string identity to permanent IDs in a
new `orgs/{orgId}.categories: [{id,label}]` org-config doc; `products.category` and
`users.specialties[]` migrated to store the ID, `categoryLabel()` resolves the label at render
time with a fallback-to-raw-value for anything not a known ID (safe for both migrated and
not-yet-migrated data at the same call site). `submissions.category` was deliberately left
un-migrated — a submission is an immutable snapshot, not live config, and the fallback already
displays a legacy value correctly. One-time migration (Org tab, manager-only): dry-run preview
before writing, `skipAudit`+one summary `logBulkAudit` entry, safe to re-run. Contract-term labels
(`orgs/{orgId}.contractTermLabels`) are a separate, optional override layered on top of each
product's own stored `pricingOption.label` — no migration needed, nothing breaks if never set.

**Products config panel (`js/products.js showCategoryConfigModal`):** manager-only — rename
(label edit; IDs are permanent), add, and delete (blocked while any product references the
category, blocking products listed by name) for categories; rename for contract-term labels.

**Manager's Cockpit dashboard:** `js/dashboardData.js getDashboardData(period)` — a swappable
client-side aggregation module (period presets + custom ≤92-day range) that Phase C will later
replace internally with rollup-counter reads, same call signature/output shape.
`js/dashboardCharts.js` — dependency-free hand-rolled SVG donut (`renderDonutCard`). Wired into
`js/dashboard.js`'s manager-only `#mgr-cockpit` section: period/AED-count selector shared by
donuts (Share by Team, Share by Contributor), role-metrics cards (`js/dashboardCards.js` — sales
agent AED closed/lines submitted; backend submissions handled/queue wait/handling time/du
turnaround, the last explicitly labeled du's own clock; KAM/escalations reserved placeholder), and
target-remaining (AED remaining vs. sum of agent targets, This Month only — N/A for every other
period) with a run-rate toggle (days-left + required daily run-rate, default OFF). Donut/role
attribution rule (**repointed in Session B5 — see below**): a normal line credits the submitting
agent; a `sourcedBy`-flagged line credits that partner (or "Outsourced Revenue" if no partner name
recorded) — independent of a sales agent's own `aedClosed`/`linesSubmitted`, which is keyed on
`agentId` directly regardless of that split.

**Session B5 correction (attribution now reads `sourcedBy`, not `accTransfer`):** B4's attribution
used `accTransfer.fromPartner` as a sourcing proxy. Domain review established `accTransfer` is
actually an operational account-TAKEOVER marker (custody moving from a losing partner to us,
reversible by du) — orthogonal to sourcing, and crediting revenue to `fromPartner` (often the
LOSING competitor) was wrong by design. `js/dashboardData.js`'s `byContributor` loop now reads a
new, separate `sourcedBy` field exclusively; `accTransfer` is never read in the aggregation at all.
Zero submissions had `accTransfer.flag==true` in production at the time of this correction, so no
data migration was needed. See the `submissions` schema above for both fields, and the Session B5
Phase-History entry below for the full writeup (sourcing capture UI, transfer outcome tracking).

**Run-rate visibility resolution:** per-user override (`users/{uid}.runRateVisible`) always wins
over the org default (`orgs/{orgId}.runRateDefaultVisible`) in either direction — verified live
across all four combinations. The org-default toggle is manager-AND-team-lead-writable at the
rule level, verified live, but **no UI currently exposes it to a TL** (the whole Manager's Cockpit
section is manager-only) — not an open-ended gap: the TL toggle UI ships with the TL/agent-facing
target views phase, since the toggle governs a manager-only view today and TL-facing UI for it
would be meaningless until those views exist.

**Rules changes (published this session, both required a live-tested republish after an initial
publish mismatch — see below):**
- New `orgs/{oid}` collection, authorized by key match (`oid == userDoc().orgId`) rather than
  `sameOrg()`/`sameOrgWrite()` — the doc ID itself is the identity, and this avoids depending on
  `js/db.js`'s `dbSet()` gateway continuing to stamp a redundant `orgId` field. Read: any same-org
  user (`loadOrgConfig()` runs for every role at login). Write: manager unrestricted, team_lead
  narrowed to `runRateDefaultVisible` only (`hasOnly()`).
- **`users` self-write privilege-escalation fix, found during this step's review (not something
  this session set out to change):** the prior clause let any user update ANY field on their own
  doc, including `role`/`department` — an agent could self-write `role:'manager'` or
  `department:'backend'` and pass every `role()=='manager'`/`isActiveBackend()` check in the
  entire rules file. Narrowed self-write to exclude a blocklist (`role`, `department`, `orgId`,
  `teamId`, `tlId`, `active`, `monthlyTarget`, `targetSource`, `autoTarget`, `permissions`,
  `specialties`, `available`, `email`, `createdBy`, `createdAt`); manager stays unrestricted.
  Verified live as an agent, twice — the first publish turned out to be a stale pre-fix version
  (self-promotion to manager briefly succeeded against live data, immediately reverted, root-caused
  to a publish mismatch rather than a rule-logic bug, republished, reverified clean on all three
  cases: `runRateVisible` self-write succeeds, `role`/`monthlyTarget` self-writes denied).
- One composite index: `submissions (status ASC, activatedAt ASC)`, for the dashboard's
  activated-in-period query. The other two dashboard queries (`createdAt` range, `claimedAt`
  range) are single-field ranges, already auto-indexed.

**Rules-engine findings:**
1. **LIST-query provability, re-litigated and confirmed correct.** A manager's list query against
   `submissions` succeeds with no `where('orgId',...)` filter even though `sameOrg()` references
   `resource.data.orgId` — `role()=='manager'` is a request-time-only fact (one `get()` on the
   caller's own doc), sufficient to satisfy the whole conjunction regardless of what the
   resource.data-dependent branches would otherwise require. Settled with a purpose-built
   adversarial probe (`tools/rules-probe.html`, kept in-repo, NOT a throwaway — independent of the
   app's own Firebase module instance) run as both manager (four query shapes, all succeeded) and
   a sales-agent control (all four correctly denied). Re-run obligation recorded in
   `ARCHITECTURE.md` §12: this must be re-run before any future change to
   `sameOrg()`/`sameOrgWrite()` or a similarly-shaped rule.
2. **`getDoc()` on a nonexistent document can be denied even when the rule never references
   `resource.data` at all** — observed on `orgs/{oid}`'s pure key-match read rule before the doc
   existed; the identical read succeeded immediately after creation. Extends the existing
   `submissionDocs`-era "denied get() on nonexistent doc" gotcha (Phase C) — that pattern is not
   conditional on the rule touching `resource.data`. No code fix needed: `loadOrgConfig()` and
   `computeCategoryMigrationPlan()` already treated any read failure as "doesn't exist."

**Regression:** donut totals, byTeam, byContributor (both the accTransfer-with-partner and
accTransfer-without-partner "Outsourced Revenue" fallback), sales-agent role metrics, and all
three backend timing averages reconciled exactly against a 6-line hand-calculated fixture (normal
agent line, two manager-kept/external-source lines, a 2-line partial-activation bundle, one
activated line with no `claimedAt`) — every field matched, which also proved partial-activation
handling and the queue-wait N/A mechanism in the same pass. Category rename propagation verified
live across Products display, the category filter, and the Org tab specialty checklist with no
page reload. Migration integrity verified live: zero dangling name-strings in `products`/`users`.
Queue tab, action panel, copy tools, and the pipeline `submissionSummary` badge all still render
correctly against post-migration category IDs. All fixture/test data cleaned up after use.

### Session B5 (shipped) — Sourcing & Transfer Tracking
Per `ARCHITECTURE.md` §13. Corrects a B4 design mistake and adds a small new operational tracker —
no rules or index changes needed for either.

**Why:** B4's donut/contributor attribution used `accTransfer.fromPartner` as a sourcing proxy.
Domain review established `accTransfer` is actually an operational account-TAKEOVER marker (du
custody moving from a losing partner to us, reversible by du) — orthogonal to sourcing. Crediting
revenue to `fromPartner` (often the losing competitor) was wrong by design. Zero submissions had
`accTransfer.flag==true` in production at the time (confirmed via a live data pull before this
session started), so this was a pure go-forward correction with no data to migrate.

**Attribution repoint (`js/dashboardData.js`):** `byContributor` now reads a new `sourcedBy` field
exclusively; `accTransfer` is never read in the aggregation anymore. Verified with a synthetic
5-case logic check (normal line, `sourcedBy`-with-name, `sourcedBy`-no-name fallback,
`accTransfer`-flagged-but-not-`sourcedBy` — proving it no longer affects attribution, and both
flags set simultaneously — proving `sourcedBy` alone decides) AND a live 4-line Firestore fixture
reconciled exactly against hand-calculated totals, same four scenarios.

**Sourcing capture (`js/leads.js`, `js/submissions.js`):** new `sourcedBy: {flag, partnerName}`
checkbox + name input on the Submit-to-Backend modal, alongside (not replacing) the existing
`accTransfer` checkbox — same re-render-survival state pattern, same toggle-reveals-input UX,
create-time-only and immutable thereafter. Both checkboxes gained one line of helper text so
agents can't confuse the two concepts (custody transfer vs. deal origin).

**Transfer outcome tracking (`js/submissions.js`, `js/queue.js`):** new `transferStatus:
'pending'|'completed'|'rejected'` field, present ONLY on `accTransfer`-flagged lines (absent
elsewhere — `accTransfer.flag` stays the single source of truth for "is this a transfer"). Two new
`appendEvent` types, `transferCompleted`/`transferRejected`, each in their own branch that touches
ONLY `transferStatus` — structurally incapable of altering the submission's own `status`/document-
review lifecycle, not just conventionally kept separate. `transferRejected` requires a free-text
reason (a different concept from `ORG_DEFAULTS.rejectionReasons`, which governs document
rejection). UI: Mark Transfer Completed/Rejected buttons in the Queue action panel, visible to
backend or manager only, only while `transferStatus==='pending'`; a rejected transfer renders a red
"⚠ Transfer Rejected" stall badge in three places (Queue list, action panel, agent's own Submission
Timeline) sharing one set of label/color constants so they can't drift apart.

**Regression:** live-tested as backend (`rajubai@shaunapp.ae`) — `transferCompleted` succeeds, is
correctly attributed in the timeline to the acting backend user (not the original submitting
agent), no rule changes needed (backend already has unrestricted submissions update). Live-tested
as manager — `transferRejected` with a reason succeeds, badge renders in both the Queue list and
the action panel, and the submission's `status`/Quick Actions were confirmed completely unaffected
(the lifecycle-independence guarantee holds in practice, not just in code structure). B4 smoke
(Manager's Cockpit dashboard, run-rate toggle, Products tab) re-verified with no regressions —
Session B5 touched none of those files. All test data (submissions, denormalized lead fields)
cleaned up back to baseline after use; one pre-existing, unrelated data inconsistency was
discovered during cleanup verification (a real lead's `submissionSummary` badge reads "submitted"
with zero backing submissions) and deliberately left untouched, since B5 never wrote to that lead
and reverting data this session didn't touch, based on an uncertain history, was judged riskier
than leaving a stale badge — flagged for Ashok to investigate separately.

---

## Planned / Future Phases

**Superseded by `ARCHITECTURE.md`** — that document is now the source of truth for all future
build phases (Phase A0 through G) and overrides anything below where they conflict. This section
is kept only as a pointer, not duplicated content that could drift out of sync.

Already shipped, previously listed here as pending (do not re-plan these):
- ~~Companies as a real entity~~ — done, see Data Model above.
- ~~Reusable permission-grant system~~ — done, see Permission-Grant System above.
- ~~Splitting `index.html` into ES modules~~ — done, see File Structure above.

Still ahead, with correct current detail in `ARCHITECTURE.md` (not restated here to avoid two
sources of truth going stale independently):
- Backend department + submission workflow — the actual shipped pipeline is
  `SUBMISSION_STAGES` (Account Creation → Financial Approval → Activity → Work Order → Activated)
  with a `blocked: needsCorrection|rejected` side-branch, not the earlier "Submitted → In Review"
  model this section used to describe. See `ARCHITECTURE.md` §0 (audit), §8 (Phase A-G plan).
- Reports — full 17-report catalog with audience/source/rollup design in `ARCHITECTURE.md` §7,
  superseding the vague "projection report" placeholder this file used to carry.
- Document expiry tracking, company merge tooling — `ARCHITECTURE.md` §0 audit items and phase plan.
