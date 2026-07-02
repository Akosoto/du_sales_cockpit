# du Sales Cockpit — Project Spec
**Last updated:** July 2026 | **Phase 5 in progress (bulk-assign + module split shipped; companies/permissions/backend-dept next)**

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
js/org.js             — Org & Teams tab, team/user CRUD, seedLeads, repairLeadTeamData
js/leads.js           — Pipeline tab (incl. bulk-assign), lead modal, add-lead modal
js/dashboard.js       — Dashboard tab
js/scripts.js         — Scripts tab, channels, approval workflow
js/products.js        — Products tab, seed catalog, discounts, waivers
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
  permissions: string[]            // PLANNED — individual permission grants, e.g. ['editCompanies']
}
```

### `teams`
```
{
  name,
  teamLeadId: null,                // legacy field, kept for compatibility
  createdBy, createdAt,
  permissions: string[]            // PLANNED — team-wide permission grants
}
```

### `leads`
```
{
  company, contact, phone, email, industry, city,
  companyId,                       // PLANNED — link to companies collection (Phase 5)
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

### `companies` — PLANNED, not yet built
See `PHASE5_SPEC_AND_HANDOFF.md` for full schema, migration plan, and Firestore rules proposal. Blocking prerequisite for the backend-department/submissions/reports/document-expiry work.

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

All rules changes have been treated with extra care after one earlier bug (a fragile secondary `tlId` lookup was replaced with a direct `teamId` comparison). Current state, six collections:

| Collection | Read | Write |
|---|---|---|
| `users` | Any auth | Self or manager (create/update); manager-only (delete) |
| `teams` | Any auth | Manager only |
| `leads` | Any auth | Manager unrestricted; TL within own `teamId` for general edits, blocked from `ownerLocked`/`createdBy`/`createdByRole`/`teamId`; **`tlId` reassignment additionally gated** — a TL may only change `tlId` if the lead is currently unowned or already theirs, and the result must land back in their own sub-group; Agent own assigned leads, blocked from admin fields; delete guards on `ownerLocked` |
| `channels` | Any auth | Create: any auth (seed guard); update/delete: manager only |
| `scripts` | Any auth | Manager unrestricted; TL own scripts direct, manager scripts suggest-only via `pendingApproval` (`affectedKeys().hasOnly(['pendingApproval'])`) |
| `products` | Any auth | Manager only |

**Key implementation notes:**
- `role()` helper does a `get()` on `users/{auth.uid}` — cached within a single rule evaluation, so calling it multiple times across helper functions doesn't multiply read cost.
- `deleteRequest` field is intentionally **not** in the TL update rule's blocked-fields list — a TL writing a delete request, or a manager clearing one, needs no rule changes beyond what already exists.
- `companyId` (planned) will similarly need no new `leads` rule — it's not an admin-locked field.

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
- **Next up:** `companies` collection + migration (see `PHASE5_SPEC_AND_HANDOFF.md`), reusable team/user permission-grant system (starting with `editCompanies`), splitting `index.html` into ES modules, then backend-department/submissions workflow (gated on companies being confirmed solid in production) and reports (pending a business definition of "projection")

---

## Planned / Future Phases

See `PHASE5_SPEC_AND_HANDOFF.md` for full detail on:
- Companies as a real entity (dedup, `companyId` on leads, merge tool)
- Reusable permission-grant system (team-level + user-level `permissions[]`)
- Backend department + submission workflow (status pipeline: Submitted → In Review → Needs Correction → Activated/Rejected)
- Reports (projection definition still open — pipeline-based vs. submission-based)
- Document expiry tracking (lowest priority, fully decoupled)
- Splitting `index.html` (currently 3,163+ lines) into ES modules before the next large addition
