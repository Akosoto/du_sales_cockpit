import {
  auth, db, CU, CP, setUser,
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
  updatePassword, reauthenticateWithCredential, EmailAuthProvider,
  doc, getDoc
} from './state.js';
import { v, toast, modal, closeModal } from './helpers.js';
import { renderNav, switchTab } from './main.js';
import { loadOrgConfig } from './orgConfig.js';

// ════════════════════════════════════════════════════
// CHANGE PASSWORD
// ════════════════════════════════════════════════════
document.getElementById('btn-pw').onclick = () => {
  modal('Change Password', `
    <div class="field"><label>Current Password</label><input type="password" id="cpw-cur" placeholder="••••••••"></div>
    <div class="field"><label>New Password (min 8 chars)</label><input type="password" id="cpw-new" placeholder="••••••••"></div>
    <div class="field"><label>Confirm New Password</label><input type="password" id="cpw-conf" placeholder="••••••••"></div>
    <p id="cpw-err" class="err"></p>
    <button class="btn btn-primary btn-full mt-12" id="cpw-btn">Update Password</button>`);
  document.getElementById('cpw-btn').onclick = async () => {
    const cur  = v('cpw-cur'), nw = v('cpw-new'), conf = v('cpw-conf');
    const err  = document.getElementById('cpw-err');
    if(!cur||!nw||!conf){ err.textContent='All fields are required.'; return; }
    if(nw.length<8){ err.textContent='New password must be at least 8 characters.'; return; }
    if(nw!==conf){ err.textContent='New passwords do not match.'; return; }
    try {
      const cred = EmailAuthProvider.credential(CU.email, cur);
      await reauthenticateWithCredential(CU, cred);
      await updatePassword(CU, nw);
      closeModal(); toast('Password updated.');
    } catch(e) {
      err.textContent = e.code==='auth/wrong-password'||e.code==='auth/invalid-credential'
        ? 'Current password is incorrect.' : e.message;
    }
  };
};

// ════════════════════════════════════════════════════
// AUTH — LOGIN / LOGOUT
// ════════════════════════════════════════════════════
async function doLogin(){
  const email = document.getElementById('li-email').value.trim();
  const pw    = document.getElementById('li-pw').value;
  const err   = document.getElementById('li-err');
  const btn   = document.getElementById('li-btn');
  err.textContent = ''; btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    await signInWithEmailAndPassword(auth, email, pw);
  } catch(e) {
    let m = 'Login failed. Check your email and password.';
    if(['auth/wrong-password','auth/user-not-found','auth/invalid-credential'].includes(e.code)) m = 'Incorrect email or password.';
    if(e.code === 'auth/too-many-requests') m = 'Too many attempts. Try again in a few minutes.';
    err.textContent = m; btn.disabled = false; btn.textContent = 'Sign In';
  }
}
document.getElementById('li-btn').onclick = doLogin;
document.getElementById('li-pw').onkeydown = e => { if(e.key==='Enter') doLogin(); };
document.getElementById('btn-logout').onclick = () => signOut(auth);

document.getElementById('li-pw-eye').onclick = function(){
  const i = document.getElementById('li-pw');
  const show = i.type === 'password';
  i.type = show ? 'text' : 'password';
  this.textContent = show ? 'Hide' : 'Show';
};

// ════════════════════════════════════════════════════
// LOAD FIRESTORE USER PROFILE ON LOGIN
//
// Session P0: this function used to SELF-CREATE a users/{uid} document
// when none existed, for any email matching the hardcoded SEED_EMAILS
// allowlist in state.js. That branch is gone, along with the rule clause
// (`request.auth.uid == uid`) that permitted it — see ARCHITECTURE.md §18.
//
// The allowlist was never a security control. It ran in the client, and
// the rule behind it validated no fields at all, so anyone who registered
// through the public Firebase Auth API could write their own user document
// with role:'manager' and any orgId without ever loading this file. Users
// are now provisioned exclusively from a manager's own session
// (js/org.js's Add User flow: create the Auth account on the secondary
// instance, then write users/{uid} in the manager's batch), which the
// manager-only create rule covers.
//
// A user with an Auth login but no profile document is signed straight
// back out by the caller below — the intended behaviour for a hard-deleted
// account, and now also for anyone who self-registers.
//
// FIRST-MANAGER BOOTSTRAP (white-label onboarding, ARCHITECTURE.md §1):
// a brand-new deployment has no manager to run Add User, and no rule can
// safely grant that first write to an arbitrary caller. Create the first
// manager's users/{uid} document by hand in the Firestore Console — Console
// and Admin SDK writes bypass security rules entirely, so this needs no
// rule hole and no temporary relaxation. See §18 for the exact document
// shape and the onboarding-runbook step.
// ════════════════════════════════════════════════════
async function loadProfile(fbUser){
  const snap = await getDoc(doc(db, 'users', fbUser.uid));
  return snap.exists() ? { id: fbUser.uid, ...snap.data() } : null;
}

// ════════════════════════════════════════════════════
// AUTH STATE → ROUTING
// ════════════════════════════════════════════════════
onAuthStateChanged(auth, async fbUser => {
  if(fbUser){
    const p = await loadProfile(fbUser);
    if(!p){
      setUser(fbUser, null);
      await signOut(auth);
      document.getElementById('li-err').textContent = 'Account not set up. Contact your manager.';
      showLogin(); return;
    }
    setUser(fbUser, p);
    showApp();
  } else {
    setUser(null, null); showLogin();
  }
});

export function showLogin(){
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  document.getElementById('li-btn').disabled = false;
  document.getElementById('li-btn').textContent = 'Sign In';
}

export async function showApp(){
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  const role = CP.role;
  const rp = document.getElementById('hdr-role');
  const roleLabel = role === 'manager' ? 'Manager' : role === 'team_lead' ? 'Team Lead' : 'Agent';
  rp.textContent = `● ${roleLabel}`;
  rp.className = `role-pill ${role}`;
  document.getElementById('hdr-name').textContent = CP.name;

  // Awaited before the first tab renders — category labels (Products,
  // Org's specialty checklists) need real data on first paint, not a
  // flash of defaults that then jumps to the manager-edited label on the
  // next re-render. Falls back to DEFAULT_CATEGORIES internally on any
  // failure, so this never blocks login on a slow/missing orgs/{orgId}.
  await loadOrgConfig();

  renderNav();
  switchTab(role === 'manager' ? 'org' : 'dashboard');

  // Team name in the header (agent/TL only — manager isn't scoped to one
  // team, so it stays as-is). Fetched after the tab switch so a slow/failed
  // lookup never blocks the app from becoming usable.
  if(role !== 'manager' && CP.teamId){
    try {
      const snap = await getDoc(doc(db,'teams',CP.teamId));
      if(snap.exists()) rp.textContent = `● ${roleLabel} · ${snap.data().name}`;
    } catch(e){ /* header team name is cosmetic — a failed lookup just leaves the role-only label */ }
  }
}
