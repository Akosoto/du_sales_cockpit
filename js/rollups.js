import { db, doc, increment } from './state.js';
import { orgId } from '../config.js';
import { currentCategories } from './orgConfig.js';

// ════════════════════════════════════════════════════
// ROLLUP COUNTERS — pure delta engine (ARCHITECTURE.md §15, Session C1)
//
// Prime directive: a wrong counter is worse than a slow read. Every number
// in a rollups/{YYYY-MM} doc is produced by a DELTA tied to a state
// TRANSITION, applied in the SAME batch/transaction as the mutation that
// justifies it, and is rebuildable from raw submissions by replaying the
// exact same transition logic (buildRollupsFromSubmissions → the recompute
// tool). The live sites and the recompute both funnel through
// transitionDeltas()/submissionContribution() below, so they cannot drift.
//
// This module's CORE is pure and unit-testable in isolation: monthKey, slug,
// contributorOf, familyResolverFrom, and every *Deltas function take plain
// data + a `familyOf` resolver and return delta descriptors — no Firestore
// I/O. Only applyRollupDeltas() and the two live-writer conveniences touch
// the SDK (increment/doc/set).
//
// A delta descriptor is one of:
//   { month:'YYYY-MM', path:[seg,...], inc:Number }   // FieldValue.increment
//   { month:'YYYY-MM', path:[seg,...], set:any }       // last-writer set (label/type)
// `path` is an ARRAY of literal key segments (not a dotted string) so a
// category id / team id / contributor key containing '.', '/', spaces, etc.
// is a safe nested-object key — never parsed as a Firestore field path. This
// is also why writes use set(ref, nestedObj, {merge:true}) rather than a
// dotted-path update(): merge deep-merges + applies the increment transforms
// AND creates the month doc on its first write (§15.3).
// ════════════════════════════════════════════════════

// ── Month bucketing — LOCAL time, deliberately (§15.2) ──
// resolvePeriodRange() (js/dashboardData.js) builds This/Last Month + This
// Quarter boundaries with local new Date(y,m,…). A rollup keyed in UTC could
// land a late-in-the-month-local timestamp in the neighbouring month and no
// longer match the live query it must equal. UAE is a fixed UTC+4, no DST, so
// local getFullYear()/getMonth() is unambiguous.
export function monthKey(iso){
  const d = new Date(iso);
  if(isNaN(d)) throw new Error(`rollups.monthKey: invalid timestamp ${JSON.stringify(iso)}`);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

// ── Contributor attribution (§15.3) — credit semantics IDENTICAL to B5's
// js/dashboardData.js byContributor loop; the only difference is the key is a
// Firestore MAP KEY now, so a partner name (which may carry '.', '/', '~',
// '*', '[', ']') is slugged. The raw display string survives in `label`.
export function slug(s){
  const out = String(s==null?'':s).trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');
  return out || 'outsourced';
}
export function contributorOf(sub){
  if(sub.sourcedBy && sub.sourcedBy.flag){
    const name = (sub.sourcedBy.partnerName||'').trim();
    if(name) return { key: slug(name), label: name, type: 'partner' };
    return { key: 'outsourced', label: 'Outsourced Revenue', type: 'partner' };
  }
  return { key: sub.agentId || 'unknown', label: sub.agentName || 'Unknown', type: 'agent' };
}

// ── Category → family resolver (§15.3). Built from a categories array
// ({id,familyId}) so it stays pure/testable; any category id not present (a
// legacy pre-migration submission.category, or one with no familyId) buckets
// under 'others', matching DEFAULT_FAMILY_MAPPING's fallback.
export function familyResolverFrom(categories){
  const map = {};
  (categories||[]).forEach(c => { if(c && c.id) map[c.id] = c.familyId || 'others'; });
  return (catId) => map[catId] || 'others';
}
// Convenience for the live call sites: resolver over the loaded org config.
export function currentFamilyResolver(){ return familyResolverFrom(currentCategories()); }

// ── Per-site delta builders (all pure) ─────────────────

// SITE 1 — create. One created submission doc = +1 linesSubmitted in its
// createdAt month. No per-dimension or AED effect (nothing is activated yet).
export function createDeltas(sub){
  const createdAt = sub.createdAt || (sub.events && sub.events[0] && sub.events[0].ts);
  return [{ month: monthKey(createdAt), path:['totals','linesSubmitted'], inc:1 }];
}

// SITES 2 & 3 — activation add (+1) / reversal (−1). BOTH bucket by the
// submission's sticky activatedAt month (js/submissions.js never clears
// activatedAt on de-activation), so an activate→deactivate→reactivate cycle
// adds and reverses in the SAME month and nets exactly. aed = current mrc for
// both directions → a post-activation mrc edit nets to zero here (the one
// documented gap, §15.4; recompute is its correction). Zero-AED prepaid lines:
// count moves, aed contributes 0 — no special-casing.
export function activationDeltas(sub, sign, familyOf){
  const at = sub.activatedAt || sub.createdAt; // activatedAt is always set when activated; createdAt is a last-resort bucket
  const m = monthKey(at);
  const aed = (Number(sub.mrc)||0) * sign;
  const cnt = sign;
  const fam = familyOf(sub.category);
  const cat = sub.category || 'unknown';
  const team = sub.teamId || 'none';
  const { key, label, type } = contributorOf(sub);
  const d = [
    { month:m, path:['totals','aedActivated'],   inc:aed },
    { month:m, path:['totals','linesActivated'], inc:cnt },
    { month:m, path:['byFamily',fam,'aed'],        inc:aed },
    { month:m, path:['byFamily',fam,'count'],      inc:cnt },
    { month:m, path:['byCategory',cat,'aed'],      inc:aed },
    { month:m, path:['byCategory',cat,'count'],    inc:cnt },
    { month:m, path:['byTeam',team,'aed'],         inc:aed },
    { month:m, path:['byTeam',team,'count'],       inc:cnt },
    { month:m, path:['byContributor',key,'aed'],   inc:aed },
    { month:m, path:['byContributor',key,'count'], inc:cnt }
  ];
  // Label/type describe the bucket, not a quantity — only stamp them on the
  // ADD direction so a reversal never blanks a still-live contributor's label.
  if(sign > 0){
    d.push({ month:m, path:['byContributor',key,'label'], set:label });
    d.push({ month:m, path:['byContributor',key,'type'],  set:type  });
  }
  return d;
}

// The single source of truth for "what does ONE event, from this running
// status, do to the rollups". Used live (one call per appended event, with
// runningStatus = the submission's pre-transaction status) AND by
// submissionContribution()'s replay — so live and recompute are identical by
// construction. Returns { deltas:[…], nextStatus }.
//
// SITE 4 (into rejected) and SITE 5 (resubmit) are historical EVENT counts:
// bucketed by the event's own ts, incremented once per transition INTO that
// state, never decremented by a later transition (only a whole-doc DELETE
// reverses them, via negate() below).
export function transitionDeltas(runningStatus, event, sub, familyOf){
  const t = event.type;
  const ts = event.ts;
  const out = [];

  if(t === 'created'){
    out.push(...createDeltas(sub));
    return { deltas: out, nextStatus: 'pendingVerification' };
  }
  if(t === 'activated'){
    if(runningStatus !== 'activated') out.push(...activationDeltas(sub, +1, familyOf)); // SITE 2 guard
    return { deltas: out, nextStatus: 'activated' };
  }
  if(t === 'rejected'){
    if(runningStatus === 'activated') out.push(...activationDeltas(sub, -1, familyOf)); // SITE 3 (out of activated)
    if(runningStatus !== 'rejected')  out.push({ month: monthKey(ts), path:['totals','linesRejected'], inc:1 }); // SITE 4
    return { deltas: out, nextStatus: 'rejected' };
  }
  if(t === 'resubmit'){
    if(runningStatus === 'activated') out.push(...activationDeltas(sub, -1, familyOf)); // SITE 3 (unusual, but symmetric)
    if(runningStatus === 'rejected')  out.push({ month: monthKey(ts), path:['totals','linesResubmitted'], inc:1 }); // SITE 5
    return { deltas: out, nextStatus: 'pendingVerification' };
  }
  if(t === 'submittedToDu'){
    if(runningStatus === 'activated') out.push(...activationDeltas(sub, -1, familyOf)); // SITE 3 (correction back past submit)
    return { deltas: out, nextStatus: 'submittedToDu' };
  }

  // Every other event (note, activityNo, workOrderNo, appointment, biometric,
  // sprObtained, correction, docsVerified, verificationCall/Email,
  // transferCompleted, transferRejected) has NO rollup effect. Status only
  // moves for the mirror of appendEvent's "submittedToDu → inProgress on any
  // other backend touch" — rollup-neutral, tracked only so a later transition
  // sees a faithful runningStatus. transferCompleted/transferRejected and the
  // auto-marker proceededWithoutVerification are excluded (they don't imply
  // work started / are not real transitions), matching js/submissions.js.
  let nextStatus = runningStatus;
  if(runningStatus === 'submittedToDu'
     && t !== 'transferCompleted' && t !== 'transferRejected' && t !== 'proceededWithoutVerification'){
    nextStatus = 'inProgress';
  }
  return { deltas: out, nextStatus };
}

// Replay a submission's full events[] timeline into the net set of deltas it
// SHOULD have contributed (the "rebuildable from raw truth" guarantee). Used
// by the recompute tool (summed across all submissions) and, negated, by the
// delete site. proceededWithoutVerification is skipped — it's an auto-appended
// marker, never a transition (js/submissions.js appends it inside the
// submittedToDu handling, it is never itself processed as a triggering event).
export function submissionContribution(sub, familyOf){
  const events = [...(sub.events||[])].sort((a,b)=> (a.ts<b.ts ? -1 : a.ts>b.ts ? 1 : 0));
  let status = null;
  const all = [];
  for(const ev of events){
    if(!ev || ev.type === 'proceededWithoutVerification') continue;
    const { deltas, nextStatus } = transitionDeltas(status, ev, sub, familyOf);
    all.push(...deltas);
    status = nextStatus;
  }
  return all;
}

// SITE 6 — delete. Negate a submission's entire net contribution: flip every
// increment, DROP every label/type set (a decrement must never re-stamp a
// bucket's descriptor). After applying this the rollup equals a fresh
// recompute over the surviving docs (§15.3, row 6).
export function negate(deltas){
  return deltas.filter(d => 'inc' in d).map(d => ({ month:d.month, path:d.path, inc: -d.inc }));
}

// ── Apply layer (touches the SDK) ──────────────────────
// Writes a delta list onto rollups/{month} docs via the caller's writer (a
// writeBatch OR a runTransaction — both expose .set(ref,data,{merge:true})).
//
// CRITICAL: increments for the SAME path within one call are SUMMED into a
// single increment(sum), and only ONE .set() is emitted per month doc. Two
// reasons: (a) Firestore forbids writing the same document twice in one
// batch/transaction — a bundle of N created lines all bump
// totals.linesSubmitted in the same month, and a delete-reversal can revisit
// a path across an activate/reverse cycle; (b) a naive "last write wins" per
// path would silently drop N-1 of those increments. Accumulation is into a
// nested Map tree (not a joined-string key), so a path segment — even a legacy
// name-string category with spaces/punctuation — needs no separator or
// escaping. Sets (label/type) apply after increments, so a counter path never
// mixes with a descriptor. orgId + month are stamped on every write (orgId is
// what the sameOrg() rule reads; §15.5). Field transforms need no prior read,
// so this is safe to add to a transaction after its reads.
export function applyRollupDeltas(writer, deltas){
  if(!deltas || !deltas.length) return;
  const months = new Map();
  for(const d of deltas){
    let bucket = months.get(d.month);
    if(!bucket){ bucket = { incTree: new Map(), sets: [] }; months.set(d.month, bucket); }
    if('inc' in d){
      let node = bucket.incTree;
      for(let i=0; i<d.path.length-1; i++){
        let child = node.get(d.path[i]);
        if(!(child instanceof Map)){ child = new Map(); node.set(d.path[i], child); }
        node = child;
      }
      const leaf = d.path[d.path.length-1];
      node.set(leaf, (node.get(leaf)||0) + d.inc);
    } else {
      bucket.sets.push({ path: d.path, value: d.set });
    }
  }
  for(const [month, bucket] of months){
    const payload = { orgId, month };
    (function walk(node, obj){
      for(const [k,v] of node){
        if(v instanceof Map){ if(typeof obj[k] !== 'object' || obj[k] === null) obj[k] = {}; walk(v, obj[k]); }
        else obj[k] = increment(v);
      }
    })(bucket.incTree, payload);
    for(const { path, value } of bucket.sets){
      let obj = payload;
      for(let i=0; i<path.length-1; i++){
        const k = path[i];
        if(typeof obj[k] !== 'object' || obj[k] === null) obj[k] = {};
        obj = obj[k];
      }
      obj[path[path.length-1]] = value;
    }
    writer.set(doc(db,'rollups',month), payload, { merge:true });
  }
}

// ── Recompute / backfill core (pure; §15.4) ────────────
// Sum every submission's replayed contribution into ABSOLUTE per-month rollup
// objects. The recompute tool (js/*, Step 4) reads these, diffs vs the stored
// docs for a drift report, then overwrites with a full set() (no merge). Same
// transition logic as live → recompute is the reconciliation ground truth.
export function blankMonth(){
  return {
    totals: { aedActivated:0, linesActivated:0, linesSubmitted:0, linesRejected:0, linesResubmitted:0 },
    byFamily:{}, byCategory:{}, byTeam:{}, byContributor:{}
  };
}

// Per-bucket drift between a STORED rollup doc (or null/absent) and a freshly
// recomputed one — the dry-run report the recompute tool shows BEFORE it
// overwrites (§15.4). Compares only the counter leaves; ignores orgId/month/
// audit fields and the byContributor label/type descriptors (not quantities).
// Returns [{path, old, new}] for every leaf that differs, old missing → 0.
const ROLLUP_TOTAL_KEYS = ['aedActivated','linesActivated','linesSubmitted','linesRejected','linesResubmitted'];
const ROLLUP_DIM_KEYS = ['byFamily','byCategory','byTeam','byContributor'];
export function diffRollups(oldObj, newObj){
  const o = oldObj || {}, n = newObj || {};
  const num = x => Number(x)||0;
  const drifts = [];
  for(const k of ROLLUP_TOTAL_KEYS){
    const ov = num(o.totals && o.totals[k]), nv = num(n.totals && n.totals[k]);
    if(ov !== nv) drifts.push({ path:`totals.${k}`, old:ov, new:nv });
  }
  for(const dim of ROLLUP_DIM_KEYS){
    const keys = new Set([...Object.keys(o[dim]||{}), ...Object.keys(n[dim]||{})]);
    for(const key of keys){
      for(const metric of ['aed','count']){
        const ov = num(o[dim] && o[dim][key] && o[dim][key][metric]);
        const nv = num(n[dim] && n[dim][key] && n[dim][key][metric]);
        if(ov !== nv) drifts.push({ path:`${dim}.${key}.${metric}`, old:ov, new:nv });
      }
    }
  }
  return drifts;
}
export function buildRollupsFromSubmissions(subs, familyOf){
  const months = {};
  const ensure = m => months[m] || (months[m] = blankMonth());
  for(const sub of (subs||[])){
    for(const d of submissionContribution(sub, familyOf)){
      const acc = ensure(d.month);
      let node = acc;
      for(let i=0; i<d.path.length-1; i++){
        const k = d.path[i];
        if(typeof node[k] !== 'object' || node[k] === null) node[k] = {};
        node = node[k];
      }
      const leaf = d.path[d.path.length-1];
      if('inc' in d) node[leaf] = (Number(node[leaf])||0) + d.inc;
      else node[leaf] = d.set;
    }
  }
  return months;
}
