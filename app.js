'use strict';

/* =============================================
   DATA MODEL
   =============================================
   db.members  = [{id, name, emoji, joinedAt}]
   db.months   = {
     "YYYY-MM": {
       days: {
         "YYYY-MM-DD": {
           mealsAvail: 1|2,          // meals available this day (default 2)
           eaten: { memberId: 0|1|2 } // how many meals each member had
         }
       },
       contributions: [{id, memberId, amount, date, note}],
       expenses:      [{id, desc, amount, date, paidBy}],
     }
   }

   MEAL LOGIC:
   - mealsAvail = 1 → cell toggles: 1 (ate ✓) ↔ 0 (skipped ✗)
   - mealsAvail = 2 → cell cycles: 2 (ate both) → 1 (ate one) → 0 (skipped)
   - Default when day exists but member not in eaten: mealsAvail value (ate all)
   - Member total = sum of eaten[memberId] across all counted days
============================================= */

const DB_KEY = 'messmate_v2';

// -----------------------------------------------------------------------------
// [LOOSE END: SUPABASE CONFIG]
// Set your Project URL and Anon Key here. Create table `messmate_state` with:
// id (int8, primary key)
// payload (jsonb)
// Insert a single row with id = 1, payload = '{"members":[],"months":{}}'
// -----------------------------------------------------------------------------
const SUBA_URL = 'https://sreqjvnhrjczpkdzixbn.supabase.co';
const SUBA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNyZXFqdm5ocmpjenBrZHppeGJuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM5NTkyODksImV4cCI6MjA5OTUzNTI4OX0.DMZ_r3h0dIN4BL-6ZSTgxmXiWwE6bY7yOfEFDwCa-L0';
const sbClient = window.supabase ? window.supabase.createClient(SUBA_URL, SUBA_KEY) : null;

function loadDB() {
  try { return JSON.parse(localStorage.getItem(DB_KEY)) || freshDB(); }
  catch { return freshDB(); }
}
function freshDB() { return { members: [], months: {} }; }

let db = loadDB();
let _saveTimer = null;

function setSyncStatus(status) {
  const el = document.getElementById('syncStatus');
  if (!el) return;
  const dot = el.querySelector('.sync-dot');
  const txt = el.querySelector('.sync-text');
  if (status === 'syncing') {
    dot.className = 'sync-dot yellow';
    txt.textContent = 'Saving...';
  } else if (status === 'error') {
    dot.className = 'sync-dot red';
    txt.textContent = 'Error';
  } else {
    dot.className = 'sync-dot green';
    txt.textContent = 'Synced';
  }
}

let currentPin = localStorage.getItem('messmate_auth');

function encryptPayload(data, pin) {
  if (typeof CryptoJS === 'undefined') return data;
  return { ciphertext: CryptoJS.AES.encrypt(JSON.stringify(data), pin).toString() };
}

function decryptPayload(payload, pin) {
  if (!payload.ciphertext) return payload; // Fallback for unencrypted migration
  try {
    const bytes = CryptoJS.AES.decrypt(payload.ciphertext, pin);
    const decrypted = bytes.toString(CryptoJS.enc.Utf8);
    if (!decrypted) return null;
    return JSON.parse(decrypted);
  } catch (e) {
    return null;
  }
}

function save() {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
  if (!sbClient || !currentPin) return;
  setSyncStatus('syncing');
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    const enc = encryptPayload(db, currentPin);
    const { error } = await sbClient.from('messmate_state').upsert({ id: 1, payload: enc });
    if (error) {
      console.error('Supabase sync failed:', error);
      setSyncStatus('error');
    } else {
      setSyncStatus('synced');
    }
  }, 1000);
}

// Fetch remote state on startup and listen for real-time changes
async function initRemoteSync(pin) {
  if (!sbClient) return true;
  const { data, error } = await sbClient.from('messmate_state').select('payload').eq('id', 1).single();
  if (data && data.payload) {
    const dec = decryptPayload(data.payload, pin);
    if (!dec) return false; // Bad pin
    db = dec;
    localStorage.setItem(DB_KEY, JSON.stringify(db));
    if (typeof renderPage === 'function' && typeof currentPage !== 'undefined') {
      renderPage(currentPage);
    }
  }

  // Bind Postgres changes listener
  sbClient.channel('custom-all-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messmate_state' }, (payload) => {
      if (payload.new && payload.new.payload) {
        const dec = decryptPayload(payload.new.payload, currentPin);
        if (dec) {
          db = dec;
          localStorage.setItem(DB_KEY, JSON.stringify(db));
          if (typeof renderPage === 'function' && typeof currentPage !== 'undefined') {
            renderPage(currentPage);
          }
        }
      }
    })
    .subscribe();
  
  return true;
}

/* =============================================
   AUTH GATE
============================================= */
const authScreen = document.getElementById('authScreen');
const authPinInput = document.getElementById('authPin');
const authBtn = document.getElementById('authBtn');

async function boot() {
  if (currentPin) {
    const ok = await initRemoteSync(currentPin);
    if (ok) {
      authScreen.style.display = 'none';
      return;
    }
    // If we are here, stored pin is invalid
    localStorage.removeItem('messmate_auth');
    currentPin = null;
  }
  
  authScreen.style.display = 'flex';
  
  authBtn.addEventListener('click', async () => {
    const pin = authPinInput.value;
    if (!pin) return;
    
    authBtn.textContent = 'Verifying...';
    const ok = await initRemoteSync(pin);
    authBtn.textContent = 'Unlock';
    
    if (ok) {
      currentPin = pin;
      localStorage.setItem('messmate_auth', pin);
      // Immediately encrypt and push to secure it if it was unencrypted
      save(); 
      authScreen.style.opacity = '0';
      setTimeout(() => authScreen.style.display = 'none', 300);
    } else {
      authPinInput.style.borderColor = 'var(--err)';
      setTimeout(() => authPinInput.style.borderColor = 'var(--line)', 1000);
    }
  });
  authPinInput.addEventListener('keydown', e => { if (e.key === 'Enter') authBtn.click(); });
}
boot();

const esc = s => (s||'').toString().replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[c]));

function getMemberContrib(mo, memId) {
  return [...(mo.bazaars||[]), ...(mo.bills||[])].reduce((s, b) => s + (b.contributions?.[memId] || 0), 0);
}

/* =============================================
   MONTH HELPERS
============================================= */
let activeMonthKey = monthKey(new Date());

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}
function monthLabel(key) {
  const [y,m] = key.split('-');
  return new Date(+y, +m-1, 1).toLocaleDateString('en-US', {month:'long', year:'numeric'});
}
function daysInMonth(key) {
  const [y,m] = key.split('-');
  return new Date(+y, +m, 0).getDate();
}
function padDate(y, m, d) {
  return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
}
function todayStr() { return new Date().toISOString().slice(0,10); }

function getMonth() {
  if (!db.months[activeMonthKey]) {
    db.months[activeMonthKey] = { days: {}, bazaars: [], bills: [] };
    save();
  }
  const mo = db.months[activeMonthKey];
  // Migrate if needed
  if (!mo.bazaars) { mo.bazaars = []; save(); }
  if (!mo.bills) { mo.bills = []; save(); }
  return mo;
}

function getDay(dateStr) {
  const mo = getMonth();
  if (!mo.days[dateStr]) {
    mo.days[dateStr] = { mealsAvail: 0, eaten: {} };
    save();
  }
  return mo.days[dateStr];
}

/* =============================================
   MEAL CALCULATIONS
============================================= */
function memberMealCount(memberId) {
  const mo = getMonth();
  const [y,m] = activeMonthKey.split('-').map(Number);
  const today = todayStr();
  const mem = db.members.find(x => x.id === memberId);
  const joinDate = mem ? mem.joinedAt.slice(0, 10) : '0000-00-00';
  let total = 0;

  for (let d = 1; d <= daysInMonth(activeMonthKey); d++) {
    const ds = padDate(y, m, d);
    if (ds > today) break;
    if (ds < joinDate) continue; // Do not charge for meals before joining

    const day = mo.days[ds];
    if (!day || day.mealsAvail === 0) continue; // day not configured — skip
    // Default = mealsAvail (everyone ate unless overridden)
    const ate = (day.eaten[memberId] !== undefined) ? day.eaten[memberId] : day.mealsAvail;
    total += ate;
  }
  return total;
}

function totalMeals() {
  return db.members.reduce((s, m) => s + memberMealCount(m.id), 0);
}
function totalFoodExpenses() {
  return getMonth().bazaars.reduce((s, b) => s + b.spent, 0);
}
function totalExtraBills() {
  return getMonth().bills.reduce((s, b) => s + b.spent, 0);
}
function totalContributions() {
  let s = 0;
  const mo = getMonth();
  mo.bazaars.forEach(b => {
    if (b.contributions) Object.values(b.contributions).forEach(v => s += v);
  });
  mo.bills.forEach(b => {
    if (b.contributions) Object.values(b.contributions).forEach(v => s += v);
  });
  return s;
}
function mealRate() {
  const meals = totalMeals();
  // Meal rate based on FOOD expenses only — bills split separately
  return meals ? totalFoodExpenses() / meals : 0;
}

/* =============================================
   TOAST
============================================= */
const toastEl = document.getElementById('toast');
let toastTmr;
function toast(msg, type = '') {
  toastEl.textContent = msg;
  toastEl.className = `toast show ${type}`;
  clearTimeout(toastTmr);
  toastTmr = setTimeout(() => toastEl.className = 'toast', 3000);
}

/* =============================================
   MODAL
============================================= */
const overlay = document.getElementById('modalOverlay');

function openModal(id) {
  overlay.classList.add('open');
  document.getElementById(id).classList.add('open');
}
function closeModal(id) {
  overlay.classList.remove('open');
  if (id) document.getElementById(id).classList.remove('open');
  else document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open'));
}

overlay.addEventListener('click', () => closeModal());
document.querySelectorAll('[data-close]').forEach(btn =>
  btn.addEventListener('click', () => closeModal(btn.dataset.close))
);

/* =============================================
   NAVIGATION
============================================= */
const PAGES = ['dashboard','members','meals','shopping','settlement','settings'];
let currentPage = 'dashboard';

function navigate(page) {
  PAGES.forEach(p => {
    document.getElementById(`page-${p}`).classList.toggle('active', p === page);
    document.getElementById(`nav-${p}`).classList.toggle('active', p === page);
  });
  currentPage = page;
  renderPage(page);
}

document.querySelectorAll('.nav-item').forEach(item =>
  item.addEventListener('click', e => { e.preventDefault(); navigate(item.dataset.page); })
);

/* =============================================
   MONTH SELECTOR
============================================= */
function buildMonthSelector() {
  const sel = document.getElementById('globalMonthSelect');
  const keys = new Set([...Object.keys(db.months), activeMonthKey]);

  // Add next month option for planning ahead
  const [y,m] = activeMonthKey.split('-').map(Number);
  const nxt = monthKey(new Date(y, m, 1));
  keys.add(nxt);

  sel.innerHTML = [...keys].sort((a,b) => b.localeCompare(a)).map(k => {
    const label = k === nxt && !db.months[k] ? `${monthLabel(k)} (upcoming)` : monthLabel(k);
    return `<option value="${k}"${k===activeMonthKey?' selected':''}>${label}</option>`;
  }).join('');
}

document.getElementById('globalMonthSelect').addEventListener('change', function() {
  activeMonthKey = this.value;
  getMonth();
  refreshSubtitle();
  renderPage(currentPage);
});

function refreshSubtitle() {
  document.getElementById('dashboardSubtitle').textContent = `Overview — ${monthLabel(activeMonthKey)}`;
  document.getElementById('mealSubtitle').textContent = `${monthLabel(activeMonthKey)} — tap a cell to mark meals eaten`;
}

/* =============================================
   MEMBERS
============================================= */
let pickedEmoji = '<i class="i8 i8-smile"></i>';

document.getElementById('addMemberBtn').addEventListener('click', () => {
  pickedEmoji = '<i class="i8 i8-smile"></i>';
  document.getElementById('memberNameInput').value = '';
  document.querySelectorAll('.emoji-opt').forEach(e =>
    e.classList.toggle('selected', e.dataset.emoji === '<i class="i8 i8-smile"></i>')
  );
  openModal('addMemberModal');
  setTimeout(() => document.getElementById('memberNameInput').focus(), 80);
});

document.querySelectorAll('.emoji-opt').forEach(opt =>
  opt.addEventListener('click', () => {
    pickedEmoji = opt.dataset.emoji;
    document.querySelectorAll('.emoji-opt').forEach(e => e.classList.remove('selected'));
    opt.classList.add('selected');
  })
);

document.getElementById('memberNameInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('saveMemberBtn').click();
});

document.getElementById('saveMemberBtn').addEventListener('click', () => {
  const name = document.getElementById('memberNameInput').value.trim();
  if (!name) { toast('Enter a name', 'err'); return; }
  if (db.members.find(m => m.name.toLowerCase() === name.toLowerCase())) {
    toast('Name already exists', 'err'); return;
  }
  db.members.push({ id: uid(), name, emoji: pickedEmoji, joinedAt: new Date().toISOString() });
  save();
  closeModal('addMemberModal');
  toast(`${name} added`, 'ok');
  renderPage(currentPage);
});

function renderMembers() {
  const grid = document.getElementById('membersGrid');
  if (!db.members.length) {
    grid.innerHTML = '<div class="empty-state large">No members yet. Click "Add Member" to get started.</div>';
    return;
  }
  const mo = getMonth();
  grid.innerHTML = db.members.map(m => {
    const meals = memberMealCount(m.id);
    const contrib = getMemberContrib(mo, m.id);
    return `<div class="member-card">
      <button class="member-del" data-id="${m.id}" title="Remove">✕</button>
      <div class="member-avatar">${m.emoji}</div>
      <div class="member-name">${esc(m.name)}</div>
      <div class="member-meta">${meals} meals · ৳${contrib.toLocaleString()} contributed</div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.member-del').forEach(btn =>
    btn.addEventListener('click', () => {
      const m = db.members.find(x => x.id === btn.dataset.id);
      if (!m) return;
      if (!confirm(`Remove ${m.name}?`)) return;
      db.members = db.members.filter(x => x.id !== m.id);
      Object.values(db.months).forEach(month => {
        month.bazaars.forEach(b => { if (b.contributions) delete b.contributions[m.id]; });
        month.bills.forEach(b => { if (b.contributions) delete b.contributions[m.id]; });
        Object.values(month.days).forEach(d => { if (d.eaten) delete d.eaten[m.id]; });
      });
      save();
      toast(`${m.name} removed`);
      renderPage(currentPage);
    })
  );
}

/* =============================================
   MEAL TRACKER
============================================= */
function renderMealTracker() {
  buildMealTable();
}

function buildMealTable() {
  const [y, m] = activeMonthKey.split('-').map(Number);
  const days = daysInMonth(activeMonthKey);
  const today = todayStr();
  const mo = getMonth();

  // ---- HEADER ----
  let hRow = `<tr>
    <th style="text-align:left;padding:10px 16px;min-width:130px">Member</th>`;

  for (let d = 1; d <= days; d++) {
    const ds = padDate(y, m, d);
    const isTd = ds === today;
    const future = ds > today;
    const wk = new Date(y, m-1, d).toLocaleDateString('en-US',{weekday:'short'}).slice(0,2);

    const dayData = mo.days[ds];
    const avail = dayData ? dayData.mealsAvail : 0;
    // Badge CSS: 0=muted, 1=white, 2=teal
    const maCls = avail === 0 ? 'meals-avail ma-0'
                : avail === 2 ? 'meals-avail ma-2'
                : 'meals-avail ma-1';
    const maTip = avail === 0 ? 'Day not set — click to set 1 meal'
                : avail === 1 ? '1 meal today — click for 2'
                : '2 meals today — click to clear';

    hRow += `<th class="day-th${isTd ? ' today-col' : ''}">
      <span class="day-num">${d}</span>
      <span class="day-wk">${wk}</span>
      ${!future ? `<span class="${maCls}" data-date="${ds}" data-avail="${avail}" title="${maTip}">${avail}</span>` : '<span style="opacity:.15;font-size:.6rem">·</span>'}
    </th>`;
  }
  hRow += `<th class="sum-th">Meals</th></tr>`;
  document.getElementById('mealTHead').innerHTML = hRow;

  // ---- BODY ----
  if (!db.members.length) {
    document.getElementById('mealTBody').innerHTML =
      `<tr><td colspan="${days+2}" class="empty-state">Add members first.</td></tr>`;
    return;
  }

  let body = '';
  db.members.forEach(member => {
    let cells = '';
    let mealTotal = 0;

    for (let d = 1; d <= days; d++) {
      const ds = padDate(y, m, d);
      const future = ds > today;

      if (future) {
        cells += `<td><div class="meal-cell mc-future"></div></td>`;
        continue;
      }

      const dayData = mo.days[ds];
      const avail = dayData ? dayData.mealsAvail : 0;

      // Day not configured yet — show inactive
      if (avail === 0) {
        cells += `<td><div class="meal-cell mc-future"></div></td>`;
        continue;
      }

      // Default = mealsAvail (everyone ate unless explicitly overridden)
      const ate = (dayData.eaten[member.id] !== undefined) ? dayData.eaten[member.id] : avail;
      mealTotal += ate;

      let cellCls = '';
      if (avail === 1) {
        cellCls = ate >= 1 ? 'mc-1 single' : 'mc-0';
      } else {
        cellCls = ate === 2 ? 'mc-2' : ate === 1 ? 'mc-1 double' : 'mc-0';
      }

      cells += `<td><div class="meal-cell ${cellCls}"
        data-member="${member.id}" data-date="${ds}" data-avail="${avail}" data-ate="${ate}"
        role="button" tabindex="0" title="Click to change"></div></td>`;
    }

    body += `<tr>
      <td><span style="margin-right:6px">${member.emoji}</span>${esc(member.name)}</td>
      ${cells}
      <td class="sum-td">${mealTotal}</td>
    </tr>`;
  });

  document.getElementById('mealTBody').innerHTML = body;

  // ---- Events: meals-avail badge — cycles 0 → 1 → 2 → 0 ----
  document.getElementById('mealTHead').querySelectorAll('.meals-avail').forEach(badge => {
    badge.addEventListener('click', () => {
      const ds = badge.dataset.date;
      const day = getDay(ds);
      const next = (day.mealsAvail + 1) % 3; // 0→1→2→0
      day.mealsAvail = next;
      // Clear per-person overrides when resetting to 0,
      // or clamp overrides that exceed new avail
      if (next === 0) {
        day.eaten = {};
      } else {
        db.members.forEach(mem => {
          if (day.eaten[mem.id] !== undefined && day.eaten[mem.id] > next) {
            delete day.eaten[mem.id]; // back to default (= mealsAvail)
          }
        });
      }
      save();
      buildMealTable();
      renderDashStats();
    });
  });

  // ---- Events: meal cells ----
  document.getElementById('mealTBody').querySelectorAll('.meal-cell[data-date]').forEach(cell => {
    cell.addEventListener('click', () => cycleMeal(cell));
    cell.addEventListener('keydown', e => { if (e.key==='Enter'||e.key===' ') cycleMeal(cell); });
  });
}

function cycleMeal(cell) {
  const memberId = cell.dataset.member;
  const ds = cell.dataset.date;
  const avail = parseInt(cell.dataset.avail);
  if (!avail) return; // day not configured, ignore clicks
  const day = getDay(ds);

  // Current value: default is mealsAvail (ate everything)
  const current = (day.eaten[memberId] !== undefined) ? day.eaten[memberId] : avail;

  // Toggle: mealsAvail ↔ 0
  if (current === avail) {
    day.eaten[memberId] = 0;
  } else {
    // Back to default (which equals avail)
    delete day.eaten[memberId];
  }
  save();
  buildMealTable();
  renderDashStats();
}

document.getElementById('prevMonthBtn').addEventListener('click', () => shiftMonth(-1));
document.getElementById('nextMonthBtn').addEventListener('click', () => shiftMonth(+1));

function shiftMonth(dir) {
  const [y,m] = activeMonthKey.split('-').map(Number);
  activeMonthKey = monthKey(new Date(y, m - 1 + dir, 1));
  getMonth();
  buildMonthSelector();
  refreshSubtitle();
  renderPage(currentPage);
}

/* =============================================
   MONEY & SHOPPING
============================================= */

// Modal initialization helper
function initMoneyModal(prefix, itemToEdit = null) {
  document.getElementById(`${prefix}TitleInput`).value = itemToEdit ? itemToEdit.title : '';
  document.getElementById(`${prefix}DateInput`).value = itemToEdit ? itemToEdit.date : todayStr();
  document.getElementById(`${prefix}SpentInput`).value = itemToEdit ? itemToEdit.spent : '';
  document.getElementById(`save${prefix.charAt(0).toUpperCase() + prefix.slice(1)}Btn`).dataset.editId = itemToEdit ? itemToEdit.id : '';
  document.getElementById(`del${prefix.charAt(0).toUpperCase() + prefix.slice(1)}Btn`).style.display = itemToEdit ? 'block' : 'none';
  
  const listEl = document.getElementById(`${prefix}MembersList`);
  listEl.innerHTML = db.members.map(m => {
    const val = (itemToEdit && itemToEdit.contributions && itemToEdit.contributions[m.id]) ? itemToEdit.contributions[m.id] : '';
    return `<div class="modal-contrib-row">
      <div class="mcr-name">${m.emoji} ${esc(m.name)}</div>
      <input type="number" class="form-input mcr-input" data-member="${m.id}" placeholder="0" min="0" value="${val}">
    </div>`;
  }).join('');
  
  const recalcTotal = () => {
    let tot = 0;
    listEl.querySelectorAll('input').forEach(i => tot += parseFloat(i.value) || 0);
    document.getElementById(`${prefix}TotalCollected`).textContent = `৳${tot.toLocaleString()}`;
  };
  
  listEl.querySelectorAll('input').forEach(inp => inp.addEventListener('input', recalcTotal));
  recalcTotal();
}

function getContributionsFromModal(prefix) {
  const contribs = {};
  document.getElementById(`${prefix}MembersList`).querySelectorAll('input').forEach(inp => {
    const val = parseFloat(inp.value);
    if (val > 0) contribs[inp.dataset.member] = val;
  });
  return contribs;
}

// ---- Bazaars ----
document.getElementById('addBazaarBtn').addEventListener('click', () => {
  if (!db.members.length) { toast('Add members first', 'err'); return; }
  initMoneyModal('baz');
  openModal('addBazaarModal');
  setTimeout(() => document.getElementById('bazTitleInput').focus(), 80);
});

document.getElementById('saveBazBtn').addEventListener('click', (e) => {
  const title = document.getElementById('bazTitleInput').value.trim();
  const date = document.getElementById('bazDateInput').value || todayStr();
  const spent = parseFloat(document.getElementById('bazSpentInput').value);
  
  if (!title) { toast('Enter a title', 'err'); return; }
  if (isNaN(spent) || spent < 0) { toast('Enter a valid spent amount', 'err'); return; }
  
  const contributions = getContributionsFromModal('baz');
  const editId = e.target.dataset.editId;
  const mo = getMonth();
  
  if (editId) {
    const idx = mo.bazaars.findIndex(b => b.id === editId);
    if (idx > -1) mo.bazaars[idx] = { ...mo.bazaars[idx], title, date, spent, contributions };
  } else {
    mo.bazaars.push({ id: uid(), title, date, spent, contributions });
  }
  
  save();
  closeModal('addBazaarModal');
  toast('Shopping trip saved', 'ok');
  renderShopping();
  renderDashStats();
});

document.getElementById('delBazBtn').addEventListener('click', () => {
  const editId = document.getElementById('saveBazBtn').dataset.editId;
  if (editId) {
    const mo = getMonth();
    mo.bazaars = mo.bazaars.filter(b => b.id !== editId);
    save();
    closeModal('addBazaarModal');
    toast('Shopping trip deleted', 'ok');
    renderShopping();
    renderDashStats();
  }
});

// ---- Extra Bills ----
let pickedCat = 'Electricity';
document.getElementById('addBillBtn').addEventListener('click', () => {
  if (!db.members.length) { toast('Add members first', 'err'); return; }
  pickedCat = 'Electricity';
  document.querySelectorAll('.cat-btn').forEach(b => b.classList.toggle('active', b.dataset.cat === 'Electricity'));
  
  initMoneyModal('bill');
  openModal('addBillModal');
  setTimeout(() => document.getElementById('billTitleInput').focus(), 80);
});

document.querySelectorAll('.cat-btn').forEach(btn =>
  btn.addEventListener('click', () => {
    pickedCat = btn.dataset.cat;
    document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const titleEl = document.getElementById('billTitleInput');
    if (!titleEl.value) titleEl.value = pickedCat;
  })
);

document.getElementById('saveBillBtn').addEventListener('click', (e) => {
  const title = document.getElementById('billTitleInput').value.trim();
  const date = document.getElementById('billDateInput').value || todayStr();
  const spent = parseFloat(document.getElementById('billSpentInput').value);
  
  if (!title) { toast('Enter a title', 'err'); return; }
  if (isNaN(spent) || spent < 0) { toast('Enter a valid spent amount', 'err'); return; }
  
  const contributions = getContributionsFromModal('bill');
  const editId = e.target.dataset.editId;
  const mo = getMonth();
  
  if (editId) {
    const idx = mo.bills.findIndex(b => b.id === editId);
    if (idx > -1) mo.bills[idx] = { ...mo.bills[idx], cat: pickedCat, title, date, spent, contributions };
  } else {
    mo.bills.push({ id: uid(), cat: pickedCat, title, date, spent, contributions });
  }
  
  save();
  closeModal('addBillModal');
  toast('Bill saved', 'ok');
  renderShopping();
  renderDashStats();
});

document.getElementById('delBillBtn').addEventListener('click', () => {
  const editId = document.getElementById('saveBillBtn').dataset.editId;
  if (editId) {
    const mo = getMonth();
    mo.bills = mo.bills.filter(b => b.id !== editId);
    save();
    closeModal('addBillModal');
    toast('Bill deleted', 'ok');
    renderShopping();
    renderDashStats();
  }
});

function renderMoneyTable(items, prefix) {
  const thEl = document.getElementById(`${prefix}THead`);
  const tbEl = document.getElementById(`${prefix}TBody`);
  const tfEl = document.getElementById(`${prefix}TFoot`);
  
  if (!items.length) {
    thEl.innerHTML = '';
    tfEl.innerHTML = '';
    tbEl.innerHTML = `<tr><td><div class="empty-state">No entries yet.</div></td></tr>`;
    return;
  }
  
  thEl.innerHTML = `<tr>
    <th>Member</th>
    ${items.map(item => `<th>
      <div style="display:flex; align-items:center; justify-content:flex-end; gap:6px;">
        <span>${esc(item.title)}</span>
        <button class="btn btn-ghost btn-sm edit-btn" style="padding:2px 4px; height:auto; font-size:12px;" data-id="${item.id}">✎</button>
      </div>
      <div style="font-size:0.7rem; color:var(--t-lo); text-transform:none">${item.date}</div>
    </th>`).join('')}
  </tr>`;
  
  tbEl.innerHTML = db.members.map(m => {
    const cells = items.map(item => {
      const val = item.contributions[m.id] || 0;
      return `<td>${val > 0 ? `৳${val.toLocaleString()}` : '<span style="color:var(--t-lo)">—</span>'}</td>`;
    }).join('');
    return `<tr>
      <td><span style="margin-right:6px">${m.emoji}</span>${esc(m.name)}</td>
      ${cells}
      </tr>`;
  }).join('');
  
  const collectedRow = items.map(item => {
    const collected = Object.values(item.contributions).reduce((a,b)=>a+b, 0);
    return `<td class="mt-collected">৳${collected.toLocaleString()}</td>`;
  }).join('');
  
  const spentRow = items.map(item => {
    return `<td class="mt-spent">৳${item.spent.toLocaleString()}</td>`;
  }).join('');
  
  const poolRow = items.map(item => {
    const collected = Object.values(item.contributions).reduce((a,b)=>a+b, 0);
    const diff = collected - item.spent;
    const sign = diff >= 0 ? '+' : '−';
    return `<td class="mt-pool">${sign}৳${Math.abs(diff).toLocaleString()}</td>`;
  }).join('');
  
  tfEl.innerHTML = `
    <tr><td>Total Collected</td>${collectedRow}</tr>
    <tr><td>Actually Spent</td>${spentRow}</tr>
    <tr><td>Extra</td>${poolRow}</tr>
  `;
  
  // Attach edit handlers
  thEl.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const item = items.find(x => x.id === id);
      if (!item) return;
      
      if (prefix === 'baz') {
        initMoneyModal('baz', item);
        openModal('addBazaarModal');
      } else {
        pickedCat = item.cat || 'Other';
        document.querySelectorAll('.cat-btn').forEach(b => b.classList.toggle('active', b.dataset.cat === pickedCat));
        initMoneyModal('bill', item);
        openModal('addBillModal');
      }
    });
  });
}

function renderShopping() {
  renderMoneyTable(getMonth().bazaars, 'baz');
  renderMoneyTable(getMonth().bills, 'bill');
}

function catIcon(cat) {
  return { Electricity:'<i class="i8 i8-elec"></i>', WiFi:'<i class="i8 i8-wifi"></i>', Gas:'<i class="i8 i8-gas"></i>', Water:'<i class="i8 i8-water"></i>', Other:'<i class="i8 i8-other"></i>' }[cat] || '<i class="i8 i8-other"></i>';
}

/* =============================================
   SETTLEMENT
============================================= */
document.getElementById('recalcBtn').addEventListener('click', renderSettlement);
document.getElementById('exportBtn').addEventListener('click', copyReport);

function renderSettlement() {
  const te   = totalFoodExpenses();
  const tb   = totalExtraBills();
  const tm   = totalMeals();
  const tc   = totalContributions();
  const rate = mealRate();
  const n    = db.members.length;
  const billShare = n ? tb / n : 0;

  document.getElementById('sumTotalSpent').textContent   = `৳${te.toFixed(2)}`;
  document.getElementById('sumTotalMeals').textContent   = tm;
  document.getElementById('sumMealRate').textContent     = rate ? `৳${rate.toFixed(2)} / meal` : '—';
  document.getElementById('sumExtraBills').textContent   = `৳${tb.toFixed(2)}`;
  document.getElementById('sumTotalContrib').textContent = `৳${tc.toFixed(2)}`;

  const tbl = document.getElementById('settlementTable');
  if (!db.members.length) {
    tbl.innerHTML = '<div class="empty-state">Add members and record meals first.</div>';
    document.getElementById('txCard').style.display = 'none';
    return;
  }

  const rows = db.members.map(mem => {
    const meals     = memberMealCount(mem.id);
    const contrib   = getMemberContrib(getMonth(), mem.id);
    const mealCost  = meals * rate;
    const totalCost = mealCost + billShare;
    const bal       = contrib - totalCost;
    return { mem, meals, contrib, mealCost, billShare, totalCost, bal };
  });

  tbl.innerHTML = rows.map(({ mem, meals, contrib, mealCost, billShare, totalCost, bal }) => {
    const balCls  = bal > 0.005 ? 'bal-pos' : bal < -0.005 ? 'bal-neg' : 'bal-zero';
    const balText = bal > 0.005 ? `+৳${bal.toFixed(0)}`
                  : bal < -0.005 ? `−৳${Math.abs(bal).toFixed(0)}`
                  : '0';
    return `<tr>
      <td>
        <div class="st-mem">
          <div class="st-emo">${mem.emoji}</div>
          <div>
            <div class="st-name">${esc(mem.name)}</div>
            <div class="st-sub">${meals} meals</div>
          </div>
        </div>
      </td>
      <td><div class="st-val">৳${contrib.toFixed(0)}</div></td>
      <td><div class="st-val">৳${mealCost.toFixed(0)}</div></td>
      <td><div class="st-val">৳${billShare.toFixed(0)}</div></td>
      <td><div class="st-val">৳${totalCost.toFixed(0)}</div></td>
      <td style="padding-right:16px"><div class="bal-badge ${balCls}">${balText}</div></td>
    </tr>`;
  }).join('');

  const txs = minTransactions(rows);
  const txCard = document.getElementById('txCard');
  if (txs.length) {
    txCard.style.display = '';
    document.getElementById('txList').innerHTML = txs.map(tx =>
      `<div class="tx-item">
        <span>${tx.from.emoji}</span>
        <span class="tx-from">${esc(tx.from.name)}</span>
        <span class="tx-arr">→ pays →</span>
        <span>${tx.to.emoji}</span>
        <span class="tx-to">${esc(tx.to.name)}</span>
        <span class="tx-amt">৳${tx.amount.toFixed(2)}</span>
      </div>`
    ).join('');
  } else {
    txCard.style.display = 'none';
  }
}

function minTransactions(rows) {
  const eps = 0.01;
  const debtors   = rows.filter(r => r.bal < -eps).map(r => ({ ...r.mem, owes: -r.bal }));
  const creditors = rows.filter(r => r.bal >  eps).map(r => ({ ...r.mem, gets: r.bal }));
  const txs = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].owes, creditors[j].gets);
    if (pay > eps) txs.push({ from: debtors[i], to: creditors[j], amount: pay });
    debtors[i].owes  -= pay;
    creditors[j].gets -= pay;
    if (debtors[i].owes  < eps) i++;
    if (creditors[j].gets < eps) j++;
  }
  return txs;
}

function copyReport() {
  const te = totalFoodExpenses(), tb = totalExtraBills(), tm = totalMeals();
  const rate = mealRate(), tc = totalContributions();
  const n = db.members.length;
  const billShare = n ? tb / n : 0;

  let r = `MessMate — Settlement Report\nMonth: ${monthLabel(activeMonthKey)}\nGenerated: ${new Date().toLocaleDateString()}\n${'='.repeat(42)}\n\n`;
  r += `Food Expenses:     ৳${te.toFixed(2)}\nExtra Bills:       ৳${tb.toFixed(2)}\nTotal Meals:       ${tm}\nMeal Rate:         ৳${rate.toFixed(2)} / meal\nBill/head:         ৳${billShare.toFixed(2)}\nTotal Contributed: ৳${tc.toFixed(2)}\n\n`;

  if (getMonth().bills.length) {
    r += `EXTRA BILLS\n${'─'.repeat(42)}\n`;
    getMonth().bills.forEach(b => r += `${b.title}: ৳${b.spent.toFixed(2)}\n`);
    r += `\n`;
  }

  r += `BREAKDOWN\n${'─'.repeat(42)}\n`;
  db.members.forEach(mem => {
    const meals     = memberMealCount(mem.id);
    const contrib   = getMemberContrib(getMonth(), mem.id);
    const mealCost  = meals * rate;
    const totalCost = mealCost + billShare;
    const bal       = contrib - totalCost;
    const st        = bal > 0.005 ? `gets ৳${bal.toFixed(2)} back` : bal < -0.005 ? `owes ৳${Math.abs(bal).toFixed(2)}` : 'settled';
    r += `${mem.name}: ${meals} meals (৳${mealCost.toFixed(2)}) + bills (৳${billShare.toFixed(2)}) = ৳${totalCost.toFixed(2)} | contributed ৳${contrib.toFixed(2)} | ${st}\n`;
  });

  navigator.clipboard.writeText(r)
    .then(() => toast('Report copied!', 'ok'))
    .catch(() => { alert(r); });
}

document.getElementById('exportImageBtn').addEventListener('click', () => {
  const target = document.getElementById('page-settlement');
  const actions = target.querySelector('.header-actions');
  if (actions) actions.style.display = 'none';
  
  // Use html2canvas to capture the page
  if (typeof html2canvas !== 'undefined') {
    html2canvas(target, { 
      backgroundColor: '#111', 
      scale: 2 // Higher resolution
    }).then(canvas => {
      if (actions) actions.style.display = '';
      const link = document.createElement('a');
      link.download = `MessMate_Settlement_${activeMonthKey}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
      toast('Image saved', 'ok');
    }).catch(err => {
      if (actions) actions.style.display = '';
      toast('Failed to capture image', 'err');
      console.error(err);
    });
  } else {
    if (actions) actions.style.display = '';
    toast('Image export library not loaded', 'err');
  }
});

/* =============================================
   DASHBOARD
============================================= */
function renderDash() {
  renderDashStats();
  renderTodayMeals();
  renderSpendSummary();
}

function renderDashStats() {
  document.getElementById('statMembers').textContent = db.members.length;
  document.getElementById('statMeals').textContent = totalMeals();
  
  const rate = mealRate();
  document.getElementById('statRate').textContent = rate ? `৳${rate.toFixed(2)}` : '৳0';
  
  document.getElementById('statFund').textContent = `৳${totalContributions().toLocaleString()}`;
  document.getElementById('statBillsOut').textContent = `৳${totalExtraBills().toLocaleString()}`;
}

function renderTodayMeals() {
  const ts = todayStr();
  const day = getDay(ts);
  const avail = day.mealsAvail;
  
  // Format header
  const todayDate = new Date();
  document.getElementById('dashTodayDate').textContent = todayDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  
  const badge = document.getElementById('dashTodayAvailBtn');
  badge.textContent = `Default: ${avail} meals`;
  
  badge.onclick = () => {
    const next = (day.mealsAvail + 1) % 3;
    day.mealsAvail = next;
    if (next === 0) {
      day.eaten = {};
    } else {
      db.members.forEach(mem => {
        if (day.eaten[mem.id] !== undefined && day.eaten[mem.id] > next) delete day.eaten[mem.id];
      });
    }
    save();
    renderDash();
  };

  const el = document.getElementById('dashTodayMeals');
  if (!db.members.length) { el.innerHTML = '<div class="empty-state">No members yet.</div>'; return; }
  
  if (avail === 0) {
    el.innerHTML = '<div class="empty-state" style="padding:40px 20px">Click the badge above to start marking meals for today.</div>';
    return;
  }

  el.innerHTML = db.members.map(m => {
    const ate = (day.eaten[m.id] !== undefined) ? day.eaten[m.id] : avail;
    let cellCls = '';
    if (avail === 1) cellCls = ate >= 1 ? 'mc-1 single' : 'mc-0';
    else cellCls = ate === 2 ? 'mc-2' : ate === 1 ? 'mc-1 double' : 'mc-0';

    return `<div class="dash-row">
      <div class="dr-emo">${m.emoji}</div>
      <div class="dr-info">
        <div class="dr-name">${esc(m.name)}</div>
        <div class="dr-sub">${memberMealCount(m.id)} meals total</div>
      </div>
      <div class="meal-cell ${cellCls}"
        data-member="${m.id}" data-date="${ts}" data-avail="${avail}"
        role="button" tabindex="0" title="Click to change"></div>
    </div>`;
  }).join('');

  // Cell clicks
  el.querySelectorAll('.meal-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      cycleMeal(cell);
      // cycleMeal re-renders the Meal table, we also need to re-render Dash
      renderDash();
    });
  });
}

function renderSpendSummary() {
  const te = totalFoodExpenses();
  const tb = totalExtraBills();
  const total = te + tb;
  
  const badge = document.getElementById('dashTotalSpentBadge');
  badge.textContent = `৳${total.toLocaleString()}`;

  const el = document.getElementById('dashSpendSummary');
  if (total === 0) { el.innerHTML = '<div class="empty-state">No expenses yet.</div>'; return; }

  let items = [];
  
  if (te > 0) {
    items.push({ name: 'Food & Groceries', emoji: '<i class="i8 i8-cart"></i>', amount: te });
  }

  // Group bills by title to prevent showing 5 entries for "Electricity" if entered separately
  const billGroups = {};
  getMonth().bills.forEach(b => {
    if (!billGroups[b.title]) billGroups[b.title] = { name: b.title, emoji: catIcon(b.cat), amount: 0 };
    billGroups[b.title].amount += b.spent;
  });

  Object.values(billGroups).forEach(g => items.push(g));
  
  // Sort descending by amount
  items.sort((a,b) => b.amount - a.amount);

  el.innerHTML = items.map(r => {
    return `<div class="dash-row">
      <div class="dr-emo">${r.emoji}</div>
      <div class="dr-info">
        <div class="dr-name">${esc(r.name)}</div>
      </div>
      <div class="dr-val">৳${r.amount.toFixed(0)}</div>
    </div>`;
  }).join('');
}

/* =============================================
   ROUTER
============================================= */
function renderPage(page) {
  switch (page) {
    case 'dashboard':  renderDash(); break;
    case 'members':    renderMembers(); break;
    case 'meals':      renderMealTracker(); break;
    case 'shopping':   renderShopping(); break;
    case 'settlement': renderSettlement(); break;
    case 'settings':   /* static page, no render needed */ break;
  }
}

/* =============================================
   UTILS
============================================= */
function uid() { return Math.random().toString(36).slice(2,9) + Date.now().toString(36); }

function fillMemberSel(id) {
  document.getElementById(id).innerHTML = db.members.map(m =>
    `<option value="${m.id}">${m.emoji} ${m.name}</option>`).join('');
}
function fillMemberSelOpt(id) {
  document.getElementById(id).innerHTML =
    `<option value="">— Common fund —</option>` +
    db.members.map(m => `<option value="${m.id}">${m.emoji} ${m.name}</option>`).join('');
}

/* =============================================
   SETTINGS
============================================= */
document.getElementById('changePinBtn')?.addEventListener('click', () => {
  const oldPin = document.getElementById('setOldPin').value;
  const newPin = document.getElementById('setNewPin').value;
  
  if (oldPin !== currentPin) {
    toast('Current PIN is incorrect', 'err');
    return;
  }
  if (!newPin || newPin.length < 4) {
    toast('New PIN must be at least 4 characters', 'err');
    return;
  }
  
  currentPin = newPin;
  localStorage.setItem('messmate_auth', newPin);
  
  // Re-encrypt the DB and push to Supabase
  save();
  
  document.getElementById('setOldPin').value = '';
  document.getElementById('setNewPin').value = '';
  toast('PIN updated & DB secured', 'ok');
});

/* =============================================
   BOOT
============================================= */
function init() {
  getMonth();
  buildMonthSelector();
  refreshSubtitle();
  renderDash();
}

init();
