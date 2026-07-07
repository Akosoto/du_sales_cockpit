import {
  auth, db, CU, CP, SEED_EMAILS, setUser,
  signInWithEmailAndPassword, signOut, onAuthStateChanged,
  updatePassword, reauthenticateWithCredential, EmailAuthProvider,
  doc, getDoc
} from './state.js';
import { dbSet } from './db.js';
import { v, now, toast, modal, closeModal } from './helpers.js';
import { renderNav, switchTab } from './main.js';

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
// ENSURE FIRESTORE USER PROFILE ON FIRST LOGIN
// ════════════════════════════════════════════════════
async function ensureProfile(fbUser){
  const snap = await getDoc(doc(db, 'users', fbUser.uid));
  if(snap.exists()) return { id: fbUser.uid, ...snap.data() };

  const seed = SEED_EMAILS[(fbUser.email||'').toLowerCase()];
  if(!seed) return null;

  const data = {
    name: seed.name, email: fbUser.email, role: seed.role,
    teamId: null, monthlyTarget: 0, targetSource: 'manager',
    active: true, createdBy: 'system', createdAt: now()
  };
  // skipAudit: this is a brand-new user's first-ever login — CU/CP are still
  // null at this point (setUser() runs AFTER ensureProfile() returns), so
  // db.js's default audit stamping (reads CU.uid/CP.name) would throw here.
  await dbSet('users', fbUser.uid, data, {skipAudit:true});
  return { id: fbUser.uid, ...data };
}

// ════════════════════════════════════════════════════
// AUTH STATE → ROUTING
// ════════════════════════════════════════════════════
onAuthStateChanged(auth, async fbUser => {
  if(fbUser){
    const p = await ensureProfile(fbUser);
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

export function showApp(){
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  const role = CP.role;
  const rp = document.getElementById('hdr-role');
  rp.textContent = role === 'manager' ? '● Manager' : role === 'team_lead' ? '● Team Lead' : '● Agent';
  rp.className = `role-pill ${role}`;
  document.getElementById('hdr-name').textContent = CP.name;
  renderNav();
  switchTab(role === 'manager' ? 'org' : 'dashboard');
}
