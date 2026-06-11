// Content script for DIU IntelliMarks Extension
console.log('DIU IntelliMarks: Content script loaded');

// --- VOICE RECORDING LOGIC ---
let mediaRecorder = null;
let audioChunks = [];
let currentStream = null;

chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
  
  // Handle Mark Filling
  if (request.action === 'fillMarks') {
    fillMarksData(request.data, request.columnIndex, request.columnName)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, message: error.message }));
    return true; 
  }

  // Handle Start Recording
  if (request.action === 'startRecording') {
    startAudioRecording()
      .then(() => sendResponse({ status: 'started' }))
      .catch(err => sendResponse({ status: 'error', message: err.message }));
    return true;
  }

  // Handle Stop Recording
  if (request.action === 'stopRecording') {
    stopAudioRecording()
      .then(result => sendResponse({ status: 'stopped', blobBase64: result.blobBase64, mimeType: result.mimeType }))
      .catch(err => sendResponse({ status: 'error', message: err.message }));
    return true;
  }

  // Get all student IDs from the marks table
  if (request.action === 'getStudentIds') {
    sendResponse({ ids: getStudentIdsFromPage() });
    return true;
  }

  // Get all student {id, name} pairs from the marks table
  if (request.action === 'getStudentData') {
    sendResponse({ students: getStudentDataFromPage() });
    return true;
  }
});

// Helper: strip hyphens for digits-only comparison
// Allows matching "251-15-012" against "25115012", and 16-digit IDs against formatted ones
function normalizeIdDigits(id) {
  return String(id).replace(/-/g, '');
}

// Helper: extract student IDs from the first column of the marks table
function getStudentIdsFromPage() {
  return getStudentDataFromPage().map(s => s.id);
}

// Helper: extract [{id, name}] from the marks table (col 0 = ID, col 1 = name)
function getStudentDataFromPage() {
  const table = findMarksTable();
  if (!table) return [];

  const tbody = table.querySelector('tbody');
  const rows = (tbody || table).querySelectorAll('tr');
  const students = [];

  for (const row of rows) {
    const cells = row.querySelectorAll('td');
    if (cells.length < 1) continue;
    const idText = cells[0].textContent.trim();
    if (idText.match(/^\d{3}-\d{2}-\d{3}$/) || idText.match(/^\d{16}$/)) {
      students.push({
        id: idText,
        name: cells[1] ? cells[1].textContent.trim() : '',
      });
    }
  }
  return students;
}

async function startAudioRecording() {
  try {
    currentStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(currentStream);
    audioChunks = [];

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.start();
    console.log('Recording started...');
  } catch (error) {
    console.error('Mic Error:', error);
    throw error;
  }
}

function stopAudioRecording() {
  return new Promise((resolve, reject) => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      reject(new Error('Not recording'));
      return;
    }

    mediaRecorder.onstop = () => {
      const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
      
      if (currentStream) {
        currentStream.getTracks().forEach(track => track.stop());
        currentStream = null;
      }

      const reader = new FileReader();
      reader.onloadend = () => {
        const base64Audio = reader.result.split(',')[1];
        resolve({ blobBase64: base64Audio, mimeType: 'audio/webm' });
      };
      reader.onerror = () => reject(new Error('Failed to read audio for transfer'));
      reader.readAsDataURL(audioBlob);
    };

    mediaRecorder.stop();
  });
}

async function fillMarksData(data, columnIndex, columnName) {
  console.log('DIU IntelliMarks: Filling data', { data, columnIndex, columnName });

  const table = findMarksTable();
  if (!table) {
    return { success: false, message: 'No marks table found on this page' };
  }

  const tbody = table.querySelector('tbody');
  const rowsContainer = tbody || table;
  const rows = rowsContainer.querySelectorAll('tr');

  // Build two secondary lookup maps so we can fall back gracefully:
  //
  // 1. digits-only map  → handles "251-15-012" ↔ "25115012" and 16-digit ↔ formatted mismatches
  // 2. name map         → handles data keyed by student name instead of ID
  const normalizedIdMap = {};
  const nameMap = {};

  Object.entries(data).forEach(([key, mark]) => {
    normalizedIdMap[normalizeIdDigits(key)] = mark;
    if (/[a-zA-Z]/.test(key)) {
      nameMap[key.toLowerCase().trim()] = mark;
    }
  });

  let filledCount = 0;
  let matchedCount = 0;

  for (const row of rows) {
    const cells = row.querySelectorAll('td');
    if (cells.length === 0) continue;

    const studentId   = cells[0].textContent.trim();
    const studentName = cells[1] ? cells[1].textContent.trim() : '';

    // Lookup priority:
    //   1. Exact ID match
    //   2. Digits-only ID match  (handles hyphens / 16-digit differences)
    //   3. Student name match    (case-insensitive)
    let mark;
    if (data[studentId] !== undefined) {
      mark = data[studentId];
    } else if (normalizedIdMap[normalizeIdDigits(studentId)] !== undefined) {
      mark = normalizedIdMap[normalizeIdDigits(studentId)];
    } else if (studentName && nameMap[studentName.toLowerCase()] !== undefined) {
      mark = nameMap[studentName.toLowerCase()];
    }

    if (mark !== undefined) {
      matchedCount++;
      const targetCell = cells[columnIndex];
      if (targetCell) {
        const filled = await fillCell(targetCell, mark);
        if (filled) filledCount++;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  if (matchedCount === 0) {
    return { success: false, message: 'No matching students found.' };
  }

  return {
    success: true,
    filledCount: filledCount,
    message: `Filled ${filledCount} out of ${matchedCount} matched students`
  };
}

function findMarksTable() {
  const tables = document.querySelectorAll('table');
  for (const table of tables) {
    const tbody = table.querySelector('tbody');
    const rows = tbody ? tbody.querySelectorAll('tr') : table.querySelectorAll('tr');
    for (const row of rows) {
      const firstCell = row.querySelector('td');
      if (firstCell) {
        const text = firstCell.textContent.trim();
        if (text.match(/^\d{3}-\d{2}-\d{3}$/) || text.match(/^\d{16}$/)) {
          return table;
        }
      }
    }
  }
  return tables[0];
}

async function fillCell(cell, score) {
  const input = cell.querySelector('input[type="number"]');
  if (input) {
    input.focus();
    await new Promise(resolve => setTimeout(resolve, 50));
    input.value = '';
    input.value = score.toString();
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
    return true;
  }

  const editableSpan = cell.querySelector('.editable-cell');
  if (editableSpan) {
    editableSpan.click();
    await new Promise(resolve => setTimeout(resolve, 50));
    const dynamicInput = cell.querySelector('input');
    if (dynamicInput) {
      dynamicInput.value = score;
      dynamicInput.dispatchEvent(new Event('input', { bubbles: true }));
      dynamicInput.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      editableSpan.textContent = score;
    }
    return true;
  }
  return false;
}