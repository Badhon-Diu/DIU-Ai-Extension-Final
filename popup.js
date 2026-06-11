// Popup script for DIU IntelliMarks Extension
document.addEventListener('DOMContentLoaded', function() {
  // Tab switching
  const tabs = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');
  tabs.forEach(tab => {
    tab.addEventListener('click', function() {
      const targetTab = this.getAttribute('data-tab');
      tabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      this.classList.add('active');
      document.getElementById(targetTab).classList.add('active');
    });
  });

  // ==================== GLOBALS ====================
  // Change API_BASE_URL to your LAN IP when using QR / mobile upload on local network.
  // e.g. 'http://192.168.1.42:3001'  — the server prints it on startup as "✓ Network: ..."
  const API_BASE_URL = 'http://localhost:3001';

  let currentValidStudentIds = [];   // will be filled from active tab

  // Strip hyphens so "251-15-012", "25115012", and "0242220005101707" can all
  // be compared on equal footing.
  function normalizeIdDigits(id) {
    return String(id).replace(/-/g, '');
  }

  // Returns true if `id` matches any entry in currentValidStudentIds,
  // using both exact string and digits-only comparison.
  function isValidId(id) {
    if (currentValidStudentIds.includes(id)) return true;
    const norm = normalizeIdDigits(id);
    return currentValidStudentIds.some(v => normalizeIdDigits(v) === norm);
  }
  let voiceAiResults = {};
  let aiGeneratedResults = {};
  let qrAiResults = {};
  let uploadedFiles = [];

  // ==================== HELPERS: Fetch live student data from page ====================

  async function fetchStudentIds() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        if (tabs.length === 0) { resolve([]); return; }
        chrome.tabs.sendMessage(tabs[0].id, { action: 'getStudentIds' }, function(response) {
          if (chrome.runtime.lastError || !response || !response.ids) resolve([]);
          else resolve(response.ids);
        });
      });
    });
  }

  // Returns [{id, name}, ...] for all students currently on the page
  async function fetchStudentData() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        if (tabs.length === 0) { resolve([]); return; }
        chrome.tabs.sendMessage(tabs[0].id, { action: 'getStudentData' }, function(response) {
          if (chrome.runtime.lastError || !response || !response.students) resolve([]);
          else resolve(response.students);
        });
      });
    });
  }

  /**
   * Match raw API result items against the actual student list from the page.
   * Priority: exact ID → digits-only ID → exact name → partial name.
   * Falls back to keeping the raw ID when no match is found.
   * Returns { [canonicalId]: mark } keyed by the real page IDs.
   */
  function matchResultsToStudents(resultItems, studentData) {
    if (!resultItems || resultItems.length === 0) return {};

    // If we have no student context, fall back to basic transform
    if (!studentData || studentData.length === 0) return transformApiData(resultItems);

    const byId   = new Map(studentData.map(s => [s.id, s]));
    const byNorm = new Map(studentData.map(s => [s.id.replace(/-/g, ''), s]));
    const byName = new Map(
      studentData.filter(s => s.name).map(s => [s.name.toLowerCase().trim(), s])
    );

    const result = {};

    resultItems.forEach(item => {
      const rawId   = item['student id'] || item.student_id || item.studentId || '';
      const rawName = item.name || item.studentName || item.student_name || '';
      const mark    = item.mark ?? item.marks ?? item.score;
      if (mark === undefined) return;

      let student = null;

      // 1. Exact ID
      if (rawId) student = byId.get(rawId);

      // 2. Digits-only ID  (handles "25115146" ↔ "251-15-146")
      if (!student && rawId) student = byNorm.get(rawId.replace(/-/g, ''));

      // 3. Exact name
      if (!student && rawName) student = byName.get(rawName.toLowerCase().trim());

      // 4. Partial name (AI may return only first name or truncated name)
      if (!student && rawName) {
        const lower = rawName.toLowerCase().trim();
        for (const [key, val] of byName) {
          if (key.includes(lower) || lower.includes(key)) { student = val; break; }
        }
      }

      if (student) {
        result[student.id] = mark;
      } else if (rawId && rawId !== 'N/A') {
        // No match found — keep the raw ID so content.js can still try
        result[rawId] = mark;
      }
    });

    return result;
  }

  // Update UI elements that depend on valid IDs (mismatch sections)
  function displayFilteredResults(resultsContainerId, mismatchContainerId, resultsObj) {
    const resultsContent = document.getElementById(resultsContainerId);
    const mismatchSection = document.getElementById(mismatchContainerId);
    const mismatchList = document.getElementById(mismatchContainerId.replace('Section', 'List'));

    const matchedIds   = Object.keys(resultsObj).filter(id => isValidId(id));
    const mismatchedIds = Object.keys(resultsObj).filter(id => !isValidId(id));
    
    resultsContent.innerHTML = matchedIds.map(id => `
      <div class="result-item">
        <span class="result-id">${id}</span>
        <span class="result-score">${resultsObj[id]}</span>
      </div>
    `).join('');

    if (mismatchedIds.length > 0 && mismatchSection) {
      mismatchSection.classList.remove('hidden');
      if (mismatchList) {
        mismatchList.innerHTML = mismatchedIds.map(id => `<span class="mismatch-item">${id}</span>`).join('');
      }
    } else if (mismatchSection) {
      mismatchSection.classList.add('hidden');
    }
  }

  // ==================== AUDIO TAB (Manual Entry) ====================
  const columnSelect = document.getElementById('columnSelect');
  const dataInput = document.getElementById('dataInput');
  const saveBtn = document.getElementById('saveBtn');
  const fillBtn = document.getElementById('fillBtn');
  const clearBtn = document.getElementById('clearBtn');
  const exportBtn = document.getElementById('exportBtn');
  const saveStatus = document.getElementById('saveStatus');
  const actionStatus = document.getElementById('actionStatus');
  const savedDataPreview = document.getElementById('savedDataPreview');

  const columnMapping = {
    'attendance': 2,   // ATTM
    'quiz1': 3,        // Q1
    'quiz2': 4,        // Q2
    'quiz3': 5,        // Q3
    'presentation': 7, // Presn
    'assignment': 8,   // Assign
    'midterm': 9,      // MT
    'final': 14        // Final
  };

  loadSavedData();

  saveBtn.addEventListener('click', function() {
    const column = columnSelect.value;
    const inputText = dataInput.value.trim();
    if (!inputText) {
      showStatus(saveStatus, 'Please enter some data!', 'error');
      return;
    }
    const parsedData = parseInputData(inputText);
    if (Object.keys(parsedData).length === 0) {
      showStatus(saveStatus, 'No valid data found. Use format: StudentID: Score', 'error');
      return;
    }
    const storageKey = 'marks_' + column;
    chrome.storage.local.set({ [storageKey]: parsedData }, function() {
      showStatus(saveStatus, `Saved ${Object.keys(parsedData).length} student records!`, 'success');
      loadSavedData();
      dataInput.value = '';
    });
  });

  fillBtn.addEventListener('click', async function() {
    const column = columnSelect.value;
    const storageKey = 'marks_' + column;
    chrome.storage.local.get([storageKey], async function(result) {
      const data = result[storageKey];
      if (!data || Object.keys(data).length === 0) {
        showStatus(actionStatus, 'No saved data for this column. Please save data first.', 'error');
        return;
      }
      // Refresh valid IDs before filling
      currentValidStudentIds = await fetchStudentIds();
      const columnIndex = columnMapping[column];
      chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        if (tabs.length === 0) return;
        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'fillMarks',
          data: data,
          columnIndex: columnIndex,
          columnName: column
        }, function(response) {
          if (chrome.runtime.lastError) {
            showStatus(actionStatus, 'Error: ' + chrome.runtime.lastError.message, 'error');
            return;
          }
          if (response && response.success) {
            showStatus(actionStatus, `Successfully filled ${response.filledCount} student marks!`, 'success');
          } else {
            showStatus(actionStatus, response?.message || 'Failed to fill marks', 'error');
          }
        });
      });
    });
  });

  clearBtn.addEventListener('click', function() {
    if (confirm('Are you sure you want to clear all saved data?')) {
      chrome.storage.local.clear(function() {
        voiceAiResults = {};
        aiGeneratedResults = {};
        qrAiResults = {};
        uploadedFiles = [];
        // Hide all result cards
        document.getElementById('voiceResultsCard').classList.add('hidden');
        document.getElementById('voiceChatCard').classList.add('hidden');
        document.getElementById('voiceRecordCard').classList.remove('hidden');
        document.getElementById('resultsCard').classList.add('hidden');
        document.getElementById('uploadCard').classList.remove('hidden');
        document.getElementById('fileListCard').classList.add('hidden');
        document.getElementById('qrResultsCard').classList.add('hidden');
        document.getElementById('qrDisplayCard').classList.remove('hidden');
        document.getElementById('startScanBtn').classList.remove('hidden');
        document.getElementById('timerContainer').classList.add('hidden');
        showStatus(actionStatus, 'All data cleared!', 'success');
        loadSavedData();
      });
    }
  });

  exportBtn.addEventListener('click', function() {
    chrome.storage.local.get(null, function(result) {
      const dataStr = JSON.stringify(result, null, 2);
      const blob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'diu-marks-data.json';
      a.click();
      URL.revokeObjectURL(url);
      showStatus(actionStatus, 'Data exported!', 'success');
    });
  });

  function loadSavedData() {
    chrome.storage.local.get(null, function(result) {
      let html = '';
      let hasData = false;
      const columnNames = {
        'marks_quiz1': 'Quiz 1', 'marks_quiz2': 'Quiz 2', 'marks_quiz3': 'Quiz 3',
        'marks_attendance': 'Attendance', 'marks_presentation': 'Presentation',
        'marks_assignment': 'Assignment', 'marks_midterm': 'Midterm', 'marks_final': 'Final'
      };
      for (const [key, value] of Object.entries(result)) {
        if (key.startsWith('marks_') && Object.keys(value).length > 0) {
          hasData = true;
          const columnName = columnNames[key] || key;
          const studentCount = Object.keys(value).length;
          html += `<div style="margin-bottom: 14px;">`;
          html += `<div style="font-weight: 600; color: #667eea; font-size: 13px; margin-bottom: 8px;">${columnName} (${studentCount} students)</div>`;
          for (const [studentId, score] of Object.entries(value)) {
            html += `<div class="student-item"><span class="student-id">${studentId}</span><span class="student-score">${score}</span></div>`;
          }
          html += `</div>`;
        }
      }
      savedDataPreview.innerHTML = hasData ? html : '<div class="empty-state">No data saved yet</div>';
    });
  }

  function parseInputData(text) {
    const data = {};
    const lines = text.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Accept: XXX-XX-XXX  or  16-digit barcode ID  followed by a score
      const match = trimmed.match(/^(\d{3}-\d{2}-\d{3}|\d{16})[:\s,]+(\d+(?:\.\d+)?)$/);
      if (match) {
        data[match[1]] = parseFloat(match[2]);
      }
    }
    return data;
  }

  // ==================== VOICE WITH AI TAB ====================
  const voiceAssessmentType = document.getElementById('voiceAssessmentType');
  const voiceRecordBtn = document.getElementById('voiceRecordBtn');
  const recordingIndicator = document.getElementById('recordingIndicator');
  const voiceRecordCard = document.getElementById('voiceRecordCard');
  const voiceProcessingCard = document.getElementById('voiceProcessingCard');
  const voiceChatCard = document.getElementById('voiceChatCard');
  const voiceChatContainer = document.getElementById('voiceChatContainer');
  const voiceResultsCard = document.getElementById('voiceResultsCard');
  const voiceAiResultsContent = document.getElementById('voiceAiResultsContent');
  const voiceMismatchSection = document.getElementById('voiceMismatchSection');
  const voiceMismatchList = document.getElementById('voiceMismatchList');
  const voiceFillAIBtn = document.getElementById('voiceFillAIBtn');
  const voiceResetBtn = document.getElementById('voiceResetBtn');
  const voiceStatus = document.getElementById('voiceStatus');
  const manualToggle = document.getElementById('manualToggle');
  const manualSection = document.getElementById('manualSection');

  let isRecording = false;

  if (manualToggle) {
    manualToggle.addEventListener('click', function() {
      const isHidden = manualSection.style.display === 'none';
      manualSection.style.display = isHidden ? 'block' : 'none';
      manualToggle.textContent = isHidden ? '⌨️ Manual Entry (Click to collapse)' : '⌨️ Manual Entry (Click to expand)';
    });
  }

  voiceRecordBtn.addEventListener('click', async function() {
    const assessment = voiceAssessmentType.value;
    if (!assessment) {
      showStatus(voiceStatus, 'Please select an assessment type first!', 'error');
      return;
    }
    chrome.tabs.query({ active: true, currentWindow: true }, async function(tabs) {
      if (tabs.length === 0) {
        showStatus(voiceStatus, 'No active tab found!', 'error');
        return;
      }
      const tabId = tabs[0].id;

      if (!isRecording) {
        showStatus(voiceStatus, 'Starting microphone...', 'success');
        voiceRecordBtn.querySelector('.voice-text').textContent = 'Starting...';
        voiceRecordBtn.disabled = true;
        chrome.tabs.sendMessage(tabId, { action: 'startRecording' }, function(response) {
          voiceRecordBtn.disabled = false;
          if (chrome.runtime.lastError) {
            showStatus(voiceStatus, 'Content script not found. Open the DIU marks portal page and try again.', 'error');
            voiceRecordBtn.querySelector('.voice-text').textContent = 'Voice with AI';
            return;
          }
          if (response && response.status === 'started') {
            isRecording = true;
            voiceRecordBtn.classList.add('recording');
            voiceRecordBtn.querySelector('.voice-text').textContent = 'Recording...';
            voiceRecordBtn.querySelector('.voice-subtext').textContent = 'Click to stop';
            recordingIndicator.classList.remove('hidden');
            showStatus(voiceStatus, 'Recording... Speak the marks clearly', 'success');
          } else if (response && response.status === 'error') {
            showStatus(voiceStatus, 'Microphone error: ' + response.message, 'error');
            voiceRecordBtn.querySelector('.voice-text').textContent = 'Voice with AI';
          }
        });
      } else {
        showStatus(voiceStatus, 'Processing audio...', 'success');
        voiceRecordBtn.querySelector('.voice-text').textContent = 'Stopping...';
        voiceRecordBtn.disabled = true;
        chrome.tabs.sendMessage(tabId, { action: 'stopRecording' }, async function(response) {
          voiceRecordBtn.disabled = false;
          if (chrome.runtime.lastError) {
            showStatus(voiceStatus, 'Error stopping recording.', 'error');
            voiceRecordBtn.querySelector('.voice-text').textContent = 'Voice with AI';
            return;
          }
          if (response && response.status === 'stopped') {
            isRecording = false;
            voiceRecordBtn.classList.remove('recording');
            voiceRecordBtn.querySelector('.voice-text').textContent = 'Voice with AI';
            voiceRecordBtn.querySelector('.voice-subtext').textContent = 'Click to start recording';
            recordingIndicator.classList.add('hidden');
            await processVoiceAudio(response.blobBase64, assessment);
          }
        });
      }
    });
  });

  async function processVoiceAudio(base64Audio, assessment) {
    voiceRecordCard.classList.add('hidden');
    voiceProcessingCard.classList.remove('hidden');
    try {
      // Fetch student list before the API call so it can be sent as context
      const studentData = await fetchStudentData();

      const response = await fetch(`${API_BASE_URL}/api/analyze-audio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: base64Audio, assessment, students: studentData })
      });
      if (!response.ok) {
        const errBody = await response.json().catch(() => ({}));
        throw new Error(errBody.error || 'API request failed (status ' + response.status + ')');
      }
      const apiData = await response.json();

      // Server returns { results: [...], transcript: "..." }
      const resultItems = Array.isArray(apiData) ? apiData : (apiData.results || []);
      const transcript  = (!Array.isArray(apiData) && apiData.transcript) ? apiData.transcript : '';

      // Match against actual student list for canonical IDs
      voiceAiResults = matchResultsToStudents(resultItems, studentData);

      voiceProcessingCard.classList.add('hidden');
      showVoiceChat(resultItems, transcript);
      voiceResultsCard.classList.remove('hidden');
      currentValidStudentIds = studentData.map(s => s.id);
      displayFilteredResults('voiceAiResultsContent', 'voiceMismatchSection', voiceAiResults);
      chrome.storage.local.set({ '_pendingVoice': { assessment, results: voiceAiResults, resultItems, transcript } });
    } catch (error) {
      showStatus(voiceStatus, 'Error: ' + error.message, 'error');
      voiceProcessingCard.classList.add('hidden');
      voiceRecordCard.classList.remove('hidden');
    }
  }

  function showVoiceChat(resultItems, transcript) {
    let html = '';

    if (transcript) {
      html += `<div class="chat-bubble" style="background:#f0f4ff;font-style:italic;">
                 🎙️ Whisper heard: "${transcript}"
               </div>`;
    }

    if (!resultItems || resultItems.length === 0) {
      html += '<div class="chat-bubble">No marks detected in audio</div>';
      if (transcript) {
        html += '<div class="chat-bubble ai">The transcript above was not parsed into any marks. Check IDs and keywords (got / পেয়েছে).</div>';
      } else if (transcript === '') {
        html += '<div class="chat-bubble ai">Whisper returned an empty transcript. Check microphone input and audio quality.</div>';
      }
    } else {
      html += resultItems.map(item => {
        const id   = item['student id'] || item.student_id || item.studentId || '???';
        const mark = item.mark ?? item.marks ?? item.score ?? '?';
        return `<div class="chat-bubble">Detected: ${id} → ${mark} marks</div>
                <div class="chat-bubble ai">Recorded ${id}: ${mark}</div>`;
      }).join('');
    }

    voiceChatContainer.innerHTML = html;
    voiceChatCard.classList.remove('hidden');
  }

  function transformApiData(apiData) {
    const results = {};
    if (Array.isArray(apiData)) {
      apiData.forEach(item => {
        const studentId = item['student id'] || item.student_id || item.studentId;
        const mark = item.mark ?? item.marks ?? item.score;
        if (studentId && mark !== undefined) {
          results[studentId] = mark;
        }
        // Also index by name so fillMarksData can fall back to name matching
        const name = item.name || item.studentName || item.student_name;
        if (name && mark !== undefined) {
          results[name] = mark;
        }
      });
    }
    return results;
  }

  voiceFillAIBtn.addEventListener('click', async function() {
    const assessment = voiceAssessmentType.value;
    const storageKey = 'marks_' + assessment;
    // Save all results; let fillMarksData (content script) do the matching —
    // it already handles exact ID, normalised digits, and student name lookups.
    chrome.storage.local.set({ [storageKey]: voiceAiResults }, function() {
      chrome.storage.local.remove('_pendingVoice');
      showStatus(voiceStatus, `Saved ${Object.keys(voiceAiResults).length} AI voice records!`, 'success');
      loadSavedData();
      chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        if (tabs.length > 0) {
          const columnIndex = columnMapping[assessment];
          chrome.tabs.sendMessage(tabs[0].id, {
            action: 'fillMarks',
            data: voiceAiResults,
            columnIndex: columnIndex,
            columnName: assessment
          }, function(response) {
            if (chrome.runtime.lastError) {
              showStatus(voiceStatus, 'Error: ' + chrome.runtime.lastError.message, 'error');
              return;
            }
            if (response && response.success) {
              showStatus(voiceStatus, `Successfully filled ${response.filledCount} marks from voice AI!`, 'success');
            } else {
              showStatus(voiceStatus, response?.message || 'No matching students found on page', 'error');
            }
          });
        }
      });
    });
  });

  voiceResetBtn.addEventListener('click', function() {
    voiceAiResults = {};
    voiceResultsCard.classList.add('hidden');
    voiceChatCard.classList.add('hidden');
    voiceChatContainer.innerHTML = '';
    voiceRecordCard.classList.remove('hidden');
    voiceAssessmentType.value = '';
    chrome.storage.local.remove('_pendingVoice');
    showStatus(voiceStatus, '', '');
  });

  // Restore pending voice results
  chrome.storage.local.get(['_pendingVoice'], async function(data) {
    if (data._pendingVoice) {
      const p = data._pendingVoice;
      voiceAssessmentType.value = p.assessment;
      voiceAiResults = p.results;
      if (p.resultItems !== undefined) showVoiceChat(p.resultItems, p.transcript || '');
      else if (p.apiData) showVoiceChat(Array.isArray(p.apiData) ? p.apiData : (p.apiData.results || []), p.apiData.transcript || '');
      voiceChatCard.classList.remove('hidden');
      voiceProcessingCard.classList.add('hidden');
      voiceRecordCard.classList.add('hidden');
      voiceResultsCard.classList.remove('hidden');
      currentValidStudentIds = await fetchStudentIds();
      displayFilteredResults('voiceAiResultsContent', 'voiceMismatchSection', voiceAiResults);
    }
  });

  // ==================== QR SCAN TAB (Mobile Upload) ====================
  const qrAssessmentType    = document.getElementById('qrAssessmentType');
  const qrDisplayCard       = document.getElementById('qrDisplayCard');
  const qrProcessingCard    = document.getElementById('qrProcessingCard');
  const qrResultsCard       = document.getElementById('qrResultsCard');
  const qrImage             = document.getElementById('qrImage');
  const qrPlaceholder       = document.getElementById('qrPlaceholder');
  const scanStatus          = document.getElementById('scanStatus');
  const qrUrlText           = document.getElementById('qrUrlText');
  const qrImageCountCard    = document.getElementById('qrImageCountCard');
  const qrImageCountText    = document.getElementById('qrImageCountText');
  const refreshQrBtn        = document.getElementById('refreshQrBtn');
  const generateQrBtn       = document.getElementById('generateQrBtn');
  const processQrImagesBtn  = document.getElementById('processQrImagesBtn');
  const qrAiResultsContent  = document.getElementById('qrAiResultsContent');
  const qrMismatchSection   = document.getElementById('qrMismatchSection');
  const qrMismatchList      = document.getElementById('qrMismatchList');
  const qrFillAIBtn         = document.getElementById('qrFillAIBtn');
  const qrResetBtn          = document.getElementById('qrResetBtn');
  const qrStatus            = document.getElementById('qrStatus');

  let currentQrUuid = null;

  // Helper: resolve the correct base URL for mobile QR links.
  // If the server reports a LAN IP (starts with 192.168.), use it so the QR
  // URL works on the phone. Otherwise the server is live/public and API_BASE_URL
  // already points to the right host — use that directly.
  async function getMobileBaseUrl() {
    try {
      const res  = await fetch(`${API_BASE_URL}/api/network-info`);
      const info = await res.json();
      if (info && info.lanIp && info.lanIp.startsWith('192.168.')) {
        return info.baseUrl; // local network — use LAN IP
      }
    } catch (_) { /* fall through */ }
    return API_BASE_URL; // live server or fallback
  }

  // Helper: show QR code image + URL for a given uuid + mobileBase
  function applyQrSession(uuid, mobileBase) {
    const base      = mobileBase || API_BASE_URL;
    const uploadUrl = `${base}/upload/${uuid}`;
    const qrApiUrl  = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(uploadUrl)}&format=png&qzone=2`;

    qrImage.src             = qrApiUrl;
    qrImage.style.display   = 'block';
    qrPlaceholder.style.display = 'none';

    qrUrlText.textContent   = uploadUrl;
    qrUrlText.style.display = 'block';

    scanStatus.textContent  = 'Scan with phone to upload images';
    scanStatus.className    = 'scan-status scanning';

    qrImageCountCard.classList.remove('hidden');
    processQrImagesBtn.classList.remove('hidden');
    generateQrBtn.textContent = '↻ Regenerate';
  }

  // ── Generate QR ─────────────────────────────────────────────────────────────
  generateQrBtn.addEventListener('click', async function() {
    const assessment = qrAssessmentType.value;
    if (!assessment) {
      showStatus(qrStatus, 'Please select an assessment type first!', 'error');
      return;
    }
    currentQrUuid = crypto.randomUUID();
    processQrImagesBtn.disabled = true;
    qrImageCountText.textContent = 'No images uploaded yet';
    qrImageCountText.style.color = '';
    showStatus(qrStatus, 'Generating QR code…', '');

    const mobileBase = await getMobileBaseUrl();
    applyQrSession(currentQrUuid, mobileBase);

    chrome.storage.local.set({ '_pendingQrSession': { uuid: currentQrUuid, assessment } });
    showStatus(qrStatus, 'QR code ready — scan with a mobile device to upload mark sheets.', 'success');
  });

  // ── Refresh image count ──────────────────────────────────────────────────────
  refreshQrBtn.addEventListener('click', async function() {
    if (!currentQrUuid) return;
    refreshQrBtn.disabled     = true;
    refreshQrBtn.textContent  = 'Checking…';

    try {
      const resp = await fetch(`${API_BASE_URL}/api/session/${currentQrUuid}`);
      const data = await resp.json();
      const count = data.count || 0;

      if (count > 0) {
        qrImageCountText.textContent = `${count} image${count > 1 ? 's' : ''} uploaded from mobile`;
        qrImageCountText.style.color = 'var(--success)';
        processQrImagesBtn.disabled  = false;
      } else {
        qrImageCountText.textContent = 'No images uploaded yet';
        qrImageCountText.style.color = '';
      }
      showStatus(qrStatus, `Found ${count} image${count !== 1 ? 's' : ''} on server.`, count > 0 ? 'success' : '');
    } catch (err) {
      showStatus(qrStatus, 'Refresh failed: ' + err.message, 'error');
    } finally {
      refreshQrBtn.disabled    = false;
      refreshQrBtn.textContent = '↻ Refresh Image Count';
    }
  });

  // ── Process uploaded images ──────────────────────────────────────────────────
  processQrImagesBtn.addEventListener('click', async function() {
    if (!currentQrUuid) return;

    qrDisplayCard.classList.add('hidden');
    qrProcessingCard.classList.remove('hidden');
    showStatus(qrStatus, '', '');

    try {
      const studentData = await fetchStudentData();

      const resp = await fetch(`${API_BASE_URL}/api/session/${currentQrUuid}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ students: studentData }),
      });
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        throw new Error(e.error || 'Analysis failed (status ' + resp.status + ')');
      }

      const apiData     = await resp.json();
      const resultItems = Array.isArray(apiData) ? apiData : (apiData.results || []);

      qrAiResults = matchResultsToStudents(resultItems, studentData);

      qrProcessingCard.classList.add('hidden');
      qrResultsCard.classList.remove('hidden');

      currentValidStudentIds = studentData.map(s => s.id);
      displayFilteredResults('qrAiResultsContent', 'qrMismatchSection', qrAiResults);
      chrome.storage.local.set({ '_pendingQr': { assessment: qrAssessmentType.value, results: qrAiResults } });

    } catch (err) {
      showStatus(qrStatus, 'Error: ' + err.message, 'error');
      qrProcessingCard.classList.add('hidden');
      qrDisplayCard.classList.remove('hidden');
    }
  });

  // ── Fill button ──────────────────────────────────────────────────────────────
  qrFillAIBtn.addEventListener('click', async function() {
    const assessment = qrAssessmentType.value;
    const storageKey = 'marks_' + assessment;
    chrome.storage.local.set({ [storageKey]: qrAiResults }, function() {
      chrome.storage.local.remove(['_pendingQr', '_pendingQrSession']);
      showStatus(qrStatus, `Saved ${Object.keys(qrAiResults).length} record(s)!`, 'success');
      loadSavedData();
      chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        if (tabs.length === 0) return;
        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'fillMarks',
          data: qrAiResults,
          columnIndex: columnMapping[assessment],
          columnName: assessment,
        }, function(response) {
          if (chrome.runtime.lastError) {
            showStatus(qrStatus, 'Error: ' + chrome.runtime.lastError.message, 'error');
            return;
          }
          if (response && response.success) {
            showStatus(qrStatus, `Filled ${response.filledCount} marks successfully!`, 'success');
          } else {
            showStatus(qrStatus, response?.message || 'No matching students found', 'error');
          }
        });
      });
    });
  });

  // ── Reset ────────────────────────────────────────────────────────────────────
  qrResetBtn.addEventListener('click', function() {
    qrAiResults   = {};
    currentQrUuid = null;
    qrResultsCard.classList.add('hidden');
    qrProcessingCard.classList.add('hidden');
    qrDisplayCard.classList.remove('hidden');
    qrImage.style.display       = 'none';
    qrPlaceholder.style.display = 'block';
    qrUrlText.style.display     = 'none';
    qrImageCountCard.classList.add('hidden');
    processQrImagesBtn.classList.add('hidden');
    qrAssessmentType.value  = '';
    generateQrBtn.textContent = 'Generate QR Code';
    scanStatus.textContent  = 'No session active';
    scanStatus.className    = 'scan-status';
    chrome.storage.local.remove(['_pendingQr', '_pendingQrSession']);
    showStatus(qrStatus, '', '');
  });

  // ── Restore pending session on popup open ────────────────────────────────────
  chrome.storage.local.get(['_pendingQrSession', '_pendingQr'], async function(data) {
    if (data._pendingQrSession) {
      const p = data._pendingQrSession;
      currentQrUuid = p.uuid;
      qrAssessmentType.value = p.assessment;
      const mobileBase = await getMobileBaseUrl();
      applyQrSession(p.uuid, mobileBase);
    }
    if (data._pendingQr) {
      const p = data._pendingQr;
      qrAssessmentType.value = p.assessment;
      qrAiResults = p.results;
      qrDisplayCard.classList.add('hidden');
      qrResultsCard.classList.remove('hidden');
      currentValidStudentIds = await fetchStudentIds();
      displayFilteredResults('qrAiResultsContent', 'qrMismatchSection', qrAiResults);
    }
  });

  // ==================== UPLOAD IMAGES TAB ====================
  const assessmentType = document.getElementById('assessmentType');
  const uploadDropzone = document.getElementById('uploadDropzone');
  const fileInput = document.getElementById('fileInput');
  const uploadCard = document.getElementById('uploadCard');
  const fileListCard = document.getElementById('fileListCard');
  const fileList = document.getElementById('fileList');
  const fileCount = document.getElementById('fileCount');
  const clearAllFiles = document.getElementById('clearAllFiles');
  const processBtn = document.getElementById('processBtn');
  const processingCard = document.getElementById('processingCard');
  const resultsCard = document.getElementById('resultsCard');
  const aiResultsContent = document.getElementById('aiResultsContent');
  const mismatchSection = document.getElementById('mismatchSection');
  const mismatchList = document.getElementById('mismatchList');
  const fillAIBtn = document.getElementById('fillAIBtn');
  const resetUploadBtn = document.getElementById('resetUploadBtn');
  const uploadStatus = document.getElementById('uploadStatus');

  uploadDropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', handleFiles);
  uploadDropzone.addEventListener('dragover', (e) => { e.preventDefault(); uploadDropzone.classList.add('dragover'); });
  uploadDropzone.addEventListener('dragleave', () => { uploadDropzone.classList.remove('dragover'); });
  uploadDropzone.addEventListener('drop', (e) => { e.preventDefault(); uploadDropzone.classList.remove('dragover'); addFiles(Array.from(e.dataTransfer.files)); });

  function handleFiles(e) { addFiles(Array.from(e.target.files)); }

  function addFiles(files) {
    const validTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'application/pdf'];
    files.forEach(file => {
      if (validTypes.includes(file.type) || file.name.endsWith('.pdf')) {
        if (!uploadedFiles.find(f => f.name === file.name && f.size === file.size)) {
          uploadedFiles.push(file);
        }
      }
    });
    updateFileList();
  }

  function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function updateFileList() {
    if (uploadedFiles.length === 0) {
      fileListCard.classList.add('hidden');
      uploadCard.classList.remove('hidden');
      return;
    }
    uploadCard.classList.add('hidden');
    fileListCard.classList.remove('hidden');
    fileCount.textContent = `Uploaded Files (${uploadedFiles.length})`;
    fileList.innerHTML = uploadedFiles.map((file, index) => `
      <div class="file-item">
        <div class="file-info">
          <span class="file-icon">${file.type === 'application/pdf' ? '📄' : '🖼️'}</span>
          <div class="file-details">
            <div class="file-name">${file.name}</div>
            <div class="file-size">${formatFileSize(file.size)}</div>
          </div>
        </div>
        <button class="file-remove" data-index="${index}">✕</button>
      </div>
    `).join('');
    fileList.querySelectorAll('.file-remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const index = parseInt(e.target.dataset.index);
        uploadedFiles.splice(index, 1);
        updateFileList();
      });
    });
  }

  clearAllFiles.addEventListener('click', () => { uploadedFiles = []; updateFileList(); });

  processBtn.addEventListener('click', async function() {
    const assessment = assessmentType.value;
    if (!assessment) { showStatus(uploadStatus, 'Please select an assessment type first!', 'error'); return; }
    if (uploadedFiles.length === 0) { showStatus(uploadStatus, 'Please upload at least one file!', 'error'); return; }
    fileListCard.classList.add('hidden');
    processingCard.classList.remove('hidden');
    try {
      const studentData = await fetchStudentData();

      const formData = new FormData();
      uploadedFiles.forEach(file => formData.append('images', file));
      formData.append('assessment', assessment);
      if (studentData.length > 0) {
        formData.append('students', JSON.stringify(studentData));
      }

      const response = await fetch(`${API_BASE_URL}/api/analyze-images`, { method: 'POST', body: formData });
      if (!response.ok) throw new Error('API request failed');
      const apiData = await response.json();

      // Match raw results against actual student list
      aiGeneratedResults = matchResultsToStudents(Array.isArray(apiData) ? apiData : [], studentData);

      processingCard.classList.add('hidden');
      resultsCard.classList.remove('hidden');
      currentValidStudentIds = studentData.map(s => s.id);
      displayFilteredResults('aiResultsContent', 'mismatchSection', aiGeneratedResults);
      chrome.storage.local.set({ '_pendingImage': { assessment, results: aiGeneratedResults } });
    } catch (error) {
      showStatus(uploadStatus, 'Error processing images: ' + error.message, 'error');
      processingCard.classList.add('hidden');
      fileListCard.classList.remove('hidden');
    }
  });

  fillAIBtn.addEventListener('click', async function() {
    const assessment = assessmentType.value;
    const storageKey = 'marks_' + assessment;
    chrome.storage.local.set({ [storageKey]: aiGeneratedResults }, function() {
      chrome.storage.local.remove('_pendingImage');
      showStatus(uploadStatus, `Saved ${Object.keys(aiGeneratedResults).length} AI-generated records!`, 'success');
      loadSavedData();
      chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        if (tabs.length > 0) {
          const columnIndex = columnMapping[assessment];
          chrome.tabs.sendMessage(tabs[0].id, {
            action: 'fillMarks',
            data: aiGeneratedResults,
            columnIndex: columnIndex,
            columnName: assessment
          }, function(response) {
            if (chrome.runtime.lastError) {
              showStatus(uploadStatus, 'Error: ' + chrome.runtime.lastError.message, 'error');
              return;
            }
            if (response && response.success) {
              showStatus(uploadStatus, `Successfully filled ${response.filledCount} marks from AI analysis!`, 'success');
            } else {
              showStatus(uploadStatus, response?.message || 'No matching students found on page', 'error');
            }
          });
        }
      });
    });
  });

  resetUploadBtn.addEventListener('click', function() {
    uploadedFiles = [];
    aiGeneratedResults = {};
    resultsCard.classList.add('hidden');
    uploadCard.classList.remove('hidden');
    fileInput.value = '';
    chrome.storage.local.remove('_pendingImage');
  });

  chrome.storage.local.get(['_pendingImage'], async function(data) {
    if (data._pendingImage) {
      const p = data._pendingImage;
      assessmentType.value = p.assessment;
      aiGeneratedResults = p.results;
      processingCard.classList.add('hidden');
      fileListCard.classList.add('hidden');
      uploadCard.classList.add('hidden');
      resultsCard.classList.remove('hidden');
      currentValidStudentIds = await fetchStudentIds();
      displayFilteredResults('aiResultsContent', 'mismatchSection', aiGeneratedResults);
    }
  });

  // ==================== UTILITY FUNCTIONS ====================
  function showStatus(element, message, type) {
    element.textContent = message;
    element.className = 'status ' + type;
    setTimeout(() => { element.className = 'status'; }, 5000);
  }
});