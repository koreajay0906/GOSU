const DRAFT_STORAGE_KEY = 'gosu_direct_scheduler_draft_v2';
const PRINT_LIMIT_PX = 140;
const MAX_HISTORY = 50;

let supabaseClient = null;
let currentUser = null;
let cachedOnlineSchedules = [];

let scheduleData = {};
let selectedDates = new Set();

// Undo / Redo 히스토리 스택
let undoStack = [];
let redoStack = [];
let focusStartSnapshot = null;
let typingDebounceTimer = null;

// 마우스 드래그 및 선택 상태
let isMouseDown = false;
let isDraggingRange = false;
let isCtrlClicking = false;
let dragStartCell = null;

// 내부 클립보드
let copiedCells = [];
let lastCopiedPlainText = '';

function getSupabaseClient() {
  if (!window.supabase) return null;
  if (!supabaseClient) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return supabaseClient;
}

window.onload = async function () {
  loadDraftFromLocalStorage();
  renderCalendar();
  setupGlobalEvents();
  await initAuthSession();
};

/* =========================================================
   1. Supabase 인증 (로그인 / 회원가입 / 로그아웃)
   ========================================================= */
async function initAuthSession() {
  const client = getSupabaseClient();
  if (!client) {
    showAuthScreen('Supabase 라이브러리를 불러오지 못했습니다.');
    return;
  }

  const { data } = await client.auth.getSession();
  if (data?.session?.user) {
    currentUser = data.session.user;
    showAppShell();
  } else {
    showAuthScreen('');
  }

  client.auth.onAuthStateChange((_event, session) => {
    if (session?.user) {
      currentUser = session.user;
      showAppShell();
    } else {
      currentUser = null;
      showAuthScreen('');
    }
  });
}

function showAuthScreen(message) {
  document.getElementById('authScreen').classList.remove('hidden');
  const appShell = document.getElementById('appShell');
  appShell.classList.add('hidden');
  appShell.classList.remove('is-ready');

  const msgEl = document.getElementById('authMessage');
  if (msgEl) {
    msgEl.textContent = message || '';
    msgEl.style.color = '#e74c3c';
  }
}

function showAppShell() {
  document.getElementById('authScreen').classList.add('hidden');
  const appShell = document.getElementById('appShell');
  appShell.classList.remove('hidden');
  appShell.classList.add('is-ready');
  checkAllCellsOverflow();
}

async function handleAuth(mode) {
  const client = getSupabaseClient();
  if (!client) return;

  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const msgEl = document.getElementById('authMessage');

  if (!email || !password) {
    msgEl.textContent = '이메일과 비밀번호를 입력해 주세요.';
    msgEl.style.color = '#e74c3c';
    return;
  }

  msgEl.textContent = '처리 중...';
  msgEl.style.color = '#4a90e2';

  if (mode === 'signUp') {
    const { error } = await client.auth.signUp({ email, password });
    if (error) {
      msgEl.textContent = error.message;
      msgEl.style.color = '#e74c3c';
      return;
    }
    msgEl.textContent = '회원가입이 완료되었습니다. 로그인을 눌러 주세요.';
    msgEl.style.color = '#2563eb';
    return;
  }

  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    msgEl.textContent = '로그인 실패: 이메일 또는 비밀번호를 확인해 주세요.';
    msgEl.style.color = '#e74c3c';
    return;
  }

  if (data?.session) {
    currentUser = data.session.user;
    showAppShell();
  }
}

async function handleLogout() {
  const client = getSupabaseClient();
  if (!client) return;
  if (!confirm('로그아웃하시겠습니까?')) return;

  const { error } = await client.auth.signOut();
  if (error) {
    alert(`로그아웃 오류: ${error.message}`);
  } else {
    currentUser = null;
    closeOnlineList();
    showAuthScreen('로그아웃되었습니다.');
  }
}

/* =========================================================
   2. 온라인 시간표 저장 / 목록 조회 / 불러오기 / 삭제
   ========================================================= */
async function saveToOnline() {
  const client = getSupabaseClient();
  if (!client || !currentUser) {
    alert('로그인한 사용자만 저장할 수 있습니다.');
    return;
  }

  const name = document.getElementById('studentName').value.trim() || '이름없음';
  const startDate = document.getElementById('startDateInput').value;
  const endDate = document.getElementById('endDateInput').value;

  if (!startDate || !endDate) {
    alert('달력 시작일을 먼저 설정해 주세요.');
    return;
  }

  const { error } = await client.from('schedules').insert([
    {
      owner_id: currentUser.id,
      student_name: name,
      start_date: startDate,
      end_date: endDate,
      monthly_database: scheduleData,
      font_size: '9.5px',
    },
  ]);

  if (error) {
    alert(`온라인 저장에 실패했습니다: ${error.message}`);
    return;
  }

  showToast(`☁️ ${name} 학생의 시간표를 온라인에 저장했습니다.`);
  if (document.getElementById('appShell').classList.contains('show-online-panel')) {
    fetchOnlineSchedules();
  }
}

function toggleOnlineList() {
  const appShell = document.getElementById('appShell');
  if (appShell.classList.contains('show-online-panel')) {
    closeOnlineList();
  } else {
    openOnlineList();
  }
}

async function openOnlineList() {
  const client = getSupabaseClient();
  if (!client || !currentUser) {
    alert('로그인한 사용자만 목록을 볼 수 있습니다.');
    return;
  }

  document.getElementById('appShell').classList.add('show-online-panel');
  const searchInput = document.getElementById('onlineSearchInput');
  if (searchInput) searchInput.value = '';
  await fetchOnlineSchedules();
}

function closeOnlineList() {
  document.getElementById('appShell').classList.remove('show-online-panel');
}

async function fetchOnlineSchedules() {
  const client = getSupabaseClient();
  const body = document.getElementById('onlineListBody');
  body.innerHTML = '<div class="online-loading">☁️ 목록을 불러오는 중...</div>';

  const { data, error } = await client
    .from('schedules')
    .select('id, student_name, start_date, end_date, created_at')
    .order('created_at', { ascending: false });

  if (error) {
    body.innerHTML = `<div class="online-empty">목록 조회 오류: ${error.message}</div>`;
    return;
  }

  cachedOnlineSchedules = data || [];
  renderOnlineScheduleCards(cachedOnlineSchedules);
}

function filterOnlineSchedules() {
  const keyword = (document.getElementById('onlineSearchInput')?.value || '').trim().toLowerCase();
  if (!keyword) {
    renderOnlineScheduleCards(cachedOnlineSchedules);
    return;
  }
  const filtered = cachedOnlineSchedules.filter((item) =>
    (item.student_name || '').toLowerCase().includes(keyword)
  );
  renderOnlineScheduleCards(filtered);
}

function renderOnlineScheduleCards(list) {
  const body = document.getElementById('onlineListBody');
  if (!list || list.length === 0) {
    body.innerHTML = '<div class="online-empty">저장된 시간표가 없습니다.</div>';
    return;
  }

  body.innerHTML = list
    .map((item) => {
      const created = formatCreatedAt(item.created_at);
      const safeName = escapeHtml(item.student_name || '이름없음');
      return `
        <div class="online-card">
          <div class="online-card-main">
            <div class="online-card-title">
              <span class="student-badge">학생</span>
              <strong>${safeName}</strong>
            </div>
            <div class="online-card-meta">
              <span>📅 ${item.start_date} ~ ${item.end_date}</span>
              <span>🕒 저장: ${created}</span>
            </div>
          </div>
          <div class="online-card-actions">
            <button type="button" class="btn-card-load" onclick="loadFromOnline('${item.id}')">불러오기</button>
            <button type="button" class="btn-card-delete" onclick="deleteFromOnline('${item.id}', '${safeName.replace(/'/g, "\'")}')">삭제</button>
          </div>
        </div>
      `;
    })
    .join('');
}

async function loadFromOnline(id) {
  const client = getSupabaseClient();
  if (!client) return;

  const { data, error } = await client
    .from('schedules')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) {
    alert(`시간표를 불러오지 못했습니다: ${error?.message || ''}`);
    return;
  }

  pushHistorySnapshot();

  document.getElementById('studentName').value = data.student_name || '';
  if (data.start_date) {
    const s = parseDate(data.start_date);
    document.getElementById('startDateInput').value = formatDate(s);
    document.getElementById('endDateInput').value = formatDate(addOneMonth(s));
  }

  scheduleData = data.monthly_database || {};
  selectedDates.clear();
  saveDraftToLocalStorage();
  renderCalendar();
  showToast(`📂 ${data.student_name} 학생의 시간표를 불러왔습니다.`);
}

async function deleteFromOnline(id, name) {
  const client = getSupabaseClient();
  if (!client) return;
  if (!confirm(`'${name}' 학생의 저장된 시간표를 삭제할까요?`)) return;

  const { error } = await client.from('schedules').delete().eq('id', id);
  if (error) {
    alert(`삭제에 실패했습니다: ${error.message}`);
    return;
  }

  showToast(`🗑️ '${name}' 시간표가 삭제되었습니다.`);
  fetchOnlineSchedules();
}

function formatCreatedAt(isoStr) {
  if (!isoStr) return '-';
  const d = new Date(isoStr);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}.${mm}.${dd} ${hh}:${min}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* =========================================================
   3. 실행 취소(Ctrl+Z) / 다시 실행(Ctrl+Y) 히스토리 관리
   ========================================================= */
function cloneScheduleData(obj) {
  return JSON.parse(JSON.stringify(obj || {}));
}

function pushHistorySnapshot(snapshot = null) {
  const snap = snapshot ? cloneScheduleData(snapshot) : cloneScheduleData(scheduleData);
  const serialized = JSON.stringify(snap);

  if (undoStack.length > 0 && JSON.stringify(undoStack[undoStack.length - 1]) === serialized) {
    return;
  }

  undoStack.push(snap);
  if (undoStack.length > MAX_HISTORY) {
    undoStack.shift();
  }
  redoStack = [];
}

function applySnapshotToDOM(snapshot) {
  scheduleData = cloneScheduleData(snapshot);
  document.querySelectorAll('td.date-cell').forEach((td) => {
    const dateStr = td.dataset.date;
    const cellData = scheduleData[dateStr] || { text: '', fontSize: '9.5px' };
    const editor = td.querySelector('.cell-editor');
    if (editor) {
      editor.innerText = cellData.text || '';
      editor.style.fontSize = cellData.fontSize || '9.5px';
    }
    checkCellOverflow(td);
  });
  syncSelectionUI();
  saveDraftToLocalStorage();
  focusStartSnapshot = cloneScheduleData(scheduleData);
}

function performUndo() {
  if (undoStack.length === 0) {
    showToast('더 이상 되돌릴 작업이 없습니다.');
    return;
  }

  redoStack.push(cloneScheduleData(scheduleData));
  const prev = undoStack.pop();
  applySnapshotToDOM(prev);
  showToast('↩️ 실행 취소 (Ctrl+Z)');
}

function performRedo() {
  if (redoStack.length === 0) {
    showToast('다시 실행할 작업이 없습니다.');
    return;
  }

  undoStack.push(cloneScheduleData(scheduleData));
  const next = redoStack.pop();
  applySnapshotToDOM(next);
  showToast('↪️ 다시 실행 (Ctrl+Y)');
}

/* =========================================================
   4. 날짜 계산 및 달력 렌더링
   ========================================================= */
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseDate(str) {
  if (!str) return null;
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addOneMonth(date) {
  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const lastDayOfNextMonth = new Date(year, month + 2, 0).getDate();
  return new Date(year, month + 1, Math.min(day, lastDayOfNextMonth));
}

function initDefaultDates() {
  const today = new Date();
  const end = addOneMonth(today);
  document.getElementById('startDateInput').value = formatDate(today);
  document.getElementById('endDateInput').value = formatDate(end);
}

function onStartDateChange() {
  const s = parseDate(document.getElementById('startDateInput').value);
  if (s) {
    const e = addOneMonth(s);
    document.getElementById('endDateInput').value = formatDate(e);
  } else {
    initDefaultDates();
  }
  renderCalendar();
}

function updateHeaderAndSaveDraft() {
  const name = document.getElementById('studentName').value.trim();
  document.getElementById('calendarTitle').innerText = name
    ? `${name} 공부 시간표`
    : '공부 시간표를 작성해 주세요';

  const s = parseDate(document.getElementById('startDateInput').value);
  if (s) {
    const e = addOneMonth(s);
    document.getElementById('endDateInput').value = formatDate(e);
    document.getElementById('calendarSubtitle').innerText =
      `${formatDate(s).replace(/-/g, '.')} ~ ${formatDate(e).replace(/-/g, '.')}`;
  }
  saveDraftToLocalStorage();
}

function checkCellOverflow(td) {
  if (!td) return;
  const editor = td.querySelector('.cell-editor');
  if (!editor) return;
  if (editor.scrollHeight > PRINT_LIMIT_PX) {
    td.classList.add('overflow-warning');
  } else {
    td.classList.remove('overflow-warning');
  }
}

function checkAllCellsOverflow() {
  document.querySelectorAll('td.date-cell').forEach((td) => checkCellOverflow(td));
}

function renderCalendar() {
  const startDate = parseDate(document.getElementById('startDateInput').value);
  if (!startDate) return;

  const endDate = addOneMonth(startDate);
  document.getElementById('endDateInput').value = formatDate(endDate);

  updateHeaderAndSaveDraft();

  const container = document.getElementById('calendarBody');
  container.innerHTML = '';

  const table = document.createElement('table');
  table.className = 'calendar-table';

  const thead = document.createElement('thead');
  const headTr = document.createElement('tr');
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];

  dayNames.forEach((dayLabel, colIdx) => {
    const th = document.createElement('th');
    th.innerText = dayLabel;
    th.dataset.col = colIdx;
    th.title = '클릭: 해당 요일 전체 선택 / Ctrl+클릭: 요일 추가·해제';

    th.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (document.activeElement && document.activeElement.classList.contains('cell-editor')) {
        document.activeElement.blur();
      }

      const colCells = Array.from(document.querySelectorAll(`td.date-cell[data-col="${colIdx}"]`));
      const colDates = colCells.map((cell) => cell.dataset.date);

      if (e.ctrlKey || e.metaKey) {
        const allSelected = colDates.every((d) => selectedDates.has(d));
        if (allSelected) {
          colDates.forEach((d) => selectedDates.delete(d));
        } else {
          colDates.forEach((d) => selectedDates.add(d));
        }
      } else {
        selectedDates.clear();
        colDates.forEach((d) => selectedDates.add(d));
      }

      syncSelectionUI();
      if (selectedDates.size > 0) {
        showToast(`${dayLabel}요일 선택 (${selectedDates.size}개 칸 선택됨)`);
      }
    });

    headTr.appendChild(th);
  });
  thead.appendChild(headTr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  let row = document.createElement('tr');
  let rowIndex = 0;

  for (let i = 0; i < startDate.getDay(); i++) {
    const emptyTd = document.createElement('td');
    emptyTd.className = 'empty';
    row.appendChild(emptyTd);
  }

  const cursor = new Date(startDate);
  while (cursor <= endDate) {
    if (row.childElementCount === 7) {
      tbody.appendChild(row);
      row = document.createElement('tr');
      rowIndex++;
    }

    const dateStr = formatDate(cursor);
    const colIndex = cursor.getDay();
    const cellData = scheduleData[dateStr] || { text: '', fontSize: '9.5px' };

    const td = document.createElement('td');
    td.className = 'date-cell';
    if (colIndex === 0) td.classList.add('sun-cell');
    else if (colIndex === 6) td.classList.add('sat-cell');
    else td.classList.add('weekday-cell');

    if (selectedDates.has(dateStr)) {
      td.classList.add('selected');
    }

    td.dataset.date = dateStr;
    td.dataset.row = rowIndex;
    td.dataset.col = colIndex;

    const header = document.createElement('div');
    header.className = 'date-header';
    header.innerHTML = `
      <div class="date-month-tag">${String(cursor.getMonth() + 1).padStart(2, '0')}월</div>
      <div class="date-day-tag">${cursor.getDate()}일</div>
    `;

    const editor = document.createElement('div');
    editor.className = 'cell-editor';
    editor.contentEditable = 'true';
    editor.style.fontSize = cellData.fontSize || '9.5px';
    editor.innerText = cellData.text || '';

    const badge = document.createElement('div');
    badge.className = 'overflow-badge';
    badge.innerText = '⚠️ 인쇄 잘림 주의';

    editor.addEventListener('focus', () => {
      focusStartSnapshot = cloneScheduleData(scheduleData);
      if (!isDraggingRange && !isCtrlClicking) {
        selectedDates.clear();
        selectedDates.add(dateStr);
        syncSelectionUI();
      }
    });

    editor.addEventListener('input', () => {
      if (focusStartSnapshot) {
        pushHistorySnapshot(focusStartSnapshot);
        focusStartSnapshot = null;
      }

      if (!scheduleData[dateStr]) {
        scheduleData[dateStr] = { text: '', fontSize: editor.style.fontSize || '9.5px' };
      }
      scheduleData[dateStr].text = editor.innerText;
      checkCellOverflow(td);
      saveDraftToLocalStorage();

      clearTimeout(typingDebounceTimer);
      typingDebounceTimer = setTimeout(() => {
        focusStartSnapshot = cloneScheduleData(scheduleData);
      }, 800);
    });

    editor.addEventListener('paste', (e) => {
      const plain = e.clipboardData.getData('text/plain');
      if (copiedCells.length > 0 && plain === lastCopiedPlainText) {
        e.preventDefault();
        pasteCopiedCells();
        return;
      }
      e.preventDefault();
      pushHistorySnapshot();
      document.execCommand('insertText', false, plain);
    });

    td.addEventListener('mousedown', (e) => {
      isMouseDown = true;
      isDraggingRange = false;
      dragStartCell = td;

      if (e.ctrlKey || e.metaKey) {
        isCtrlClicking = true;
        e.preventDefault();
        if (selectedDates.has(dateStr)) {
          selectedDates.delete(dateStr);
        } else {
          selectedDates.add(dateStr);
        }
        syncSelectionUI();
      } else {
        isCtrlClicking = false;
        if (!selectedDates.has(dateStr) || selectedDates.size > 1) {
          selectedDates.clear();
          selectedDates.add(dateStr);
          syncSelectionUI();
        }
      }
    });

    td.addEventListener('mouseover', () => {
      if (!isMouseDown || !dragStartCell) return;
      if (dragStartCell === td && !isDraggingRange) return;
      isDraggingRange = true;

      window.getSelection().removeAllRanges();
      if (document.activeElement) document.activeElement.blur();

      const d1 = dragStartCell.dataset.date;
      const d2 = td.dataset.date;
      const minDate = d1 < d2 ? d1 : d2;
      const maxDate = d1 < d2 ? d2 : d1;

      selectedDates.clear();
      document.querySelectorAll('td.date-cell').forEach((cell) => {
        const d = cell.dataset.date;
        if (d >= minDate && d <= maxDate) {
          selectedDates.add(d);
        }
      });
      syncSelectionUI();
    });

    td.appendChild(header);
    td.appendChild(editor);
    td.appendChild(badge);
    row.appendChild(td);

    cursor.setDate(cursor.getDate() + 1);
  }

  while (row.childElementCount < 7) {
    const emptyTd = document.createElement('td');
    emptyTd.className = 'empty';
    row.appendChild(emptyTd);
  }
  tbody.appendChild(row);
  table.appendChild(tbody);
  container.appendChild(table);

  syncSelectionUI();
  checkAllCellsOverflow();
}

/* =========================================================
   5. 선택 서식 및 복사 / 붙여넣기 (헤더 열 복붙 포함)
   ========================================================= */
function syncSelectionUI() {
  document.querySelectorAll('td.date-cell').forEach((td) => {
    if (selectedDates.has(td.dataset.date)) {
      td.classList.add('selected');
    } else {
      td.classList.remove('selected');
    }
  });

  const statusEl = document.getElementById('selectionStatus');
  if (selectedDates.size === 0) {
    statusEl.innerText = '선택된 칸: 0개';
  } else if (selectedDates.size === 1) {
    const [onlyDate] = selectedDates;
    statusEl.innerText = `선택된 칸: ${onlyDate} (1개)`;
  } else {
    statusEl.innerText = `선택된 칸: ${selectedDates.size}개 (일괄 서식/복붙 가능)`;
  }

  const fontBtns = document.querySelectorAll('.font-btn');
  fontBtns.forEach((btn) => btn.classList.remove('active'));

  if (selectedDates.size > 0) {
    const sizes = new Set();
    selectedDates.forEach((dateStr) => {
      const size = (scheduleData[dateStr] && scheduleData[dateStr].fontSize) || '9.5px';
      sizes.add(size);
    });

    if (sizes.size === 1) {
      const [commonSize] = sizes;
      fontBtns.forEach((btn) => {
        if (btn.dataset.size === commonSize) {
          btn.classList.add('active');
        }
      });
    }
  }
}

function applyFontSizeToSelected(size) {
  if (selectedDates.size === 0) {
    showToast('먼저 달력에서 날짜 칸을 선택해 주세요.');
    return;
  }

  pushHistorySnapshot();

  selectedDates.forEach((dateStr) => {
    if (!scheduleData[dateStr]) {
      scheduleData[dateStr] = { text: '', fontSize: size };
    } else {
      scheduleData[dateStr].fontSize = size;
    }

    const td = document.querySelector(`td.date-cell[data-date="${dateStr}"]`);
    if (td) {
      const editor = td.querySelector('.cell-editor');
      if (editor) editor.style.fontSize = size;
      checkCellOverflow(td);
    }
  });

  syncSelectionUI();
  saveDraftToLocalStorage();
  showToast(`선택한 ${selectedDates.size}개 칸의 글자 크기를 ${size}로 변경했습니다.`);
}

function copySelectedCells() {
  if (selectedDates.size === 0) return;

  const allCells = Array.from(document.querySelectorAll('td.date-cell'));
  const selectedElements = allCells.filter((el) => el.classList.contains('selected'));
  if (selectedElements.length === 0) return;

  const minIndex = Math.min(...selectedElements.map((el) => allCells.indexOf(el)));

  copiedCells = selectedElements.map((el) => {
    const dateStr = el.dataset.date;
    const data = scheduleData[dateStr] || { text: '', fontSize: '9.5px' };
    return {
      dIndex: allCells.indexOf(el) - minIndex,
      text: data.text || '',
      fontSize: data.fontSize || '9.5px',
    };
  });

  lastCopiedPlainText = copiedCells.map((c) => c.text).join('
');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(lastCopiedPlainText).catch(() => {});
  }

  showToast(`${copiedCells.length}개 칸이 복사되었습니다. (Ctrl+V로 붙여넣기)`);
}

function pasteCopiedCells() {
  if (copiedCells.length === 0 || selectedDates.size === 0) return;

  pushHistorySnapshot();

  // 1칸만 복사된 경우: 선택된 모든 칸(드래그 범위, 요일 헤더 열 등)에 동일하게 붙여넣기
  if (copiedCells.length === 1 && selectedDates.size >= 1) {
    const src = copiedCells[0];
    selectedDates.forEach((dateStr) => {
      scheduleData[dateStr] = { text: src.text, fontSize: src.fontSize };
      const td = document.querySelector(`td.date-cell[data-date="${dateStr}"]`);
      if (td) {
        const editor = td.querySelector('.cell-editor');
        editor.innerText = src.text;
        editor.style.fontSize = src.fontSize;
        checkCellOverflow(td);
      }
    });
    syncSelectionUI();
    saveDraftToLocalStorage();
    showToast(`${selectedDates.size}개 칸에 붙여넣었습니다.`);
    return;
  }

  const allCells = Array.from(document.querySelectorAll('td.date-cell'));
  const selectedElements = allCells.filter((el) => el.classList.contains('selected'));
  if (selectedElements.length === 0) return;

  // 요일 헤더 등 여러 칸을 선택한 상태이고 복사한 칸 수와 같을 때: 순서대로 매칭해 붙여넣기
  if (selectedElements.length > 1 && selectedElements.length === copiedCells.length) {
    selectedElements.forEach((targetTd, i) => {
      const item = copiedCells[i];
      const dateStr = targetTd.dataset.date;
      scheduleData[dateStr] = { text: item.text, fontSize: item.fontSize };
      const editor = targetTd.querySelector('.cell-editor');
      editor.innerText = item.text;
      editor.style.fontSize = item.fontSize;
      checkCellOverflow(targetTd);
    });
    syncSelectionUI();
    saveDraftToLocalStorage();
    showToast(`${selectedElements.length}개 칸에 순서대로 붙여넣었습니다.`);
    return;
  }

  // 기준(Anchor) 날짜부터 상대 간격대로 붙여넣기
  const baseIndex = allCells.indexOf(selectedElements[0]);
  let pastedCount = 0;

  copiedCells.forEach((item) => {
    const targetTd = allCells[baseIndex + item.dIndex];
    if (targetTd) {
      const dateStr = targetTd.dataset.date;
      scheduleData[dateStr] = { text: item.text, fontSize: item.fontSize };
      const editor = targetTd.querySelector('.cell-editor');
      editor.innerText = item.text;
      editor.style.fontSize = item.fontSize;
      checkCellOverflow(targetTd);
      pastedCount++;
    }
  });

  syncSelectionUI();
  saveDraftToLocalStorage();
  showToast(`${pastedCount}개 칸에 붙여넣었습니다.`);
}

/* =========================================================
   6. 전역 단축키 및 로컬 임시 저장
   ========================================================= */
function setupGlobalEvents() {
  window.addEventListener('resize', checkAllCellsOverflow);

  window.addEventListener('mouseup', () => {
    if (isMouseDown && !isDraggingRange && !isCtrlClicking && dragStartCell && selectedDates.size === 1) {
      const editor = dragStartCell.querySelector('.cell-editor');
      if (editor && document.activeElement !== editor) {
        editor.focus();
      }
    }
    isMouseDown = false;
    isDraggingRange = false;
    isCtrlClicking = false;
    dragStartCell = null;
  });

  document.addEventListener('keydown', (e) => {
    // 로그인 화면이 열려 있을 때는 단축키 동작 안 함
    if (!document.getElementById('appShell').classList.contains('is-ready')) return;

    const isCmdOrCtrl = e.ctrlKey || e.metaKey;
    const textSelection = window.getSelection().toString();
    const keyLower = e.key.toLowerCase();

    // 실행 취소 (Ctrl+Z) / 다시 실행 (Ctrl+Y 또는 Ctrl+Shift+Z)
    if (isCmdOrCtrl && (e.code === 'KeyZ' || keyLower === 'z')) {
      e.preventDefault();
      if (e.shiftKey) {
        performRedo();
      } else {
        performUndo();
      }
      return;
    }

    if (isCmdOrCtrl && (e.code === 'KeyY' || keyLower === 'y')) {
      e.preventDefault();
      performRedo();
      return;
    }

    // Tab / Shift+Tab 칸 이동
    if (e.key === 'Tab') {
      const activeEditor = document.activeElement?.classList.contains('cell-editor')
        ? document.activeElement
        : null;
      const currentSelectedTd = document.querySelector('td.date-cell.selected');

      if (activeEditor || currentSelectedTd) {
        const allEditors = Array.from(document.querySelectorAll('.cell-editor'));
        const currentEditor = activeEditor || currentSelectedTd.querySelector('.cell-editor');
        const idx = allEditors.indexOf(currentEditor);

        if (idx !== -1) {
          const nextIdx = e.shiftKey ? idx - 1 : idx + 1;
          if (nextIdx >= 0 && nextIdx < allEditors.length) {
            e.preventDefault();
            const targetEditor = allEditors[nextIdx];
            targetEditor.focus();

            const range = document.createRange();
            const sel = window.getSelection();
            range.selectNodeContents(targetEditor);
            range.collapse(false);
            sel.removeAllRanges();
            sel.addRange(range);
          }
        }
      }
    }

    // 복사 (Ctrl+C) — 한글 입력기 상태 호환
    if (isCmdOrCtrl && (e.code === 'KeyC' || keyLower === 'c')) {
      if (selectedDates.size > 1 || (selectedDates.size === 1 && textSelection === '')) {
        e.preventDefault();
        copySelectedCells();
      }
    }

    // 붙여넣기 (Ctrl+V) — 헤더 열 선택 상태 및 한글 입력기 상태 호환
    if (isCmdOrCtrl && (e.code === 'KeyV' || keyLower === 'v')) {
      const activeIsEditor = document.activeElement?.classList.contains('cell-editor');
      if (copiedCells.length > 0 && (selectedDates.size > 1 || !activeIsEditor)) {
        e.preventDefault();
        pasteCopiedCells();
      }
    }

    // 일괄 삭제 (Delete / Backspace)
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedDates.size > 1) {
      e.preventDefault();
      pushHistorySnapshot();
      selectedDates.forEach((dateStr) => {
        if (scheduleData[dateStr]) {
          scheduleData[dateStr].text = '';
        }
        const td = document.querySelector(`td.date-cell[data-date="${dateStr}"]`);
        if (td) {
          td.querySelector('.cell-editor').innerText = '';
          checkCellOverflow(td);
        }
      });
      saveDraftToLocalStorage();
      showToast(`${selectedDates.size}개 칸의 내용을 비웠습니다.`);
    }
  });
}

function updatePrintScale(val) {
  const num = parseFloat(val);
  document.documentElement.style.setProperty('--print-scale', num.toFixed(2));
  document.getElementById('printScaleValue').innerText = `${Math.round(num * 100)}%`;
}

function saveDraftToLocalStorage() {
  const payload = {
    studentName: document.getElementById('studentName').value,
    startDate: document.getElementById('startDateInput').value,
    endDate: document.getElementById('endDateInput').value,
    scheduleData,
  };
  localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(payload));
}

function loadDraftFromLocalStorage() {
  const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
  if (!raw) {
    initDefaultDates();
    return;
  }
  try {
    const parsed = JSON.parse(raw);
    document.getElementById('studentName').value = parsed.studentName || '';
    scheduleData = parsed.scheduleData || {};
    if (parsed.startDate) {
      const s = parseDate(parsed.startDate);
      document.getElementById('startDateInput').value = formatDate(s);
      document.getElementById('endDateInput').value = formatDate(addOneMonth(s));
    } else {
      initDefaultDates();
    }
  } catch {
    initDefaultDates();
  }
}

function clearAll() {
  if (!confirm('작성된 모든 시간표 내용을 초기화할까요?')) return;
  pushHistorySnapshot();
  scheduleData = {};
  selectedDates.clear();
  document.getElementById('studentName').value = '';
  initDefaultDates();
  saveDraftToLocalStorage();
  renderCalendar();
  showToast('전체 내용이 초기화되었습니다. (Ctrl+Z로 복구 가능)');
}

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.innerText = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}
