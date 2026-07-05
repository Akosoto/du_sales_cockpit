import { esc } from './helpers.js';

// ════════════════════════════════════════════════════
// PERMISSIONS — catalog + grant/check helpers
// Managers grant a permission to a whole TEAM (applies to every member) or to
// an individual USER (applies to just them, on top of whatever their team
// grants). Add new capabilities by extending PERMISSIONS below — nothing
// else in this file needs to change.
// ════════════════════════════════════════════════════
export const PERMISSIONS = [
  { key:'edit_companies', label:'Edit Companies', desc:'Edit company details (industry, city, du account status) and merge duplicate company records.' }
];

// Manager always passes. Otherwise: user-level grant wins, falling back to
// the user's team-level grant (pass the user's team doc, if known).
export function hasPermission(perm, profile, team){
  if(!profile) return false;
  if(profile.role === 'manager') return true;
  if((profile.permissions||[]).includes(perm)) return true;
  if(team && (team.permissions||[]).includes(perm)) return true;
  return false;
}

// Searchable checkbox list — idPrefix must be unique per modal instance
// (e.g. 'et-perm' for Edit Team, 'eu-perm' for Edit User) so multiple
// instances never collide on element ids.
export function permissionChecklistHtml(idPrefix, selected=[]){
  return `
    <div class="field">
      <label>Permissions</label>
      <input type="text" id="${idPrefix}-search" placeholder="Search permissions…" class="mb-8">
      <div id="${idPrefix}-list">
        ${PERMISSIONS.map(p => `<div class="ms-item" data-perm-row>
          <input type="checkbox" value="${p.key}" id="${idPrefix}-${p.key}" ${selected.includes(p.key)?'checked':''} style="width:auto;margin:0;cursor:pointer">
          <label for="${idPrefix}-${p.key}" style="margin:0;cursor:pointer;flex:1">
            <div>${esc(p.label)}</div>
            <div class="text-dim text-xs">${esc(p.desc)}</div>
          </label>
        </div>`).join('')}
      </div>
    </div>`;
}

export function wirePermissionSearch(idPrefix){
  const search = document.getElementById(`${idPrefix}-search`);
  const list   = document.getElementById(`${idPrefix}-list`);
  if(!search || !list) return;
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    list.querySelectorAll('[data-perm-row]').forEach(row => {
      row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
    });
  });
}

export function getSelectedPermissions(idPrefix){
  return PERMISSIONS
    .filter(p => document.getElementById(`${idPrefix}-${p.key}`)?.checked)
    .map(p => p.key);
}
