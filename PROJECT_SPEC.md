# du Sales Cockpit — Project Spec
**Last updated:** July 2026 | **`wip-submissions` merged into `main`** — companies, backend-department schema, and submission creation (Phases 5-7 of the original handoff numbering) are all now on `main`. Submission file upload is still blocked pending a Storage decision (Blaze plan cost — see ARCHITECTURE.md Section 4). **`ARCHITECTURE.md` is now the authoritative spec for all future work** (product architecture, its own Phase A0-G build plan, and the current-state audit) — this file stays as historical/reference documentation for what's already shipped.

---

## Overview

A Firebase-backed B2B sales management web app for Shaun Technologies Trading LLC (authorised du Business partner, Dubai). Built for a multi-role sales team to manage leads, track pipeline, standardise outreach scripts across channels, and reference du Business product pricing with discount and waiver management.

**Live URL:** https://akosoto.github.io/du_sales_cockpit
**Firebase project:** `du-sales-cockpit`
**Stack:** `index.html` (shell: HTML + CSS only) + `js/*.js` ES modules, Firebase Auth, Firestore, no build step
**Repo:** https://github.com/Akosoto/du_sales_cockpit (branch `main`, GitHub Pages deploys from `main` / root)

### File structure (as of the Phase 5 module split)
```
index.html          — HTML shell + all CSS, loads js/main.js as the sole entry script
js/state.js          — Firebase init (db/auth/auth2), SEED_EMAILS, STAGES, SP, mutable CU/CP/TAB
                        (exported as live bindings; only state.js's own setUser()/setTab() may
                        reassign them — every other module just imports and reads)
js/helpers.js         — v, esc, now, fmtDate, disable, enable, toast, modal, closeModal,
                        confirmModal, stagePill, calculateTLTarget, buildMsFilter, wireMsFilter
js/auth.js            — login/logout, ensureProfile, onAuthStateChanged routing, change-password
js/org.js             — Org & Teams tab, team/user CRUD, seedLeads, repairLeadTeamData,
                        Companies card (list/edit/backfill), permission-checklist wiring
js/leads.js           — Pipeline tab (incl. bulk-assign), lead modal, add-lead modal
                        (add-lead includes the company search/fuzzy-match picker), and the
                        Submit to Backend modal (shown on Closed leads with a companyId)
js/companies.js       — normalizeCompanyName, findFuzzyMatch, fetchCompanies,
                        findOrCreateCompany, backfillCompanies — the one shared
                        implementation used by both the lead picker and the backfill
js/permissions.js     — PERMISSIONS catalog, hasPermission(), searchable checklist
                        HTML/wiring for Edit Team/Edit User modals
js/submissions.js     — computeRequiredDocs, pickBackendAgent (rotation-based auto-assign),
                        createSubmission (uploads files, resolves per-item stage/assignment,
                        writes the submission doc) — pure logic; the modal UI lives in leads.js
js/dashboard.js       — Dashboard tab
js/scripts.js         — Scripts tab, channels, approval workflow
js/products.js        — Products tab, seed catalog, discounts, waivers, PRODUCT_CATEGORIES
                        (shared with js/org.js's backend agent specialties checklist)
js/main.js            — getTabs/renderNav/switchTab — the only place that imports every
                        render*Tab function and routes between them
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
  specialties: string[],           // NEW (Phase 6) — backend agents only; product category names
                                    // (js/products.js PRODUCT_CATEGORIES); empty/omitted = generalist,
                                    // handles anything. Not set for sales agents or TLs.
  available: boolean               // NEW (Phase 6) — backend agents only; manual "I'm out today"
                                    // toggle, default true. Not set for sales agents or TLs.
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
  assignedTo, assignedBy,
  teamId,                          // team of the assigned agent (empty string if unassigned)
  tlId,                            // TL of the assigned agent (empty string if unassigned; written on create/reassign)
  dealValue, notes, followup,
  ownerLocked,                     // bool — manager-locked leads: TL/agent can edit stage/notes/followup but not delete directly
  deleteRequest: { requestedBy, requestedByName, requestedAt } | null,  // TL request to delete a locked lead, pending manager approval
  createdBy, createdByRole,
  lastEditedBy, lastEditedAt,
  history: [{ ts, actorId, actorName, change }]
}
```

> `assignedTo`/`teamId`/`tlId` can all be empty string `''` to represent "unassigned" — this is a valid, intentional state (e.g. after a team member is removed/deleted), not an error state. The lead modal shows an explicit "— Unassigned —" option in that case rather than defaulting the dropdown to whatever agent renders first.

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
  category: 'Starter' | 'Essential' | 'Ultimate' | 'Mobile',
  name,                            // e.g. "Ultimate 600 Mbps"
  pricingOptions: [                // at least one required
    { term, label, price }         // term in months (0 = no contract)
  ],
  activationFee,
  specs: { key: value },           // free-form key-value pairs, displayed on card
  sourceDoc,                       // rate sheet version reference e.g. "ENT-ULT-BTL-SEP-2025"
  notes,                           // freetext — add-on caveats, availability notes
  active: true | false,
  discounts: [ { id, appliesToTerm, appliesToTermLabel, price, percentage, validFrom, validTo, conditions, createdBy, createdByName, createdAt } ],
  monthlyWaivers: [ { id, label, value, valueType: 'amount'|'percentage', conditions, createdBy, createdByName, createdAt } ],
  createdBy, createdByName, createdAt,
  lastEditedBy, lastEditedAt
}
```

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
                                    // collapsed — the dedup key (see normalizeCompanyName())
  industry, city,
  hasDuAccount: boolean,           // drives whether a future submission skips Account Creation
  createdBy, createdAt,
  mergedInto: null | companyId,    // soft-merge marker — not yet used, merge UI not built (v1
                                    // cut per PHASE5_SPEC_AND_HANDOFF.md section 3/4)
  lastEditedBy, lastEditedAt
}
```
- Dedup key is `normalizedName` equality (exact), not the fuzzy check — fuzzy match
  (Levenshtein, `js/companies.js`) is only a "did you mean X?" nudge on entry, shown inline
  in the Add Lead modal, not a hard block.
- One-time backfill (`backfillCompanies()`, triggered by the manager-only "🏢 Backfill
  Companies" button in the Org tab when any lead has `company` set but no `companyId`) groups
  existing leads by `normalizedName`, creates one company doc per unique group, writes
  `companyId` back onto each lead. Safe to re-run — skips names that already resolve to an
  existing company.
- Manager-only "Companies" card in the Org tab lists all companies (name, industry, city,
  du Account, linked lead count) with an Edit action (industry/city/hasDuAccount). No merge
  tool yet — deliberately deferred, per spec, until duplicate volume is visible in practice.
- Blocking prerequisite for the backend-department/submissions/reports/document-expiry work —
  see `PHASE5_SPEC_AND_HANDOFF.md`.

### `submissions` (Phase 7) — agent → backend handoff
```
{
  leadId, companyId,
  agentId, agentName,
  teamId, tlId,                     // sales team/TL credit, snapshotted at submit time
  items: [
    {
      itemId, productId, productName, category, subType,  // productName/category/subType are
                                     // SNAPSHOTS — a later catalog change must not rewrite history
      dealValue,
      stage: 'Account Creation' | 'Financial Approval' | 'Activity' | 'Work Order' | 'Activated',
      activityRef: null|string, workOrderRef: null|string,   // required before advancing past
                                     // Activity/Work Order — not yet enforced (Phase 8, stage
                                     // advancement UI doesn't exist yet)
      blocked: null | 'needsCorrection' | 'rejected', pausedAtStage: null|stageName, correctionNote,
      stageHistory: [ { ts, actorId, actorName, stage, note } ],
      assignedBackendAgent: userId|null, activatedAt: null|timestamp
    }
  ],
  requiredDocs: [ docType, ... ],   // MANDATORY_DOC_TYPES + any per-product requiredDocuments,
                                     // computed at submit time and stored (not re-derived later)
  files: [ { docType, name, storagePath, uploadedAt, uploadedBy, size, type } ],
  submittedAt, submittedBy, createdAt, lastEditedBy, lastEditedAt
}
```
- `SUBMISSION_STAGES` and `MANDATORY_DOC_TYPES = ['Trade License','Emirates ID (Front)','Emirates ID (Back)']`
  live in `js/state.js`. Per-product extras (`products.requiredDocuments: [{docType,label}]`) are
  empty/TBD until Ashok defines them — `computeRequiredDocs()` already reads the field, so no
  code change is needed when he does.
- Every item starts at `Financial Approval` instead of `Account Creation` when
  `companies.hasDuAccount === true` at submit time.
- **Assignment (v1, `js/submissions.js` pickBackendAgent):** candidates are backend-department
  agents in the team who are `available !== false` and either have no `specialties` (generalist)
  or list the item's category. Zero matches → `assignedBackendAgent: null` (shared queue). One
  match → assigned directly. Multiple matches → simple rotation via `teams.assignmentCursor`
  (incremented per auto-assignment, not a load-balancer — see spec section 1). Manual-mode teams
  leave every item unassigned for the TL to assign by hand (that UI is Phase 8).
- **v1 simplification, not yet in the spec's own words:** assignment only considers the first
  team with `department:'backend'` found in `teams` — multi-backend-team routing isn't designed
  yet. If no backend team exists, every item is simply left unassigned.
- **Submit to Backend UI** (`js/leads.js` showSubmitModal) appears on a Closed lead with a
  `companyId`, for the assigned agent or manager, once no submission already exists for that
  lead (1 lead → at most 1 submission, v1 assumption). Gates the Submit button until every
  `requiredDocs` entry has a tagged uploaded file and at least one product line item is added.
- Files upload directly to Firebase Storage (`js/state.js` exports `storage`/`ref`/`uploadBytes`)
  under `submissions/{submissionId}/{timestamp}_{filename}` — only `storagePath` is stored, no
  download URL (nothing needs to display/download a file yet; that's Phase 8).
- **No backend-side queue view, stage advancement, or correction loop yet** — this is Phase 8.
  Right now a submission can be created and assigned but nothing reads it back.

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

All rules changes have been treated with extra care after one earlier bug (a fragile secondary `tlId` lookup was replaced with a direct `teamId` comparison). Current state, seven collections:

| Collection | Read | Write |
|---|---|---|
| `users` | Any auth | Self or manager (create/update); manager-only (delete) |
| `teams` | Any auth | Manager only, **plus** any auth may update ONLY the `assignmentCursor` field (`affectedKeys().hasOnly(['assignmentCursor'])`) — needed so an agent's own submission-create call can advance the rotation cursor without being manager |
| `companies` | Any auth | Create: any auth, must set `createdBy == request.auth.uid` (same pattern as `leads`/`scripts`); update/delete: manager only |
| `leads` | Any auth | Manager unrestricted; TL within own `teamId` for general edits, blocked from `ownerLocked`/`createdBy`/`createdByRole`/`teamId`; **`tlId` reassignment additionally gated** — a TL may only change `tlId` if the lead is currently unowned or already theirs, and the result must land back in their own sub-group; Agent own assigned leads, blocked from admin fields; delete guards on `ownerLocked` |
| `channels` | Any auth | Create: any auth (seed guard); update/delete: manager only |
| `scripts` | Any auth | Manager unrestricted; TL own scripts direct, manager scripts suggest-only via `pendingApproval` (`affectedKeys().hasOnly(['pendingApproval'])`) |
| `products` | Any auth | Manager only |
| `submissions` (Phase 7) | Manager; the submitting agent (`agentId`); their TL (`teamId` match); anyone in the backend department | Create: must set `agentId`/`submittedBy` to self; update: manager or backend-department (broad for now — Phase 8's actual stage-advancement UI will narrow this once the real update shape is known) |

**Key implementation notes:**
- `role()` helper does a `get()` on `users/{auth.uid}` — cached within a single rule evaluation, so calling it multiple times across helper functions doesn't multiply read cost.
- `deleteRequest` field is intentionally **not** in the TL update rule's blocked-fields list — a TL writing a delete request, or a manager clearing one, needs no rule changes beyond what already exists.
- `companyId` needed no new `leads` rule — it's not an admin-locked field.
- The `companies` rule was handed to Ashok as a full-file paste-in for the Firebase Console (rules aren't version-controlled in this repo — Console is the source of truth) — confirm it's been published before relying on non-manager company creation working in production.
- **Caught during Phase 7 rule review:** `createSubmission()` writes `teams.assignmentCursor` as part of the submitting agent's own batch — the existing manager-only `teams` write rule would have silently failed that update for any non-manager agent. Fixed by adding a narrowly-scoped `affectedKeys().hasOnly(['assignmentCursor'])` exception, the same pattern already used for `scripts.pendingApproval`.
- **Storage rules (separate ruleset, Storage → Rules in Firebase Console):** write is allowed for any authenticated user restricted to PDF/image content-type and a 10MB cap — not gated on the submission doc's existence, because files upload *before* the Firestore submission doc is written (see `createSubmission()`). Read is gated via `firestore.get()` cross-service calls against the submission doc (manager/submitting agent/their TL/backend department) — **not yet exercised by any UI** (no file-viewing screen exists until Phase 8), so treat the read rule as best-effort until then.

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
