# DIU IntelliMarks - AI-Powered Marks Assistant

An intelligent Chrome extension for Daffodil International University teachers to automate student marks entry using AI-powered Voice, Image, and QR Scan features.

## Features

### 🤖 AI-Powered Input Methods
- **Voice with AI** - Speak student marks and let AI process them
- **Upload Images** - Upload mark sheets (Images/PDF) and extract marks automatically
- **QR Scan** - Scan QR codes to import marks instantly

### 📊 Smart Features
- Store marks data for multiple columns (Quiz 1, Quiz 2, Quiz 3, Assignment, Midterm, Final)
- Auto-fill all student marks with one click
- Match students by Student ID
- Detect mismatched IDs
- Export/import data as JSON

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the Extension folder
5. The extension icon will appear in your toolbar

## How to Use

### 1. Select Assessment Type

Choose the assessment (Quiz 1, Quiz 2, Quiz 3, Assignment, Midterm, or Final).

### 2. Choose Input Method

**Voice with AI:**
- Click "Voice with AI" and speak marks (e.g., "232-15-047 got 12")
- AI processes and extracts student marks

**Upload Images:**
- Drag & drop or browse mark sheet images/PDFs
- AI analyzes and extracts marks automatically

**QR Scan:**
- Click "Start QR Scan"
- Scan the QR code within 10 seconds
- Import marks instantly

### 3. Review Results

AI shows:
- ✅ Matched IDs (found in portal)
- ⚠️ Mismatched IDs (not found in portal)

### 4. Auto-Fill

Click "Auto-Fill Matching Results" to fill marks on the marks sheet page automatically!

## File Structure

- `manifest.json` - Extension configuration
- `popup.html` & `popup.js` - Extension popup UI
- `content.js` - Script that runs on the marks page
- `content.css` - Styles for the floating button
