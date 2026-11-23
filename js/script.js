// ============================================================
// GOSU STUDY 공부 시간표 스케줄러 - 전체 동작 스크립트 (js/script.js)
// ============================================================

let monthlyDatabase = {}; // { "YYYY_M": { [day]: { items: string[], fontSize: string } | string[] } }
let defaultFontSize = '9.5px';
let printScale = 0.9;

let selectedDateStrs = new Set();
let isDraggingCells = false;
let dragAnchorDateStr = null;

// 복사 / 붙여넣기 클립보드 [{ text: string, fontSize: string }]
let cellClipboard = [];

// 실행 취소 / 다시 실행 스택
const MAX_HISTORY = 50;
let undoStack = [];
let redoStack = [];
let isRestoringHistory = false;
let typingSnapshot = null;

// 온라인 저장 목록 원본 보관용
let onlineSchedulesData = [];

// Supabase 상태
let supabaseClient = null;
let currentUser = null;

// ── 1. 초기화 ──
window.addEventListener('DOMContentLoaded', () => {
  initDateInputs();
  renderCalendar();
  updateHeaderAndSaveDraft();
  updatePrintScale(printScale);
  bindGlobalShortcuts();
  initAuthFlow();
});

function formatDateInput(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseDateInput(str) {
  if (!str) return null;
  const [y, m, d] = str.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function toDateStr(date) {
  return formatDateInput(date);
}

function getMonthKey(date) {
  return `${date.getFullYear()}_${date.getMonth()}`;
}

function calcOneMonthLater(startDate) {
  const end = new Date(startDate);
  end.setDate(end.getDate() + 30);
  return end;
}

function initDateInputs() {
  const startInput = document.getElementById('startDateInput');
  const endInput = document.getElementById('endDateInput');
  if (!startInput || !endInput) return;

  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const end = calcOneMonthLater(start);

  startInput.value = formatDateInput(start);
  endInput.value = formatDateInput(end);
}

function onStartDateChange() {
  const startInput = document.getElementById('startDateInput');
  const endInput = document.getElementById('endDateInput');
  const start = parseDateInput(startInput.value);
  if (!start) return;

  const end = calcOneMonthLater(start);
  endInput.value = formatDateInput(end);

  selectedDateStrs.clear();
  renderCalendar();
  updateHeaderAndSaveDraft();
}

// ── 2. 데이터 읽기 / 쓰기 헬퍼 ──
function getCellData(dateStr) {
  const date = parseDateInput(dateStr);
  if (!date) return { text: '', fontSize: defaultFontSize };

  const key = getMonthKey(date);
  const day = date.getDate();
  const raw = monthlyDatabase[key]?.[day];

  if (!raw) {
    return { text: '', fontSize: defaultFontSize };
  }

  if (Array.isArray(raw)) {
    return {
      text: raw.join('\n'),
      fontSize: defaultFontSize,
    };
  }

  const items = Array.isArray(raw.items) ? raw.items : [];
  return {
    text: items.join('\n'),
    fontSize: raw.fontSize || defaultFontSize,
  };
}

function setCellData(dateStr, text, fontSize) {
  const date = parseDateInput(dateStr);
  if (!date) return;

  const key = getMonthKey(date);
  const day = date.getDate();
  if (!monthlyDatabase[key]) monthlyDatabase[key] = {};

  const prev = getCellData(dateStr);
  const nextText = text !== undefined ? text : prev.text;
  const nextSize = fontSize !== undefined ? fontSize : prev.fontSize;
  const lines = nextText === '' ? [] : nextText.split('\n');

  if (nextSize === defaultFontSize) {
    monthlyDatabase[key][day] = lines;
  } else {
    monthlyDatabase[key][day] = {
      items: lines,
      fontSize: nextSize,
    };
  }
}

// ── 3. 실행 취소 / 다시 실행 (Ctrl+Z / Ctrl+Y) ──
function createSnapshot() {
  return JSON.stringify({
    studentName: document.getElementById('studentName')?.value || '',
    startDate: document.getElementById('startDateInput')?.value || '',
    endDate: document.getElementById('endDateInput')?.value || '',
    monthlyDatabase,
    defaultFontSize,
  });
}

function pushUndoState(customSnapshot) {
  if (isRestoringHistory) return;
  const snap = customSnapshot || createSnapshot();
  if (undoStack.length > 0 && undoStack[undoStack.length - 1] === snap) return;
  undoStack.push(snap);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack = [];
}

function applySnapshot(snapStr) {
  if (!snapStr) return;
  isRestoringHistory = true;
  try {
    const state = JSON.parse(snapStr);
    const nameEl = document.getElementById('studentName');
    const startEl = document.getElementById('startDateInput');
    const endEl = document.getElementById('endDateInput');

    if (nameEl) nameEl.value = state.studentName || '';
    if (startEl && state.startDate) startEl.value = state.startDate;
    if (endEl && state.endDate) endEl.value = state.endDate;
    monthlyDatabase = state.monthlyDatabase || {};
    defaultFontSize = state.defaultFontSize || '9.5px';

    renderCalendar();
    updateHeaderAndSaveDraft();
  } finally {
    isRestoringHistory = false;
  }
}

function undo() {
  if (undoStack.length === 0) {
    showToast('되돌릴 작업이 없습니다.');
    return;
  }
  const current = createSnapshot();
  const prev = undoStack.pop();
  redoStack.push(current);
  applySnapshot(prev);
  showToast('↩️ 실행 취소 (Ctrl+Z)');
}

function redo() {
  if (redoStack.length === 0) {
    showToast('다시 실행할 작업이 없습니다.');
    return;
  }
  const current = createSnapshot();
  const next = redoStack.pop();
  undoStack.push(current);
  applySnapshot(next);
  showToast('↪️ 다시 실행 (Ctrl+Y)');
}

// ── 4. 헤더 제목 / 기간 부제목 업데이트 ──
function updateHeaderAndSaveDraft() {
  const name = (document.getElementById('studentName')?.value || '').trim();
  const startStr = document.getElementById('startDateInput')?.value || '';
  const endStr = document.getElementById('endDateInput')?.value || '';

  const titleEl = document.getElementById('calendarTitle');
  const subEl = document.getElementById('calendarSubtitle');

  if (titleEl) {
    titleEl.textContent = name ? `${name} 공부 시간표` : '공부 시간표를 작성해 주세요';
  }
  if (subEl && startStr && endStr) {
    subEl.textContent = `${startStr.replace(/-/g, '.')} ~ ${endStr.replace(/-/g, '.')}`;
  }
}

// ── 5. 달력 렌더링 및 셀 바인딩 ──
function renderCalendar() {
  const body = document.getElementById('calendarBody');
  if (!body) return;

  const start = parseDateInput(document.getElementById('startDateInput')?.value);
  const end = parseDateInput(document.getElementById('endDateInput')?.value);
  if (!start || !end || start > end) {
    body.innerHTML = '';
    return;
  }

  const dayHeaders = ['일', '월', '화', '수', '목', '금', '토'];
  let html = '<table class="calendar-table"><thead><tr>';
  dayHeaders.forEach((label, dow) => {
    html += `<th data-dow="${dow}" title="클릭 시 ${label}요일 전체 선택">${label}</th>`;
  });
  html += '</tr></thead><tbody>';

  const gridStart = new Date(start);
  gridStart.setDate(start.getDate() - start.getDay());

  const gridEnd = new Date(end);
  gridEnd.setDate(end.getDate() + (6 - end.getDay()));

  const cursor = new Date(gridStart);
  while (cursor <= gridEnd) {
    if (cursor.getDay() === 0) {
      html += '<tr>';
    }

    const inRange = cursor >= start && cursor <= end;
    if (!inRange) {
      html += '<td class="empty"></td>';
    } else {
      const dateStr = toDateStr(cursor);
      const dow = cursor.getDay();
      const cellClass = dow === 0 ? 'sun-cell' : dow === 6 ? 'sat-cell' : 'weekday-cell';
      const monthLabel = `${cursor.getMonth() + 1}월`;
      const dayLabel = `${cursor.getDate()}일`;
      const { text, fontSize } = getCellData(dateStr);

      html += `
        <td class="${cellClass}" data-date="${dateStr}" data-dow="${dow}" data-font-size="${fontSize}">
          <div class="date-header">
            <span class="date-month-tag">${monthLabel}</span>
            <span class="date-day-tag">${dayLabel}</span>
          </div>
          <div class="cell-editor" contenteditable="true" spellcheck="false" style="font-size: ${fontSize};">${escapeHtml(text)}</div>
        </td>
      `;
    }

    if (cursor.getDay() === 6) {
      html += '</tr>';
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  html += '</tbody></table>';
  body.innerHTML = html;

  bindCalendarEvents();
  syncSelectionUI();
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function bindCalendarEvents() {
  const table = document.querySelector('.calendar-table');
  if (!table) return;

  // 요일 헤더(일~토) 클릭 시 해당 요일 전체 선택
  table.querySelectorAll('th[data-dow]').forEach((th) => {
    th.addEventListener('click', (e) => {
      const dow = th.dataset.dow;
      const matchingCells = Array.from(table.querySelectorAll(`td[data-date][data-dow="${dow}"]`));
      if (matchingCells.length === 0) return;

      if (e.ctrlKey || e.metaKey) {
        const allAlreadySelected = matchingCells.every((td) => selectedDateStrs.has(td.dataset.date));
        matchingCells.forEach((td) => {
          if (allAlreadySelected) selectedDateStrs.delete(td.dataset.date);
          else selectedDateStrs.add(td.dataset.date);
        });
      } else {
        selectedDateStrs.clear();
        matchingCells.forEach((td) => selectedDateStrs.add(td.dataset.date));
      }
      syncSelectionUI();
    });
  });

  // 각 날짜 칸 이벤트
  table.querySelectorAll('td[data-date]').forEach((td) => {
    const dateStr = td.dataset.date;
    const editor = td.querySelector('.cell-editor');

    td.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      isDraggingCells = true;
      dragAnchorDateStr = dateStr;

      if (e.ctrlKey || e.metaKey) {
        if (selectedDateStrs.has(dateStr)) {
          selectedDateStrs.delete(dateStr);
        } else {
          selectedDateStrs.add(dateStr);
        }
        syncSelectionUI();
      } else {
        if (!(selectedDateStrs.size === 1 && selectedDateStrs.has(dateStr))) {
          selectContinuousRange(dateStr, dateStr);
        }
      }
    });

    td.addEventListener('mouseenter', () => {
      if (!isDraggingCells || !dragAnchorDateStr) return;
      if (dragAnchorDateStr !== dateStr) {
        window.getSelection()?.removeAllRanges();
        if (document.activeElement && document.activeElement.classList.contains('cell-editor')) {
          document.activeElement.blur();
        }
        selectContinuousRange(dragAnchorDateStr, dateStr);
      }
    });

    if (editor) {
      editor.addEventListener('focus', () => {
        typingSnapshot = createSnapshot();
        if (!selectedDateStrs.has(dateStr)) {
          selectedDateStrs.clear();
          selectedDateStrs.add(dateStr);
          syncSelectionUI();
        }
      });

      editor.addEventListener('input', () => {
        if (typingSnapshot) {
          pushUndoState(typingSnapshot);
          typingSnapshot = null;
        }
        const rawText = editor.innerText.replace(/\r\n/g, '\n').replace(/\n$/, '');
        setCellData(dateStr, rawText);
      });

      editor.addEventListener('blur', () => {
        typingSnapshot = null;
      });
    }
  });
}

document.addEventListener('mouseup', () => {
  isDraggingCells = false;
});

function selectContinuousRange(startStr, endStr) {
  selectedDateStrs.clear();
  const s = parseDateInput(startStr);
  const e = parseDateInput(endStr);
  if (!s || !e) return;

  const [from, to] = s <= e ? [s, e] : [e, s];
  const cur = new Date(from);
  while (cur <= to) {
    const str = toDateStr(cur);
    if (document.querySelector(`.calendar-table td[data-date="${str}"]`)) {
      selectedDateStrs.add(str);
    }
    cur.setDate(cur.getDate() + 1);
  }
  syncSelectionUI();
}

function syncSelectionUI() {
  const statusEl = document.getElementById('selectionStatus');
  if (statusEl) {
    statusEl.textContent = `선택된 칸: ${selectedDateStrs.size}개`;
  }

  const fontSizes = new Set();
  document.querySelectorAll('.calendar-table td[data-date]').forEach((td) => {
    const dStr = td.dataset.date;
    if (selectedDateStrs.has(dStr)) {
      td.classList.add('cell-selected');
      const size = (td.dataset.fontSize || defaultFontSize).trim();
      fontSizes.add(size);
    } else {
      td.classList.remove('cell-selected');
    }
  });

  document.querySelectorAll('.font-btn').forEach((btn) => {
    btn.classList.remove('active');
    if (fontSizes.size === 1) {
      const onlySize = Array.from(fontSizes)[0];
      if ((btn.dataset.size || '').trim() === onlySize) {
        btn.classList.add('active');
      }
    }
  });
}

// ── 6. 글자 크기 변경 & 배율 & 전체 초기화 ──
function applyFontSizeToSelected(size) {
  if (selectedDateStrs.size === 0) {
    showToast('먼저 달력에서 칸을 선택해 주세요.');
    return;
  }

  pushUndoState();
  selectedDateStrs.forEach((dateStr) => {
    const current = getCellData(dateStr);
    setCellData(dateStr, current.text, size);

    const td = document.querySelector(`.calendar-table td[data-date="${dateStr}"]`);
    if (td) {
      td.dataset.fontSize = size;
      const editor = td.querySelector('.cell-editor');
      if (editor) editor.style.fontSize = size;
    }
  });

  syncSelectionUI();
}

function updatePrintScale(value) {
  let v = parseFloat(value);
  if (isNaN(v)) return;
  if (v > 1) v = v / 100;
  printScale = v;

  document.documentElement.style.setProperty('--print-scale', printScale.toFixed(2));
  const slider = document.getElementById('printScale');
  const valLabel = document.getElementById('printScaleValue');
  if (slider) slider.value = printScale;
  if (valLabel) valLabel.textContent = `${Math.round(printScale * 100)}%`;
}

function clearAll() {
  if (!confirm('작성된 모든 시간표 내용을 초기화하시겠습니까?')) return;
  pushUndoState();
  monthlyDatabase = {};
  selectedDateStrs.clear();
  renderCalendar();
  showToast('🔄 전체 내용을 초기화했습니다.');
}

// ── 7. 단축키 (Ctrl+Z, Ctrl+Y, Ctrl+C, Ctrl+V, Delete, Tab) ──
function getSortedSelectedDates() {
  return Array.from(selectedDateStrs).sort();
}

function bindGlobalShortcuts() {
  document.addEventListener('keydown', (e) => {
    const activeEl = document.activeElement;
    const isInputField =
      activeEl &&
      (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA') &&
      !activeEl.classList.contains('cell-editor');

    if (isInputField) return;

    const isMod = e.ctrlKey || e.metaKey;

    if (isMod && e.code === 'KeyZ') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }

    if (isMod && e.code === 'KeyY') {
      e.preventDefault();
      redo();
      return;
    }

    if (isMod && e.code === 'KeyC') {
      const selText = window.getSelection()?.toString() || '';
      if (!selText && selectedDateStrs.size > 0) {
        e.preventDefault();
        const sorted = getSortedSelectedDates();
        cellClipboard = sorted.map((dateStr) => getCellData(dateStr));
        showToast(`📋 ${cellClipboard.length}개 칸을 복사했습니다.`);
      }
      return;
    }

    if (isMod && e.code === 'KeyV') {
      if (cellClipboard.length > 0 && selectedDateStrs.size > 0) {
        e.preventDefault();
        pushUndoState();

        const targets = getSortedSelectedDates();
        targets.forEach((dateStr, idx) => {
          const source =
            cellClipboard.length === 1
              ? cellClipboard[0]
              : cellClipboard[idx % cellClipboard.length];
          setCellData(dateStr, source.text, source.fontSize);
        });

        renderCalendar();
        showToast(`📌 ${targets.length}개 칸에 붙여넣었습니다.`);
      }
      return;
    }

    if (e.key === 'Delete' && selectedDateStrs.size > 1) {
      e.preventDefault();
      pushUndoState();
      selectedDateStrs.forEach((dateStr) => {
        setCellData(dateStr, '', defaultFontSize);
      });
      renderCalendar();
      showToast(`🗑️ ${selectedDateStrs.size}개 칸을 비웠습니다.`);
      return;
    }

    if (e.key === 'Tab') {
      const allCells = Array.from(document.querySelectorAll('.calendar-table td[data-date]'));
      if (allCells.length === 0) return;

      const currentDate =
        (activeEl && activeEl.closest('td[data-date]')?.dataset.date) ||
        getSortedSelectedDates()[0];
      const currentIdx = allCells.findIndex((td) => td.dataset.date === currentDate);

      if (currentIdx !== -1) {
        e.preventDefault();
        const nextIdx = e.shiftKey
          ? (currentIdx - 1 + allCells.length) % allCells.length
          : (currentIdx + 1) % allCells.length;
        const targetTd = allCells[nextIdx];
        const nextDateStr = targetTd.dataset.date;

        selectedDateStrs.clear();
        selectedDateStrs.add(nextDateStr);
        syncSelectionUI();

        const editor = targetTd.querySelector('.cell-editor');
        if (editor) editor.focus();
      }
    }
  });
}

// ── 8. 토스트 알림 ──
let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
  }, 2200);
}

// ============================================================
// 9. Supabase 인증 및 온라인 시간표 저장 · 목록 · 검색 · 불러오기
// ============================================================
function getSupabaseClient() {
  if (typeof window.supabase === 'undefined') {
    alert('Supabase 라이브러리를 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.');
    return null;
  }
  if (
    typeof SUPABASE_URL === 'undefined' ||
    typeof SUPABASE_ANON_KEY === 'undefined' ||
    !SUPABASE_URL ||
    !SUPABASE_ANON_KEY
  ) {
    alert('Supabase 설정이 필요합니다. js/supabase-config.js 파일을 확인해 주세요.');
    return null;
  }
  if (!supabaseClient) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return supabaseClient;
}

function showAppShell() {
  const authScreen = document.getElementById('authScreen');
  const appShell = document.getElementById('appShell');
  if (authScreen) authScreen.classList.add('hidden');
  if (appShell) {
    appShell.classList.remove('hidden');
    appShell.classList.add('is-ready');
  }
}

function showAuthScreen(message = '') {
  const authScreen = document.getElementById('authScreen');
  const appShell = document.getElementById('appShell');
  if (authScreen) authScreen.classList.remove('hidden');
  if (appShell) {
    appShell.classList.add('hidden');
    appShell.classList.remove('is-ready');
  }
  const msgEl = document.getElementById('authMessage');
  if (msgEl) msgEl.textContent = message;
}

async function initAuthFlow() {
  const client = getSupabaseClient();
  if (!client) {
    showAuthScreen('Supabase 연결 설정을 확인해 주세요.');
    return;
  }

  const {
    data: { session },
  } = await client.auth.getSession();

  if (session) {
    currentUser = session.user;
    showAppShell();
  } else {
    showAuthScreen();
  }

  client.auth.onAuthStateChange((_event, nextSession) => {
    if (nextSession) {
      currentUser = nextSession.user;
      showAppShell();
    } else {
      currentUser = null;
      showAuthScreen('로그아웃되었습니다. 다시 로그인해 주세요.');
    }
  });
}

async function handleAuth(mode) {
  const client = getSupabaseClient();
  if (!client) return;

  const email = (document.getElementById('authEmail')?.value || '').trim();
  const password = document.getElementById('authPassword')?.value || '';
  const msgEl = document.getElementById('authMessage');

  if (!email || !password) {
    if (msgEl) {
      msgEl.textContent = '이메일과 비밀번호를 모두 입력해 주세요.';
      msgEl.style.color = '#e74c3c';
    }
    return;
  }

  if (mode === 'signUp') {
    const { data, error } = await client.auth.signUp({ email, password });
    if (error) {
      if (msgEl) {
        msgEl.textContent = error.message;
        msgEl.style.color = '#e74c3c';
      }
      return;
    }
    if (data?.session) {
      currentUser = data.session.user;
      showAppShell();
      return;
    }
    if (msgEl) {
      msgEl.textContent = '회원가입이 완료되었습니다. 로그인 버튼을 눌러 주세요.';
      msgEl.style.color = '#2563eb';
    }
    return;
  }

  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    if (msgEl) {
      msgEl.textContent = `로그인 실패: ${error.message}`;
      msgEl.style.color = '#e74c3c';
    }
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
    showAuthScreen('로그아웃되었습니다.');
  }
}

async function saveToOnline() {
  const client = getSupabaseClient();
  if (!client) return;
  if (!currentUser) {
    alert('로그인한 사용자만 저장할 수 있습니다.');
    return;
  }

  const name = (document.getElementById('studentName')?.value || '').trim() || '이름없음';
  let startDate = document.getElementById('startDateInput')?.value || '';
  let endDate = document.getElementById('endDateInput')?.value || '';

  const filledDates = [];
  for (const monthKey in monthlyDatabase) {
    const [year, monthIdx] = monthKey.split('_').map(Number);
    const dayMap = monthlyDatabase[monthKey];
    if (!dayMap) continue;

    for (const day in dayMap) {
      const raw = dayMap[day];
      const items = Array.isArray(raw) ? raw : raw?.items;
      const hasContent = Array.isArray(items) && items.some((v) => v && v.trim() !== '');
      if (hasContent) {
        filledDates.push(new Date(year, monthIdx, parseInt(day, 10)));
      }
    }
  }

  if (filledDates.length > 0) {
    filledDates.sort((a, b) => a - b);
    startDate = formatDateInput(filledDates[0]);
    endDate = formatDateInput(filledDates[filledDates.length - 1]);
  }

  const { error } = await client.from('schedules').insert([
    {
      owner_id: currentUser.id,
      student_name: name,
      start_date: startDate,
      end_date: endDate,
      monthly_database: monthlyDatabase,
      font_size: defaultFontSize,
    },
  ]);

  if (error) {
    alert(`온라인 저장에 실패했습니다: ${error.message}`);
    return;
  }

  showToast(`☁️ ${name} 학생의 시간표를 저장했습니다.`);
  if (document.getElementById('appShell')?.classList.contains('show-online-panel')) {
    fetchOnlineSchedules();
  }
}

function toggleOnlineList() {
  const appShell = document.getElementById('appShell');
  if (!appShell) return;
  if (appShell.classList.contains('show-online-panel')) {
    closeOnlineList();
  } else {
    openOnlineList();
  }
}

async function openOnlineList() {
  const client = getSupabaseClient();
  if (!client) return;
  if (!currentUser) {
    alert('로그인한 사용자만 목록을 볼 수 있습니다.');
    return;
  }

  const appShell = document.getElementById('appShell');
  if (appShell) appShell.classList.add('show-online-panel');

  const searchInput = document.getElementById('onlineSearchInput');
  if (searchInput) searchInput.value = '';

  fetchOnlineSchedules();
}

function closeOnlineList() {
  const appShell = document.getElementById('appShell');
  if (appShell) appShell.classList.remove('show-online-panel');
}

async function fetchOnlineSchedules() {
  const client = getSupabaseClient();
  const body = document.getElementById('onlineListBody');
  if (!client || !body) return;

  body.innerHTML = '<div class="online-loading">☁️ 목록을 불러오는 중...</div>';

  const { data, error } = await client
    .from('schedules')
    .select('id, student_name, start_date, end_date, created_at')
    .order('created_at', { ascending: false });

  if (error) {
    body.innerHTML = `<div class="online-empty">시간표를 불러오지 못했습니다.<br><small>${escapeHtml(error.message)}</small></div>`;
    return;
  }

  onlineSchedulesData = data || [];
  filterOnlineSchedules();
}

function filterOnlineSchedules() {
  const searchInput = document.getElementById('onlineSearchInput');
  const keyword = searchInput ? searchInput.value.trim().toLowerCase() : '';

  if (!keyword) {
    renderOnlineSchedules(onlineSchedulesData);
    return;
  }

  const filtered = onlineSchedulesData.filter((item) =>
    (item.student_name || '').toLowerCase().includes(keyword)
  );
  renderOnlineSchedules(filtered);
}

function renderOnlineSchedules(list) {
  const body = document.getElementById('onlineListBody');
  if (!body) return;

  if (!list || list.length === 0) {
    body.innerHTML = '<div class="online-empty">🔍 검색된 시간표가 없습니다.</div>';
    return;
  }

  body.innerHTML = '';
  list.forEach((item) => {
    const createdAt = item.created_at
      ? new Date(item.created_at).toLocaleDateString('ko-KR', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '';

    const card = document.createElement('div');
    card.className = 'online-card';
    card.innerHTML = `
      <div class="online-card-main">
        <div class="online-card-title">
          <span class="student-badge">학생</span>
          <strong>${escapeHtml(item.student_name || '이름 없음')}</strong>
        </div>
        <div class="online-card-meta">
          <span>📅 ${escapeHtml(item.start_date)} ~ ${escapeHtml(item.end_date)}</span>
          <span>🕒 ${escapeHtml(createdAt)}</span>
        </div>
      </div>
      <div class="online-card-actions">
        <button type="button" class="btn-card-load" data-id="${item.id}">불러오기</button>
        <button type="button" class="btn-card-delete" data-id="${item.id}">삭제</button>
      </div>
    `;
    body.appendChild(card);
  });

  body.querySelectorAll('.btn-card-load').forEach((btn) => {
    btn.addEventListener('click', () => loadFromOnline(btn.getAttribute('data-id')));
  });

  body.querySelectorAll('.btn-card-delete').forEach((btn) => {
    btn.addEventListener('click', () => deleteFromOnline(btn.getAttribute('data-id')));
  });
}

async function loadFromOnline(id) {
  const client = getSupabaseClient();
  if (!client || !id) return;

  const { data, error } = await client
    .from('schedules')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) {
    alert(`불러오기에 실패했습니다: ${error ? error.message : '데이터 없음'}`);
    return;
  }

  pushUndoState();

  const nameInput = document.getElementById('studentName');
  if (nameInput) nameInput.value = data.student_name || '';

  monthlyDatabase = data.monthly_database || {};
  defaultFontSize = data.font_size || '9.5px';

  if (data.start_date) {
    const sDate = parseDateInput(data.start_date);
    if (sDate) {
      const eDate = calcOneMonthLater(sDate);
      const startInput = document.getElementById('startDateInput');
      const endInput = document.getElementById('endDateInput');
      if (startInput) startInput.value = formatDateInput(sDate);
      if (endInput) endInput.value = formatDateInput(eDate);
    }
  }

  selectedDateStrs.clear();
  renderCalendar();
  updateHeaderAndSaveDraft();
  showToast(`📂 ${data.student_name || '선택'} 학생의 시간표를 불러왔습니다.`);
}

async function deleteFromOnline(id) {
  if (!confirm('선택한 학생의 시간표를 삭제하시겠습니까?')) return;
  const client = getSupabaseClient();
  if (!client || !id) return;

  const { error } = await client.from('schedules').delete().eq('id', id);
  if (error) {
    alert(`삭제에 실패했습니다: ${error.message}`);
    return;
  }

  showToast('🗑️ 시간표를 삭제했습니다.');
  fetchOnlineSchedules();
}
