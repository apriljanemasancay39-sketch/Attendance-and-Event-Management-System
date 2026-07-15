// DATA LAYER
// ═══════════════════════════════
// All data now lives in MySQL and is accessed through php/api.php.
// These arrays/objects are an in-memory mirror of the database, kept in
// the exact same shape the rest of this file already expects — every
// render function below works unchanged.
let students = [];
let events = [];
let records = [];
let photos = {}; // key: studentId_eventId (or 'co_'+studentId_eventId for checkout selfies) → base64
let checkouts = {}; // key: studentId_eventId → {time, ...}
let fines = {}; // key: studentId_eventId (or +'_late') → {amount, status: 'unpaid'|'paid'|'waived'}
let appeals = {}; // key: studentId_eventId → {studentId, eventId, reason, type, submittedAt, status, adminNote}
let currentUser = null;
let editingStudentId = null;
let editingEventId = null;
let selectedStudentForStatus = null;
let viewingProfileStudentId = null;
let studentsPage = 1;

// Path to the PHP API. Adjust if you deploy this app somewhere other than
// http://localhost/attendance_system/
const API_BASE = 'php/api.php';

// ─── Admin Credentials (SHA-256 hashed), loaded from MySQL on startup ─
let adminCreds = { username: 'admin', passHash: null };
async function sha256(msg) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}
function getAdminCreds() {
  return adminCreds;
}
function saveAdminCreds(creds) {
  adminCreds = creds;
  fetch(`${API_BASE}?entity=admin&action=updateCreds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: creds.username, passHash: creds.passHash })
  }).catch(err => console.error('Failed to sync admin credentials to the database:', err));
}

const PAGE_SIZE = 10;

// Selfie state
let selfieEventId = null;
let selfieStream = null;
let selfieDataUrl = null;

// ─── Persistence: push the full in-memory state to MySQL ──────────────
// Called after every mutation, exactly like the old localStorage version.
function save() {
  fetch(`${API_BASE}?entity=sync&action=saveAll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ students, events, records, fines, appeals, checkouts })
  }).catch(err => {
    console.error('Failed to save to the database:', err);
    toast('⚠️ Could not save to the database. Check your MySQL/XAMPP connection.', 'error');
  });
}

// ─── Persistence: push a single captured photo to MySQL immediately ───
// Photos can be large, so they're synced individually rather than as
// part of the bulk save() above.
function syncPhoto(key, dataUrl) {
  const isCheckout = key.startsWith('co_');
  const rawKey = isCheckout ? key.slice(3) : key;
  const underscoreIdx = rawKey.lastIndexOf('_');
  const studentId = rawKey.slice(0, underscoreIdx);
  const eventId = rawKey.slice(underscoreIdx + 1);
  fetch(`${API_BASE}?entity=photos&action=create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studentId, eventId, type: isCheckout ? 'checkout' : 'checkin', photoData: dataUrl })
  }).catch(err => console.error('Failed to save photo to the database:', err));
}

// ─── Initial load: pull everything from MySQL before the app is usable ─
async function loadAllData() {
  try {
    const res = await fetch(`${API_BASE}?entity=sync&action=loadAll`);
    const data = await res.json();
    students  = data.students  || [];
    events    = data.events    || [];
    records   = data.records   || [];
    fines     = data.fines     || {};
    appeals   = data.appeals   || {};
    checkouts = data.checkouts || {};
    photos    = data.photos    || {};
    adminCreds = data.adminCreds || { username: 'admin', passHash: null };

    // Seed a default event the first time the database is empty
    if (events.length === 0) {
      events.push({ id: 'ev1', name: 'Tech Conference', date: '2026-05-24', openTime: '07:00', onTimeDeadline: '08:00', lateDeadline: '09:00', fineAmount: 100 });
      save();
    }
  } catch (err) {
    console.error('Failed to load data from the database:', err);
    toast('⚠️ Could not connect to the database. Make sure XAMPP/MySQL is running and php/api.php is reachable.', 'error');
  }

  const overlay = document.getElementById('appLoadingOverlay');
  if (overlay) overlay.remove();

  // Re-render anything that already drew (empty) before data arrived
  renderAuthCalendar();
  renderAuthUpcomingEvents();
}

// Full-screen loading overlay shown until the initial database fetch completes,
// so nobody can try to log in before data.exists in memory.
(function showLoadingOverlay() {
  const el = document.createElement('div');
  el.id = 'appLoadingOverlay';
  el.style.cssText = 'position:fixed;inset:0;background:#0b1120;color:#fff;display:flex;align-items:center;justify-content:center;font-family:sans-serif;font-size:16px;z-index:99999;letter-spacing:.3px;';
  el.innerHTML = '<div>⏳ Loading data from database…</div>';
  document.body.appendChild(el);
})();

loadAllData();

// ═══════════════════════════════
// TOAST
// ═══════════════════════════════
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast-item toast-${type}`;
  const icons = { success: 'fa-check-circle', error: 'fa-times-circle', info: 'fa-info-circle' };
  el.innerHTML = `<i class="fas ${icons[type]}"></i> ${msg}`;
  document.getElementById('toast').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ═══════════════════════════════
// LIVE CLOCK
// ═══════════════════════════════
function startClock() {
  function tick() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2,'0');
    const mm = String(now.getMinutes()).padStart(2,'0');
    const ss = String(now.getSeconds()).padStart(2,'0');
    const clockEl = document.getElementById('authClock');
    const dateEl = document.getElementById('authClockDate');
    if (clockEl) clockEl.textContent = `${hh}:${mm}:${ss}`;
    if (dateEl) dateEl.textContent = now.toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'});
  }
  tick();
  setInterval(tick, 1000);
}

// ═══════════════════════════════
// MINI CALENDAR
// ═══════════════════════════════
let calViewYear = new Date().getFullYear();
let calViewMonth = new Date().getMonth();

function calNav(dir) {
  calViewMonth += dir;
  if (calViewMonth > 11) { calViewMonth = 0; calViewYear++; }
  if (calViewMonth < 0) { calViewMonth = 11; calViewYear--; }
  renderAuthCalendar();
}

function renderAuthCalendar() {
  const label = document.getElementById('calMonthLabel');
  const grid = document.getElementById('miniCalGrid');
  if (!label || !grid) return;

  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  label.textContent = `${monthNames[calViewMonth]} ${calViewYear}`;

  const today = new Date();
  const eventDates = new Set(events.map(ev => ev.date));

  const firstDay = new Date(calViewYear, calViewMonth, 1).getDay();
  const daysInMonth = new Date(calViewYear, calViewMonth + 1, 0).getDate();
  const daysInPrev = new Date(calViewYear, calViewMonth, 0).getDate();

  const dows = ['Su','Mo','Tu','We','Th','Fr','Sa'];
  let html = dows.map(d => `<div class="cal-dow">${d}</div>`).join('');

  // Prev month tail
  for (let i = firstDay - 1; i >= 0; i--) {
    html += `<div class="cal-day other-month">${daysInPrev - i}</div>`;
  }

  // Current month
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${calViewYear}-${String(calViewMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const isToday = today.getFullYear()===calViewYear && today.getMonth()===calViewMonth && today.getDate()===d;
    const hasEv = eventDates.has(dateStr);
    html += `<div class="cal-day${isToday?' today':''}${hasEv?' has-event':''}" title="${hasEv?events.filter(e=>e.date===dateStr).map(e=>e.name).join(', '):''}">${d}</div>`;
  }

  // Next month fill
  const total = firstDay + daysInMonth;
  const remaining = total % 7 === 0 ? 0 : 7 - (total % 7);
  for (let d = 1; d <= remaining; d++) {
    html += `<div class="cal-day other-month">${d}</div>`;
  }

  grid.innerHTML = html;
}

// ═══════════════════════════════
// CHECK-IN WINDOW HELPERS
// ═══════════════════════════════
function getCheckinStatus(ev) {
  // Returns: 'before_open' | 'open' | 'late_window' | 'closed' | 'future'
  const now = new Date();
  const todayStr = now.toISOString().slice(0,10);

  if (ev.date > todayStr) return 'future';
  if (ev.date < todayStr) return 'closed';

  // Same day — check time
  const nowTime = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
  const open = ev.openTime || '07:00';
  const onTime = ev.onTimeDeadline || '08:00';
  const late = ev.lateDeadline || '09:00';

  if (nowTime < open) return 'before_open';
  if (nowTime < onTime) return 'open';         // present window
  if (nowTime < late) return 'late_window';    // late window
  return 'closed';
}

function getCheckoutStatus(ev) {
  // Returns: 'unavailable' | 'open' | 'closed'
  if (!ev.checkoutEnabled) return 'unavailable';
  const now = new Date();
  const todayStr = now.toISOString().slice(0,10);
  if (ev.date !== todayStr) return ev.date < todayStr ? 'closed' : 'unavailable';
  const nowTime = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
  const coOpen = ev.checkoutOpen || '11:00';
  const coClose = ev.checkoutClose || '13:00';
  if (nowTime < coOpen) return 'unavailable';
  if (nowTime <= coClose) return 'open';
  return 'closed';
}

function doCheckout(studentId, eventId) {
  const coKey = studentId + '_' + eventId;
  if (checkouts[coKey]) return; // already checked out
  checkouts[coKey] = { time: new Date().toISOString(), studentId, eventId };
  save();
  toast('✅ Checked out successfully!', 'success');
  renderStudentPortal && currentUser && renderStudentPortal();
  renderAll && renderAll();
}

function adminDoCheckout(studentId, eventId) {
  const coKey = studentId + '_' + eventId;
  if (checkouts[coKey]) { toast('Student already checked out.', 'info'); return; }
  checkouts[coKey] = { time: new Date().toISOString(), studentId, eventId, adminCheckout: true };
  save();
  toast('✅ Checkout recorded.', 'success');
  renderAll();
}

function checkinWindowLabel(ev) {
  const status = getCheckinStatus(ev);
  const open = ev.openTime || '07:00';
  const onTime = ev.onTimeDeadline || '08:00';
  const late = ev.lateDeadline || '09:00';
  const fmt = t => {
    const [h,m] = t.split(':');
    const hr = parseInt(h);
    return `${hr > 12 ? hr-12 : hr || 12}:${m} ${hr >= 12 ? 'PM' : 'AM'}`;
  };
  switch(status) {
    case 'future':       return { label: `Opens ${fmt(open)}`, cls: 'upcoming', icon: 'fa-clock' };
    case 'before_open':  return { label: `Opens at ${fmt(open)}`, cls: 'upcoming', icon: 'fa-clock' };
    case 'open':         return { label: `On-time until ${fmt(onTime)}`, cls: 'open', icon: 'fa-check-circle' };
    case 'late_window':  return { label: `Late until ${fmt(late)}`, cls: 'late-window', icon: 'fa-exclamation-circle' };
    case 'closed':       return { label: 'Check-in Closed', cls: 'closed', icon: 'fa-lock' };
  }
}

function fmt12(t) {
  if (!t) return '';
  const [h,m] = t.split(':');
  const hr = parseInt(h);
  return `${hr > 12 ? hr-12 : hr || 12}:${m} ${hr >= 12 ? 'PM' : 'AM'}`;
}

// ═══════════════════════════════
// UPCOMING EVENTS (auth panel)
// ═══════════════════════════════
function renderAuthUpcomingEvents() {
  const el = document.getElementById('authUpcomingEvents');
  if (!el) return;
  const today = new Date().toISOString().slice(0,10);
  const upcoming = events
    .filter(ev => ev.date >= today)
    .sort((a,b) => a.date.localeCompare(b.date))
    .slice(0, 6);

  if (upcoming.length === 0) {
    el.innerHTML = `<div style="color:rgba(255,255,255,0.25); font-size:13px; text-align:center; padding:12px 0;">No upcoming events</div>`;
    return;
  }

  const colors = ['#34d399','#60a5fa','#f472b6','#a78bfa','#fb923c','#facc15'];
  el.innerHTML = upcoming.map((ev, i) => {
    const win = checkinWindowLabel(ev);
    const open = ev.openTime || '07:00';
    const late = ev.lateDeadline || '09:00';
    return `
    <div class="upcoming-event-item">
      <div class="upcoming-dot" style="background:${colors[i%colors.length]};"></div>
      <div style="flex:1; min-width:0;">
        <div class="upcoming-event-name">${ev.name}</div>
        <div class="upcoming-event-time">${fmt12(open)} – ${fmt12(late)}</div>
      </div>
      <div style="display:flex; flex-direction:column; align-items:flex-end; gap:3px;">
        <div class="upcoming-event-date">${formatDate(ev.date)}</div>
        <span class="tw-pill ${win.cls}"><i class="fas ${win.icon}"></i> ${win.label}</span>
      </div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════
// AUTH TABS
// ═══════════════════════════════
function switchTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((t,i) => {
    t.classList.toggle('active', ['login','register','admin'][i] === tab);
  });
  document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
  const formEl = document.getElementById(tab + 'Form');
  if (formEl) formEl.classList.add('active');
  ['loginError','regError','adminError','resetError'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.style.display = 'none';
  });
  const resetOk = document.getElementById('resetSuccess');
  if (resetOk) resetOk.style.display = 'none';
}

// Init auth screen UI
startClock();
renderAuthCalendar();
renderAuthUpcomingEvents();
// Refresh upcoming events every minute
setInterval(renderAuthUpcomingEvents, 60000);
// Clear login fields to prevent browser autofill leaking admin credentials
window.addEventListener('load', () => {
  const loginId = document.getElementById('loginId');
  if (loginId) loginId.value = '';
  const loginName = document.getElementById('loginName');
  if (loginName) loginName.value = '';
});

function showError(id, msg) {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.style.display = 'block';
}

// ═══════════════════════════════
// AUTH ACTIONS
// ═══════════════════════════════
function doStudentLogin() {
  const name = document.getElementById('loginName').value.trim();
  const id = document.getElementById('loginId').value.trim();
  const student = students.find(s => s.name.toLowerCase() === name.toLowerCase() && s.studentId === id);
  if (!student) { showError('loginError', 'No student found with these credentials.'); return; }
  currentUser = student;
  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('studentApp').style.display = 'block';

  // Check if admin scanned this student's barcode while they were logged out
  const pendingKey = 'ap_pending_selfie_' + student.studentId;
  const pendingEvId = localStorage.getItem(pendingKey);
  if (pendingEvId) {
    pendingSelfieEventId = pendingEvId;
  }

  renderStudentPortal();
  startStudentCountdown();
}

function doRegister() {
  const name = document.getElementById('regName').value.trim();
  const id = document.getElementById('regId').value.trim();
  const dept = document.getElementById('regDept').value;
  if (!name) { showError('regError', 'Please enter your full name.'); return; }
  if (!id) { showError('regError', 'Please enter a Student ID.'); return; }
  if (!dept) { showError('regError', 'Please select your department.'); return; }
  if (students.find(s => s.studentId === id)) { showError('regError', 'A student with this ID already exists.'); return; }
  students.push({
    id: 'stu_' + Date.now(), name, studentId: id, department: dept,
    email: '', contact: '', yearLevel: '', course: '',
    createdAt: new Date().toISOString()
  });
  save();
  toast('Registration successful! You can now sign in.');
  switchTab('login');
  document.getElementById('loginName').value = name;
  document.getElementById('loginId').value = id;
}

async function doAdminLogin() {
  const userInput = document.getElementById('adminUser').value.trim();
  const passInput = document.getElementById('adminPass').value;
  if (!userInput) { showError('adminError', 'Please enter your username.'); return; }
  if (!passInput) { showError('adminError', 'Please enter your password.'); return; }

  const creds = getAdminCreds();
  const inputHash = await sha256(passInput);

  if (userInput !== creds.username || inputHash !== creds.passHash) {
    showError('adminError', 'Incorrect username or password.');
    return;
  }

  document.getElementById('authScreen').style.display = 'none';
  document.getElementById('adminApp').classList.add('active');
  document.getElementById('todayDate').textContent = new Date().toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  // Show admin username in sidebar chip
  const initials = creds.username.slice(0,2).toUpperCase();
  const nameChip = document.getElementById('adminNameChip');
  const avatarChip = document.getElementById('adminAvatarChip');
  if (nameChip) nameChip.textContent = creds.username;
  if (avatarChip) avatarChip.textContent = initials;

  // Pre-fill settings username
  const settingsUser = document.getElementById('settingsUsername');
  if (settingsUser) settingsUser.value = creds.username;

  renderAll();
}

function showResetForm() {
  document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
  document.getElementById('adminResetForm').classList.add('active');
}

function togglePwVis(fieldId, btn) {
  const el = document.getElementById(fieldId);
  if (!el) return;
  if (el.type === 'password') {
    el.type = 'text';
    btn.innerHTML = '<i class="fas fa-eye-slash"></i>';
  } else {
    el.type = 'password';
    btn.innerHTML = '<i class="fas fa-eye"></i>';
  }
}

function checkPwStrength(pw) {
  const reqs = [
    { id: 'req-len',   ok: pw.length >= 8 },
    { id: 'req-upper', ok: /[A-Z]/.test(pw) },
    { id: 'req-lower', ok: /[a-z]/.test(pw) },
    { id: 'req-num',   ok: /[0-9]/.test(pw) },
    { id: 'req-sym',   ok: /[^A-Za-z0-9]/.test(pw) },
  ];
  let score = reqs.filter(r => r.ok).length;
  reqs.forEach(r => {
    const el = document.getElementById(r.id);
    if (el) { el.className = 'pw-req-item ' + (r.ok ? 'ok' : 'fail'); }
  });
  const fill = document.getElementById('pwStrengthFill');
  const label = document.getElementById('pwStrengthLabel');
  if (!fill || !label) return score;
  const levels = [
    { w:'0%', c:'#ef4444', t:'' },
    { w:'20%', c:'#ef4444', t:'Very Weak' },
    { w:'40%', c:'#f59e0b', t:'Weak' },
    { w:'60%', c:'#eab308', t:'Fair' },
    { w:'80%', c:'#22c55e', t:'Strong' },
    { w:'100%', c:'#10b981', t:'Very Strong' }
  ];
  const lv = levels[score];
  fill.style.width = lv.w; fill.style.background = lv.c;
  label.textContent = lv.t; label.style.color = lv.c;
  return score;
}

function checkPwStrengthInner(pw) {
  const fill = document.getElementById('pwStrengthFillInner');
  const label = document.getElementById('pwStrengthLabelInner');
  if (!fill || !label) return;
  const reqs = [pw.length>=8, /[A-Z]/.test(pw), /[a-z]/.test(pw), /[0-9]/.test(pw), /[^A-Za-z0-9]/.test(pw)];
  const score = reqs.filter(Boolean).length;
  const levels = [
    { w:'0%', c:'#e2e8f0', t:'' },
    { w:'20%', c:'#ef4444', t:'Very Weak' },
    { w:'40%', c:'#f59e0b', t:'Weak' },
    { w:'60%', c:'#eab308', t:'Fair' },
    { w:'80%', c:'#22c55e', t:'Strong' },
    { w:'100%', c:'#10b981', t:'Very Strong' }
  ];
  const lv = levels[score];
  fill.style.width = lv.w; fill.style.background = lv.c;
  label.textContent = lv.t; label.style.color = lv.c;
}

function pwMeetsPolicy(pw) {
  return pw.length >= 8 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw);
}

async function doResetPassword() {
  const cur = document.getElementById('resetCurrentPass').value;
  const nw  = document.getElementById('resetNewPass').value;
  const cf  = document.getElementById('resetConfirmPass').value;
  const errEl = document.getElementById('resetError');
  const okEl  = document.getElementById('resetSuccess');
  errEl.style.display='none'; okEl.style.display='none';

  const creds = getAdminCreds();
  const curHash = await sha256(cur);
  if (curHash !== creds.passHash) { errEl.textContent='Current password is incorrect.'; errEl.style.display='block'; return; }
  if (!pwMeetsPolicy(nw)) { errEl.textContent='New password does not meet the security policy requirements.'; errEl.style.display='block'; return; }
  if (nw !== cf) { errEl.textContent='Passwords do not match.'; errEl.style.display='block'; return; }

  creds.passHash = await sha256(nw);
  saveAdminCreds(creds);
  okEl.textContent = 'Password updated successfully! Please log in again.';
  okEl.style.display = 'block';
  document.getElementById('resetCurrentPass').value='';
  document.getElementById('resetNewPass').value='';
  document.getElementById('resetConfirmPass').value='';
  setTimeout(() => switchTab('admin'), 2200);
}

// Settings page save functions
async function saveAdminUsername() {
  const newUser = document.getElementById('settingsUsername').value.trim();
  if (!newUser || newUser.length < 3) { toast('Username must be at least 3 characters.', 'error'); return; }
  const creds = getAdminCreds();
  creds.username = newUser;
  saveAdminCreds(creds);
  const nameChip = document.getElementById('adminNameChip');
  const avatarChip = document.getElementById('adminAvatarChip');
  if (nameChip) nameChip.textContent = newUser;
  if (avatarChip) avatarChip.textContent = newUser.slice(0,2).toUpperCase();
  toast('Username updated successfully!');
}

async function saveAdminPassword() {
  const cur = document.getElementById('settingsCurPass').value;
  const nw  = document.getElementById('settingsNewPass').value;
  const cf  = document.getElementById('settingsConfPass').value;
  const creds = getAdminCreds();
  const curHash = await sha256(cur);
  if (curHash !== creds.passHash) { toast('Current password is incorrect.', 'error'); return; }
  if (!pwMeetsPolicy(nw)) { toast('Password does not meet security policy requirements.', 'error'); return; }
  if (nw !== cf) { toast('New passwords do not match.', 'error'); return; }
  creds.passHash = await sha256(nw);
  saveAdminCreds(creds);
  document.getElementById('settingsCurPass').value='';
  document.getElementById('settingsNewPass').value='';
  document.getElementById('settingsConfPass').value='';
  toast('Password changed successfully!');
}

function doLogout(role) {
  currentUser = null;
  // Stop any inline step2 cameras
  Object.keys(step2Streams).forEach(evId => step2StopCamera(evId));
  pendingSelfieEventId = null;
  document.getElementById('authScreen').style.display = 'flex';
  if (role === 'student') {
    document.getElementById('studentApp').style.display = 'none';
  } else {
    document.getElementById('adminApp').classList.remove('active');
    document.getElementById('adminUser').value = '';
    document.getElementById('adminPass').value = '';
  }
}

// ═══════════════════════════════
// STUDENT PORTAL
// ═══════════════════════════════
function renderStudentPortal() {
  document.getElementById('sPortalName').textContent = currentUser.name;
  document.getElementById('sPortalId').textContent = currentUser.studentId;
  document.getElementById('sPortalDept').textContent = currentUser.department;

  // Restore pendingSelfieEventId from localStorage in case student re-opened the page
  if (!pendingSelfieEventId) {
    const pendingKey = 'ap_pending_selfie_' + currentUser.studentId;
    const saved = localStorage.getItem(pendingKey);
    if (saved) pendingSelfieEventId = saved;
  }

  const myRecs = records.filter(r => r.studentId === currentUser.studentId);
  const present = myRecs.filter(r => r.status === 'present').length;
  const late = myRecs.filter(r => r.status === 'late').length;
  const absent = myRecs.filter(r => r.status === 'absent').length;
  const total = events.length;
  const rate = total > 0 ? Math.round((present + late) / total * 100) : 0;

  document.getElementById('sPresentCnt').textContent = present;
  document.getElementById('sLateCnt').textContent = late;
  document.getElementById('sAbsentCnt').textContent = absent;
  document.getElementById('ringPct').textContent = rate + '%';
  document.getElementById('sAttRate').textContent = `${present + late} of ${total} events attended`;

  const circumference = 2 * Math.PI * 38;
  const offset = circumference * (1 - rate / 100);
  const circle = document.getElementById('ringCircle');
  circle.style.strokeDashoffset = offset;
  circle.style.stroke = rate >= 75 ? '#059669' : rate >= 50 ? '#d97706' : '#dc2626';

  // Calculate fines for this student — only show badge for events that have fully closed
  let totalFine = 0, totalPaid = 0;
  events.forEach(ev => {
    const evStatus = getCheckinStatus(ev);
    // Only count fines for events that are fully closed (not ongoing or future)
    if (evStatus !== 'closed') return;
    const rec = myRecs.find(r => r.eventId === ev.id);
    const isAbsent = !rec || rec.status === 'absent';
    if (isAbsent && (ev.fineAmount || 0) > 0) {
      const fKey = currentUser.studentId + '_' + ev.id;
      const fRec = fines[fKey];
      const fStatus = fRec ? fRec.status : 'unpaid';
      if (fStatus !== 'waived') {
        totalFine += ev.fineAmount;
        if (fStatus === 'paid') totalPaid += ev.fineAmount;
      }
    }
    // Also count late fines
    const isLate = rec && rec.status === 'late';
    if (isLate && (ev.lateFineAmount || 0) > 0) {
      const lateFKey = currentUser.studentId + '_' + ev.id + '_late';
      const lateFRec = fines[lateFKey];
      const lateFStatus = lateFRec ? lateFRec.status : 'unpaid';
      if (lateFStatus !== 'waived') {
        totalFine += ev.lateFineAmount;
        if (lateFStatus === 'paid') totalPaid += ev.lateFineAmount;
      }
    }
  });
  const totalUnpaid = totalFine - totalPaid;
  const finesBadge = document.getElementById('sPortalFinesBadge');
  if (finesBadge) {
    if (totalUnpaid > 0) {
      finesBadge.style.display = 'block';
      finesBadge.innerHTML = `<i class="fas fa-peso-sign"></i> ₱${totalUnpaid} unpaid`;
    } else {
      finesBadge.style.display = 'none';
    }
  }

  const list = document.getElementById('studentAttList');
  if (events.length === 0) {
    list.innerHTML = `<div class="empty-state"><i class="fas fa-calendar-times"></i><p>No events scheduled yet.</p></div>`;
    return;
  }

  list.innerHTML = events.map(ev => {
    const rec = myRecs.find(r => r.eventId === ev.id);
    const status = rec ? rec.status : null;
    const photoKey = currentUser.studentId + '_' + ev.id;
    const photo = photos[photoKey];
    const checkedIn = status === 'present' || status === 'late';
    const winStatus = getCheckinStatus(ev);
    const win = checkinWindowLabel(ev);
    const open = ev.openTime || '07:00';
    const onTime = ev.onTimeDeadline || '08:00';
    const lateTime = ev.lateDeadline || '09:00';
    const fine = ev.fineAmount || 0;
    const fKey = currentUser.studentId + '_' + ev.id;
    const fRec = fines[fKey];
    const fStatus = fRec ? fRec.status : 'unpaid';
    const isAbsent = status === 'absent' || (!checkedIn && winStatus === 'closed');

    // Fine display for student — only shown when event is fully closed
    let fineHtml = '';
    if (winStatus === 'closed') {
      // Absence fine
      if (fine > 0 && isAbsent) {
        const fColor = fStatus === 'paid' ? 'var(--success)' : fStatus === 'waived' ? '#166534' : 'var(--danger)';
        const fBg = fStatus === 'paid' ? 'var(--success-light)' : fStatus === 'waived' ? '#f0fdf4' : 'var(--danger-light)';
        fineHtml += `<div style="margin-top:5px; font-size:11px; display:inline-flex; align-items:center; gap:4px; background:${fBg}; color:${fColor}; padding:2px 8px; border-radius:12px; font-weight:600; font-family:var(--mono);">
          <i class="fas fa-peso-sign"></i> Absence Fine: ₱${fine} — ${fStatus === 'paid' ? 'Paid ✓' : fStatus === 'waived' ? 'Waived' : 'Unpaid'}
        </div>`;
      }
      // Late fine
      const lateFine = ev.lateFineAmount || 0;
      const status = rec ? rec.status : null;
      const checkedInLate = status === 'late';
      if (lateFine > 0 && checkedInLate) {
        const lateFKey2 = currentUser.studentId + '_' + ev.id + '_late';
        const lateFRec2 = fines[lateFKey2];
        const lateFStatus2 = lateFRec2 ? lateFRec2.status : 'unpaid';
        const fColor2 = lateFStatus2 === 'paid' ? 'var(--success)' : lateFStatus2 === 'waived' ? '#166534' : 'var(--warning)';
        const fBg2 = lateFStatus2 === 'paid' ? 'var(--success-light)' : lateFStatus2 === 'waived' ? '#f0fdf4' : 'var(--warning-light)';
        fineHtml += `<div style="margin-top:5px; font-size:11px; display:inline-flex; align-items:center; gap:4px; background:${fBg2}; color:${fColor2}; padding:2px 8px; border-radius:12px; font-weight:600; font-family:var(--mono);">
          <i class="fas fa-peso-sign"></i> Late Fine: ₱${lateFine} — ${lateFStatus2 === 'paid' ? 'Paid ✓' : lateFStatus2 === 'waived' ? 'Waived' : 'Unpaid'}
        </div>`;
      }
    }

    let actionHtml = '';
    if (status === 'absent') {
      actionHtml = `<span class="badge badge-absent badge-dot">Absent</span>`;
    } else if (checkedIn) {
      const isPendingSelfie = pendingSelfieEventId === ev.id && !photo;
      if (isPendingSelfie) {
        // Step 2: Admin just scanned this student — show the selfie prompt inline
        actionHtml = `
          <div class="step2-selfie-prompt" id="step2_${ev.id}">
            <div class="step2-header">
              <span class="badge badge-${status} badge-dot" style="margin-bottom:6px;">${cap(status)}</span>
              <div class="step2-title"><i class="fas fa-camera"></i> Step 2 — Take Your Selfie</div>
              <div class="step2-sub">Admin has checked you in. Take a selfie as backup evidence.</div>
            </div>
            <div class="step2-camera-wrap" id="step2cam_${ev.id}">
              <video id="step2vid_${ev.id}" autoplay playsinline class="step2-video"></video>
              <canvas id="step2canvas_${ev.id}" style="display:none;"></canvas>
              <div class="camera-overlay"></div>
            </div>
            <div id="step2preview_${ev.id}" class="step2-preview" style="display:none;">
              <div class="step2-preview-frame">
                <img id="step2img_${ev.id}" class="step2-preview-img" />
              </div>
              <div class="step2-preview-label"><i class="fas fa-check-circle"></i> Looks good?</div>
            </div>
            <div id="step2err_${ev.id}" class="step2-error" style="display:none;"></div>
            <div class="step2-actions">
              <button class="btn btn-ghost btn-sm" onclick="step2Skip('${ev.id}')"><i class="fas fa-forward"></i> Skip</button>
              <button class="btn btn-ghost btn-sm" id="step2retake_${ev.id}" style="display:none;" onclick="step2Retake('${ev.id}')"><i class="fas fa-redo"></i> Retake</button>
              <button class="btn btn-primary btn-sm" id="step2capture_${ev.id}" onclick="step2Capture('${ev.id}')"><i class="fas fa-camera"></i> Capture</button>
              <button class="btn btn-success btn-sm" id="step2confirm_${ev.id}" style="display:none;" onclick="step2Confirm('${ev.id}')"><i class="fas fa-check"></i> Save Selfie</button>
            </div>
          </div>`;
        // Auto-start camera after render
        setTimeout(() => step2StartCamera(ev.id), 150);
      } else {
        actionHtml = `
          <div style="display:flex; align-items:center; gap:8px; flex-direction:column; align-items:flex-end;">
            <span class="badge badge-${status} badge-dot">${cap(status)}</span>
            ${photo ? `<img class="selfie-preview" src="${photo}" title="View selfie" onclick="openLightbox('${photoKey}', '${ev.name}', '${currentUser.name}')">` : ''}
            ${(() => {
              if (!ev.checkoutEnabled) return '';
              const coKey = currentUser.studentId + '_' + ev.id;
              const co = checkouts[coKey];
              if (co) {
                const coTime = new Date(co.time).toLocaleTimeString('en-PH',{hour:'2-digit',minute:'2-digit',hour12:true});
                return `<div class="checkout-time-badge"><i class="fas fa-sign-out-alt"></i> Checked out ${coTime}</div>`;
              }
              const coStatus = getCheckoutStatus(ev);
              if (coStatus === 'open') {
                return `<button class="checkout-btn" onclick="openCheckoutModal('${ev.id}')"><i class="fas fa-sign-out-alt"></i> Check Out</button>`;
              } else if (coStatus === 'closed') {
                return `<span class="checkout-time-badge" style="color:var(--text-muted);background:var(--surface2);"><i class="fas fa-lock"></i> Checkout closed</span>`;
              } else {
                const coOpen = ev.checkoutOpen || '11:00';
                return `<span class="checkout-time-badge" style="color:var(--text-muted);background:var(--surface2);"><i class="fas fa-clock"></i> Checkout opens ${fmt12(coOpen)}</span>`;
              }
            })()}
          </div>`;
      }
    } else if (winStatus === 'future' || winStatus === 'before_open') {
      actionHtml = `
        <div style="text-align:right;">
          <span class="tw-pill upcoming"><i class="fas fa-clock"></i> Opens ${fmt12(open)}</span>
        </div>`;
    } else if (winStatus === 'open' || winStatus === 'late_window') {
      const isLate = winStatus === 'late_window';
      const btnCls = isLate ? 'late-btn' : '';
      const lbl = isLate ? 'Check In (Late)' : 'Check In';
      const timeNote = isLate ? `Closes ${fmt12(lateTime)}` : `On-time until ${fmt12(onTime)}`;
      const noteColor = isLate ? 'var(--warning)' : 'var(--success)';
      actionHtml = `
        <div class="checkin-options">
          <div class="checkin-method-btns">
            <button class="checkin-btn ${btnCls}" onclick="openSelfieModal('${ev.id}')"><i class="fas fa-camera"></i> ${lbl}</button>
          </div>
          <div style="font-size:10px; color:${noteColor}; margin-top:3px; font-family:var(--mono); text-align:right;">${timeNote}</div>
        </div>`;
    } else {
      actionHtml = `<span class="tw-pill closed"><i class="fas fa-lock"></i> Check-in Closed</span>`;
    }

    // Appeal button — show if event is closed and student is absent (and hasn't already appealed)
    const appealKey = currentUser.studentId + '_' + ev.id;
    const existingAppeal = appeals[appealKey];
    let appealHtml = '';
    if (winStatus === 'closed' && !checkedIn && status !== 'present' && status !== 'late') {
      if (!existingAppeal) {
        appealHtml = `<div style="margin-top:8px;">
          <button class="btn btn-ghost btn-sm" style="font-size:12px; color:#6366f1; border-color:#c7d2fe;" onclick="openAppealModal('${ev.id}')">
            <i class="fas fa-flag" style="color:#6366f1;"></i> File an Appeal / Excuse
          </button>
        </div>`;
      } else {
        const aColor = existingAppeal.status === 'approved' ? 'var(--success)' : existingAppeal.status === 'rejected' ? 'var(--danger)' : 'var(--warning)';
        const aBg = existingAppeal.status === 'approved' ? 'var(--success-light)' : existingAppeal.status === 'rejected' ? 'var(--danger-light)' : 'var(--warning-light)';
        const aIcon = existingAppeal.status === 'approved' ? 'fa-check-circle' : existingAppeal.status === 'rejected' ? 'fa-times-circle' : 'fa-hourglass-half';
        const aLabel = existingAppeal.status === 'approved' ? 'Appeal Approved' : existingAppeal.status === 'rejected' ? 'Appeal Rejected' : 'Appeal Pending Review';
        appealHtml = `<div style="margin-top:8px; padding:8px 12px; border-radius:var(--radius-sm); background:${aBg}; border:1px solid ${aColor}30; display:flex; align-items:flex-start; gap:8px;">
          <i class="fas ${aIcon}" style="color:${aColor}; margin-top:2px; flex-shrink:0;"></i>
          <div>
            <div style="font-size:12px; font-weight:600; color:${aColor};">${aLabel}</div>
            <div style="font-size:11px; color:var(--text-muted); margin-top:2px;">${existingAppeal.type} · Submitted ${new Date(existingAppeal.submittedAt).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</div>
            ${existingAppeal.adminNote ? `<div style="font-size:11px; color:var(--text-muted); margin-top:3px; font-style:italic;">"${existingAppeal.adminNote}"</div>` : ''}
          </div>
        </div>`;
      }
    }

    const borderColor = checkedIn ? 'var(--success)' : status === 'absent' ? 'var(--danger)' : winStatus === 'closed' ? 'var(--danger)' : winStatus === 'open' ? 'var(--accent)' : winStatus === 'late_window' ? 'var(--warning)' : 'var(--border)';

    const isPendingThisRow = pendingSelfieEventId === ev.id && checkedIn && !photo;
    return `
    <div class="attendance-row" style="border-left: 3px solid ${borderColor}; ${isPendingThisRow ? 'flex-direction:column; align-items:stretch; gap:14px;' : ''}">
      <div style="flex:1;">
        <div class="event-name">${ev.name}</div>
        <div class="event-date">${formatDate(ev.date)}</div>
        <div style="margin-top:4px; display:flex; flex-wrap:wrap; gap:5px; align-items:center;">
          <span class="tw-pill ${win.cls}"><i class="fas ${win.icon}"></i> ${win.label}</span>
          ${fine > 0 && !checkedIn && winStatus !== 'open' && winStatus !== 'late_window' && winStatus !== 'future' && winStatus !== 'before_open' ? `<span style="font-size:10px; color:var(--danger); font-family:var(--mono);"><i class="fas fa-peso-sign"></i> ₱${fine} fine if absent</span>` : ''}
        </div>
        ${fineHtml}
        ${appealHtml}
      </div>
      <div ${isPendingThisRow ? 'style="width:100%;"' : ''}>${actionHtml}</div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════
// STUDENT COUNTDOWN TIMER
// ═══════════════════════════════
let countdownInterval = null;

function startStudentCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  tickCountdown();
  countdownInterval = setInterval(tickCountdown, 1000);
}

function tickCountdown() {
  const banner = document.getElementById('countdownBanner');
  if (!banner) return;

  const now = new Date();
  const todayStr = now.toISOString().slice(0,10);
  const todayEvents = events.filter(ev => ev.date === todayStr);

  if (todayEvents.length === 0) {
    banner.style.display = 'none';
    return;
  }

  // Find the most relevant event for today
  let target = null;
  let targetLabel = '';
  let targetCls = '';
  let timeStr = '';

  for (const ev of todayEvents) {
    const winStatus = getCheckinStatus(ev);
    const open = ev.openTime || '07:00';
    const onTime = ev.onTimeDeadline || '08:00';
    const late = ev.lateDeadline || '09:00';
    const toMs = t => {
      const [h,m] = t.split(':').map(Number);
      const d = new Date(now);
      d.setHours(h,m,0,0);
      return d - now;
    };

    if (winStatus === 'before_open') {
      const diff = toMs(open);
      target = ev; targetLabel = `${ev.name} — Check-in opens in`; targetCls = 'upcoming'; timeStr = fmtCountdown(diff);
      break;
    } else if (winStatus === 'open') {
      const diff = toMs(onTime);
      target = ev; targetLabel = `${ev.name} — On-time deadline in`; targetCls = diff < 300000 ? 'urgent' : '';
      timeStr = fmtCountdown(diff);
      break;
    } else if (winStatus === 'late_window') {
      const diff = toMs(late);
      target = ev; targetLabel = `${ev.name} — Late window closes in`; targetCls = 'late';
      timeStr = fmtCountdown(diff);
      break;
    }
  }

  if (!target) {
    banner.style.display = 'none';
    return;
  }

  banner.style.display = 'flex';
  banner.innerHTML = `
    <i class="fas fa-clock" style="color:#60a5fa;"></i>
    <span style="opacity:0.7;">${targetLabel}</span>
    <span class="countdown-time ${targetCls}">${timeStr}</span>`;

  // Also refresh the student portal list every minute so status badges update
}

function fmtCountdown(ms) {
  if (ms <= 0) return '00:00';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ═══════════════════════════════
// ADMIN PAGES
// ═══════════════════════════════
function showPage(page, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const pageEl = document.getElementById('page-' + page);
  if (pageEl) pageEl.classList.add('active');
  if (btn) btn.classList.add('active');
  if (page === 'reports') {
    renderReports();
    renderDailyReport();
    renderMonthlyReport();
    renderDeptReport();
    renderPctReport();
    populateDeptReportEventSelect();
  }
  if (page === 'settings') {
    const creds = getAdminCreds();
    const settingsUser = document.getElementById('settingsUsername');
    if (settingsUser) settingsUser.value = creds.username;
  }
  renderAll();
}

function renderAll() {
  renderStats();
  renderDashboard();
  renderStudentsTable();
  renderEventsAdmin();
  renderAttendanceTable();
  populateEventSelects();
  renderReports();
  renderFinesTable();
  populateFinesEventSelect();
  renderAppealsTable();
  updateAppealsBadge();
}

// STATS
function renderStats() {
  const present = records.filter(r => r.status === 'present').length;
  const late = records.filter(r => r.status === 'late').length;
  const absent = records.filter(r => r.status === 'absent').length;

  const pendingAppealsCnt = Object.values(appeals).filter(a => a.status === 'pending').length;
  document.getElementById('statsRow').innerHTML = `
    <div class="stat-card">
      <div class="stat-icon blue"><i class="fas fa-users"></i></div>
      <div><div class="stat-label">Total Students</div><div class="stat-value">${students.length}</div></div>
    </div>
    <div class="stat-card">
      <div class="stat-icon green"><i class="fas fa-check-circle"></i></div>
      <div><div class="stat-label">Present</div><div class="stat-value">${present}</div></div>
    </div>
    <div class="stat-card">
      <div class="stat-icon orange"><i class="fas fa-clock"></i></div>
      <div><div class="stat-label">Late</div><div class="stat-value">${late}</div></div>
    </div>
    <div class="stat-card" style="cursor:${pendingAppealsCnt>0?'pointer':'default'};" onclick="${pendingAppealsCnt>0?`showPage('appeals', document.querySelector('[onclick*=appeals]'))`:''}">
      <div class="stat-icon" style="background:${pendingAppealsCnt>0?'#fef3c7':'var(--danger-light)'}; color:${pendingAppealsCnt>0?'var(--warning)':'var(--danger)'};">
        <i class="fas ${pendingAppealsCnt>0?'fa-flag':'fa-peso-sign'}"></i>
      </div>
      <div>
        <div class="stat-label">${pendingAppealsCnt>0?'Pending Appeals':'Unpaid Fines'}</div>
        <div class="stat-value" style="font-size:${pendingAppealsCnt>0?'28px':'20px'}; color:${pendingAppealsCnt>0?'var(--warning)':'inherit'};">
          ${pendingAppealsCnt>0 ? pendingAppealsCnt : '₱0'}
        </div>
        ${pendingAppealsCnt>0 ? `<div style="font-size:11px; color:var(--text-muted);">₱0 unpaid fines</div>` : ''}
      </div>
    </div>
  `;
}

// DASHBOARD
function renderDashboard() {
  const present = records.filter(r => r.status === 'present').length;
  const late = records.filter(r => r.status === 'late').length;
  const absent = records.filter(r => r.status === 'absent').length;
  const total = present + late + absent || 1;
  const circ = 2 * Math.PI * 42; // ≈ 263.9

  // Attendance rate = (present + late) / total records
  const rate = Math.round((present + late) / total * 100);

  // Donut chart — stacked stroke-dasharray offsets
  const pP = (present / total) * circ;
  const pL = (late / total) * circ;
  const pA = (absent / total) * circ;

  const dPresent = document.getElementById('donutPresent');
  const dLate = document.getElementById('donutLate');
  const dAbsent = document.getElementById('donutAbsent');
  const dPct = document.getElementById('donutCenterPct');

  if (dPresent) {
    dPresent.setAttribute('stroke-dasharray', `${pP} ${circ - pP}`);
    dPresent.setAttribute('stroke-dashoffset', '0');
    // Offset late after present
    if (dLate) {
      dLate.setAttribute('stroke-dasharray', `${pL} ${circ - pL}`);
      dLate.setAttribute('stroke-dashoffset', `${circ - pP}`);
    }
    if (dAbsent) {
      dAbsent.setAttribute('stroke-dasharray', `${pA} ${circ - pA}`);
      dAbsent.setAttribute('stroke-dashoffset', `${circ - pP - pL}`);
    }
  }
  if (dPct) dPct.textContent = rate + '%';

  // Legend
  const legend = document.getElementById('dashStatusLegend');
  if (legend) {
    legend.innerHTML = [
      { label: 'Present', count: present, color: 'var(--success)', pct: Math.round(present/total*100) },
      { label: 'Late', count: late, color: 'var(--warning)', pct: Math.round(late/total*100) },
      { label: 'Absent', count: absent, color: 'var(--danger)', pct: Math.round(absent/total*100) },
    ].map(item => `
      <div style="display:flex; align-items:center; gap:8px;">
        <div style="width:12px; height:12px; border-radius:3px; background:${item.color}; flex-shrink:0;"></div>
        <div style="flex:1;">
          <div style="font-size:12px; color:var(--text-muted); font-weight:500;">${item.label}</div>
          <div style="font-size:13px; font-weight:700; font-family:var(--mono);">${item.count} <span style="font-size:11px; font-weight:400; color:var(--text-muted);">(${item.pct}%)</span></div>
        </div>
        <div style="width:40px; height:5px; background:var(--surface2); border-radius:4px; overflow:hidden;">
          <div style="height:100%; width:${item.pct}%; background:${item.color}; border-radius:4px;"></div>
        </div>
      </div>`).join('');
  }

  // Per-event mini breakdown
  const evBreak = document.getElementById('dashEventBreakdown');
  if (evBreak) {
    if (events.length === 0) {
      evBreak.innerHTML = '';
    } else {
      evBreak.innerHTML = `<div style="font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-muted); margin-bottom:10px;">Per Event</div>` +
        events.slice(-5).map(ev => {
          const evPresent = records.filter(r => r.eventId === ev.id && r.status === 'present').length;
          const evLate = records.filter(r => r.eventId === ev.id && r.status === 'late').length;
          const evAbsent = students.length - evPresent - evLate;
          const evTotal = students.length || 1;
          const evRate = Math.round((evPresent + evLate) / evTotal * 100);
          const pendingForEv = Object.values(appeals).filter(a => a.eventId === ev.id && a.status === 'pending').length;
          return `
          <div style="margin-bottom:10px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
              <span style="font-size:12px; font-weight:500; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:160px;" title="${ev.name}">${ev.name}</span>
              <div style="display:flex; gap:6px; align-items:center; flex-shrink:0;">
                ${pendingForEv > 0 ? `<span style="font-size:10px; background:var(--warning-light); color:var(--warning); padding:1px 6px; border-radius:10px; font-weight:600;"><i class="fas fa-flag"></i> ${pendingForEv}</span>` : ''}
                <span style="font-size:11px; font-family:var(--mono); color:var(--text-muted);">${evRate}%</span>
              </div>
            </div>
            <div style="height:6px; background:var(--surface2); border-radius:4px; overflow:hidden; display:flex; gap:1px;">
              <div style="height:100%; width:${evPresent/evTotal*100}%; background:var(--success); border-radius:4px 0 0 4px;"></div>
              <div style="height:100%; width:${evLate/evTotal*100}%; background:var(--warning);"></div>
              <div style="height:100%; width:${Math.max(0,evAbsent)/evTotal*100}%; background:var(--danger); border-radius:0 4px 4px 0;"></div>
            </div>
          </div>`;
        }).join('');
    }
  }

  // Appeals alert
  const pendingAppeals = Object.values(appeals).filter(a => a.status === 'pending').length;
  const alertEl = document.getElementById('dashAppealsAlert');
  const alertText = document.getElementById('dashAppealsAlertText');
  if (alertEl) {
    if (pendingAppeals > 0) {
      alertEl.style.display = 'flex';
      alertText.textContent = `${pendingAppeals} pending appeal${pendingAppeals > 1 ? 's' : ''} awaiting review`;
    } else {
      alertEl.style.display = 'none';
    }
  }

  // Department distribution
  const depts = ['CCS','EDUC','BEED','CAREGIVING','HMTM'];
  const deptCounts = depts.map(d => ({ dept: d, count: students.filter(s => s.department === d).length }));
  const maxC = Math.max(...deptCounts.map(d => d.count), 1);
  document.getElementById('deptBreakdown').innerHTML = deptCounts.map(d => `
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;">
      <span class="dept-badge" style="width:80px; text-align:center;">${d.dept}</span>
      <div style="flex:1; background:var(--surface2); border-radius:4px; height:8px; overflow:hidden;">
        <div style="height:100%; width:${d.count/maxC*100}%; background:var(--accent); border-radius:4px; transition:width 0.4s;"></div>
      </div>
      <span style="font-size:12px; font-family:var(--mono); color:var(--text-muted); min-width:20px;">${d.count}</span>
    </div>
  `).join('');

  const recent = records.slice(-5).reverse();
  if (recent.length === 0) {
    document.getElementById('recentActivity').innerHTML = `<div class="empty-state" style="padding:24px 0;"><i class="fas fa-clipboard" style="font-size:24px;"></i><p>No activity yet.</p></div>`;
    return;
  }
  document.getElementById('recentActivity').innerHTML = recent.map(r => {
    const stu = students.find(s => s.studentId === r.studentId);
    const ev = events.find(e => e.id === r.eventId);
    return `
    <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--border);">
      <div style="display:flex; align-items:center; gap:12px;">
        <div class="user-avatar" style="width:34px;height:34px;font-size:11px;">${stu ? initials(stu.name) : '?'}</div>
        <div>
          <div style="font-size:14px; font-weight:500;">${stu ? stu.name : 'Unknown'}</div>
          <div style="font-size:12px; color:var(--text-muted);">${ev ? ev.name : 'Unknown Event'}</div>
        </div>
      </div>
      <span class="badge badge-${r.status} badge-dot">${cap(r.status)}</span>
    </div>`;
  }).join('');
}

// STUDENTS TABLE
function renderStudentsTable() {
  const q = (document.getElementById('studentSearch')?.value || '').toLowerCase();
  const dept = document.getElementById('deptFilterStudents')?.value || 'all';

  let filtered = students.filter(s => {
    const matchQ = !q || s.name.toLowerCase().includes(q) || s.studentId.toLowerCase().includes(q);
    const matchD = dept === 'all' || s.department === dept;
    return matchQ && matchD;
  });

  const total = filtered.length;
  const pages = Math.ceil(total / PAGE_SIZE) || 1;
  if (studentsPage > pages) studentsPage = 1;
  const slice = filtered.slice((studentsPage - 1) * PAGE_SIZE, studentsPage * PAGE_SIZE);

  const tbody = document.getElementById('studentsTableBody');
  if (!tbody) return;

  if (slice.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><i class="fas fa-user-slash"></i><p>No students found.</p></div></td></tr>`;
  } else {
    tbody.innerHTML = slice.map(s => {
      const myRecs = records.filter(r => r.studentId === s.studentId);
      const rate = events.length > 0 ? Math.round(myRecs.filter(r => r.status !== 'absent').length / events.length * 100) : 0;
      return `
      <tr>
        <td>
          <div style="display:flex; align-items:center; gap:10px;">
            <div class="user-avatar" style="width:32px;height:32px;font-size:11px;">${initials(s.name)}</div>
            <span style="font-weight:500;">${s.name}</span>
          </div>
        </td>
        <td><span style="font-family:var(--mono); font-size:13px;">${s.studentId}</span></td>
        <td><span class="dept-badge">${s.department}</span></td>
        <td>
          <div style="display:flex; align-items:center; gap:8px;">
            <div style="flex:1; min-width:60px; background:var(--surface2); border-radius:4px; height:6px;">
              <div style="height:100%; width:${rate}%; background:${rate>=75?'var(--success)':rate>=50?'var(--warning)':'var(--danger)'}; border-radius:4px;"></div>
            </div>
            <span style="font-size:12px; font-family:var(--mono);">${rate}%</span>
          </div>
        </td>
        <td>
          <div style="display:flex; gap:6px;">
            <button class="btn btn-ghost btn-sm btn-icon" title="View Profile" onclick="openAdminStudentProfile('${s.studentId}')">
              <i class="fas fa-user-circle"></i>
            </button>
            <button class="btn btn-ghost btn-sm btn-icon" title="View QR Code" onclick="openViewBarcodeModal('${s.studentId}')">
              <i class="fas fa-qrcode"></i>
            </button>
            <button class="btn btn-ghost btn-sm btn-icon" title="Edit" onclick="openEditStudentModal('${s.studentId}')">
              <i class="fas fa-edit"></i>
            </button>
            <button class="btn btn-ghost btn-sm btn-icon" title="Mark Attendance" onclick="openStatusModal('${s.studentId}')">
              <i class="fas fa-clipboard-check"></i>
            </button>
            <button class="btn btn-ghost btn-sm btn-icon" title="Delete" style="color:var(--danger);" onclick="confirmDeleteStudent('${s.studentId}')">
              <i class="fas fa-trash"></i>
            </button>
          </div>
        </td>
      </tr>`;
    }).join('');
  }

  // Pagination
  const pg = document.getElementById('studentsPagination');
  if (!pg) return;
  if (pages <= 1) { pg.innerHTML = ''; return; }
  pg.innerHTML = Array.from({length: pages}, (_, i) => i + 1).map(p =>
    `<button class="page-btn ${p === studentsPage ? 'active' : ''}" onclick="studentsPage=${p}; renderStudentsTable();">${p}</button>`
  ).join('');
}

// EVENTS ADMIN
function renderEventsAdmin() {
  const el = document.getElementById('eventsListAdmin');
  if (!el) return;
  if (events.length === 0) {
    el.innerHTML = `<div class="empty-state"><i class="fas fa-calendar-times"></i><p>No events yet. Add your first event!</p></div>`;
    return;
  }
  el.innerHTML = events.map(ev => {
    const attCount = records.filter(r => r.eventId === ev.id).length;
    const absentCount = students.filter(s => {
      const rec = records.find(r => r.studentId === s.studentId && r.eventId === ev.id);
      return !rec || rec.status === 'absent';
    }).length;
    const open = ev.openTime || '07:00';
    const onTime = ev.onTimeDeadline || '08:00';
    const late = ev.lateDeadline || '09:00';
    const win = checkinWindowLabel(ev);
    const fine = ev.fineAmount || 0;
    return `
    <div class="event-card">
      <div style="flex:1;">
        <div class="event-card-name"><i class="fas fa-calendar-day" style="color:var(--accent); margin-right:8px;"></i>${ev.name}</div>
        <div class="event-card-date">${formatDate(ev.date)} · ${attCount} records</div>
        <div style="margin-top:6px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <span style="font-size:12px; color:var(--text-muted);"><i class="fas fa-door-open" style="color:var(--success);"></i> Opens ${fmt12(open)}</span>
          <span style="font-size:12px; color:var(--text-muted);"><i class="fas fa-check" style="color:var(--accent);"></i> On-time until ${fmt12(onTime)}</span>
          <span style="font-size:12px; color:var(--text-muted);"><i class="fas fa-clock" style="color:var(--warning);"></i> Late until ${fmt12(late)}</span>
          ${fine > 0 ? `<span class="event-fine-info"><i class="fas fa-peso-sign"></i> ₱${fine} absence fine${absentCount > 0 ? ' · ' + absentCount + ' absent' : ''}</span>` : ''}
          ${ev.checkoutEnabled ? `<span style="font-size:11px; color:#0369a1; background:#e0f2fe; padding:2px 8px; border-radius:12px; font-weight:600;"><i class="fas fa-sign-out-alt"></i> Checkout ${fmt12(ev.checkoutOpen||'11:00')}–${fmt12(ev.checkoutClose||'13:00')}</span>` : ''}
          <span class="tw-pill ${win.cls}"><i class="fas ${win.icon}"></i> ${win.label}</span>
        </div>
      </div>
      <div class="event-actions">
        <button class="btn btn-ghost btn-sm" onclick="openEditEventModal('${ev.id}')">
          <i class="fas fa-edit"></i> Edit
        </button>
        <button class="btn btn-ghost btn-sm" style="color:var(--danger);" onclick="confirmDeleteEvent('${ev.id}')">
          <i class="fas fa-trash"></i>
        </button>
      </div>
    </div>`;
  }).join('');
}

// ATTENDANCE TABLE
function renderAttendanceTable() {
  const tbody = document.getElementById('attendanceTableBody');
  if (!tbody) return;
  const eventFilter = document.getElementById('attEventFilter')?.value || 'all';
  const statusFilter = document.getElementById('attStatusFilter')?.value || 'all';
  const deptFilter = document.getElementById('attDeptFilter')?.value || 'all';
  const q = (document.getElementById('attSearch')?.value || '').toLowerCase();

  // Update summary bar
  renderAttSummaryBar(eventFilter);

  // When "All Events" is selected, build one row per (student × event) combination
  let rows = [];
  if (eventFilter === 'all') {
    // For "All Events": show each student's record per event
    events.forEach(ev => {
      students.forEach(s => {
        const matchDept = deptFilter === 'all' || s.department === deptFilter;
        const matchQ = !q || s.name.toLowerCase().includes(q) || s.studentId.toLowerCase().includes(q);
        if (!matchDept || !matchQ) return;
        const rec = records.find(r => r.studentId === s.studentId && r.eventId === ev.id);
        const status = rec ? rec.status : 'absent';
        if (statusFilter !== 'all' && status !== statusFilter) return;
        rows.push({ s, ev, rec, status, eventId: ev.id });
      });
    });
  } else {
    // Specific event: show ALL students (even those with no record)
    const ev = events.find(e => e.id === eventFilter);
    students.forEach(s => {
      const matchDept = deptFilter === 'all' || s.department === deptFilter;
      const matchQ = !q || s.name.toLowerCase().includes(q) || s.studentId.toLowerCase().includes(q);
      if (!matchDept || !matchQ) return;
      const rec = records.find(r => r.studentId === s.studentId && r.eventId === eventFilter);
      const status = rec ? rec.status : 'absent';
      if (statusFilter !== 'all' && status !== statusFilter) return;
      rows.push({ s, ev, rec, status, eventId: eventFilter });
    });
  }

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state"><i class="fas fa-search"></i><p>No records match your filters.</p></div></td></tr>`;
    return;
  }

  // Show/hide Event column header based on mode
  const evColHeader = document.getElementById('attEvColHeader');
  if (evColHeader) evColHeader.style.display = eventFilter === 'all' ? '' : '';

  tbody.innerHTML = rows.map(({ s, ev, rec, status, eventId }) => {
    const photoKey = s.studentId + '_' + eventId;
    const photo = photos[photoKey];
    const recTime = rec?.createdAt ? new Date(rec.createdAt).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}) : '';
    const appeal = appeals[s.studentId + '_' + eventId];
    const appealBadge = appeal
      ? `<span style="font-size:10px; padding:2px 7px; border-radius:10px; font-weight:600; display:inline-flex; align-items:center; gap:4px;
          background:${appeal.status==='approved'?'var(--success-light)':appeal.status==='rejected'?'var(--danger-light)':'var(--warning-light)'};
          color:${appeal.status==='approved'?'var(--success)':appeal.status==='rejected'?'var(--danger)':'var(--warning)'};">
          <i class="fas ${appeal.status==='approved'?'fa-check-circle':appeal.status==='rejected'?'fa-times-circle':'fa-hourglass-half'}"></i>
          Appeal: ${cap(appeal.status)}</span>`
      : '';
    return `
    <tr>
      <td>
        <div style="display:flex; align-items:center; gap:10px;">
          <div class="user-avatar" style="width:30px;height:30px;font-size:11px;">${initials(s.name)}</div>
          <div>
            <div style="font-weight:500;">${s.name}</div>
            ${rec?.selfCheckin ? `<div style="font-size:11px; color:var(--success);"><i class="fas fa-mobile-alt"></i> Self check-in${recTime ? ' · ' + recTime : ''}</div>` : ''}
            ${rec?.barcodeCheckin ? `<div style="font-size:11px; color:var(--accent);"><i class="fas fa-barcode"></i> Barcode scan${recTime ? ' · ' + recTime : ''}</div>` : ''}
            ${appealBadge}
          </div>
        </div>
      </td>
      <td><span style="font-family:var(--mono); font-size:13px;">${s.studentId}</span></td>
      <td><span class="dept-badge">${s.department}</span></td>
      ${eventFilter === 'all' ? `<td><div style="font-size:13px; font-weight:500;">${ev ? ev.name : '—'}</div><div style="font-size:11px; color:var(--text-muted); font-family:var(--mono);">${ev ? formatDate(ev.date) : ''}</div></td>` : ''}
      <td><span class="badge badge-${status} badge-dot">${cap(status)}</span></td>
      <td>
        ${photo
          ? `<img class="photo-thumb" src="${photo}" title="View selfie" onclick="openLightbox('${photoKey}', '${(ev?.name||'Event').replace(/'/g,"\\'")}', '${s.name.replace(/'/g,"\\'")}'")`
          : `<span style="font-size:12px; color:var(--text-muted);">—</span>`}
      </td>
      <td>
        ${(() => {
          if (!ev || !ev.checkoutEnabled) return '<span style="font-size:11px; color:var(--text-muted);">—</span>';
          const coKey = s.studentId + '_' + ev.id;
          const co = checkouts[coKey];
          if (co) {
            const coTime = new Date(co.time).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
            return `<div style="display:flex;flex-direction:column;gap:2px;">
              <span style="font-size:11px;font-family:var(--mono);font-weight:600;color:var(--danger);background:var(--danger-light);padding:2px 8px;border-radius:12px;display:inline-flex;align-items:center;gap:4px;"><i class="fas fa-sign-out-alt"></i> ${coTime}${co.adminCheckout?' (Admin)':''}</span>
            </div>`;
          }
          if (status === 'present' || status === 'late') {
            return `<button class="btn btn-ghost btn-sm" style="font-size:11px;color:var(--text-muted);border-color:var(--border);" onclick="adminDoCheckout('${s.studentId}','${ev.id}')"><i class="fas fa-sign-out-alt"></i> Check Out</button>`;
          }
          return '<span style="font-size:11px; color:var(--text-muted);">—</span>';
        })()}
      </td>
      <td>
        <div style="display:flex; gap:5px; flex-wrap:wrap; align-items:center;">
          <button class="btn btn-ghost btn-sm" onclick="openStatusModal('${s.studentId}')">
            <i class="fas fa-edit"></i> Update
          </button>
          ${appeal ? `<button class="btn btn-ghost btn-sm" style="color:var(--warning);" onclick="openAppealReviewModal('${s.studentId}','${eventId}')">
            <i class="fas fa-file-alt"></i> Review Appeal
          </button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

function renderAttSummaryBar(eventFilter) {
  const el = document.getElementById('attSummaryBar');
  if (!el) return;
  let present = 0, late = 0, absent = 0, total = 0;
  if (eventFilter === 'all') {
    present = records.filter(r => r.status === 'present').length;
    late = records.filter(r => r.status === 'late').length;
    absent = records.filter(r => r.status === 'absent').length;
    total = students.length * events.length;
    absent += Math.max(0, total - present - late - absent);
  } else {
    students.forEach(s => {
      const rec = records.find(r => r.studentId === s.studentId && r.eventId === eventFilter);
      if (!rec || rec.status === 'absent') absent++;
      else if (rec.status === 'present') present++;
      else if (rec.status === 'late') late++;
    });
    total = students.length;
  }
  const pendingAppeals = Object.values(appeals).filter(a => {
    if (eventFilter === 'all') return a.status === 'pending';
    return a.eventId === eventFilter && a.status === 'pending';
  }).length;
  el.innerHTML = `
    <div style="display:flex; gap:16px; align-items:center; flex-wrap:wrap; font-size:13px;">
      <span style="color:var(--success); font-weight:600;"><i class="fas fa-check-circle"></i> ${present} Present</span>
      <span style="color:var(--warning); font-weight:600;"><i class="fas fa-clock"></i> ${late} Late</span>
      <span style="color:var(--danger); font-weight:600;"><i class="fas fa-times-circle"></i> ${absent} Absent</span>
      <span style="color:var(--text-muted);">/ ${total} total</span>
      ${pendingAppeals > 0 ? `<span style="background:var(--warning-light); color:var(--warning); padding:3px 10px; border-radius:20px; font-weight:600; font-size:12px;"><i class="fas fa-flag"></i> ${pendingAppeals} Pending Appeal${pendingAppeals>1?'s':''}</span>` : ''}
    </div>`;
}

// POPULATE EVENT SELECTS
function populateEventSelects() {
  ['attEventFilter','reportEventSelect','statusEventSelect'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const current = el.value;
    const isStatus = id === 'statusEventSelect';
    el.innerHTML = (isStatus ? '' : '<option value="all">All Events</option>') +
      events.map(ev => `<option value="${ev.id}">${ev.name}</option>`).join('');
    if (current && [...el.options].find(o => o.value === current)) el.value = current;
  });
}

// REPORTS
function renderReports() {
  const el = document.getElementById('reportQuickStats');
  if (!el) return;
  const total = records.length;
  const present = records.filter(r => r.status === 'present').length;
  const rate = total > 0 ? Math.round(present / total * 100) : 0;
  el.innerHTML = `
    <div style="display:grid; gap:12px;">
      <div style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--border);">
        <span style="color:var(--text-muted);">Total Records</span>
        <strong style="font-family:var(--mono);">${total}</strong>
      </div>
      <div style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--border);">
        <span style="color:var(--text-muted);">Attendance Rate</span>
        <strong style="font-family:var(--mono); color:var(--success);">${rate}%</strong>
      </div>
      <div style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid var(--border);">
        <span style="color:var(--text-muted);">Total Students</span>
        <strong style="font-family:var(--mono);">${students.length}</strong>
      </div>
      <div style="display:flex; justify-content:space-between; padding:10px 0;">
        <span style="color:var(--text-muted);">Total Events</span>
        <strong style="font-family:var(--mono);">${events.length}</strong>
      </div>
    </div>
  `;
}

// ═══════════════════════════════
// MODAL HELPERS
// ═══════════════════════════════
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

function openModal(id) {
  document.getElementById(id).classList.add('open');
}

// STUDENT MODAL
function openAddStudentModal() {
  editingStudentId = null;
  document.getElementById('studentModalTitle').textContent = 'Add Student';
  document.getElementById('modalStudentName').value = '';
  document.getElementById('modalStudentId').value = '';
  document.getElementById('modalStudentDept').value = 'CCS';
  document.getElementById('modalStudentEmail').value = '';
  document.getElementById('modalStudentContact').value = '';
  document.getElementById('modalStudentYear').value = '';
  document.getElementById('modalStudentCourse').value = '';
  document.getElementById('modalStudentId').disabled = false;
  openModal('studentModal');
}

function openEditStudentModal(studentId) {
  const s = students.find(x => x.studentId === studentId);
  if (!s) return;
  editingStudentId = studentId;
  document.getElementById('studentModalTitle').textContent = 'Edit Student';
  document.getElementById('modalStudentName').value = s.name;
  document.getElementById('modalStudentId').value = s.studentId;
  document.getElementById('modalStudentDept').value = s.department;
  document.getElementById('modalStudentEmail').value = s.email || '';
  document.getElementById('modalStudentContact').value = s.contact || '';
  document.getElementById('modalStudentYear').value = s.yearLevel || '';
  document.getElementById('modalStudentCourse').value = s.course || '';
  document.getElementById('modalStudentId').disabled = true;
  openModal('studentModal');
}

function saveStudent() {
  const name    = document.getElementById('modalStudentName').value.trim();
  const sid     = document.getElementById('modalStudentId').value.trim();
  const dept    = document.getElementById('modalStudentDept').value;
  const email   = document.getElementById('modalStudentEmail').value.trim();
  const contact = document.getElementById('modalStudentContact').value.trim();
  const year    = document.getElementById('modalStudentYear').value;
  const course  = document.getElementById('modalStudentCourse').value.trim();
  if (!name || !sid) { toast('Name and Student ID are required.', 'error'); return; }

  if (editingStudentId) {
    const s = students.find(x => x.studentId === editingStudentId);
    if (s) { s.name = name; s.department = dept; s.email = email; s.contact = contact; s.yearLevel = year; s.course = course; }
    toast('Student profile updated.');
  } else {
    if (students.find(s => s.studentId === sid)) { toast('A student with this ID already exists.', 'error'); return; }
    students.push({ id: 'stu_' + Date.now(), name, studentId: sid, department: dept, email, contact, yearLevel: year, course, createdAt: new Date().toISOString() });
    toast('Student added successfully.');
  }

  save();
  closeModal('studentModal');
  renderAll();
}

// ─── Admin view student profile ─────────────────────────
function openAdminStudentProfile(studentId) {
  const s = students.find(x => x.studentId === studentId);
  if (!s) return;
  viewingProfileStudentId = studentId;
  document.getElementById('adminProfileAvatar').textContent = initials(s.name);
  document.getElementById('adminProfileName').textContent = s.name;
  document.getElementById('adminProfileId').textContent = s.studentId;
  document.getElementById('adminProfileDeptBadge').innerHTML = `<span class="dept-badge">${s.department}</span>`;
  const myRecs = records.filter(r => r.studentId === s.studentId);
  const rate = events.length > 0 ? Math.round(myRecs.filter(r => r.status !== 'absent').length / events.length * 100) : 0;
  document.getElementById('adminProfileInfoGrid').innerHTML = `
    <div class="profile-field"><div class="profile-field-label"><i class="fas fa-envelope"></i> Email</div><div class="profile-field-value">${s.email || '<span style="color:var(--text-muted);">Not set</span>'}</div></div>
    <div class="profile-field"><div class="profile-field-label"><i class="fas fa-phone"></i> Contact</div><div class="profile-field-value">${s.contact || '<span style="color:var(--text-muted);">Not set</span>'}</div></div>
    <div class="profile-field"><div class="profile-field-label"><i class="fas fa-layer-group"></i> Year Level</div><div class="profile-field-value">${s.yearLevel || '<span style="color:var(--text-muted);">Not set</span>'}</div></div>
    <div class="profile-field"><div class="profile-field-label"><i class="fas fa-graduation-cap"></i> Course</div><div class="profile-field-value">${s.course || '<span style="color:var(--text-muted);">Not set</span>'}</div></div>
    <div class="profile-field"><div class="profile-field-label"><i class="fas fa-chart-pie"></i> Attendance Rate</div><div class="profile-field-value" style="color:${rate>=75?'var(--success)':rate>=50?'var(--warning)':'var(--danger)'}; font-weight:700;">${rate}%</div></div>
    <div class="profile-field"><div class="profile-field-label"><i class="fas fa-calendar-alt"></i> Member Since</div><div class="profile-field-value">${s.createdAt ? formatDate(s.createdAt.slice(0,10)) : '—'}</div></div>
  `;
  openModal('viewStudentProfileModal');
}

function editStudentFromProfile() {
  closeModal('viewStudentProfileModal');
  if (viewingProfileStudentId) openEditStudentModal(viewingProfileStudentId);
}

// ─── Student: open own profile modal ──────────────────
function openStudentProfileModal() {
  if (!currentUser) return;
  const s = currentUser;
  document.getElementById('profileAvatarLg').textContent = initials(s.name);
  document.getElementById('profileNameLg').textContent = s.name;
  document.getElementById('profileIdLg').textContent = s.studentId;
  document.getElementById('profileDeptBadgeLg').innerHTML = `<span class="dept-badge">${s.department}</span>`;
  const myRecs = records.filter(r => r.studentId === s.studentId);
  const rate = events.length > 0 ? Math.round(myRecs.filter(r => r.status !== 'absent').length / events.length * 100) : 0;
  document.getElementById('profileInfoGrid').innerHTML = `
    <div class="profile-field"><div class="profile-field-label"><i class="fas fa-envelope"></i> Email</div><div class="profile-field-value">${s.email || '<span style="color:var(--text-muted);">Not set</span>'}</div></div>
    <div class="profile-field"><div class="profile-field-label"><i class="fas fa-phone"></i> Contact</div><div class="profile-field-value">${s.contact || '<span style="color:var(--text-muted);">Not set</span>'}</div></div>
    <div class="profile-field"><div class="profile-field-label"><i class="fas fa-layer-group"></i> Year Level</div><div class="profile-field-value">${s.yearLevel || '<span style="color:var(--text-muted);">Not set</span>'}</div></div>
    <div class="profile-field"><div class="profile-field-label"><i class="fas fa-graduation-cap"></i> Course</div><div class="profile-field-value">${s.course || '<span style="color:var(--text-muted);">Not set</span>'}</div></div>
    <div class="profile-field"><div class="profile-field-label"><i class="fas fa-chart-pie"></i> Attendance Rate</div><div class="profile-field-value" style="color:${rate>=75?'var(--success)':rate>=50?'var(--warning)':'var(--danger)'}; font-weight:700;">${rate}%</div></div>
    <div class="profile-field"><div class="profile-field-label"><i class="fas fa-university"></i> Department</div><div class="profile-field-value">${s.department}</div></div>
  `;
  openModal('studentProfileModal');
}

// EVENT MODAL
function toggleCheckoutFields() {
  const cb = document.getElementById('modalEventCheckout');
  const fields = document.getElementById('checkoutWindowFields');
  const slider = document.getElementById('checkoutToggleSlider');
  const knob = document.getElementById('checkoutToggleKnob');
  const on = cb.checked;
  fields.style.display = on ? 'block' : 'none';
  slider.style.background = on ? '#0ea5e9' : '#cbd5e1';
  knob.style.transform = on ? 'translateX(20px)' : 'translateX(0)';
}

function openAddEventModal() {
  editingEventId = null;
  document.getElementById('eventModalTitle').textContent = 'Add Event';
  document.getElementById('modalEventName').value = '';
  document.getElementById('modalEventDate').value = '';
  document.getElementById('modalEventOpenTime').value = '07:00';
  document.getElementById('modalEventOnTimeDeadline').value = '08:00';
  document.getElementById('modalEventLateDeadline').value = '09:00';
  document.getElementById('modalEventFine').value = '0';
  document.getElementById('modalEventLateFine').value = '0';
  document.getElementById('modalEventCheckout').checked = false;
  document.getElementById('modalEventCheckoutOpen').value = '11:00';
  document.getElementById('modalEventCheckoutClose').value = '13:00';
  toggleCheckoutFields();
  openModal('eventModal');
}

function openEditEventModal(eventId) {
  const ev = events.find(e => e.id === eventId);
  if (!ev) return;
  editingEventId = eventId;
  document.getElementById('eventModalTitle').textContent = 'Edit Event';
  document.getElementById('modalEventName').value = ev.name;
  document.getElementById('modalEventDate').value = ev.date;
  document.getElementById('modalEventOpenTime').value = ev.openTime || '07:00';
  document.getElementById('modalEventOnTimeDeadline').value = ev.onTimeDeadline || '08:00';
  document.getElementById('modalEventLateDeadline').value = ev.lateDeadline || '09:00';
  document.getElementById('modalEventFine').value = ev.fineAmount || 0;
  document.getElementById('modalEventLateFine').value = ev.lateFineAmount || 0;
  document.getElementById('modalEventCheckout').checked = !!ev.checkoutEnabled;
  document.getElementById('modalEventCheckoutOpen').value = ev.checkoutOpen || '11:00';
  document.getElementById('modalEventCheckoutClose').value = ev.checkoutClose || '13:00';
  toggleCheckoutFields();
  openModal('eventModal');
}

function saveEvent() {
  const name = document.getElementById('modalEventName').value.trim();
  const date = document.getElementById('modalEventDate').value;
  const openTime = document.getElementById('modalEventOpenTime').value;
  const onTimeDeadline = document.getElementById('modalEventOnTimeDeadline').value;
  const lateDeadline = document.getElementById('modalEventLateDeadline').value;
  const fineAmount = parseFloat(document.getElementById('modalEventFine').value) || 0;
  const lateFineAmount = parseFloat(document.getElementById('modalEventLateFine').value) || 0;
  const checkoutEnabled = document.getElementById('modalEventCheckout').checked;
  const checkoutOpen = document.getElementById('modalEventCheckoutOpen').value;
  const checkoutClose = document.getElementById('modalEventCheckoutClose').value;
  if (!name || !date) { toast('Please fill in all fields.', 'error'); return; }
  if (onTimeDeadline <= openTime) { toast('On-time deadline must be after check-in opens.', 'error'); return; }
  if (lateDeadline <= onTimeDeadline) { toast('Late deadline must be after on-time deadline.', 'error'); return; }

  if (editingEventId) {
    const ev = events.find(e => e.id === editingEventId);
    if (ev) { ev.name = name; ev.date = date; ev.openTime = openTime; ev.onTimeDeadline = onTimeDeadline; ev.lateDeadline = lateDeadline; ev.fineAmount = fineAmount; ev.lateFineAmount = lateFineAmount; ev.checkoutEnabled = checkoutEnabled; ev.checkoutOpen = checkoutOpen; ev.checkoutClose = checkoutClose; }
    toast('Event updated successfully.');
  } else {
    events.push({ id: 'ev_' + Date.now(), name, date, openTime, onTimeDeadline, lateDeadline, fineAmount, lateFineAmount, checkoutEnabled, checkoutOpen, checkoutClose });
    toast('Event added successfully.');
  }

  save();
  closeModal('eventModal');
  renderAll();
  renderAuthCalendar();
  renderAuthUpcomingEvents();
}

// STATUS MODAL
function openStatusModal(studentId) {
  const s = students.find(x => x.studentId === studentId);
  if (!s) return;
  selectedStudentForStatus = studentId;
  document.getElementById('statusModalInfo').innerHTML = `
    <strong>${s.name}</strong><br>
    <span style="font-family:var(--mono);">${s.studentId}</span> · ${s.department}
  `;

  const evSel = document.getElementById('statusEventSelect');
  evSel.innerHTML = events.map(ev => `<option value="${ev.id}">${ev.name}</option>`).join('');

  if (events.length > 0) {
    const existingRec = records.find(r => r.studentId === studentId);
    const currentEventId = existingRec?.eventId || events[0].id;
    evSel.value = currentEventId;

    const rec = records.find(r => r.studentId === studentId && r.eventId === currentEventId);
    document.getElementById('statusSelect').value = rec?.status || 'absent';

    evSel.onchange = () => {
      const r = records.find(r => r.studentId === studentId && r.eventId === evSel.value);
      document.getElementById('statusSelect').value = r?.status || 'absent';
    };
  }

  openModal('statusModal');
}

function saveAttendanceStatus() {
  const status = document.getElementById('statusSelect').value;
  const eventId = document.getElementById('statusEventSelect').value;
  if (!selectedStudentForStatus || !eventId) { toast('Please select an event.', 'error'); return; }

  let rec = records.find(r => r.studentId === selectedStudentForStatus && r.eventId === eventId);
  if (rec) {
    rec.status = status;
    rec.updatedAt = new Date().toISOString();
  } else {
    records.push({ studentId: selectedStudentForStatus, eventId, status, createdAt: new Date().toISOString() });
  }

  save();
  closeModal('statusModal');
  toast(`Marked as ${cap(status)}.`);
  generateFinesForAbsent();
  renderAll();
}

// MARK ALL PRESENT
function markAllPresent() {
  const eventFilter = document.getElementById('attEventFilter')?.value || 'all';
  const eventId = eventFilter !== 'all' ? eventFilter : (events[0]?.id);
  if (!eventId) { toast('Please add an event first.', 'error'); return; }

  students.forEach(s => {
    let rec = records.find(r => r.studentId === s.studentId && r.eventId === eventId);
    if (rec) { rec.status = 'present'; }
    else { records.push({ studentId: s.studentId, eventId, status: 'present', createdAt: new Date().toISOString() }); }
  });

  save();
  toast(`Marked all students as Present.`);
  renderAll();
}

// DELETE STUDENT
function confirmDeleteStudent(studentId) {
  const s = students.find(x => x.studentId === studentId);
  if (!s) return;
  document.getElementById('confirmMsg').innerHTML = `Are you sure you want to delete <span class="confirm-name">${s.name}</span>? This will also remove all their attendance records.`;
  document.getElementById('confirmDeleteBtn').onclick = () => {
    students = students.filter(x => x.studentId !== studentId);
    records = records.filter(r => r.studentId !== studentId);
    save();
    closeModal('confirmModal');
    toast('Student deleted.', 'info');
    renderAll();
  };
  openModal('confirmModal');
}

// DELETE EVENT
function confirmDeleteEvent(eventId) {
  const ev = events.find(e => e.id === eventId);
  if (!ev) return;
  document.getElementById('confirmMsg').innerHTML = `Are you sure you want to delete the event <span class="confirm-name">${ev.name}</span>? All attendance records for this event will be removed.`;
  document.getElementById('confirmDeleteBtn').onclick = () => {
    events = events.filter(e => e.id !== eventId);
    records = records.filter(r => r.eventId !== eventId);
    save();
    closeModal('confirmModal');
    toast('Event deleted.', 'info');
    renderAll();
  };
  openModal('confirmModal');
}

// ═══════════════════════════════
// EXPORT
// ═══════════════════════════════
function exportStudentsCSV() {
  let csv = 'Name,Student ID,Department,Attendance Rate\n';
  students.forEach(s => {
    const myRecs = records.filter(r => r.studentId === s.studentId);
    const rate = events.length > 0 ? Math.round(myRecs.filter(r => r.status !== 'absent').length / events.length * 100) : 0;
    csv += `"${s.name}",${s.studentId},${s.department},${rate}%\n`;
  });
  downloadCSV(csv, 'students.csv');
}

function exportFullCSV() {
  const eventFilter = document.getElementById('reportEventSelect').value;
  const deptFilter = document.getElementById('reportDeptSelect').value;

  let csv = 'Name,Student ID,Department,Event,Date,Status,Check-In Time,Check-Out Time,Fine Amount,Fine Status\n';
  const filteredStudents = students.filter(s => deptFilter === 'all' || s.department === deptFilter);
  const filteredEvents = events.filter(ev => eventFilter === 'all' || ev.id === eventFilter);

  filteredStudents.forEach(s => {
    filteredEvents.forEach(ev => {
      const rec = records.find(r => r.studentId === s.studentId && r.eventId === ev.id);
      const status = rec ? rec.status : 'absent';
      const checkinTime = rec?.createdAt ? new Date(rec.createdAt).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}) : '';
      const coKey = s.studentId + '_' + ev.id;
      const co = checkouts[coKey];
      const checkoutTime = co ? new Date(co.time).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}) : '';
      const fKey = s.studentId + '_' + ev.id;
      const fRec = fines[fKey];
      const fineAmt = (status === 'absent' && ev.fineAmount) ? ev.fineAmount : 0;
      const fineStatus = fRec ? fRec.status : (fineAmt > 0 ? 'unpaid' : 'n/a');
      csv += `"${s.name}",${s.studentId},${s.department},"${ev.name}",${ev.date},${status},${checkinTime},${checkoutTime},${fineAmt > 0 ? '₱' + fineAmt : '—'},${fineStatus}\n`;
    });
  });

  downloadCSV(csv, 'attendance-report.csv');
  toast('Report downloaded!');
}

function downloadCSV(csv, filename) {
  const blob = new Blob([csv], { type: 'text/csv' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
}

// ═══════════════════════════════
// REPORT TABS
// ═══════════════════════════════
function switchReportTab(tab, btn) {
  document.querySelectorAll('.report-tab-content').forEach(c => c.style.display = 'none');
  document.querySelectorAll('.report-tab-btn').forEach(b => b.classList.remove('active'));
  const el = document.getElementById('reportTab-' + tab);
  if (el) el.style.display = '';
  if (btn) btn.classList.add('active');
  if (tab === 'daily') renderDailyReport();
  if (tab === 'monthly') renderMonthlyReport();
  if (tab === 'department') { populateDeptReportEventSelect(); renderDeptReport(); }
  if (tab === 'percentage') renderPctReport();
}

function populateDeptReportEventSelect() {
  const sel = document.getElementById('deptReportEvent');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="all">All Events</option>' + events.map(ev => `<option value="${ev.id}">${ev.name} — ${formatDate(ev.date)}</option>`).join('');
  if (cur && [...sel.options].find(o => o.value === cur)) sel.value = cur;
}

// ─── Daily Report ─────────────────────────────────────
function renderDailyReport() {
  const dateInput = document.getElementById('dailyReportDate');
  if (!dateInput) return;
  if (!dateInput.value) dateInput.value = new Date().toISOString().slice(0,10);
  const date = dateInput.value;
  const dayEvents = events.filter(ev => ev.date === date);
  const el = document.getElementById('dailyReportContent');
  if (!el) return;

  if (dayEvents.length === 0) {
    el.innerHTML = `<div class="empty-state"><i class="fas fa-calendar-times"></i><p>No events on ${formatDate(date)}.</p></div>`;
    return;
  }

  let html = '';
  dayEvents.forEach(ev => {
    const evRecs = records.filter(r => r.eventId === ev.id);
    const present = students.filter(s => evRecs.find(r => r.studentId === s.studentId && r.status === 'present'));
    const late    = students.filter(s => evRecs.find(r => r.studentId === s.studentId && r.status === 'late'));
    const absent  = students.filter(s => !evRecs.find(r => r.studentId === s.studentId && (r.status === 'present' || r.status === 'late')));
    const rate = students.length > 0 ? Math.round((present.length + late.length) / students.length * 100) : 0;

    html += `
    <div style="margin-bottom:24px;">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
        <div style="font-size:15px; font-weight:700;">${ev.name}</div>
        <span class="dept-badge" style="background:var(--accent-light); color:var(--accent);">${formatDate(ev.date)}</span>
      </div>
      <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:16px;">
        <div class="stat-card"><div class="stat-icon green"><i class="fas fa-check"></i></div><div><div class="stat-label">Present</div><div class="stat-value">${present.length}</div></div></div>
        <div class="stat-card"><div class="stat-icon orange"><i class="fas fa-clock"></i></div><div><div class="stat-label">Late</div><div class="stat-value">${late.length}</div></div></div>
        <div class="stat-card"><div class="stat-icon red"><i class="fas fa-times"></i></div><div><div class="stat-label">Absent</div><div class="stat-value">${absent.length}</div></div></div>
        <div class="stat-card"><div class="stat-icon blue"><i class="fas fa-percent"></i></div><div><div class="stat-label">Rate</div><div class="stat-value" style="color:${rate>=75?'var(--success)':rate>=50?'var(--warning)':'var(--danger)'};">${rate}%</div></div></div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Student</th><th>ID</th><th>Department</th><th>Status</th><th>Time</th></tr></thead>
        <tbody>
          ${students.map(s => {
            const r = evRecs.find(x => x.studentId === s.studentId);
            const st = r ? r.status : 'absent';
            const time = r?.createdAt ? new Date(r.createdAt).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}) : '—';
            return `<tr>
              <td><div style="display:flex;align-items:center;gap:8px;"><div class="user-avatar" style="width:28px;height:28px;font-size:10px;">${initials(s.name)}</div>${s.name}</div></td>
              <td><span style="font-family:var(--mono);font-size:12px;">${s.studentId}</span></td>
              <td><span class="dept-badge">${s.department}</span></td>
              <td><span class="badge badge-${st}">${cap(st)}</span></td>
              <td style="font-family:var(--mono);font-size:12px;">${time}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>
    </div>`;
  });
  el.innerHTML = html;
}

function exportDailyCSV() {
  const date = document.getElementById('dailyReportDate')?.value || new Date().toISOString().slice(0,10);
  const dayEvents = events.filter(ev => ev.date === date);
  let csv = 'Event,Student Name,Student ID,Department,Status,Check-in Time\n';
  dayEvents.forEach(ev => {
    students.forEach(s => {
      const r = records.find(x => x.studentId === s.studentId && x.eventId === ev.id);
      const st = r ? r.status : 'absent';
      const time = r?.createdAt ? new Date(r.createdAt).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}) : '';
      csv += `"${ev.name}","${s.name}",${s.studentId},${s.department},${st},${time}\n`;
    });
  });
  downloadCSV(csv, `daily-report-${date}.csv`);
  toast('Daily report downloaded!');
}

// ─── Monthly Report ────────────────────────────────────
function renderMonthlyReport() {
  const monthInput = document.getElementById('monthlyReportMonth');
  if (!monthInput) return;
  if (!monthInput.value) monthInput.value = new Date().toISOString().slice(0,7);
  const month = monthInput.value; // YYYY-MM
  const dept = document.getElementById('monthlyReportDept')?.value || 'all';
  const monthEvents = events.filter(ev => ev.date.startsWith(month));
  const el = document.getElementById('monthlyReportContent');
  if (!el) return;

  if (monthEvents.length === 0) {
    el.innerHTML = `<div class="empty-state"><i class="fas fa-calendar-times"></i><p>No events in ${month}.</p></div>`;
    return;
  }

  const filteredStudents = students.filter(s => dept === 'all' || s.department === dept);
  const totEvt = monthEvents.length;

  let html = `
  <div class="table-wrap"><table>
    <thead><tr>
      <th>Student</th><th>ID</th><th>Dept</th>
      ${monthEvents.map(ev => `<th style="font-size:11px;text-align:center;">${ev.name.slice(0,14)}<br><span style="font-family:var(--mono);font-size:10px;color:var(--text-muted);">${ev.date.slice(5)}</span></th>`).join('')}
      <th>Attended</th><th>Rate</th>
    </tr></thead>
    <tbody>
      ${filteredStudents.map(s => {
        const cells = monthEvents.map(ev => {
          const r = records.find(x => x.studentId === s.studentId && x.eventId === ev.id);
          const st = r ? r.status : 'absent';
          const color = st === 'present' ? 'var(--success)' : st === 'late' ? 'var(--warning)' : 'var(--danger)';
          return `<td style="text-align:center;"><span style="font-size:16px;color:${color};">${st === 'present' ? '✓' : st === 'late' ? '⏰' : '✗'}</span></td>`;
        }).join('');
        const attended = monthEvents.filter(ev => {
          const r = records.find(x => x.studentId === s.studentId && x.eventId === ev.id);
          return r && (r.status === 'present' || r.status === 'late');
        }).length;
        const rate = totEvt > 0 ? Math.round(attended / totEvt * 100) : 0;
        return `<tr>
          <td><div style="display:flex;align-items:center;gap:8px;"><div class="user-avatar" style="width:28px;height:28px;font-size:10px;">${initials(s.name)}</div>${s.name}</div></td>
          <td><span style="font-family:var(--mono);font-size:12px;">${s.studentId}</span></td>
          <td><span class="dept-badge">${s.department}</span></td>
          ${cells}
          <td style="text-align:center;font-family:var(--mono);font-weight:600;">${attended}/${totEvt}</td>
          <td><span style="font-weight:700;color:${rate>=75?'var(--success)':rate>=50?'var(--warning)':'var(--danger)'};">${rate}%</span></td>
        </tr>`;
      }).join('')}
    </tbody>
  </table></div>`;
  el.innerHTML = html;
}

function exportMonthlyCSV() {
  const month = document.getElementById('monthlyReportMonth')?.value || new Date().toISOString().slice(0,7);
  const dept = document.getElementById('monthlyReportDept')?.value || 'all';
  const monthEvents = events.filter(ev => ev.date.startsWith(month));
  const filteredStudents = students.filter(s => dept === 'all' || s.department === dept);
  let csv = 'Student Name,Student ID,Department,' + monthEvents.map(ev => `"${ev.name} (${ev.date})"`).join(',') + ',Attended,Rate\n';
  filteredStudents.forEach(s => {
    const attended = monthEvents.filter(ev => { const r = records.find(x => x.studentId === s.studentId && x.eventId === ev.id); return r && (r.status==='present'||r.status==='late'); }).length;
    const rate = monthEvents.length > 0 ? Math.round(attended/monthEvents.length*100) : 0;
    const cells = monthEvents.map(ev => { const r = records.find(x => x.studentId === s.studentId && x.eventId === ev.id); return r ? r.status : 'absent'; }).join(',');
    csv += `"${s.name}",${s.studentId},${s.department},${cells},${attended},${rate}%\n`;
  });
  downloadCSV(csv, `monthly-report-${month}.csv`);
  toast('Monthly report downloaded!');
}

// ─── Department Report ─────────────────────────────────
function renderDeptReport() {
  const evFilter = document.getElementById('deptReportEvent')?.value || 'all';
  const el = document.getElementById('deptReportContent');
  if (!el) return;

  const depts = ['CCS','EDUC','BEED','CAREGIVING','HMTM'];
  const filteredEvents = events.filter(ev => evFilter === 'all' || ev.id === evFilter);

  if (filteredEvents.length === 0) {
    el.innerHTML = `<div class="empty-state"><i class="fas fa-building"></i><p>No events found.</p></div>`;
    return;
  }

  let html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">';
  depts.forEach(dept => {
    const deptStudents = students.filter(s => s.department === dept);
    if (deptStudents.length === 0) return;
    let totalAtt = 0, totalPossible = 0;
    filteredEvents.forEach(ev => {
      deptStudents.forEach(s => {
        totalPossible++;
        const r = records.find(x => x.studentId === s.studentId && x.eventId === ev.id);
        if (r && (r.status === 'present' || r.status === 'late')) totalAtt++;
      });
    });
    const rate = totalPossible > 0 ? Math.round(totalAtt / totalPossible * 100) : 0;
    const color = rate >= 75 ? 'var(--success)' : rate >= 50 ? 'var(--warning)' : 'var(--danger)';
    html += `
    <div class="panel" style="padding:16px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
        <div style="font-size:15px;font-weight:700;">${dept}</div>
        <span class="dept-badge">${deptStudents.length} students</span>
      </div>
      <div style="font-size:28px;font-weight:800;color:${color};margin-bottom:8px;">${rate}%</div>
      <div style="background:var(--surface2);border-radius:6px;height:8px;overflow:hidden;margin-bottom:8px;">
        <div style="width:${rate}%;height:100%;background:${color};border-radius:6px;"></div>
      </div>
      <div style="font-size:12px;color:var(--text-muted);">${totalAtt} attended of ${totalPossible} possible</div>
    </div>`;
  });
  html += '</div>';
  el.innerHTML = html;
}

function exportDeptCSV() {
  const evFilter = document.getElementById('deptReportEvent')?.value || 'all';
  const filteredEvents = events.filter(ev => evFilter === 'all' || ev.id === evFilter);
  let csv = 'Department,Total Students,Total Attended,Total Possible,Attendance Rate\n';
  ['CCS','EDUC','BEED','CAREGIVING','HMTM'].forEach(dept => {
    const deptStudents = students.filter(s => s.department === dept);
    let totalAtt = 0, totalPossible = 0;
    filteredEvents.forEach(ev => {
      deptStudents.forEach(s => {
        totalPossible++;
        const r = records.find(x => x.studentId === s.studentId && x.eventId === ev.id);
        if (r && (r.status === 'present' || r.status === 'late')) totalAtt++;
      });
    });
    const rate = totalPossible > 0 ? Math.round(totalAtt/totalPossible*100) : 0;
    csv += `${dept},${deptStudents.length},${totalAtt},${totalPossible},${rate}%\n`;
  });
  downloadCSV(csv, 'department-report.csv');
  toast('Department report downloaded!');
}

// ─── Attendance Percentage Report ──────────────────────
function renderPctReport() {
  const dept = document.getElementById('pctReportDept')?.value || 'all';
  const threshold = parseInt(document.getElementById('pctReportThreshold')?.value || '0');
  const el = document.getElementById('pctReportContent');
  if (!el) return;

  const filteredStudents = students.filter(s => dept === 'all' || s.department === dept);
  const totEvt = events.length;

  const data = filteredStudents.map(s => {
    const attended = events.filter(ev => {
      const r = records.find(x => x.studentId === s.studentId && x.eventId === ev.id);
      return r && (r.status === 'present' || r.status === 'late');
    }).length;
    const rate = totEvt > 0 ? Math.round(attended / totEvt * 100) : 0;
    return { s, attended, rate };
  }).filter(d => threshold === 0 ? true : d.rate < threshold)
    .sort((a, b) => a.rate - b.rate);

  if (data.length === 0) {
    el.innerHTML = `<div class="empty-state"><i class="fas fa-check-circle" style="color:var(--success);"></i><p>All students meet the attendance threshold.</p></div>`;
    return;
  }

  el.innerHTML = `
  <div class="table-wrap"><table>
    <thead><tr><th>Student</th><th>ID</th><th>Department</th><th>Course</th><th>Year</th><th>Attended</th><th>Rate</th><th>Status</th></tr></thead>
    <tbody>
      ${data.map(({ s, attended, rate }) => `
      <tr>
        <td><div style="display:flex;align-items:center;gap:8px;"><div class="user-avatar" style="width:28px;height:28px;font-size:10px;">${initials(s.name)}</div>${s.name}</div></td>
        <td><span style="font-family:var(--mono);font-size:12px;">${s.studentId}</span></td>
        <td><span class="dept-badge">${s.department}</span></td>
        <td style="font-size:13px;color:var(--text-muted);">${s.course || '—'}</td>
        <td style="font-size:13px;color:var(--text-muted);">${s.yearLevel || '—'}</td>
        <td style="font-family:var(--mono);text-align:center;">${attended}/${totEvt}</td>
        <td>
          <div style="display:flex;align-items:center;gap:8px;">
            <div style="flex:1;background:var(--surface2);border-radius:4px;height:6px;">
              <div style="width:${rate}%;height:100%;background:${rate>=75?'var(--success)':rate>=50?'var(--warning)':'var(--danger)'};border-radius:4px;"></div>
            </div>
            <span style="font-family:var(--mono);font-size:12px;font-weight:700;color:${rate>=75?'var(--success)':rate>=50?'var(--warning)':'var(--danger)'};">${rate}%</span>
          </div>
        </td>
        <td><span class="badge badge-${rate>=75?'present':'absent'}">${rate>=75?'Good Standing':'At Risk'}</span></td>
      </tr>`).join('')}
    </tbody>
  </table></div>`;
}

function exportPctCSV() {
  const dept = document.getElementById('pctReportDept')?.value || 'all';
  const filteredStudents = students.filter(s => dept === 'all' || s.department === dept);
  const totEvt = events.length;
  let csv = 'Student Name,Student ID,Department,Course,Year Level,Email,Contact,Events Attended,Total Events,Attendance Rate,Status\n';
  filteredStudents.forEach(s => {
    const attended = events.filter(ev => { const r = records.find(x => x.studentId === s.studentId && x.eventId === ev.id); return r && (r.status==='present'||r.status==='late'); }).length;
    const rate = totEvt > 0 ? Math.round(attended/totEvt*100) : 0;
    csv += `"${s.name}",${s.studentId},${s.department},"${s.course||''}","${s.yearLevel||''}","${s.email||''}","${s.contact||''}",${attended},${totEvt},${rate}%,${rate>=75?'Good Standing':'At Risk'}\n`;
  });
  downloadCSV(csv, 'attendance-percentage-report.csv');
  toast('Attendance percentage report downloaded!');
}

// ═══════════════════════════════
// UTILS
// ═══════════════════════════════
function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : ''; }
function initials(name) { return name.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase(); }
function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// ═══════════════════════════════
// SELFIE / CAMERA CHECK-IN
// ═══════════════════════════════
function openSelfieModal(eventId) {
  selfieEventId = eventId;
  selfieDataUrl = null;
  const ev = events.find(e => e.id === eventId);
  document.getElementById('selfieEventLabel').innerHTML = `
    <i class="fas fa-calendar-day" style="color:var(--accent);"></i>
    <strong style="color:var(--text); margin-left:6px;">${ev ? ev.name : 'Event'}</strong>
    <span style="margin-left:8px;">${ev ? formatDate(ev.date) : ''}</span>`;

  // Reset UI
  document.getElementById('cameraBox').style.display = 'block';
  document.getElementById('selfiePreviewWrap').style.display = 'none';
  document.getElementById('cameraError').style.display = 'none';
  document.getElementById('captureBtn').style.display = '';
  document.getElementById('retakeBtn').style.display = 'none';
  document.getElementById('confirmCheckinBtn').style.display = 'none';
  document.getElementById('cameraCanvas').style.display = 'none';
  document.getElementById('cameraFeed').style.display = 'block';

  openModal('selfieModal');
  startCamera();
}

async function startCamera() {
  const errEl = document.getElementById('cameraError');
  try {
    // Try progressive constraints for broadest mobile compatibility
    const constraints = [
      { video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
      { video: { facingMode: 'user' }, audio: false },
      { video: { facingMode: { ideal: 'user' } }, audio: false },
      { video: true, audio: false }
    ];
    let stream = null;
    for (const c of constraints) {
      try { stream = await navigator.mediaDevices.getUserMedia(c); break; } catch(e) {}
    }
    if (!stream) throw new Error('No camera available');
    selfieStream = stream;
    const video = document.getElementById('cameraFeed');
    video.srcObject = stream;
    // Ensure video plays (required on iOS Safari)
    await video.play().catch(() => {});
    errEl.style.display = 'none';
  } catch(e) {
    errEl.textContent = 'Could not access camera. Please allow camera access in your browser settings, or use HTTPS.';
    errEl.style.display = 'block';
    document.getElementById('captureBtn').style.display = 'none';
  }
}

function stopCamera() {
  if (selfieStream) {
    selfieStream.getTracks().forEach(t => t.stop());
    selfieStream = null;
  }
}

function captureSelfie() {
  const video = document.getElementById('cameraFeed');
  const canvas = document.getElementById('cameraCanvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  // Add timestamp overlay
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  const tsText = `${dateStr}  ${timeStr}`;
  const padding = 10;
  const fontSize = Math.max(14, Math.floor(canvas.width / 32));

  ctx.font = `bold ${fontSize}px monospace`;
  const textW = ctx.measureText(tsText).width;
  const boxH = fontSize + padding * 2;
  const boxW = textW + padding * 2;

  // Dark semi-transparent box at bottom-left
  ctx.fillStyle = 'rgba(0, 51, 25, 0.72)';
  ctx.fillRect(8, canvas.height - boxH - 8, boxW, boxH);

  // White text
  ctx.fillStyle = '#ffffff';
  ctx.fillText(tsText, 8 + padding, canvas.height - 8 - padding);

  // Green bottom border line
  ctx.fillStyle = '#00a651';
  ctx.fillRect(8, canvas.height - 8, boxW, 3);

  selfieDataUrl = canvas.toDataURL('image/jpeg', 0.7);

  document.getElementById('selfiePreviewImg').src = selfieDataUrl;
  document.getElementById('selfiePreviewWrap').style.display = 'block';
  document.getElementById('cameraBox').style.display = 'none';
  document.getElementById('captureBtn').style.display = 'none';
  document.getElementById('retakeBtn').style.display = '';
  document.getElementById('confirmCheckinBtn').style.display = '';

  stopCamera();
}

function retakeSelfie() {
  selfieDataUrl = null;
  document.getElementById('cameraBox').style.display = 'block';
  document.getElementById('selfiePreviewWrap').style.display = 'none';
  document.getElementById('captureBtn').style.display = '';
  document.getElementById('retakeBtn').style.display = 'none';
  document.getElementById('confirmCheckinBtn').style.display = 'none';
  startCamera();
}

function confirmCheckinNoPhoto() {
  // Check-in without a selfie photo
  if (!selfieEventId || !currentUser) return;
  closeSelfieModal();
  doStudentCheckin(selfieEventId, null);
}

function confirmCheckin() {
  if (!selfieDataUrl || !selfieEventId || !currentUser) return;

  const ev = events.find(e => e.id === selfieEventId);
  const winStatus = ev ? getCheckinStatus(ev) : 'closed';

  // Check if already checked in (e.g., via barcode) — allow adding photo even if window closed
  const existingRec = records.find(r => r.studentId === currentUser.studentId && r.eventId === selfieEventId);
  const alreadyCheckedIn = existingRec && (existingRec.status === 'present' || existingRec.status === 'late');

  if (!alreadyCheckedIn && winStatus !== 'open' && winStatus !== 'late_window') {
    toast('Check-in window is closed for this event.', 'error');
    closeSelfieModal();
    return;
  }

  // Save photo
  const photoKey = currentUser.studentId + '_' + selfieEventId;
  photos[photoKey] = selfieDataUrl;
  syncPhoto(photoKey, selfieDataUrl);

  closeSelfieModal();

  if (alreadyCheckedIn) {
    // Already checked in via barcode — just add the photo
    toast('📸 Photo added to your check-in!', 'success');
    renderStudentPortal();
  } else {
    doStudentCheckin(selfieEventId, selfieDataUrl);
  }
}

function doStudentCheckin(eventId, photoDataUrl) {
  if (!currentUser) return;
  const ev = events.find(e => e.id === eventId);
  const winStatus = ev ? getCheckinStatus(ev) : 'closed';

  let checkInStatus = 'present';
  if (winStatus === 'late_window') checkInStatus = 'late';
  else if (winStatus !== 'open') {
    toast('Check-in window is closed for this event.', 'error');
    return;
  }

  if (photoDataUrl) {
    const photoKey = currentUser.studentId + '_' + eventId;
    photos[photoKey] = photoDataUrl;
    syncPhoto(photoKey, photoDataUrl);
  }

  let rec = records.find(r => r.studentId === currentUser.studentId && r.eventId === eventId);
  if (rec) {
    rec.status = checkInStatus;
    rec.selfCheckin = true;
    rec.updatedAt = new Date().toISOString();
  } else {
    records.push({
      studentId: currentUser.studentId,
      eventId,
      status: checkInStatus,
      selfCheckin: true,
      createdAt: new Date().toISOString()
    });
  }
  save();
  const msg = checkInStatus === 'late' ? '⏰ Checked in as Late.' : '✅ Checked in as Present!';
  toast(msg, checkInStatus === 'late' ? 'info' : 'success');
  renderStudentPortal();
}

function closeSelfieModal() {
  stopCamera();
  closeModal('selfieModal');
}

// ═══════════════════════════════
// PHOTO LIGHTBOX
// ═══════════════════════════════
function openLightbox(photoKey, eventName, studentName) {
  const src = photos[photoKey];
  if (!src) return;
  document.getElementById('lightboxImg').src = src;
  document.getElementById('lightboxInfo').textContent = `${studentName} · ${eventName}`;
  document.getElementById('photoLightbox').classList.add('open');
}

function closeLightbox() {
  document.getElementById('photoLightbox').classList.remove('open');
}

// ═══════════════════════════════
// STUDENT BARCODE SELF-SCAN
// ═══════════════════════════════
let studentScanEventId = null;
let studentQuaggaRunning = false;
let studentLastScanned = '';
let studentLastScannedAt = 0;
let studentJsQRStream = null;
let studentJsQRAnimId = null;

function openStudentScanModal(eventId) {
  if (!currentUser) return;
  studentScanEventId = eventId;
  const ev = events.find(e => e.id === eventId);
  document.getElementById('studentScanEventLabel').innerHTML = `
    <i class="fas fa-calendar-day" style="color:var(--accent);"></i>
    <strong style="color:var(--text); margin-left:6px;">${ev ? ev.name : 'Event'}</strong>
    <span style="margin-left:8px;">${ev ? formatDate(ev.date) : ''}</span>`;
  document.getElementById('studentScanResult').className = 'scan-result-box';
  document.getElementById('studentScanResult').innerHTML = '';
  document.getElementById('studentManualId').value = '';
  document.getElementById('studentScannerView').style.display = 'block';
  document.getElementById('studentScanPhotoOffer').style.display = 'none';
  openModal('studentScanModal');
  setTimeout(startStudentQRScanner, 300);
}

function closeStudentScanModal() {
  stopStudentQRScanner();
  closeModal('studentScanModal');
}

function startStudentQRScanner() {
  const container = document.getElementById('studentScannerContainer');
  if (!container) return;
  container.innerHTML = '<video id="stuJsqrVideo" style="width:100%;border-radius:8px;" playsinline autoplay muted></video><canvas id="stuJsqrCanvas" style="display:none;"></canvas>';
  const video  = document.getElementById('stuJsqrVideo');
  const canvas = document.getElementById('stuJsqrCanvas');
  // Try environment camera first (rear camera on phones for barcode scanning)
  const tryCamera = async () => {
    const constraints = [
      { video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false },
      { video: { facingMode: 'environment' }, audio: false },
      { video: { facingMode: { ideal: 'environment' } }, audio: false },
      { video: true, audio: false }
    ];
    for (const c of constraints) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(c);
        studentJsQRStream = stream;
        video.srcObject = stream;
        await video.play().catch(() => {});
        studentQuaggaRunning = true;
        const tick = () => {
          if (!studentQuaggaRunning) return;
          if (video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.width = video.videoWidth; canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: 'dontInvert' });
            if (code) {
              const now = Date.now();
              if (code.data !== studentLastScanned || now - studentLastScannedAt > 3000) {
                studentLastScanned = code.data;
                studentLastScannedAt = now;
                processStudentBarcodeCheckin(code.data);
              }
            }
          }
          studentJsQRAnimId = requestAnimationFrame(tick);
        };
        tick();
        return;
      } catch(e) {}
    }
    showStudentScanResult('error', '<i class="fas fa-exclamation-triangle"></i> <div>Camera not available. Type your ID below.</div>');
  };
  tryCamera();
}

function stopStudentQRScanner() {
  studentQuaggaRunning = false;
  if (studentJsQRAnimId) { cancelAnimationFrame(studentJsQRAnimId); studentJsQRAnimId = null; }
  if (studentJsQRStream) { studentJsQRStream.getTracks().forEach(t => t.stop()); studentJsQRStream = null; }
}
function stopStudentQuagga() { stopStudentQRScanner(); }

function studentManualScan() {
  const id = document.getElementById('studentManualId').value.trim();
  if (!id) return;
  processStudentBarcodeCheckin(id);
  document.getElementById('studentManualId').value = '';
}

function processStudentBarcodeCheckin(scannedId) {
  if (!currentUser || !studentScanEventId) return;

  // Verify that scanned ID matches the logged-in student
  if (scannedId !== currentUser.studentId) {
    showStudentScanResult('error', `<i class="fas fa-times-circle"></i> <div><strong>ID mismatch</strong><div style="font-size:12px; opacity:0.8;">Scanned: ${scannedId}. Please scan your own barcode.</div></div>`);
    return;
  }

  const ev = events.find(e => e.id === studentScanEventId);
  const winStatus = ev ? getCheckinStatus(ev) : 'closed';

  if (winStatus !== 'open' && winStatus !== 'late_window') {
    showStudentScanResult('error', `<i class="fas fa-lock"></i> <div><strong>Check-in window closed</strong><div style="font-size:12px; opacity:0.8;">${ev?.name || ''}</div></div>`);
    return;
  }

  const alreadyRec = records.find(r => r.studentId === currentUser.studentId && r.eventId === studentScanEventId);
  if (alreadyRec && (alreadyRec.status === 'present' || alreadyRec.status === 'late')) {
    showStudentScanResult('warning', `<i class="fas fa-exclamation-circle"></i> <div><strong>Already checked in</strong><div style="font-size:12px; opacity:0.8;">${cap(alreadyRec.status)}</div></div>`);
    return;
  }

  const status = winStatus === 'late_window' ? 'late' : 'present';
  if (alreadyRec) {
    alreadyRec.status = status;
    alreadyRec.barcodeCheckin = true;
    alreadyRec.updatedAt = new Date().toISOString();
  } else {
    records.push({ studentId: currentUser.studentId, eventId: studentScanEventId, status, barcodeCheckin: true, createdAt: new Date().toISOString() });
  }
  save();
  generateFinesForAbsent();
  renderStudentPortal();

  // Stop scanner and show photo offer
  stopStudentQuagga();

  const statusLabel = status === 'late' ? '⏰ Marked as Late' : '✅ Marked as Present';
  document.getElementById('studentScanPhotoOfferStatus').textContent = statusLabel;
  document.getElementById('studentScannerView').style.display = 'none';
  document.getElementById('studentScanPhotoOffer').style.display = 'block';
}

function proceedToSelfieFromScan() {
  // Close barcode scan modal and open selfie modal for the same event
  const evId = studentScanEventId;
  closeStudentScanModal();
  setTimeout(() => openSelfieModal(evId), 200);
}

function showStudentScanResult(type, html) {
  const box = document.getElementById('studentScanResult');
  box.className = 'scan-result-box ' + type;
  box.innerHTML = html;
}

// ═══════════════════════════════
// FINES MANAGEMENT
// ═══════════════════════════════

// Tracks fines that were manually dismissed — they won't be auto-regenerated
let deletedFines = JSON.parse(localStorage.getItem('ap_deleted_fines') || '[]');

function saveDeletedFines() {
  localStorage.setItem('ap_deleted_fines', JSON.stringify(deletedFines));
}

function generateFinesForAbsent() {
  events.forEach(ev => {
    const today = new Date().toISOString().slice(0,10);
    if (ev.date > today) return; // only past/today events
    students.forEach(s => {
      const rec = records.find(r => r.studentId === s.studentId && r.eventId === ev.id);
      const isAbsent = !rec || rec.status === 'absent';
      const isLate = rec && rec.status === 'late';
      const fKey = s.studentId + '_' + ev.id;

      // Absence fine
      if ((ev.fineAmount || 0) > 0) {
        if (isAbsent && !fines[fKey] && !deletedFines.includes(fKey)) {
          fines[fKey] = { amount: ev.fineAmount, status: 'unpaid', type: 'absence', studentId: s.studentId, eventId: ev.id, createdAt: new Date().toISOString() };
        } else if (!isAbsent && fines[fKey] && fines[fKey].type !== 'late' && fines[fKey].status === 'unpaid') {
          delete fines[fKey]; // auto-remove absence fine when student checks in
        }
      }

      // Late fine — uses a separate key suffix
      const lateFKey = s.studentId + '_' + ev.id + '_late';
      if ((ev.lateFineAmount || 0) > 0) {
        if (isLate && !fines[lateFKey] && !deletedFines.includes(lateFKey)) {
          fines[lateFKey] = { amount: ev.lateFineAmount, status: 'unpaid', type: 'late', studentId: s.studentId, eventId: ev.id, createdAt: new Date().toISOString() };
        } else if (!isLate && fines[lateFKey] && fines[lateFKey].status === 'unpaid') {
          delete fines[lateFKey];
        }
      }
    });
  });
  save();
}

function populateFinesEventSelect() {
  const sel = document.getElementById('finesEventFilter');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="all">All Events</option>' + events.map(ev => `<option value="${ev.id}">${ev.name}</option>`).join('');
  if (cur && [...sel.options].find(o => o.value === cur)) sel.value = cur;
}

function renderFinesTable() {
  generateFinesForAbsent();
  const tbody = document.getElementById('finesTableBody');
  const summaryRow = document.getElementById('finesSummaryRow');
  if (!tbody) return;

  const evFilter = document.getElementById('finesEventFilter')?.value || 'all';
  const deptFilter = document.getElementById('finesDeptFilter')?.value || 'all';
  const statusFilter = document.getElementById('finesStatusFilter')?.value || 'all';

  // Collect fine rows — ONLY show fines that actually exist in storage
  let rows = [];
  events.filter(ev => evFilter === 'all' || ev.id === evFilter).forEach(ev => {
    students.filter(s => deptFilter === 'all' || s.department === deptFilter).forEach(s => {
      const rec = records.find(r => r.studentId === s.studentId && r.eventId === ev.id);
      const isAbsent = !rec || rec.status === 'absent';
      const isLate = rec && rec.status === 'late';

      // Absence fine row
      if ((ev.fineAmount || 0) > 0 && isAbsent) {
        const fKey = s.studentId + '_' + ev.id;
        const fRec = fines[fKey];
        if (fRec && (statusFilter === 'all' || fRec.status === statusFilter)) {
          rows.push({ student: s, event: ev, rec, fRec, fKey, fineType: 'absence' });
        }
      }

      // Late fine row
      if ((ev.lateFineAmount || 0) > 0 && isLate) {
        const lateFKey = s.studentId + '_' + ev.id + '_late';
        const lateFRec = fines[lateFKey];
        if (lateFRec && (statusFilter === 'all' || lateFRec.status === statusFilter)) {
          rows.push({ student: s, event: ev, rec, fRec: lateFRec, fKey: lateFKey, fineType: 'late' });
        }
      }
    });
  });

  // Summary stats
  const totalAmt = rows.reduce((a, r) => a + (r.fRec.amount || 0), 0);
  const paidAmt = rows.filter(r => r.fRec.status === 'paid').reduce((a, r) => a + (r.fRec.amount || 0), 0);
  const unpaidAmt = rows.filter(r => r.fRec.status === 'unpaid').reduce((a, r) => a + (r.fRec.amount || 0), 0);
  if (summaryRow) {
    summaryRow.innerHTML = `
      <div class="stat-card">
        <div class="stat-icon red"><i class="fas fa-peso-sign"></i></div>
        <div><div class="stat-label">Total Fines</div><div class="stat-value" style="font-size:22px;">₱${totalAmt}</div></div>
      </div>
      <div class="stat-card">
        <div class="stat-icon orange"><i class="fas fa-exclamation-circle"></i></div>
        <div><div class="stat-label">Unpaid</div><div class="stat-value" style="font-size:22px; color:var(--danger);">₱${unpaidAmt}</div></div>
      </div>
      <div class="stat-card">
        <div class="stat-icon green"><i class="fas fa-check-circle"></i></div>
        <div><div class="stat-label">Paid / Waived</div><div class="stat-value" style="font-size:22px; color:var(--success);">₱${paidAmt}</div></div>
      </div>`;
  }

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><i class="fas fa-check-circle" style="color:var(--success);"></i><p>No fines found for current filters.</p></div></td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(({ student: s, event: ev, rec, fRec, fKey, fineType }) => {
    const statusBadge = fRec.status === 'paid'
      ? `<span class="fine-badge paid"><i class="fas fa-check"></i> Paid</span>`
      : fRec.status === 'waived'
      ? `<span class="fine-badge waived"><i class="fas fa-times"></i> Waived</span>`
      : `<span class="fine-badge"><i class="fas fa-exclamation"></i> Unpaid</span>`;

    return `
    <tr>
      <td>
        <div style="display:flex; align-items:center; gap:10px;">
          <div class="user-avatar" style="width:30px;height:30px;font-size:11px;">${initials(s.name)}</div>
          <div>
            <div style="font-weight:500;">${s.name}</div>
            <div style="font-size:11px; color:var(--text-muted); font-family:var(--mono);">${s.studentId}</div>
          </div>
        </div>
      </td>
      <td>
        <div style="font-weight:500;">${ev.name}</div>
        <div style="font-size:12px; color:var(--text-muted); font-family:var(--mono);">${formatDate(ev.date)}</div>
      </td>
      <td><span class="badge ${fineType === 'late' ? 'badge-late' : 'badge-absent'} badge-dot">${fineType === 'late' ? 'Late' : 'Absent'}</span></td>
      <td><strong style="font-family:var(--mono);">₱${fRec.amount || ev.fineAmount}</strong></td>
      <td>${statusBadge}</td>
      <td>
        <div style="display:flex; gap:5px; flex-wrap:wrap;">
          ${fRec.status !== 'paid' ? `<button class="btn btn-success btn-sm" onclick="updateFineStatus('${fKey}', 'paid')"><i class="fas fa-check"></i> Paid</button>` : ''}
          ${fRec.status !== 'waived' ? `<button class="btn btn-ghost btn-sm" onclick="updateFineStatus('${fKey}', 'waived')"><i class="fas fa-times"></i> Waive</button>` : ''}
          ${fRec.status !== 'unpaid' ? `<button class="btn btn-ghost btn-sm" style="color:var(--danger);" onclick="updateFineStatus('${fKey}', 'unpaid')"><i class="fas fa-undo"></i> Reset</button>` : ''}
          <button class="btn btn-ghost btn-sm" style="color:var(--danger); border-color:rgba(220,38,38,0.3);" onclick="deleteFine('${fKey}')"><i class="fas fa-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

function renderAppealsTable() {
  const el = document.getElementById('appealsListAdmin');
  if (!el) return;

  // Populate event filter
  const evSel = document.getElementById('appealsEventFilter');
  if (evSel) {
    const cur = evSel.value;
    evSel.innerHTML = '<option value="all">All Events</option>' + events.map(ev => `<option value="${ev.id}">${ev.name}</option>`).join('');
    if (cur && [...evSel.options].find(o => o.value === cur)) evSel.value = cur;
  }

  const statusFilter = document.getElementById('appealsStatusFilter')?.value || 'all';
  const eventFilter = document.getElementById('appealsEventFilter')?.value || 'all';

  const rows = Object.entries(appeals).filter(([key, ap]) => {
    if (statusFilter !== 'all' && ap.status !== statusFilter) return false;
    if (eventFilter !== 'all' && ap.eventId !== eventFilter) return false;
    return true;
  }).sort((a, b) => {
    // Pending first
    const order = { pending: 0, approved: 1, rejected: 2 };
    return (order[a[1].status] || 0) - (order[b[1].status] || 0) || new Date(b[1].submittedAt) - new Date(a[1].submittedAt);
  });

  if (rows.length === 0) {
    el.innerHTML = `<div class="empty-state"><i class="fas fa-flag" style="opacity:0.25;"></i><p>No appeals found.</p></div>`;
    return;
  }

  el.innerHTML = rows.map(([key, ap]) => {
    const s = students.find(x => x.studentId === ap.studentId);
    const ev = events.find(e => e.id === ap.eventId);
    const statusColor = ap.status === 'approved' ? 'var(--success)' : ap.status === 'rejected' ? 'var(--danger)' : 'var(--warning)';
    const statusBg = ap.status === 'approved' ? 'var(--success-light)' : ap.status === 'rejected' ? 'var(--danger-light)' : 'var(--warning-light)';
    const statusLabel = ap.status === 'approved' ? 'Approved' : ap.status === 'rejected' ? 'Rejected' : 'Pending';
    const aIcon = ap.status === 'approved' ? 'fa-check-circle' : ap.status === 'rejected' ? 'fa-times-circle' : 'fa-hourglass-half';
    return `
    <div style="display:flex; align-items:flex-start; gap:14px; padding:16px; border-bottom:1px solid var(--border);">
      <div class="user-avatar" style="width:36px;height:36px;font-size:12px;flex-shrink:0;">${s ? initials(s.name) : '?'}</div>
      <div style="flex:1; min-width:0;">
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:4px;">
          <span style="font-weight:600;">${s ? s.name : ap.studentId}</span>
          <span class="dept-badge">${s?.department || ''}</span>
          <span style="font-size:11px; font-family:var(--mono); color:var(--text-muted);">${ap.studentId}</span>
          <span style="margin-left:auto; display:inline-flex; align-items:center; gap:4px; font-size:12px; font-weight:600; padding:3px 10px; border-radius:20px; background:${statusBg}; color:${statusColor};">
            <i class="fas ${aIcon}"></i> ${statusLabel}
          </span>
        </div>
        <div style="font-size:13px; color:var(--text-muted); margin-bottom:6px;">
          <i class="fas fa-calendar-day" style="color:var(--accent);"></i> ${ev ? ev.name : 'Unknown Event'}
          <span style="font-family:var(--mono); margin-left:6px;">${ev ? formatDate(ev.date) : ''}</span>
        </div>
        <div style="background:#f5f3ff; border:1px solid #c4b5fd30; border-radius:var(--radius-sm); padding:8px 12px; margin-bottom:8px;">
          <div style="font-size:11px; font-weight:600; color:#6366f1; margin-bottom:3px;"><i class="fas fa-flag"></i> ${ap.type}</div>
          <div style="font-size:13px; color:var(--text); line-height:1.5;">${ap.reason}</div>
          ${ap.evidence ? `<div style="margin-top:6px; font-size:11px; color:#166534; font-weight:600;"><i class="fas fa-paperclip"></i> Evidence attached — ${ap.evidence.startsWith('data:image') ? 'Image' : 'File'}: ${ap.evidenceFileName || 'document'}</div>` : ''}
        </div>
        ${ap.adminNote ? `<div style="font-size:12px; color:var(--text-muted); font-style:italic; margin-bottom:4px;"><i class="fas fa-comment-alt" style="color:var(--accent);"></i> Admin: "${ap.adminNote}"</div>` : ''}
        <div style="font-size:11px; color:var(--text-muted); font-family:var(--mono); margin-bottom:8px;">Submitted ${new Date(ap.submittedAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          <button class="btn btn-ghost btn-sm" style="color:#6366f1; border-color:#c7d2fe;" onclick="openAppealReviewModal('${ap.studentId}','${ap.eventId}')">
            <i class="fas fa-gavel"></i> Review
          </button>
          ${ap.status === 'pending' ? `
            <button class="btn btn-success btn-sm" onclick="quickResolveAppeal('${key}','approved')"><i class="fas fa-check"></i> Approve</button>
            <button class="btn btn-danger btn-sm" onclick="quickResolveAppeal('${key}','rejected')"><i class="fas fa-times"></i> Reject</button>
          ` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}

function quickResolveAppeal(aKey, decision) {
  if (!appeals[aKey]) return;
  appeals[aKey].status = decision;
  appeals[aKey].resolvedAt = new Date().toISOString();
  if (decision === 'approved') {
    const ap = appeals[aKey];
    let rec = records.find(r => r.studentId === ap.studentId && r.eventId === ap.eventId);
    if (rec) { rec.status = 'present'; rec.updatedAt = new Date().toISOString(); rec.appealed = true; }
    else { records.push({ studentId: ap.studentId, eventId: ap.eventId, status: 'present', appealed: true, createdAt: new Date().toISOString() }); }
    const fKey = ap.studentId + '_' + ap.eventId;
    if (fines[fKey]) { delete fines[fKey]; }
    toast('Appeal approved — attendance updated.', 'success');
  } else {
    toast('Appeal rejected.', 'info');
  }
  save();
  renderAll();
}

function updateFineStatus(fKey, newStatus) {
  if (!fines[fKey]) return;
  fines[fKey].status = newStatus;
  fines[fKey].updatedAt = new Date().toISOString();
  save();
  renderFinesTable();
  renderStats();
  toast(`Fine marked as ${cap(newStatus)}.`);
  if (currentUser) renderStudentPortal();
}

function deleteFine(fKey) {
  // Remove from fines object
  delete fines[fKey];
  save();
  // Add to blocklist so it won't be auto-regenerated
  if (!deletedFines.includes(fKey)) {
    deletedFines.push(fKey);
    saveDeletedFines();
  }
  renderFinesTable();
  renderStats();
  toast('Fine record deleted.', 'info');
  if (currentUser) renderStudentPortal();
}

function exportFinesCSV() {
  generateFinesForAbsent();
  let csv = 'Student Name,Student ID,Department,Event,Date,Fine Amount,Fine Status\n';
  events.forEach(ev => {
    if (!ev.fineAmount || ev.fineAmount <= 0) return;
    students.forEach(s => {
      const rec = records.find(r => r.studentId === s.studentId && r.eventId === ev.id);
      const isAbsent = !rec || rec.status === 'absent';
      if (!isAbsent) return;
      const fKey = s.studentId + '_' + ev.id;
      const fRec = fines[fKey] || { amount: ev.fineAmount, status: 'unpaid' };
      csv += `"${s.name}",${s.studentId},${s.department},"${ev.name}",${ev.date},${fRec.amount},${fRec.status}\n`;
    });
  });
  downloadCSV(csv, 'fines-report.csv');
  toast('Fines report downloaded!');
}

// ═══════════════════════════════
// QR CODE — STUDENT PORTAL
// ═══════════════════════════════
function openMyBarcodeModal() {
  if (!currentUser) return;
  document.getElementById('bcName').textContent = currentUser.name;
  document.getElementById('bcId').textContent = currentUser.studentId;
  document.getElementById('bcDept').textContent = currentUser.department;
  const wrap = document.getElementById('studentQRCanvas');
  wrap.innerHTML = '';
  try {
    new QRCode(wrap, {
      text: currentUser.studentId,
      width: 180, height: 180,
      colorDark: '#0f172a', colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.H
    });
  } catch(e) { wrap.textContent = currentUser.studentId; }
  openModal('myBarcodeModal');
}

function printBarcode() {
  const wrap = document.getElementById('studentQRCanvas');
  const img = wrap.querySelector('img') || wrap.querySelector('canvas');
  const imgSrc = img ? (img.tagName === 'CANVAS' ? img.toDataURL() : img.src) : '';
  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(`
    <html><head><title>QR Code - ${currentUser.name}</title>
    <style>
      body{display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:sans-serif;}
      .card{border:2px solid #e2e8f0;border-radius:12px;padding:28px;text-align:center;max-width:280px;}
      h2{margin:0 0 4px;font-size:16px;}p{margin:0 0 16px;color:#64748b;font-size:13px;}
      .dept{display:inline-block;background:#dbeafe;color:#2563eb;font-size:12px;font-weight:600;padding:4px 14px;border-radius:20px;margin-top:12px;}
      img{width:180px;height:180px;border-radius:8px;}
    </style></head>
    <body><div class="card">
      <h2>${currentUser.name}</h2><p>${currentUser.studentId}</p>
      <img src="${imgSrc}">
      <div class="dept">${currentUser.department}</div>
    </div></body></html>`);
  win.document.close(); win.focus();
  setTimeout(() => win.print(), 400);
}

// ═══════════════════════════════
// QR CODE — ADMIN VIEW STUDENT
// ═══════════════════════════════
function openViewBarcodeModal(studentId) {
  const s = students.find(x => x.studentId === studentId);
  if (!s) return;
  document.getElementById('vbcName').textContent = s.name;
  document.getElementById('vbcId').textContent = s.studentId;
  document.getElementById('vbcDept').textContent = s.department;
  const wrap = document.getElementById('adminQRCanvas');
  wrap.innerHTML = '';
  try {
    new QRCode(wrap, {
      text: s.studentId,
      width: 180, height: 180,
      colorDark: '#0f172a', colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.H
    });
  } catch(e) { wrap.textContent = s.studentId; }
  openModal('viewBarcodeModal');
}

function printAdminBarcode() {
  const name = document.getElementById('vbcName').textContent;
  const id   = document.getElementById('vbcId').textContent;
  const dept = document.getElementById('vbcDept').textContent;
  const wrap = document.getElementById('adminQRCanvas');
  const img  = wrap.querySelector('img') || wrap.querySelector('canvas');
  const imgSrc = img ? (img.tagName === 'CANVAS' ? img.toDataURL() : img.src) : '';
  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(`
    <html><head><title>QR Code - ${name}</title>
    <style>
      body{display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:sans-serif;}
      .card{border:2px solid #e2e8f0;border-radius:12px;padding:28px;text-align:center;max-width:280px;}
      h2{margin:0 0 4px;font-size:16px;}p{margin:0 0 16px;color:#64748b;font-size:13px;}
      .dept{display:inline-block;background:#dbeafe;color:#2563eb;font-size:12px;font-weight:600;padding:4px 14px;border-radius:20px;margin-top:12px;}
      img{width:180px;height:180px;border-radius:8px;}
    </style></head>
    <body><div class="card">
      <h2>${name}</h2><p>${id}</p>
      <img src="${imgSrc}">
      <div class="dept">${dept}</div>
    </div></body></html>`);
  win.document.close(); win.focus();
  setTimeout(() => win.print(), 400);
}

// ═══════════════════════════════
// QR SCANNER — ADMIN
// ═══════════════════════════════
let quaggaRunning = false;
let lastScannedCode = '';
let lastScannedAt = 0;
let jsQRRunning = false;
let jsQRVideo = null;
let jsQRCanvas = null;
let jsQRStream = null;
let jsQRAnimId = null;

function openScannerPage() {
  const sel = document.getElementById('scanEventSelect');
  sel.innerHTML = events.map(ev => `<option value="${ev.id}">${ev.name} — ${formatDate(ev.date)}</option>`).join('');
  if (!sel.innerHTML) sel.innerHTML = '<option value="">No events available</option>';
  clearScanResult();
  document.getElementById('manualScanId').value = '';
  document.getElementById('adminScanStep1').style.display = 'block';
  document.getElementById('adminScanStep2').style.display = 'none';
  openModal('barcodeScanModal');
  setTimeout(startQRScanner, 300);
}

function closeScannerModal() {
  stopQRScanner();
  adminStopCamera();
  document.getElementById('adminScanStep1').style.display = 'block';
  document.getElementById('adminScanStep2').style.display = 'none';
  closeModal('barcodeScanModal');
}

function startQRScanner() {
  const container = document.getElementById('scannerContainer');
  if (!container) return;
  container.innerHTML = '<video id="jsqrVideo" style="width:100%;height:100%;object-fit:cover;border-radius:8px;" playsinline autoplay muted></video><canvas id="jsqrCanvas" style="display:none;"></canvas><div class="scanner-corners"><div class="sc-inner"></div></div><div class="scanner-line"></div>';
  jsQRVideo = document.getElementById('jsqrVideo');
  jsQRCanvas = document.getElementById('jsqrCanvas');

  const tryCamera = async () => {
    const constraints = [
      { video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false },
      { video: { facingMode: 'environment' }, audio: false },
      { video: { facingMode: { ideal: 'environment' } }, audio: false },
      { video: true, audio: false }
    ];
    for (const c of constraints) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(c);
        jsQRStream = stream;
        jsQRVideo.srcObject = stream;
        await jsQRVideo.play().catch(() => {});
        jsQRRunning = true;
        scanQRFrame();
        return;
      } catch(e) {}
    }
    showScanResult('error', '<i class="fas fa-exclamation-triangle"></i> <div>Camera not available. Type student ID below.</div>');
  };
  tryCamera();
}

function scanQRFrame() {
  if (!jsQRRunning || !jsQRVideo || !jsQRCanvas) return;
  if (jsQRVideo.readyState === jsQRVideo.HAVE_ENOUGH_DATA) {
    jsQRCanvas.width  = jsQRVideo.videoWidth;
    jsQRCanvas.height = jsQRVideo.videoHeight;
    const ctx = jsQRCanvas.getContext('2d');
    ctx.drawImage(jsQRVideo, 0, 0, jsQRCanvas.width, jsQRCanvas.height);
    const imageData = ctx.getImageData(0, 0, jsQRCanvas.width, jsQRCanvas.height);
    const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
    if (code) {
      const now = Date.now();
      if (code.data !== lastScannedCode || now - lastScannedAt > 3000) {
        lastScannedCode = code.data;
        lastScannedAt = now;
        processScannedQR(code.data);
      }
    }
  }
  jsQRAnimId = requestAnimationFrame(scanQRFrame);
}

function stopQRScanner() {
  jsQRRunning = false;
  if (jsQRAnimId) { cancelAnimationFrame(jsQRAnimId); jsQRAnimId = null; }
  if (jsQRStream) { jsQRStream.getTracks().forEach(t => t.stop()); jsQRStream = null; }
}

function startQuagga() { startQRScanner(); } // alias for any remaining calls
function stopQuagga() { stopQRScanner(); }

function processScannedQR(scannedId) {
  const eventId = document.getElementById('scanEventSelect')?.value;
  if (!eventId) return;
  const s = students.find(x => x.studentId === scannedId);
  if (!s) {
    showScanResult('error', `<i class="fas fa-times-circle"></i> <div><strong>Student not found</strong><div style="font-size:12px;opacity:0.8;">QR: ${scannedId}</div></div>`);
    return;
  }
  const ev = events.find(e => e.id === eventId);
  const win = getCheckinStatus(ev);
  if (win !== 'open' && win !== 'late_window') {
    showScanResult('error', `<i class="fas fa-lock"></i> <div><strong>Check-in window closed</strong></div>`);
    return;
  }
  const existing = records.find(r => r.studentId === scannedId && r.eventId === eventId);
  if (existing && (existing.status === 'present' || existing.status === 'late')) {
    showScanResult('warning', `<i class="fas fa-exclamation-circle"></i> <div><strong>${s.name}</strong><div style="font-size:12px;opacity:0.8;">Already checked in as ${cap(existing.status)}</div></div>`);
    return;
  }
  const status = win === 'late_window' ? 'late' : 'present';
  if (existing) { existing.status = status; existing.updatedAt = new Date().toISOString(); }
  else { records.push({ studentId: scannedId, eventId, status, qrCheckin: true, createdAt: new Date().toISOString() }); }
  save(); generateFinesForAbsent(); renderAll();
  showScanResult('success', `<i class="fas fa-check-circle"></i> <div><strong>${s.name}</strong><div style="font-size:12px;opacity:0.8;">${cap(status)} — ${ev.name}</div></div>`);
  // Move to step 2 (photo)
  stopQRScanner();
  // Store state for adminConfirmSelfie
  adminScanStudentId = scannedId;
  adminScanEventId = eventId;
  lastScannedStudentId = scannedId;
  // Persist pending selfie flag so the student sees Step 2 in their Event Attendance Records
  pendingSelfieEventId = eventId;
  const pendingKey = 'ap_pending_selfie_' + scannedId;
  localStorage.setItem(pendingKey, eventId);
  // Update the admin step 2 UI
  const infoEl = document.getElementById('adminScanSuccessInfo');
  if (infoEl) infoEl.innerHTML = `<strong>${s.name}</strong> (${s.studentId}) — <span class="badge badge-${status} badge-dot" style="font-size:12px;">${cap(status)}</span>`;
  const labelEl = document.getElementById('adminScanSuccessLabel');
  if (labelEl) labelEl.textContent = status === 'late' ? '⏰ Checked In as Late!' : '✅ Checked In!';
  document.getElementById('adminScanStep1').style.display = 'none';
  document.getElementById('adminScanStep2').style.display = 'block';
  // Reset selfie UI state (elements kept hidden for JS compatibility)
  adminSelfieDataUrl = null;
}

let adminScanStudentId = null;
let adminScanEventId = null;
let adminSelfieStream = null;
let adminSelfieDataUrl = null;
let pendingSelfieEventId = null;
let lastScannedStudentId = null;

function processBarcodeCheckin(studentId) { processScannedQR(studentId); }

function adminOpenSelfieCamera() {
  document.getElementById('adminSelfieCameraArea').style.display = 'block';
  document.getElementById('adminCameraBox').style.display = 'block';
  document.getElementById('adminSelfiePreviewWrap').style.display = 'none';
  document.getElementById('adminOpenCameraBtn').style.display = 'none';
  document.getElementById('adminCaptureBtn').style.display = '';
  document.getElementById('adminCameraFeed').style.display = 'block';
  document.getElementById('adminCameraCanvas').style.display = 'none';
  adminStartCamera();
}

async function adminStartCamera() {
  const errEl = document.getElementById('adminCameraError');
  try {
    const constraints = [
      { video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
      { video: { facingMode: 'user' }, audio: false },
      { video: { facingMode: { ideal: 'user' } }, audio: false },
      { video: true, audio: false }
    ];
    let stream = null;
    for (const c of constraints) {
      try { stream = await navigator.mediaDevices.getUserMedia(c); break; } catch(e) {}
    }
    if (!stream) throw new Error('No camera');
    adminSelfieStream = stream;
    const video = document.getElementById('adminCameraFeed');
    video.srcObject = stream;
    await video.play().catch(() => {});
    errEl.style.display = 'none';
  } catch(e) {
    errEl.textContent = 'Could not access camera. Please allow camera access in your browser settings.';
    errEl.style.display = 'block';
    document.getElementById('adminCaptureBtn').style.display = 'none';
  }
}

function adminStopCamera() {
  if (adminSelfieStream) {
    adminSelfieStream.getTracks().forEach(t => t.stop());
    adminSelfieStream = null;
  }
}

function adminCaptureSelfie() {
  const video = document.getElementById('adminCameraFeed');
  const canvas = document.getElementById('adminCameraCanvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  // Timestamp overlay
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  const tsText = `${dateStr}  ${timeStr}`;
  const padding = 10;
  const fontSize = Math.max(14, Math.floor(canvas.width / 32));
  ctx.font = `bold ${fontSize}px monospace`;
  const textW = ctx.measureText(tsText).width;
  const boxH = fontSize + padding * 2;
  const boxW = textW + padding * 2;
  ctx.fillStyle = 'rgba(8, 43, 28, 0.75)';
  ctx.fillRect(8, canvas.height - boxH - 8, boxW, boxH);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(tsText, 8 + padding, canvas.height - 8 - padding);
  ctx.fillStyle = '#22d48a';
  ctx.fillRect(8, canvas.height - 8, boxW, 3);

  adminSelfieDataUrl = canvas.toDataURL('image/jpeg', 0.8);
  adminStopCamera();

  document.getElementById('adminCameraBox').style.display = 'none';
  document.getElementById('adminSelfiePreviewImg').src = adminSelfieDataUrl;
  document.getElementById('adminSelfiePreviewWrap').style.display = 'block';
  document.getElementById('adminCaptureBtn').style.display = 'none';
  document.getElementById('adminRetakeBtn').style.display = '';
  document.getElementById('adminConfirmSelfieBtn').style.display = '';
  document.getElementById('adminOpenCameraBtn').style.display = 'none';
}

function adminRetakeSelfie() {
  adminSelfieDataUrl = null;
  document.getElementById('adminSelfiePreviewWrap').style.display = 'none';
  document.getElementById('adminCameraBox').style.display = 'block';
  document.getElementById('adminCaptureBtn').style.display = '';
  document.getElementById('adminRetakeBtn').style.display = 'none';
  document.getElementById('adminConfirmSelfieBtn').style.display = 'none';
  document.getElementById('adminCameraFeed').style.display = 'block';
  adminStartCamera();
}

function adminConfirmSelfie() {
  if (adminSelfieDataUrl && adminScanStudentId && adminScanEventId) {
    const photoKey = adminScanStudentId + '_' + adminScanEventId;
    photos[photoKey] = adminSelfieDataUrl;
    syncPhoto(photoKey, adminSelfieDataUrl);
    toast('✅ Checked in with selfie saved!', 'success');
    renderAll();
  }
  // Clear the pending selfie flag so the student's Step 2 banner is removed
  const pendingKey = 'ap_pending_selfie_' + (adminScanStudentId || '');
  localStorage.removeItem(pendingKey);
  pendingSelfieEventId = null;
  adminStopCamera();
  adminScanStudentId = null;
  adminScanEventId = null;
  adminSelfieDataUrl = null;
  closeScannerModal();
}

function adminScanAnother() {
  // Clear pending state but keep the modal open and go back to Step 1
  adminStopCamera();
  adminScanStudentId = null;
  adminScanEventId = null;
  adminSelfieDataUrl = null;
  clearScanResult();
  document.getElementById('manualScanId').value = '';
  document.getElementById('adminScanStep1').style.display = 'block';
  document.getElementById('adminScanStep2').style.display = 'none';
  setTimeout(startQRScanner, 300);
}

function adminSkipSelfie() {
  toast('✅ Checked in successfully.', 'success');
  // Clear the pending selfie flag
  const pendingKey = 'ap_pending_selfie_' + (adminScanStudentId || '');
  localStorage.removeItem(pendingKey);
  pendingSelfieEventId = null;
  adminStopCamera();
  adminScanStudentId = null;
  adminScanEventId = null;
  closeScannerModal();
}

// ═══════════════════════════════
// APPEAL EVIDENCE UPLOAD
// ═══════════════════════════════
let appealEvidenceDataUrl = null;
let appealEvidenceFileName = null;

function handleEvidenceFile(file) {
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { toast('File too large. Max 5 MB.', 'error'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    appealEvidenceDataUrl = e.target.result;
    appealEvidenceFileName = file.name;
    showEvidencePreview(file);
  };
  reader.readAsDataURL(file);
}

function handleEvidenceDrop(e) {
  e.preventDefault();
  const zone = document.getElementById('appealEvidenceDropZone');
  zone.style.background = '#faf5ff'; zone.style.borderColor = '#c4b5fd';
  const file = e.dataTransfer.files[0];
  if (file) handleEvidenceFile(file);
}

function showEvidencePreview(file) {
  const preview = document.getElementById('appealEvidencePreview');
  document.getElementById('appealEvidenceFileName').textContent = file.name;
  document.getElementById('appealEvidenceFileSize').textContent = (file.size / 1024).toFixed(1) + ' KB';
  const imgPrev = document.getElementById('appealEvidenceImgPreview');
  if (file.type.startsWith('image/')) {
    imgPrev.src = appealEvidenceDataUrl;
    imgPrev.style.display = 'block';
  } else {
    imgPrev.style.display = 'none';
  }
  preview.style.display = 'flex';
}

function clearAppealEvidence() {
  appealEvidenceDataUrl = null;
  appealEvidenceFileName = null;
  document.getElementById('appealEvidenceInput').value = '';
  document.getElementById('appealEvidencePreview').style.display = 'none';
  document.getElementById('appealEvidenceImgPreview').src = '';
}

function openEvidenceLightbox() {
  if (!appealEvidenceDataUrl) return;
  const lb = document.getElementById('evidenceLightbox');
  document.getElementById('evidenceLightboxImg').src = appealEvidenceDataUrl;
  lb.style.display = 'flex';
}

function closeEvidenceLightbox() {
  document.getElementById('evidenceLightbox').style.display = 'none';
}

// ═══════════════════════════════
// APPEALS / DISPUTES
// ═══════════════════════════════
let appealTargetEventId = null;

function openAppealModal(eventId) {
  if (!currentUser) return;
  appealTargetEventId = eventId;
  const ev = events.find(e => e.id === eventId);
  document.getElementById('appealEventLabel').innerHTML = `
    <i class="fas fa-calendar-day" style="color:var(--accent);"></i>
    <strong style="margin-left:8px;">${ev ? ev.name : 'Event'}</strong>
    <span style="margin-left:8px; color:var(--text-muted); font-family:var(--mono);">${ev ? formatDate(ev.date) : ''}</span>`;
  document.getElementById('appealType').value = 'Medical Emergency';
  document.getElementById('appealReason').value = '';
  clearAppealEvidence();
  openModal('appealModal');
}

function submitAppeal() {
  if (!currentUser || !appealTargetEventId) return;
  const reason = document.getElementById('appealReason').value.trim();
  if (!reason) { toast('Please describe the reason for your appeal.', 'error'); return; }
  const type = document.getElementById('appealType').value;
  const aKey = currentUser.studentId + '_' + appealTargetEventId;
  appeals[aKey] = {
    studentId: currentUser.studentId,
    eventId: appealTargetEventId,
    type,
    reason,
    evidence: appealEvidenceDataUrl || null,
    evidenceFileName: appealEvidenceFileName || null,
    status: 'pending',
    submittedAt: new Date().toISOString(),
    adminNote: ''
  };
  save();
  clearAppealEvidence();
  closeModal('appealModal');
  toast('✅ Appeal submitted! Your admin will review it.', 'success');
  renderStudentPortal();
}

let reviewingAppealKey = null;

function openAppealReviewModal(studentId, eventId) {
  reviewingAppealKey = studentId + '_' + eventId;
  const appeal = appeals[reviewingAppealKey];
  if (!appeal) return;
  const s = students.find(x => x.studentId === studentId);
  const ev = events.find(e => e.id === eventId);
  const statusColor = appeal.status === 'approved' ? 'var(--success)' : appeal.status === 'rejected' ? 'var(--danger)' : 'var(--warning)';
  const statusLabel = appeal.status === 'approved' ? 'Approved' : appeal.status === 'rejected' ? 'Rejected' : 'Pending';
  document.getElementById('appealReviewContent').innerHTML = `
    <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px;">
      <div class="user-avatar" style="width:38px;height:38px;font-size:13px;">${s ? initials(s.name) : '?'}</div>
      <div>
        <div style="font-weight:600; font-size:15px;">${s ? s.name : 'Unknown'}</div>
        <div style="font-size:12px; color:var(--text-muted); font-family:var(--mono);">${studentId} · ${s?.department || ''}</div>
      </div>
      <span style="margin-left:auto; font-size:12px; font-weight:600; padding:4px 12px; border-radius:20px; background:${statusColor}20; color:${statusColor};">${statusLabel}</span>
    </div>
    <div style="background:var(--surface2); border-radius:var(--radius-sm); padding:12px; margin-bottom:12px;">
      <div style="font-size:12px; color:var(--text-muted); margin-bottom:4px;">Event</div>
      <div style="font-weight:500;">${ev ? ev.name : 'Unknown'} <span style="font-family:var(--mono); font-size:12px; color:var(--text-muted);">${ev ? formatDate(ev.date) : ''}</span></div>
    </div>
    <div style="background:#f5f3ff; border:1px solid #c4b5fd; border-radius:var(--radius-sm); padding:12px; margin-bottom:12px;">
      <div style="font-size:12px; font-weight:600; color:#6366f1; margin-bottom:4px;"><i class="fas fa-flag"></i> ${appeal.type}</div>
      <div style="font-size:14px; color:var(--text); line-height:1.6;">${appeal.reason}</div>
      <div style="font-size:11px; color:var(--text-muted); margin-top:8px; font-family:var(--mono);">Submitted ${new Date(appeal.submittedAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</div>
    </div>
    ${appeal.evidence ? `
    <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:var(--radius-sm); padding:12px; margin-bottom:12px;">
      <div style="font-size:12px; font-weight:600; color:#166534; margin-bottom:8px;"><i class="fas fa-paperclip"></i> Attached Evidence</div>
      ${appeal.evidence.startsWith('data:image') 
        ? `<img src="${appeal.evidence}" style="max-width:100%; border-radius:8px; cursor:pointer; max-height:200px; object-fit:contain; border:1.5px solid #bbf7d0;" onclick="window.open('${appeal.evidence}','_blank')" title="Click to view full size">`
        : `<a href="${appeal.evidence}" download="${appeal.evidenceFileName || 'evidence'}" style="display:inline-flex; align-items:center; gap:8px; background:white; border:1px solid #bbf7d0; border-radius:8px; padding:8px 14px; color:#166534; font-size:13px; font-weight:600; text-decoration:none;"><i class="fas fa-file-download"></i> Download ${appeal.evidenceFileName || 'Evidence File'}</a>`}
    </div>` : ''}`;
  document.getElementById('appealAdminNote').value = appeal.adminNote || '';
  openModal('appealReviewModal');
}

function resolveAppeal(decision) {
  if (!reviewingAppealKey || !appeals[reviewingAppealKey]) return;
  appeals[reviewingAppealKey].status = decision;
  appeals[reviewingAppealKey].adminNote = document.getElementById('appealAdminNote').value.trim();
  appeals[reviewingAppealKey].resolvedAt = new Date().toISOString();
  if (decision === 'approved') {
    // Auto-update attendance to present
    const ap = appeals[reviewingAppealKey];
    let rec = records.find(r => r.studentId === ap.studentId && r.eventId === ap.eventId);
    if (rec) { rec.status = 'present'; rec.updatedAt = new Date().toISOString(); rec.appealed = true; }
    else { records.push({ studentId: ap.studentId, eventId: ap.eventId, status: 'present', appealed: true, createdAt: new Date().toISOString() }); }
    // Remove any fine
    const fKey = ap.studentId + '_' + ap.eventId;
    if (fines[fKey]) { delete fines[fKey]; }
    toast('Appeal approved — attendance updated to Present.', 'success');
  } else {
    toast('Appeal rejected.', 'info');
  }
  save();
  closeModal('appealReviewModal');
  renderAll();
  if (currentUser) renderStudentPortal();
}

// Sidebar nav item for appeals (admin) — dynamically injects pending count badge
function updateAppealsBadge() {
  const badge = document.getElementById('appealsNavBadge');
  if (!badge) return;
  const pending = Object.values(appeals).filter(a => a.status === 'pending').length;
  badge.textContent = pending > 0 ? pending : '';
  badge.style.display = pending > 0 ? 'inline-flex' : 'none';
}
function confirmClearAllFines() {
  document.getElementById('confirmMsg').innerHTML = `Are you sure you want to delete <span class="confirm-name">ALL fine records</span>? The Unpaid Fines counter on the dashboard will reset to ₱0.`;
  document.getElementById('confirmDeleteBtn').onclick = () => {
    fines = {};
    deletedFines = [];
    save();
    saveDeletedFines();
    closeModal('confirmModal');
    toast('All fines cleared. Dashboard reset to ₱0.', 'info');
    renderAll();
  };
  openModal('confirmModal');
}

function manualScanCheckin() {
  const id = document.getElementById('manualScanId').value.trim();
  if (!id) return;
  processBarcodeCheckin(id);
  document.getElementById('manualScanId').value = '';
}

function showScanResult(type, html) {
  const box = document.getElementById('scanResultBox');
  box.className = 'scan-result-box ' + type;
  box.innerHTML = html;
  clearTimeout(window._scanResultTimer);
  window._scanResultTimer = setTimeout(() => clearScanResult(), 4000);
}

function clearScanResult() {
  const box = document.getElementById('scanResultBox');
  if (box) { box.className = 'scan-result-box'; box.innerHTML = ''; }
}

// ═══════════════════════════════
// CHECKOUT (Student)
// ═══════════════════════════════
let checkoutEventId = null;
let checkoutStream = null;
let checkoutDataUrl = null;

function openCheckoutModal(eventId) {
  if (!currentUser) return;
  checkoutEventId = eventId;
  checkoutDataUrl = null;
  const ev = events.find(e => e.id === eventId);
  document.getElementById('checkoutEventLabel').innerHTML = `
    <i class="fas fa-calendar-day" style="color:var(--accent);"></i>
    <strong style="color:var(--text); margin-left:6px;">${ev ? ev.name : 'Event'}</strong>
    <span style="margin-left:8px; font-family:var(--mono);">${ev ? formatDate(ev.date) : ''}</span>`;

  // Reset UI
  document.getElementById('checkoutCameraBox').style.display = 'block';
  document.getElementById('checkoutPreviewWrap').style.display = 'none';
  document.getElementById('checkoutCameraError').style.display = 'none';
  document.getElementById('checkoutCaptureBtn').style.display = '';
  document.getElementById('checkoutRetakeBtn').style.display = 'none';
  document.getElementById('checkoutConfirmBtn').style.display = 'none';
  document.getElementById('checkoutSkipPhotoBtn').style.display = '';
  document.getElementById('checkoutCameraCanvas').style.display = 'none';
  document.getElementById('checkoutCameraFeed').style.display = 'block';

  openModal('checkoutModal');
  startCheckoutCamera();
}

async function startCheckoutCamera() {
  const errEl = document.getElementById('checkoutCameraError');
  try {
    // Use environment camera first on mobile, fallback to user
    const constraints = [
      { video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
      { video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
      { video: true, audio: false }
    ];
    let stream = null;
    for (const c of constraints) {
      try { stream = await navigator.mediaDevices.getUserMedia(c); break; } catch(e) {}
    }
    if (!stream) throw new Error('No camera');
    checkoutStream = stream;
    const video = document.getElementById('checkoutCameraFeed');
    video.srcObject = stream;
    await video.play();
    errEl.style.display = 'none';
  } catch(e) {
    errEl.textContent = 'Camera not accessible. Use "Skip Photo & Check Out" to continue.';
    errEl.style.display = 'block';
    document.getElementById('checkoutCaptureBtn').style.display = 'none';
  }
}

function stopCheckoutCamera() {
  if (checkoutStream) {
    checkoutStream.getTracks().forEach(t => t.stop());
    checkoutStream = null;
  }
}

function checkoutCapture() {
  const video = document.getElementById('checkoutCameraFeed');
  const canvas = document.getElementById('checkoutCameraCanvas');
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  // Timestamp overlay
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  const tsText = `CHECK-OUT  ${dateStr}  ${timeStr}`;
  const padding = 10;
  const fontSize = Math.max(13, Math.floor(canvas.width / 38));
  ctx.font = `bold ${fontSize}px monospace`;
  const textW = ctx.measureText(tsText).width;
  const boxH = fontSize + padding * 2;
  const boxW = textW + padding * 2;
  ctx.fillStyle = 'rgba(220,38,38,0.80)';
  ctx.fillRect(8, canvas.height - boxH - 8, boxW, boxH);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(tsText, 8 + padding, canvas.height - 8 - padding);
  ctx.fillStyle = '#fca5a5';
  ctx.fillRect(8, canvas.height - 8, boxW, 3);

  checkoutDataUrl = canvas.toDataURL('image/jpeg', 0.82);

  document.getElementById('checkoutPreviewImg').src = checkoutDataUrl;
  document.getElementById('checkoutPreviewWrap').style.display = 'block';
  document.getElementById('checkoutCameraBox').style.display = 'none';
  document.getElementById('checkoutCaptureBtn').style.display = 'none';
  document.getElementById('checkoutRetakeBtn').style.display = '';
  document.getElementById('checkoutConfirmBtn').style.display = '';
  document.getElementById('checkoutSkipPhotoBtn').style.display = 'none';
  stopCheckoutCamera();
}

function checkoutRetake() {
  checkoutDataUrl = null;
  document.getElementById('checkoutCameraBox').style.display = 'block';
  document.getElementById('checkoutPreviewWrap').style.display = 'none';
  document.getElementById('checkoutCaptureBtn').style.display = '';
  document.getElementById('checkoutRetakeBtn').style.display = 'none';
  document.getElementById('checkoutConfirmBtn').style.display = 'none';
  document.getElementById('checkoutSkipPhotoBtn').style.display = '';
  startCheckoutCamera();
}

function confirmCheckout(withPhoto) {
  if (!currentUser || !checkoutEventId) return;
  const coKey = currentUser.studentId + '_' + checkoutEventId;
  checkouts[coKey] = { time: new Date().toISOString(), studentId: currentUser.studentId, eventId: checkoutEventId };
  if (withPhoto && checkoutDataUrl) {
    const coPhotoKey = 'co_' + coKey;
    photos[coPhotoKey] = checkoutDataUrl;
    syncPhoto(coPhotoKey, checkoutDataUrl);
    checkouts[coKey].hasPhoto = true;
  }
  save();
  stopCheckoutCamera();
  closeModal('checkoutModal');
  toast('✅ Checked out successfully!', 'success');
  renderStudentPortal();
}

function closeCheckoutModal() {
  stopCheckoutCamera();
  closeModal('checkoutModal');
}

// ═══════════════════════════════
// STEP 2 INLINE SELFIE (student portal)
// ═══════════════════════════════
const step2Streams = {}; // eventId → MediaStream

async function step2StartCamera(eventId) {
  const video = document.getElementById('step2vid_' + eventId);
  const errEl = document.getElementById('step2err_' + eventId);
  if (!video) return;
  try {
    const constraints = [
      { video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
      { video: { facingMode: 'user' }, audio: false },
      { video: { facingMode: { ideal: 'user' } }, audio: false },
      { video: true, audio: false }
    ];
    let stream = null;
    for (const c of constraints) {
      try { stream = await navigator.mediaDevices.getUserMedia(c); break; } catch(e) {}
    }
    if (!stream) throw new Error('No camera');
    step2Streams[eventId] = stream;
    video.srcObject = stream;
    await video.play().catch(() => {});
    if (errEl) errEl.style.display = 'none';
  } catch(e) {
    if (errEl) {
      errEl.textContent = 'Camera not accessible. Please allow camera access in browser settings.';
      errEl.style.display = 'block';
    }
    const captureBtn = document.getElementById('step2capture_' + eventId);
    if (captureBtn) captureBtn.style.display = 'none';
  }
}

function step2StopCamera(eventId) {
  const stream = step2Streams[eventId];
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    delete step2Streams[eventId];
  }
}

function step2Capture(eventId) {
  const video = document.getElementById('step2vid_' + eventId);
  const canvas = document.getElementById('step2canvas_' + eventId);
  if (!video || !canvas) return;

  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  // Timestamp overlay
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  const tsText = `${dateStr}  ${timeStr}`;
  const padding = 10;
  const fontSize = Math.max(13, Math.floor(canvas.width / 36));
  ctx.font = `bold ${fontSize}px monospace`;
  const textW = ctx.measureText(tsText).width;
  const boxH = fontSize + padding * 2;
  const boxW = textW + padding * 2;
  ctx.fillStyle = 'rgba(8,43,28,0.75)';
  ctx.fillRect(8, canvas.height - boxH - 8, boxW, boxH);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(tsText, 8 + padding, canvas.height - 8 - padding);
  ctx.fillStyle = '#22d48a';
  ctx.fillRect(8, canvas.height - 8, boxW, 3);

  const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
  canvas._step2DataUrl = dataUrl;

  // Show preview
  const camWrap = document.getElementById('step2cam_' + eventId);
  const preview = document.getElementById('step2preview_' + eventId);
  const previewImg = document.getElementById('step2img_' + eventId);
  if (camWrap) camWrap.style.display = 'none';
  if (preview) preview.style.display = 'block';
  if (previewImg) previewImg.src = dataUrl;

  document.getElementById('step2capture_' + eventId).style.display = 'none';
  document.getElementById('step2retake_' + eventId).style.display = '';
  document.getElementById('step2confirm_' + eventId).style.display = '';

  step2StopCamera(eventId);
}

function step2Retake(eventId) {
  const camWrap = document.getElementById('step2cam_' + eventId);
  const preview = document.getElementById('step2preview_' + eventId);
  if (camWrap) camWrap.style.display = 'block';
  if (preview) preview.style.display = 'none';

  document.getElementById('step2capture_' + eventId).style.display = '';
  document.getElementById('step2retake_' + eventId).style.display = 'none';
  document.getElementById('step2confirm_' + eventId).style.display = 'none';

  step2StartCamera(eventId);
}

function step2Confirm(eventId) {
  if (!currentUser) return;
  const canvas = document.getElementById('step2canvas_' + eventId);
  const dataUrl = canvas && canvas._step2DataUrl;
  if (!dataUrl) return;

  const photoKey = currentUser.studentId + '_' + eventId;
  photos[photoKey] = dataUrl;
  syncPhoto(photoKey, dataUrl);

  // Clear pending selfie flag
  pendingSelfieEventId = null;
  const pendingKey = 'ap_pending_selfie_' + currentUser.studentId;
  localStorage.removeItem(pendingKey);

  step2StopCamera(eventId);
  toast('📸 Selfie saved as backup evidence!', 'success');
  renderStudentPortal();
}

function step2Skip(eventId) {
  step2StopCamera(eventId);
  // Clear pending selfie flag
  pendingSelfieEventId = null;
  const pendingKey = 'ap_pending_selfie_' + (currentUser ? currentUser.studentId : '');
  localStorage.removeItem(pendingKey);
  renderStudentPortal();
}

// Close selfie modal on overlay click (override default to also stop camera)
document.getElementById('selfieModal').addEventListener('click', e => {
  if (e.target === document.getElementById('selfieModal')) closeSelfieModal();
});

// Close student scan modal on overlay click
document.getElementById('studentScanModal').addEventListener('click', e => {
  if (e.target === document.getElementById('studentScanModal')) closeStudentScanModal();
});

// Close modals on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay && overlay.id !== 'selfieModal' && overlay.id !== 'barcodeScanModal' && overlay.id !== 'studentScanModal' && overlay.id !== 'checkoutModal') overlay.classList.remove('open');
  });
});

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.open').forEach(m => {
      if (m.id === 'selfieModal') closeSelfieModal();
      else if (m.id === 'barcodeScanModal') closeScannerModal();
      else if (m.id === 'studentScanModal') closeStudentScanModal();
      else if (m.id === 'checkoutModal') closeCheckoutModal();
      else m.classList.remove('open');
    });
    closeLightbox();
    stopCamera();
    adminStopCamera();
  }
});

// Close scanner modal on overlay click
document.getElementById('barcodeScanModal').addEventListener('click', e => {
  if (e.target === document.getElementById('barcodeScanModal')) closeScannerModal();
});
