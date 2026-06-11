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
  let currentValidStudentIds = [];   // will be filled from active tab
  let voiceAiResults = {};
  let aiGeneratedResults = {};
  let qrAiResults = {};
  let uploadedFiles = [];

  // ==================== HELPER: Fetch live student IDs ====================
  async function fetchStudentIds() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        if (tabs.length === 0) {
          resolve([]);
          return;
        }
        chrome.tabs.sendMessage(tabs[0].id, { action: 'getStudentIds' }, function(response) {
          if (chrome.runtime.lastError || !response || !response.ids) {
            resolve([]);
          } else {
            resolve(response.ids);
          }
        });
      });
    });
  }

  // Update UI elements that depend on valid IDs (mismatch sections)
  function displayFilteredResults(resultsContainerId, mismatchContainerId, resultsObj) {
    const resultsContent = document.getElementById(resultsContainerId);
    const mismatchSection = document.getElementById(mismatchContainerId);
    const mismatchList = document.getElementById(mismatchContainerId.replace('Section', 'List'));
    
    const matchedIds = Object.keys(resultsObj).filter(id => currentValidStudentIds.includes(id));
    const mismatchedIds = Object.keys(resultsObj).filter(id => !currentValidStudentIds.includes(id));
    
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
      const match = trimmed.match(/^(\d{3}-\d{2}-\d{3})[:\s,]+(\d+(?:\.\d+)?)$/);
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
      const response = await fetch('https://ai-api-remake.onrender.com/api/analyze-audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: base64Audio, assessment: assessment })
      });
      if (!response.ok) throw new Error('API request failed (status ' + response.status + ')');
      const apiData = await response.json();
      voiceAiResults = transformApiData(apiData);
      voiceProcessingCard.classList.add('hidden');
      showVoiceChat(apiData);
      voiceResultsCard.classList.remove('hidden');
      // Fetch latest student IDs and refresh display
      currentValidStudentIds = await fetchStudentIds();
      displayFilteredResults('voiceAiResultsContent', 'voiceMismatchSection', voiceAiResults);
      chrome.storage.local.set({ '_pendingVoice': { assessment, results: voiceAiResults, apiData } });
    } catch (error) {
      showStatus(voiceStatus, 'Error: ' + error.message, 'error');
      voiceProcessingCard.classList.add('hidden');
      voiceRecordCard.classList.remove('hidden');
    }
  }

  function showVoiceChat(apiData) {
    if (!Array.isArray(apiData) || apiData.length === 0) {
      voiceChatContainer.innerHTML = '<div class="chat-bubble">No marks detected in audio</div>';
      return;
    }
    voiceChatContainer.innerHTML = apiData.map(item => {
      const id = item['student id'] || item.student_id || item.studentId || '???';
      const mark = item.mark || item.marks || item.score || '?';
      return `<div class="chat-bubble">Detected: ${id} → ${mark} marks</div>
              <div class="chat-bubble ai">Recorded ${id}: ${mark}</div>`;
    }).join('');
    voiceChatCard.classList.remove('hidden');
  }

  function transformApiData(apiData) {
    const results = {};
    if (Array.isArray(apiData)) {
      apiData.forEach(item => {
        const studentId = item['student id'] || item.student_id || item.studentId;
        const mark = item.mark || item.marks || item.score;
        if (studentId && mark !== undefined) {
          results[studentId] = mark;
        }
      });
    }
    return results;
  }

  voiceFillAIBtn.addEventListener('click', async function() {
    const assessment = voiceAssessmentType.value;
    // Re-fetch IDs to be safe
    currentValidStudentIds = await fetchStudentIds();
    const matchedData = {};
    Object.keys(voiceAiResults).forEach(id => {
      if (currentValidStudentIds.includes(id)) {
        matchedData[id] = voiceAiResults[id];
      }
    });
    const storageKey = 'marks_' + assessment;
    chrome.storage.local.set({ [storageKey]: matchedData }, function() {
      chrome.storage.local.remove('_pendingVoice');
      showStatus(voiceStatus, `Saved ${Object.keys(matchedData).length} AI voice records!`, 'success');
      loadSavedData();
      chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        if (tabs.length > 0) {
          const columnIndex = columnMapping[assessment];
          chrome.tabs.sendMessage(tabs[0].id, {
            action: 'fillMarks',
            data: matchedData,
            columnIndex: columnIndex,
            columnName: assessment
          }, function(response) {
            if (response && response.success) {
              showStatus(voiceStatus, `Successfully filled ${response.filledCount} marks from voice AI!`, 'success');
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
      if (p.apiData) showVoiceChat(p.apiData);
      voiceChatCard.classList.remove('hidden');
      voiceProcessingCard.classList.add('hidden');
      voiceRecordCard.classList.add('hidden');
      voiceResultsCard.classList.remove('hidden');
      currentValidStudentIds = await fetchStudentIds();
      displayFilteredResults('voiceAiResultsContent', 'voiceMismatchSection', voiceAiResults);
    }
  });

  // ==================== QR SCAN TAB ====================
  const qrAssessmentType = document.getElementById('qrAssessmentType');
  const startScanBtn = document.getElementById('startScanBtn');
  const qrDisplayCard = document.getElementById('qrDisplayCard');
  const qrProcessingCard = document.getElementById('qrProcessingCard');
  const qrResultsCard = document.getElementById('qrResultsCard');
  const qrCode = document.getElementById('qrCode');
  const scanStatus = document.getElementById('scanStatus');
  const timerContainer = document.getElementById('timerContainer');
  const timerCountdown = document.getElementById('timerCountdown');
  const timerProgress = document.getElementById('timerProgress');
  const qrAiResultsContent = document.getElementById('qrAiResultsContent');
  const qrMismatchSection = document.getElementById('qrMismatchSection');
  const qrMismatchList = document.getElementById('qrMismatchList');
  const qrFillAIBtn = document.getElementById('qrFillAIBtn');
  const qrResetBtn = document.getElementById('qrResetBtn');
  const qrStatus = document.getElementById('qrStatus');
  
  let scanTimer = null;
  let countdownValue = 10;

  startScanBtn.addEventListener('click', async function() {
    const assessment = qrAssessmentType.value;
    if (!assessment) {
      showStatus(qrStatus, 'Please select an assessment type first!', 'error');
      return;
    }
    // Fetch live student IDs before generating fake QR data
    currentValidStudentIds = await fetchStudentIds();
    if (currentValidStudentIds.length === 0) {
      showStatus(qrStatus, 'Could not detect student IDs on the page. Make sure you are on the marks entry page.', 'error');
      return;
    }
    startScanBtn.classList.add('hidden');
    timerContainer.classList.remove('hidden');
    scanStatus.textContent = 'Scanning QR code...';
    scanStatus.classList.add('scanning');
    qrCode.classList.add('qr-scanned');
    countdownValue = 10;
    timerCountdown.textContent = countdownValue;
    timerProgress.style.width = '100%';
    scanTimer = setInterval(() => {
      countdownValue--;
      timerCountdown.textContent = countdownValue;
      timerProgress.style.width = (countdownValue / 10 * 100) + '%';
      if (countdownValue <= 0) {
        clearInterval(scanTimer);
        completeScan(assessment);
      }
    }, 1000);
  });

  function completeScan(assessment) {
    scanStatus.textContent = 'Scan complete!';
    scanStatus.classList.remove('scanning');
    scanStatus.classList.add('complete');
    setTimeout(() => {
      qrDisplayCard.classList.add('hidden');
      qrProcessingCard.classList.remove('hidden');
      generateQRResults(assessment);
      setTimeout(() => {
        qrProcessingCard.classList.add('hidden');
        qrResultsCard.classList.remove('hidden');
        displayFilteredResults('qrAiResultsContent', 'qrMismatchSection', qrAiResults);
        chrome.storage.local.set({ '_pendingQr': { assessment, results: qrAiResults } });
      }, 2000);
    }, 500);
  }

  function generateQRResults(assessment) {
    qrAiResults = {};
    let maxMarks;
    switch(assessment) {
      case 'quiz1': case 'quiz2': case 'quiz3': maxMarks = 15; break;
      case 'assignment': maxMarks = 5; break;
      case 'midterm': maxMarks = 25; break;
      case 'final': maxMarks = 40; break;
      default: maxMarks = 15;
    }
    // Use actual student IDs from the page
    currentValidStudentIds.forEach(id => {
      const randomMark = Math.floor(Math.random() * (maxMarks + 1));
      qrAiResults[id] = randomMark;
    });
    // Add a couple of fake mismatched IDs for demo
    const extraIds = ['999-99-999', '888-88-888'];
    extraIds.forEach(id => {
      qrAiResults[id] = Math.floor(Math.random() * (maxMarks + 1));
    });
  }

  qrFillAIBtn.addEventListener('click', async function() {
    const assessment = qrAssessmentType.value;
    currentValidStudentIds = await fetchStudentIds();
    const matchedData = {};
    Object.keys(qrAiResults).forEach(id => {
      if (currentValidStudentIds.includes(id)) {
        matchedData[id] = qrAiResults[id];
      }
    });
    const storageKey = 'marks_' + assessment;
    chrome.storage.local.set({ [storageKey]: matchedData }, function() {
      chrome.storage.local.remove('_pendingQr');
      showStatus(qrStatus, `Saved ${Object.keys(matchedData).length} QR scan records!`, 'success');
      loadSavedData();
      chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        if (tabs.length > 0) {
          const columnIndex = columnMapping[assessment];
          chrome.tabs.sendMessage(tabs[0].id, {
            action: 'fillMarks',
            data: matchedData,
            columnIndex: columnIndex,
            columnName: assessment
          }, function(response) {
            if (response && response.success) {
              showStatus(qrStatus, `Successfully filled ${response.filledCount} marks from QR scan!`, 'success');
            }
          });
        }
      });
    });
  });

  qrResetBtn.addEventListener('click', function() {
    qrAiResults = {};
    if (scanTimer) clearInterval(scanTimer);
    countdownValue = 10;
    qrResultsCard.classList.add('hidden');
    qrDisplayCard.classList.remove('hidden');
    startScanBtn.classList.remove('hidden');
    timerContainer.classList.add('hidden');
    scanStatus.textContent = 'Ready to scan';
    scanStatus.classList.remove('complete', 'scanning');
    qrCode.classList.remove('qr-scanned');
    timerCountdown.textContent = '10';
    timerProgress.style.width = '100%';
    chrome.storage.local.remove('_pendingQr');
  });

  chrome.storage.local.get(['_pendingQr'], async function(data) {
    if (data._pendingQr) {
      const p = data._pendingQr;
      qrAssessmentType.value = p.assessment;
      qrAiResults = p.results;
      qrDisplayCard.classList.add('hidden');
      startScanBtn.classList.add('hidden');
      qrProcessingCard.classList.add('hidden');
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
      const formData = new FormData();
      uploadedFiles.forEach(file => { formData.append('images', file); });
      formData.append('assessment', assessment);
      const response = await fetch('https://ai-api-remake.onrender.com/api/analyze-images', { method: 'POST', body: formData });
      if (!response.ok) throw new Error('API request failed');
      const apiData = await response.json();
      aiGeneratedResults = transformApiData(apiData);
      processingCard.classList.add('hidden');
      resultsCard.classList.remove('hidden');
      currentValidStudentIds = await fetchStudentIds();
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
    currentValidStudentIds = await fetchStudentIds();
    const matchedData = {};
    Object.keys(aiGeneratedResults).forEach(id => {
      if (currentValidStudentIds.includes(id)) {
        matchedData[id] = aiGeneratedResults[id];
      }
    });
    const storageKey = 'marks_' + assessment;
    chrome.storage.local.set({ [storageKey]: matchedData }, function() {
      chrome.storage.local.remove('_pendingImage');
      showStatus(uploadStatus, `Saved ${Object.keys(matchedData).length} AI-generated records!`, 'success');
      loadSavedData();
      chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        if (tabs.length > 0) {
          const columnIndex = columnMapping[assessment];
          chrome.tabs.sendMessage(tabs[0].id, {
            action: 'fillMarks',
            data: matchedData,
            columnIndex: columnIndex,
            columnName: assessment
          }, function(response) {
            if (response && response.success) {
              showStatus(uploadStatus, `Successfully filled ${response.filledCount} marks from AI analysis!`, 'success');
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