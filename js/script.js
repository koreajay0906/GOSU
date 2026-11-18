let supabaseClient = null;
let monthlyDatabase = {}; // { "YYYY_M": { D: ["줄1", "줄2"] }, _meta: { cellFontSizes: { "YYYY_M_D": "11px" } } }
let defaultFontSize = '9.5px';
let printScale = 0.9;

let selectedDateKeys = new Set(); // "YYYY_M_D"
let anchorDateKey = null;
let isDraggingSelect = false;
let dragStartKey = null;

let clipboardCells = []; // [{ text, fontSize }]
let undoStack = [];
let redoStack = [];
const MAX_HISTORY = 60;

let onlineSchedulesData = [];
let isComposing = false;
let typingHistoryTimer = null;

const DRAFT_STORAGE_KEY = 'gosu_scheduler_draft_v2';

function getSupabaseClient() {
  if (supabaseClient) return supabaseClient;
  if (window.supabase && typeof SUPABASE_URL !== 'undefined' && typeof SUPABASE_ANON_KEY !== 'undefined') {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return supabaseClient;
}

window.addEventListener('DOMContentLoaded', () => {
  initDateRangeInputs();
  restoreDraftIfAvailable();
  renderCalendar();
  updateHeaderTitle();
  applyPrintScale(printScale);

  const slider = document.getElementById('printScale');
  if (slider) slider.value = printScale;
  const label = document.getElementById('printScaleValue');
  if (label) label.innerText = `${Math.round(printScale * 100)}%`;

  bindGlobalEvents();
  pushHistory(true);
});

function showToast(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove('show');
  }, 2200);
}

/* ── 날짜 유틸리티 ── */
function formatDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDateInput(value) {
  if (!value) return null;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function addOneMonth(dateObj) {
  const target = new Date(dateObj);
  target.setDate(target.getDate() + 30);
  return target;
}

function getMonthKey(dateObj) {
  return `${dateObj.getFullYear()}_${dateObj.getMonth()}`;
}

function getCellFullKey(dateObj) {
  return `${dateObj.getFullYear()}_${dateObj.getMonth()}_${dateObj.getDate()}`;
}

function initDateRangeInputs() {
  const today = new Date();
  const startInput = document.getElementById('startDateInput');
  const endInput = document.getElementById('endDateInput');
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const end = addOneMonth(start);
  startInput.value = formatDateInput(start);
  endInput.value = formatDateInput(end);
}

function onStartDateChange() {
  const startDate = parseDateInput(document.getElementById('startDateInput').value);
  if (!startDate) return;
  const endDate = addOneMonth(startDate);
  document.getElementById('endDateInput').value = formatDateInput(endDate);
  selectedDateKeys.clear();
  anchorDateKey = null;
  renderCalendar();
  updateHeaderAndSaveDraft();
}

function updateHeaderTitle() {
  const name = document.getElementById('studentName').value.trim();
  const startVal = document.getElementById('startDateInput').value;
  const endVal = document.getElementById('endDateInput').value;
  const titleEl = document.getElementById('calendarTitle');
  const subEl = document.getElementById('calendarSubtitle');

  if (titleEl) {
    titleEl.textContent = name ? `${name} 공부 시간표` : '공부 시간표를 작성해 주세요';
  }
  if (subEl) {
    subEl.textContent = startVal && endVal ? `${startVal} ~ ${endVal}` : '';
  }
}

function updateHeaderAndSaveDraft() {
  updateHeaderTitle();
  saveDraftToLocal();
}

function saveDraftToLocal() {
  try {
    const payload = {
      studentName: document.getElementById('studentName').value,
      startDate: document.getElementById('startDateInput').value,
      endDate: document.getElementById('endDateInput').value,
      monthlyDatabase,
      defaultFontSize,
    };
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    // ignore storage errors
  }
}

function restoreDraftIfAvailable() {
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!raw) return;
    const draft = JSON.parse(raw);
    if (draft.studentName) document.getElementById('studentName').value = draft.studentName;
    if (draft.startDate) {
      document.getElementById('startDateInput').value = draft.startDate;
      const s = parseDateInput(draft.startDate);
      if (s) document.getElementById('endDateInput').value = formatDateInput(addOneMonth(s));
    }
    if (draft.monthlyDatabase && typeof draft.monthlyDatabase === 'object') {
      monthlyDatabase = draft.monthlyDatabase;
    }
    if (draft.defaultFontSize) {
      defaultFontSize = draft.defaultFontSize;
    }
  } catch (e) {
    // ignore parse errors
  }
}

/* ── 데이터 읽기 / 쓰기 ── */
function ensureMeta() {
  if (!monthlyDatabase._meta) {
    monthlyDatabase._meta = { cellFontSizes: {} };
  }
  if (!monthlyDatabase._meta.cellFontSizes) {
    monthlyDatabase._meta.cellFontSizes = {};
  }
}

function getCellText(fullKey) {
  const [y, m, d] = fullKey.split('_').map(Number);
  const mKey = `${y}_${m}`;
  const val = monthlyDatabase[mKey]?.[d];
  if (Array.isArray(val)) return val.join('\n');
  if (typeof val === 'string') return val;
  return '';
}

function setCellText(fullKey, text) {
  const [y, m, d] = fullKey.split('_').map(Number);
  const mKey = `${y}_${m}`;
  if (!monthlyDatabase[mKey]) monthlyDatabase[mKey] = {};
  const lines = text ? text.split('\n') : [];
  monthlyDatabase[mKey][d] = lines;
}

function getCellFontSize(fullKey) {
  ensureMeta();
  return monthlyDatabase._meta.cellFontSizes[fullKey] || defaultFontSize || '9.5px';
}

function setCellFontSize(fullKey, size) {
  ensureMeta();
  monthlyDatabase._meta.cellFontSizes[fullKey] = size;
}

/* ── 실행 취소 / 다시 실행 (Ctrl+Z / Ctrl+Y) ── */
function cloneDatabase(db) {
  return JSON.parse(JSON.stringify(db || {}));
}

function pushHistory(isInitial = false) {
  const snapshot = cloneDatabase(monthlyDatabase);
  if (!isInitial && undoStack.length > 0) {
    const last = JSON.stringify(undoStack[undoStack.length - 1]);
    if (last === JSON.stringify(snapshot)) return;
  }
  undoStack.push(snapshot);
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  if (!isInitial) redoStack = [];
  saveDraftToLocal();
}

function undo() {
  if (undoStack.length <= 1) {
    showToast('더 이상 되돌릴 작업이 없습니다.');
    return;
  }
  const current = undoStack.pop();
  redoStack.push(current);
  const prev = undoStack[undoStack.length - 1];
  monthlyDatabase = cloneDatabase(prev);
  renderCalendar();
  saveDraftToLocal();
  showToast('↩️ 실행 취소 (Ctrl+Z)');
}

function redo() {
  if (redoStack.length === 0) {
    showToast('다시 실행할 작업이 없습니다.');
    return;
  }
  const next = redoStack.pop();
  undoStack.push(cloneDatabase(next));
  monthlyDatabase = cloneDatabase(next);
  renderCalendar();
  saveDraftToLocal();
  showToast('↪️ 다시 실행 (Ctrl+Y)');
}

/* ── 달력 렌더링 ── */
function getVisibleDateList() {
  const startDate = parseDateInput(document.getElementById('startDateInput').value);
  const endDate = parseDateInput(document.getElementById('endDateInput').value);
  if (!startDate || !endDate || startDate > endDate) return [];
  const list = [];
  const cursor = new Date(startDate);
  while (cursor <= endDate) {
    list.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return list;
}

function renderCalendar() {
  const container = document.getElementById('calendarBody');
  if (!container) return;

  const dates = getVisibleDateList();
  if (dates.length === 0) {
    container.innerHTML = '';
    return;
  }

  const dayHeaders = ['일', '월', '화', '수', '목', '금', '토'];
  let html = '<table class="calendar-table"><thead><tr>';
  dayHeaders.forEach((label, idx) => {
    html += `<th data-dow="${idx}" title="클릭하면 모든 ${label}요일 칸이 선택됩니다">${label}</th>`;
  });
  html += '</tr></thead><tbody><tr>';

  const firstDow = dates[0].getDay();
  for (let i = 0; i < firstDow; i++) {
    html += '<td class="empty"></td>';
  }

  let col = firstDow;
  dates.forEach((dateObj) => {
    if (col === 7) {
      html += '</tr><tr>';
      col = 0;
    }
    const dow = dateObj.getDay();
    const fullKey = getCellFullKey(dateObj);
    const monthNum = dateObj.getMonth() + 1;
    const dayNum = dateObj.getDate();
    const text = getCellText(fullKey);
    const fontSize = getCellFontSize(fullKey);
    const isSelected = selectedDateKeys.has(fullKey);

    let tdClass = 'date-cell';
    if (dow === 0) tdClass += ' sun-cell';
    if (dow === 6) tdClass += ' sat-cell';
    if (isSelected) tdClass += ' selected';

    html += `
      <td class="${tdClass}" data-key="${fullKey}" data-dow="${dow}">
        <div class="date-header" data-key="${fullKey}">
          <span class="date-month-tag">${monthNum}월</span>
          <span class="date-day-tag">${dayNum}일</span>
        </div>
        <div
          class="cell-editor"
          contenteditable="true"
          data-key="${fullKey}"
          style="font-size: ${fontSize};"
        >${escapeHtml(text)}</div>
        <span class="overflow-badge">인쇄 잘림 주의</span>
      </td>
    `;
    col++;
  });

  while (col > 0 && col < 7) {
    html += '<td class="empty"></td>';
    col++;
  }
  html += '</tr></tbody></table>';
  container.innerHTML = html;

  bindCalendarCellEvents();
  updateSelectionUI();
  checkAllCellsOverflow();
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function bindCalendarCellEvents() {
  const table = document.querySelector('.calendar-table');
  if (!table) return;

  // 요일 헤더 클릭 -> 해당 요일 전체 선택
  table.querySelectorAll('th[data-dow]').forEach((th) => {
    th.addEventListener('click', (e) => {
      const dow = parseInt(th.getAttribute('data-dow'), 10);
      const matchingCells = Array.from(table.querySelectorAll(`td.date-cell[data-dow="${dow}"]`));
      const matchingKeys = matchingCells.map((td) => td.getAttribute('data-key'));

      if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
        selectedDateKeys.clear();
      }
      const allAlreadySelected = matchingKeys.every((k) => selectedDateKeys.has(k));
      if (allAlreadySelected && (e.ctrlKey || e.metaKey)) {
        matchingKeys.forEach((k) => selectedDateKeys.delete(k));
      } else {
        matchingKeys.forEach((k) => selectedDateKeys.add(k));
      }
      if (matchingKeys.length > 0) anchorDateKey = matchingKeys[0];
      syncSelectionDOM();
    });
  });

  // 셀 선택 & 드래그 범위 선택
  table.querySelectorAll('td.date-cell').forEach((td) => {
    const key = td.getAttribute('data-key');
    const header = td.querySelector('.date-header');
    const editor = td.querySelector('.cell-editor');

    header.addEventListener('mousedown', (e) => {
      e.preventDefault();
      handleCellSelectMouseDown(key, e);
      isDraggingSelect = true;
      dragStartKey = key;
    });

    td.addEventListener('mouseenter', () => {
      if (isDraggingSelect && dragStartKey) {
        selectRangeBetween(dragStartKey, key);
      }
    });

    editor.addEventListener('focus', () => {
      if (!selectedDateKeys.has(key)) {
        selectedDateKeys.clear();
        selectedDateKeys.add(key);
        anchorDateKey = key;
        syncSelectionDOM();
      }
    });

    editor.addEventListener('mousedown', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        toggleSingleSelection(key);
      } else if (e.shiftKey && anchorDateKey) {
        e.preventDefault();
        selectRangeBetween(anchorDateKey, key);
      }
    });

    editor.addEventListener('compositionstart', () => {
      isComposing = true;
    });

    editor.addEventListener('compositionend', () => {
      isComposing = false;
      syncEditorToDB(key, editor);
    });

    editor.addEventListener('input', () => {
      syncEditorToDB(key, editor);
    });

    editor.addEventListener('blur', () => {
      clearTimeout(typingHistoryTimer);
      pushHistory();
    });
  });
}

function syncEditorToDB(key, editor) {
  const rawText = editor.innerText.replace(/\r\n/g, '\n');
  setCellText(key, rawText);
  checkSingleCellOverflow(editor);
  saveDraftToLocal();

  clearTimeout(typingHistoryTimer);
  typingHistoryTimer = setTimeout(() => {
    if (!isComposing) pushHistory();
  }, 600);
}

function handleCellSelectMouseDown(key, e) {
  if (e.shiftKey && anchorDateKey) {
    selectRangeBetween(anchorDateKey, key);
  } else if (e.ctrlKey || e.metaKey) {
    toggleSingleSelection(key);
  } else {
    selectedDateKeys.clear();
    selectedDateKeys.add(key);
    anchorDateKey = key;
    syncSelectionDOM();
  }
}

function toggleSingleSelection(key) {
  if (selectedDateKeys.has(key)) {
    selectedDateKeys.delete(key);
  } else {
    selectedDateKeys.add(key);
    anchorDateKey = key;
  }
  syncSelectionDOM();
}

function selectRangeBetween(startKey, endKey) {
  const allCells = Array.from(document.querySelectorAll('td.date-cell'));
  const keys = allCells.map((td) => td.getAttribute('data-key'));
  const idxA = keys.indexOf(startKey);
  const idxB = keys.indexOf(endKey);
  if (idxA === -1 || idxB === -1) return;

  const [from, to] = idxA <= idxB ? [idxA, idxB] : [idxB, idxA];
  selectedDateKeys.clear();
  for (let i = from; i <= to; i++) {
    selectedDateKeys.add(keys[i]);
  }
  syncSelectionDOM();
}

function syncSelectionDOM() {
  document.querySelectorAll('td.date-cell').forEach((td) => {
    const key = td.getAttribute('data-key');
    if (selectedDateKeys.has(key)) {
      td.classList.add('selected');
    } else {
      td.classList.remove('selected');
    }
  });
  updateSelectionUI();
}

function updateSelectionUI() {
  const statusEl = document.getElementById('selectionStatus');
  if (statusEl) {
    statusEl.textContent = `선택된 칸: ${selectedDateKeys.size}개`;
  }

  const fontBtns = document.querySelectorAll('.font-btn');
  fontBtns.forEach((btn) => btn.classList.remove('active'));

  if (selectedDateKeys.size === 0) return;

  const sizes = new Set();
  selectedDateKeys.forEach((k) => {
    sizes.add(getCellFontSize(k));
  });

  // 선택한 칸들이 모두 동일한 글자 크기일 때만 해당 크기 버튼 활성화
  if (sizes.size === 1) {
    const commonSize = Array.from(sizes)[0];
    fontBtns.forEach((btn) => {
      if (btn.getAttribute('data-size') === commonSize) {
        btn.classList.add('active');
      }
    });
  }
}

/* ── 글자 크기 일괄 적용 ── */
function applyFontSizeToSelected(size) {
  if (selectedDateKeys.size === 0) {
    showToast('먼저 글자 크기를 바꿀 칸을 선택해 주세요.');
    return;
  }
  defaultFontSize = size;
  selectedDateKeys.forEach((key) => {
    setCellFontSize(key, size);
    const editor = document.querySelector(`.cell-editor[data-key="${key}"]`);
    if (editor) {
      editor.style.fontSize = size;
      checkSingleCellOverflow(editor);
    }
  });
  updateSelectionUI();
  pushHistory();
  showToast(`글자 크기 ${size} 적용 (${selectedDateKeys.size}개 칸)`);
}

/* ── 인쇄 넘침 감지 ── */
function checkSingleCellOverflow(editor) {
  const td = editor.closest('td.date-cell');
  if (!td) return;
  if (editor.scrollHeight > 142) {
    td.classList.add('overflow-warning');
  } else {
    td.classList.remove('overflow-warning');
  }
}

function checkAllCellsOverflow() {
  document.querySelectorAll('.cell-editor').forEach((editor) => {
    checkSingleCellOverflow(editor);
  });
}

/* ── 전역 단축키 (Ctrl+Z, Ctrl+Y, Ctrl+C, Ctrl+V, Delete, Tab) ── */
function bindGlobalEvents() {
  window.addEventListener('mouseup', () => {
    isDraggingSelect = false;
    dragStartKey = null;
  });

  document.addEventListener('keydown', (e) => {
    const activeEl = document.activeElement;
    const isInputBox =
      activeEl &&
      (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA');

    // Ctrl+Z / Ctrl+Y (입력창 외 또는 셀 편집 중 실행 취소)
    if ((e.ctrlKey || e.metaKey) && !isInputBox) {
      const code = e.code;
      if (code === 'KeyZ' && !e.shiftKey) {
        e.preventDefault();
        if (activeEl && activeEl.classList.contains('cell-editor')) {
          syncEditorToDB(activeEl.getAttribute('data-key'), activeEl);
        }
        undo();
        return;
      }
      if (code === 'KeyY' || (code === 'KeyZ' && e.shiftKey)) {
        e.preventDefault();
        redo();
        return;
      }

      // 다중 선택 시 Ctrl+C / Ctrl+V
      if (code === 'KeyC' && selectedDateKeys.size > 0) {
        const sel = window.getSelection();
        // 셀 내부 텍스트를 드래그한 상태가 아니라면 셀 단위 복사
        if (!sel || sel.toString().length === 0) {
          e.preventDefault();
          copySelectedCells();
          return;
        }
      }

      if (code === 'KeyV' && selectedDateKeys.size > 0 && clipboardCells.length > 0) {
        const sel = window.getSelection();
        if (!sel || sel.toString().length === 0) {
          e.preventDefault();
          pasteToSelectedCells();
          return;
        }
      }
    }

    // 다중 선택(2칸 이상) 시 Delete 키로 일괄 비우기
    if (e.key === 'Delete' && !isInputBox && selectedDateKeys.size > 1) {
      e.preventDefault();
      selectedDateKeys.forEach((key) => {
        setCellText(key, '');
      });
      renderCalendar();
      pushHistory();
      showToast(`🗑️ 선택한 ${selectedDateKeys.size}개 칸을 비웠습니다.`);
      return;
    }

    // Tab / Shift+Tab 으로 다음·이전 칸 이동
    if (e.key === 'Tab' && activeEl && activeEl.classList.contains('cell-editor')) {
      e.preventDefault();
      const editors = Array.from(document.querySelectorAll('.cell-editor'));
      const idx = editors.indexOf(activeEl);
      if (idx === -1) return;
      const nextIdx = e.shiftKey ? idx - 1 : idx + 1;
      if (nextIdx >= 0 && nextIdx < editors.length) {
        const nextEditor = editors[nextIdx];
        const nextKey = nextEditor.getAttribute('data-key');
        selectedDateKeys.clear();
        selectedDateKeys.add(nextKey);
        anchorDateKey = nextKey;
        syncSelectionDOM();
        nextEditor.focus();
      }
    }
  });
}

function getOrderedSelectedKeys() {
  const allKeys = Array.from(document.querySelectorAll('td.date-cell')).map((td) =>
    td.getAttribute('data-key')
  );
  return allKeys.filter((k) => selectedDateKeys.has(k));
}

function copySelectedCells() {
  const ordered = getOrderedSelectedKeys();
  if (ordered.length === 0) return;
  clipboardCells = ordered.map((key) => ({
    text: getCellText(key),
    fontSize: getCellFontSize(key),
  }));
  showToast(`📋 ${clipboardCells.length}개 칸 복사됨`);
}

function pasteToSelectedCells() {
  const ordered = getOrderedSelectedKeys();
  if (ordered.length === 0 || clipboardCells.length === 0) return;

  ordered.forEach((key, idx) => {
    const src =
      clipboardCells.length === 1
        ? clipboardCells[0]
        : clipboardCells[idx % clipboardCells.length];
    setCellText(key, src.text);
    setCellFontSize(key, src.fontSize);
  });

  renderCalendar();
  pushHistory();
  showToast(`📌 ${ordered.length}개 칸에 붙여넣기 완료`);
}

/* ── 인쇄 배율 & 전체 초기화 ── */
function updatePrintScale(value) {
  let v = parseFloat(value);
  if (isNaN(v)) return;
  if (v > 1) v = v / 100;
  printScale = v;
  const label = document.getElementById('printScaleValue');
  if (label) label.innerText = `${Math.round(printScale * 100)}%`;
  applyPrintScale(printScale);
}

function applyPrintScale(scale) {
  document.documentElement.style.setProperty('--print-scale', scale.toFixed(2));
}

function clearAll() {
  if (!confirm('현재 작성 중인 시간표 내용을 모두 초기화하시겠습니까?')) return;
  monthlyDatabase = {};
  selectedDateKeys.clear();
  anchorDateKey = null;
  renderCalendar();
  pushHistory();
  showToast('🔄 전체 내용이 초기화되었습니다.');
}

/* ── Supabase 온라인 저장 / 목록 / 불러오기 / 삭제 (비로그인 즉시 연동) ── */
async function saveToOnline() {
  const client = getSupabaseClient();
  if (!client) {
    alert('Supabase 연결 설정을 확인해 주세요.');
    return;
  }

  const name = document.getElementById('studentName').value.trim() || '이름없음';
  let startDate = document.getElementById('startDateInput').value;
  let endDate = document.getElementById('endDateInput').value;

  const filledDates = [];
  for (const dateKey in monthlyDatabase) {
    if (dateKey.startsWith('_')) continue;
    const [year, monthIdx] = dateKey.split('_').map(Number);
    const dayMap = monthlyDatabase[dateKey];
    if (!dayMap) continue;

    for (const day in dayMap) {
      const items = dayMap[day];
      const hasContent =
        Array.isArray(items) && items.some((item) => item && item.trim() !== '');
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

function openOnlineList() {
  const appShell = document.getElementById('appShell');
  appShell.classList.add('show-online-panel');
  const searchInput = document.getElementById('onlineSearchInput');
  if (searchInput) searchInput.value = '';
  fetchOnlineSchedules();
}

function closeOnlineList() {
  document.getElementById('appShell').classList.remove('show-online-panel');
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
    body.innerHTML = `<div class="online-empty">시간표를 불러오지 못했습니다.<br><small>${error.message}</small></div>`;
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

    const row = document.createElement('div');
    row.className = 'online-card';
    row.innerHTML = `
      <div class="online-card-main">
        <div class="online-card-title">
          <span class="student-badge">학생</span>
          <strong>${escapeHtml(item.student_name || '이름 없음')}</strong>
        </div>
        <div class="online-card-meta">
          <span>📅 ${item.start_date} ~ ${item.end_date}</span>
          <span>🕒 ${createdAt}</span>
        </div>
      </div>
      <div class="online-card-actions">
        <button type="button" class="btn-card-load" data-id="${item.id}">불러오기</button>
        <button type="button" class="btn-card-delete" data-id="${item.id}">삭제</button>
      </div>
    `;
    body.appendChild(row);
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
  if (!client) return;

  const { data, error } = await client
    .from('schedules')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) {
    alert(`불러오기에 실패했습니다: ${error ? error.message : '데이터 없음'}`);
    return;
  }

  document.getElementById('studentName').value = data.student_name || '';
  monthlyDatabase = data.monthly_database || {};
  if (data.font_size) defaultFontSize = data.font_size;

  if (data.start_date) {
    const sDate = parseDateInput(data.start_date);
    if (sDate) {
      document.getElementById('startDateInput').value = formatDateInput(sDate);
      document.getElementById('endDateInput').value = formatDateInput(addOneMonth(sDate));
    }
  }

  selectedDateKeys.clear();
  anchorDateKey = null;
  updateHeaderTitle();
  renderCalendar();
  pushHistory();
  showToast(`📂 ${data.student_name || '선택'} 학생의 시간표를 불러왔습니다.`);
}

async function deleteFromOnline(id) {
  if (!confirm('선택한 학생의 시간표를 삭제하시겠습니까?')) return;
  const client = getSupabaseClient();
  if (!client) return;

  const { error } = await client.from('schedules').delete().eq('id', id);
  if (error) {
    alert(`삭제에 실패했습니다: ${error.message}`);
    return;
  }

  showToast('🗑️ 시간표가 삭제되었습니다.');
  fetchOnlineSchedules();
}
