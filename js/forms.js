import { CP } from './state.js';
import { esc, toast, modal, closeModal, confirmModal } from './helpers.js';
import {
  fetchLatestForms, fetchAllTemplatesForManager, uploadSofTemplate,
  downloadSofTemplate, deleteSofVersion, validateSofFile, normSofName
} from './sofTemplates.js';

// ════════════════════════════════════════════════════
// FORMS TAB (Session S1, ARCHITECTURE.md §17) — all roles see + download
// only the LATEST version of each named SOF form. Manager additionally
// gets an upload flow (new name = new form, existing name = next
// version), full per-form version history, and version delete (blocked
// outright on the current latest — upload a replacement instead).
//
// Manager makes exactly ONE query per tab load: fetchAllTemplatesForManager
// (bare, unfiltered — provable via the manager clause) supplies BOTH the
// "latest per form" view (filtered client-side to isLatest) AND every
// form's version history (filtered client-side by name) from the SAME
// in-memory dataset — no second query. Every other role can only run
// fetchLatestForms (the isLatest-filtered list — the one shape their own
// read rule clause allows), so they never see history at all.
// ════════════════════════════════════════════════════

function fmtSize(bytes){
  const n = Number(bytes)||0;
  if(!n) return '—';
  return n < 1024*1024 ? `${Math.round(n/1024)}KB` : `${(n/1024/1024).toFixed(1)}MB`;
}

function fmtDateTime(iso){
  if(!iso) return '—';
  try { return new Date(iso).toLocaleString('en-AE', {day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}); }
  catch(e){ return iso; }
}

async function downloadWithSpinner(btn, template){
  const orig = btn.textContent;
  btn.disabled = true; btn.textContent = 'Downloading…';
  try { await downloadSofTemplate(template); }
  catch(e){ toast('Error: '+e.message, 'err'); }
  btn.disabled = false; btn.textContent = orig;
}

// Manager-only: full version history for one form name, drilled into from
// the main list. `all` is the SAME already-fetched flat array the main
// table rendered from — filtered here client-side, no extra query.
function showHistoryModal(name, all, onChanged){
  const versions = all.filter(t => normSofName(t.name) === normSofName(name)).sort((a,b)=>b.version-a.version);
  const rowsHtml = versions.map(v => `
    <tr>
      <td>v${v.version}${v.isLatest ? ' <span class="sp sp-won">Latest</span>' : ''}</td>
      <td>${esc(v.fileName||'')}</td>
      <td>${fmtSize(v.sizeBytes)}</td>
      <td>${fmtDateTime(v.createdAt)}</td>
      <td>
        <button class="btn btn-ghost btn-sm" data-hist-download="${esc(v.id)}">⬇️ Download</button>
        <button class="btn btn-ghost btn-sm" data-hist-delete="${esc(v.id)}" ${v.isLatest?'disabled title="Upload a replacement instead of deleting the latest version."':''}>🗑️ Delete</button>
      </td>
    </tr>`).join('');

  modal(`Version History — ${name}`, `
    <div class="tbl-wrap">
      <table>
        <thead><tr><th>Version</th><th>File</th><th>Size</th><th>Uploaded</th><th></th></tr></thead>
        <tbody>${rowsHtml || `<tr><td colspan="5" class="text-dim">No versions found.</td></tr>`}</tbody>
      </table>
    </div>
  `, true);

  document.querySelectorAll('[data-hist-download]').forEach(b => b.addEventListener('click', () => {
    const v = versions.find(x=>x.id===b.dataset.histDownload);
    if(v) downloadWithSpinner(b, v);
  }));
  document.querySelectorAll('[data-hist-delete]').forEach(b => b.addEventListener('click', () => {
    const v = versions.find(x=>x.id===b.dataset.histDelete);
    if(!v || v.isLatest) return;
    confirmModal('Delete Version', `Delete "${v.name}" v${v.version} (${v.fileName})? This cannot be undone.`, async () => {
      try {
        await deleteSofVersion(v);
        toast('Version deleted.');
        closeModal();
        onChanged();
      } catch(e){ toast('Error: '+e.message, 'err'); }
    });
  }));
}

// Manager-only: upload a new form or a new version of an existing one.
// `existingNames` is the deduped set of names from the same already-
// fetched list — used ONLY for the datalist autocomplete + client-side
// case-insensitive match to find the current latest version to supersede;
// no extra query is ever run to check for a name collision.
function showUploadModal(all, onDone){
  const latestByNormName = {};
  all.forEach(t => { if(t.isLatest) latestByNormName[normSofName(t.name)] = t; });
  const existingNames = [...new Set(all.map(t=>t.name))].sort();

  modal('Upload New Form', `
    <div class="field mb-12">
      <label>Form Name</label>
      <input type="text" id="sof-up-name" list="sof-up-names" placeholder="e.g. Fiber Service Order Form">
      <datalist id="sof-up-names">${existingNames.map(n=>`<option value="${esc(n)}">`).join('')}</datalist>
      <p class="text-dim text-xs mt-8">An EXISTING name (case-insensitive) uploads the next version of that form. A new name creates a new form.</p>
    </div>
    <div class="field mb-12">
      <label>File <span class="text-dim">(PDF or Excel .xlsx/.xls, max 5MB)</span></label>
      <input type="file" id="sof-up-file" accept=".pdf,.xlsx,.xls">
    </div>
    <button class="btn btn-primary" id="sof-up-submit">⬆️ Upload</button>
  `);

  document.getElementById('sof-up-submit').addEventListener('click', async () => {
    const btn = document.getElementById('sof-up-submit');
    const name = document.getElementById('sof-up-name').value.trim();
    const file = document.getElementById('sof-up-file').files[0];
    if(!name){ toast('Enter a form name.', 'err'); return; }
    if(!file){ toast('Choose a file.', 'err'); return; }
    try { validateSofFile(file); } catch(e){ toast(e.message, 'err'); return; }

    const priorLatest = latestByNormName[normSofName(name)];
    btn.disabled = true; btn.textContent = 'Uploading…';
    try {
      await uploadSofTemplate({ file, name, priorLatest });
      toast(priorLatest ? `Uploaded v${(priorLatest.version||0)+1}.` : 'New form uploaded.');
      closeModal();
      onDone();
    } catch(e){
      toast('Error: '+e.message, 'err');
      btn.disabled = false; btn.textContent = '⬆️ Upload';
    }
  });
}

export async function renderFormsTab(){
  const ct = document.getElementById('content');
  ct.innerHTML = '<div class="loading"><div class="spin"></div> Loading…</div>';
  const isManager = CP.role === 'manager';

  let all = [], latest = [];
  try {
    if(isManager){
      all = await fetchAllTemplatesForManager();
      latest = all.filter(t => t.isLatest);
    } else {
      latest = await fetchLatestForms();
    }
  } catch(e){ ct.innerHTML = `<p class="err">Error: ${esc(e.message)}</p>`; return; }

  function render(){
    ct.innerHTML = `
      <div class="pg-hdr">
        <div><h2>📄 Forms</h2><p class="pg-hdr-sub">Service Order Forms — always the latest version.</p></div>
        ${isManager ? `<button class="btn btn-primary" id="sof-upload-btn">⬆️ Upload New Form</button>` : ''}
      </div>
      <div class="tbl-wrap">
        <table>
          <thead><tr><th>Form Name</th><th>Type</th><th>Size</th><th>Version</th><th></th></tr></thead>
          <tbody>${latest.length ? latest.map(f => `<tr>
            <td>${esc(f.name)}</td>
            <td>${esc((f.fileType||'').toUpperCase())}</td>
            <td>${fmtSize(f.sizeBytes)}</td>
            <td>v${f.version}</td>
            <td>
              <button class="btn btn-ghost btn-sm" data-download="${esc(f.id)}">⬇️ Download</button>
              ${isManager ? `<button class="btn btn-ghost btn-sm" data-history="${esc(f.name)}">🕐 History</button>` : ''}
            </td>
          </tr>`).join('') : `<tr><td colspan="5" class="text-dim">No forms uploaded yet.</td></tr>`}</tbody>
        </table>
      </div>
    `;

    ct.querySelectorAll('[data-download]').forEach(b => b.addEventListener('click', () => {
      const f = latest.find(x => x.id === b.dataset.download);
      if(f) downloadWithSpinner(b, f);
    }));

    if(isManager){
      document.getElementById('sof-upload-btn').addEventListener('click', () => showUploadModal(all, refresh));
      ct.querySelectorAll('[data-history]').forEach(b => b.addEventListener('click', () => showHistoryModal(b.dataset.history, all, refresh)));
    }
  }

  async function refresh(){
    if(isManager){
      all = await fetchAllTemplatesForManager();
      latest = all.filter(t => t.isLatest);
    } else {
      latest = await fetchLatestForms();
    }
    render();
  }

  render();
}
