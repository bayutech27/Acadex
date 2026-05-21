// cbt/js/cbt-admin.js - Super Admin CBT Question Management (no leaderboard)
import { db, auth } from '../../js/firebase-config.js';
import {
  collection, addDoc, getDocs, query, orderBy, limit, startAfter,
  deleteDoc, doc, serverTimestamp, updateDoc, where, getDoc,
  writeBatch
} from "https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js";
import { signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js";

// ========== DOM REFERENCES ==========
let tabButtons, tabContents;
let addQuestionForm, questionIdField, examType, subject, topicField, timeLimit,
    questionText, questionImage, questionImagePreview, questionImagePreviewImg,
    optionA, optionB, optionC, optionD, correctAnswer, solution,
    solutionImage, solutionImagePreview, solutionImagePreviewImg,
    formFeedback, validationMessage, submitQuestionBtn, cancelEditBtn, clearFormBtn;
let questionTableBody, loadMoreBtn, questionSearch, searchBtn;
let csvMethodBtn, textMethodBtn, csvUploadSection, textUploadSection,
    csvDropZone, csvFileInput, browseCsvBtn, csvPreview, downloadTemplateBtn,
    startUploadBtn, cancelUploadBtn, uploadProgress, progressFill,
    processedCount, totalCount, progressPercent,
    bulkTextInput, parseTextBtn, uploadTextBtn, textPreview, bulkUploadFeedback,
    textProgressFill, textProcessedCount, textTotalCount, textProgressPercent, textUploadProgress;
let bulkDeleteBtn, bulkDeleteSubject, bulkDeleteProgress, bulkDeleteProgressFill, bulkDeleteStatus;
let logoutBtn;

let questionImageBase64 = null;
let solutionImageBase64 = null;
let csvData = null;
let uploadInProgress = false;
let cancelUpload = false;
let lastVisible = null;
let currentSearchTerm = "";

// ========== HELPER FUNCTIONS ==========
function showValidationMessage(message, type = "error") {
  if (validationMessage) {
    validationMessage.textContent = message;
    validationMessage.className = `validation-message ${type}`;
    validationMessage.classList.add("show");
    validationMessage.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function hideValidationMessage() {
  if (validationMessage) validationMessage.classList.remove("show");
}

function showFeedback(message, type = "success") {
  if (formFeedback) {
    formFeedback.textContent = message;
    formFeedback.className = `feedback-message ${type}`;
    setTimeout(() => {
      formFeedback.textContent = "";
      formFeedback.className = "feedback-message";
    }, 5000);
  }
}

function showBulkUploadFeedback(message, type = "info") {
  if (bulkUploadFeedback) {
    bulkUploadFeedback.textContent = message;
    bulkUploadFeedback.className = `feedback-message ${type}`;
    bulkUploadFeedback.style.display = "block";
    if (type !== "error") setTimeout(() => (bulkUploadFeedback.style.display = "none"), 5000);
  }
}

function containsMathExpression(text) {
  if (!text) return false;
  const patterns = [
    /log\s*[a-zA-Z0-9]/, /[∫∑∏√^]/g, /[α-ωΑ-Ω]/,
    /\{\s*[^}]*\s*\}/, /\[.*\]/, /lim_\{/, /frac\{/,
    /sum_\{/, /prod_\{/, /_[a-zA-Z0-9]/, /\^[a-zA-Z0-9]/,
    /\\\(.*\\\)/, /\\\[.*\\\]/, /\$\$.*\$\$/, /\$.*\$/
  ];
  return patterns.some(p => p.test(text));
}

function preserveMathFormatting(text) {
  if (!text) return text;
  const lines = text.split("\n");
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() && !containsMathExpression(lines[i-1]||"") && !containsMathExpression(lines[i+1]||"")) {
      result.push(line);
      continue;
    }
    result.push(line);
  }
  return result.join("\n");
}

function formatTextForDisplay(text) {
  if (!text) return "";
  const encoded = text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
  let formatted = encoded;
  const lines = formatted.split("\n");
  formatted = lines.map((line,idx) => {
    const isMath = containsMathExpression(line);
    const prevMath = idx>0 && containsMathExpression(lines[idx-1]);
    const nextMath = idx<lines.length-1 && containsMathExpression(lines[idx+1]);
    if (isMath && (prevMath||nextMath)) return line;
    else return line.replace(/\n/g,"<br>");
  }).join("<br>");
  return formatted.replace(/([^<])\n([^<])/g,"$1<br>$2");
}

function formatTextForTooltip(text) {
  if (!text) return "";
  return text.replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}

function getQuestionType(q) {
  const hasText = q.questionText && q.questionText.trim() !== "";
  const hasImage = q.questionImage;
  if (hasText && hasImage) return "both";
  if (hasText) return "text";
  if (hasImage) return "image";
  return "none";
}

function getSolutionType(q) {
  const hasText = q.solution && q.solution.trim() !== "";
  const hasImage = q.solutionImage;
  if (hasText && hasImage) return "both";
  if (hasText) return "text";
  if (hasImage) return "image";
  return "none";
}

function resetQuestionForm() {
  if (!addQuestionForm) return;
  addQuestionForm.reset();
  if (questionIdField) questionIdField.value = "";
  if (topicField) topicField.value = "";
  if (submitQuestionBtn) submitQuestionBtn.innerHTML = '<i class="fas fa-save"></i> Save Question to Bank';
  if (cancelEditBtn) cancelEditBtn.style.display = "none";
  if (formFeedback) {
    formFeedback.textContent = "";
    formFeedback.className = "feedback-message";
  }
  hideValidationMessage();
  removeQuestionImage();
  removeSolutionImage();
}

window.removeQuestionImage = function() {
  questionImageBase64 = null;
  if (questionImage) questionImage.value = "";
  if (questionImagePreview) questionImagePreview.style.display = "none";
  if (questionImagePreviewImg) questionImagePreviewImg.src = "";
};

window.removeSolutionImage = function() {
  solutionImageBase64 = null;
  if (solutionImage) solutionImage.value = "";
  if (solutionImagePreview) solutionImagePreview.style.display = "none";
  if (solutionImagePreviewImg) solutionImagePreviewImg.src = "";
};

// ========== IMAGE UPLOAD HANDLERS ==========
function initImageHandlers() {
  if (questionImage) {
    questionImage.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 5*1024*1024) {
        showValidationMessage("Image size must be less than 5MB","error");
        questionImage.value = "";
        return;
      }
      const validTypes = ["image/jpeg","image/jpg","image/png","image/gif","image/webp"];
      if (!validTypes.includes(file.type)) {
        showValidationMessage("Please upload a valid image file (JPG, PNG, GIF, WEBP)","error");
        questionImage.value = "";
        return;
      }
      const reader = new FileReader();
      reader.onload = (ev) => {
        questionImageBase64 = ev.target.result;
        if (questionImagePreviewImg) questionImagePreviewImg.src = questionImageBase64;
        if (questionImagePreview) questionImagePreview.style.display = "block";
        hideValidationMessage();
      };
      reader.onerror = () => {
        showValidationMessage("Error reading image file","error");
        questionImage.value = "";
      };
      reader.readAsDataURL(file);
    });
  }

  if (solutionImage) {
    solutionImage.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 5*1024*1024) {
        showValidationMessage("Image size must be less than 5MB","error");
        solutionImage.value = "";
        return;
      }
      const validTypes = ["image/jpeg","image/jpg","image/png","image/gif","image/webp"];
      if (!validTypes.includes(file.type)) {
        showValidationMessage("Please upload a valid image file (JPG, PNG, GIF, WEBP)","error");
        solutionImage.value = "";
        return;
      }
      const reader = new FileReader();
      reader.onload = (ev) => {
        solutionImageBase64 = ev.target.result;
        if (solutionImagePreviewImg) solutionImagePreviewImg.src = solutionImageBase64;
        if (solutionImagePreview) solutionImagePreview.style.display = "block";
        hideValidationMessage();
      };
      reader.onerror = () => {
        showValidationMessage("Error reading image file","error");
        solutionImage.value = "";
      };
      reader.readAsDataURL(file);
    });
  }

  const removeQBtn = document.getElementById("removeQuestionImageBtn");
  if (removeQBtn) removeQBtn.addEventListener("click", removeQuestionImage);
  const removeSBtn = document.getElementById("removeSolutionImageBtn");
  if (removeSBtn) removeSBtn.addEventListener("click", removeSolutionImage);
}

// ========== QUESTION FORM SUBMIT ==========
function validateQuestionForm() {
  const qText = preserveMathFormatting(questionText ? questionText.value : "");
  if (!qText && !questionImageBase64) {
    showValidationMessage("❌ Please provide either question text or question image (or both)");
    return false;
  }
  if (!optionA.value.trim() || !optionB.value.trim() || !optionC.value.trim() || !optionD.value.trim()) {
    showValidationMessage("❌ All four options (A, B, C, D) are required");
    return false;
  }
  if (!correctAnswer.value) {
    showValidationMessage("❌ Please select the correct answer");
    return false;
  }
  hideValidationMessage();
  return true;
}

async function handleFormSubmit(e) {
  e.preventDefault();
  if (!validateQuestionForm()) return;
  try {
    const qData = {
      examType: examType.value,
      subject: subject.value,
      topic: topicField.value.trim() || "",
      questionText: preserveMathFormatting(questionText.value),
      options: {
        A: preserveMathFormatting(optionA.value),
        B: preserveMathFormatting(optionB.value),
        C: preserveMathFormatting(optionC.value),
        D: preserveMathFormatting(optionD.value),
      },
      correctAnswer: correctAnswer.value,
      solution: preserveMathFormatting(solution.value),
      timeLimit: Number(timeLimit.value),
      lastUpdated: serverTimestamp(),
      questionType: getQuestionType({ questionText: questionText.value, questionImage: questionImageBase64 }),
      solutionType: getSolutionType({ solution: solution.value, solutionImage: solutionImageBase64 })
    };
    if (questionImageBase64) qData.questionImage = questionImageBase64;
    if (solutionImageBase64) qData.solutionImage = solutionImageBase64;
    if (questionIdField.value) {
      await updateDoc(doc(db, "questions", questionIdField.value), qData);
      showFeedback("✅ Question updated successfully");
    } else {
      qData.createdAt = serverTimestamp();
      qData.createdBy = auth.currentUser.uid;
      await addDoc(collection(db, "questions"), qData);
      showFeedback("✅ Question saved successfully");
    }
    resetQuestionForm();
    loadQuestions(false);
  } catch (error) {
    console.error("Error saving question:", error);
    showFeedback("❌ Failed to save question", "error");
  }
}

clearFormBtn?.addEventListener("click", resetQuestionForm);
cancelEditBtn?.addEventListener("click", resetQuestionForm);

// ========== LOAD QUESTION FOR EDIT ==========
async function loadQuestionForEdit(questionId) {
  try {
    const qSnap = await getDoc(doc(db, "questions", questionId));
    if (!qSnap.exists()) {
      showFeedback("❌ Question not found", "error");
      return;
    }
    const qData = qSnap.data();
    questionIdField.value = questionId;
    examType.value = qData.examType || "";
    subject.value = qData.subject || "";
    topicField.value = qData.topic || "";
    timeLimit.value = qData.timeLimit || 120;
    questionText.value = preserveMathFormatting(qData.questionText || "");
    optionA.value = preserveMathFormatting(qData.options?.A || "");
    optionB.value = preserveMathFormatting(qData.options?.B || "");
    optionC.value = preserveMathFormatting(qData.options?.C || "");
    optionD.value = preserveMathFormatting(qData.options?.D || "");
    correctAnswer.value = qData.correctAnswer || "";
    solution.value = preserveMathFormatting(qData.solution || "");
    if (qData.questionImage) {
      questionImageBase64 = qData.questionImage;
      if (questionImagePreviewImg) questionImagePreviewImg.src = questionImageBase64;
      if (questionImagePreview) questionImagePreview.style.display = "block";
    }
    if (qData.solutionImage) {
      solutionImageBase64 = qData.solutionImage;
      if (solutionImagePreviewImg) solutionImagePreviewImg.src = solutionImageBase64;
      if (solutionImagePreview) solutionImagePreview.style.display = "block";
    }
    submitQuestionBtn.innerHTML = '<i class="fas fa-save"></i> Update Question';
    cancelEditBtn.style.display = "inline-flex";
    // Switch to question manager tab
    if (tabButtons) tabButtons.forEach(btn => btn.classList.remove("active"));
    if (tabContents) tabContents.forEach(c => c.classList.remove("active"));
    document.querySelector('[data-tab="question-manager"]')?.classList.add("active");
    document.getElementById("question-manager")?.classList.add("active");
    if (formFeedback) {
      formFeedback.textContent = "✅ Now editing question. Make changes and click 'Update Question'.";
      formFeedback.className = "feedback-message success";
    }
    document.getElementById("question-manager")?.scrollIntoView({ behavior: "smooth" });
  } catch (error) {
    console.error("Error loading question for edit:", error);
    showFeedback("❌ Error loading question", "error");
  }
}

async function deleteQuestion(questionId) {
  if (!confirm("Are you sure you want to delete this question permanently?")) return;
  try {
    await deleteDoc(doc(db, "questions", questionId));
    showFeedback("✅ Question deleted successfully");
    loadQuestions(false, currentSearchTerm);
  } catch (error) {
    console.error("Error deleting question:", error);
    showFeedback("❌ Failed to delete question", "error");
  }
}

window.editQuestion = async (id) => await loadQuestionForEdit(id);
window.deleteQuestion = deleteQuestion;

// ========== LOAD QUESTIONS ==========
async function loadQuestions(loadMore = false, searchTerm = "") {
  try {
    let q;
    if (searchTerm) {
      q = query(collection(db, "questions"), orderBy("createdAt", "desc"));
    } else {
      q = query(collection(db, "questions"), orderBy("createdAt", "desc"), limit(10));
      if (loadMore && lastVisible) q = query(q, startAfter(lastVisible));
    }
    const snapshot = await getDocs(q);
    if (!loadMore || searchTerm) {
      if (questionTableBody) questionTableBody.innerHTML = "";
      lastVisible = null;
    }
    let questions = [];
    snapshot.forEach(docSnap => {
      if (!loadMore || searchTerm) lastVisible = docSnap;
      questions.push({ id: docSnap.id, ...docSnap.data() });
    });
    if (searchTerm) {
      const lower = searchTerm.toLowerCase();
      questions = questions.filter(q =>
        (q.subject && q.subject.toLowerCase().includes(lower)) ||
        (q.examType && q.examType.toLowerCase().includes(lower)) ||
        (q.questionText && q.questionText.toLowerCase().includes(lower)) ||
        (q.solution && q.solution.toLowerCase().includes(lower))
      );
    }
    if (questions.length === 0) {
      if (questionTableBody) questionTableBody.innerHTML = `<tr><td colspan="8" class="text-center">No questions found</td><tr>`;
      return;
    }
    if (!questionTableBody) return;
    questionTableBody.innerHTML = "";
    questions.forEach(q => {
      const preview = q.questionText ? (q.questionText.length > 40 ? q.questionText.substring(0,40)+"..." : q.questionText) : "[Image Question]";
      let typeBadge = "";
      const qt = getQuestionType(q);
      if (qt === "text") typeBadge = '<span class="question-type type-text">Text</span>';
      else if (qt === "image") typeBadge = '<span class="question-type type-image">Image</span>';
      else if (qt === "both") typeBadge = '<span class="question-type type-both">Both</span>';
      questionTableBody.innerHTML += `
        <tr>
          <td>${q.id.slice(0,6)}...</td>
          <td>${q.subject}</td>
          <td>${q.examType}</td>
          <td title="${formatTextForTooltip(q.questionText || "")}">${formatTextForDisplay(preview)}</td>
          <td>${typeBadge}</td>
          <td>${q.correctAnswer}</td>
          <td>${q.timeLimit}s</td>
          <td>
            <div class="action-buttons">
              <button class="action-btn edit-btn" onclick="editQuestion('${q.id}')" title="Edit"><i class="fas fa-edit"></i></button>
              <button class="action-btn delete-btn" onclick="deleteQuestion('${q.id}')" title="Delete"><i class="fas fa-trash"></i></button>
            </div>
           </td>
         </tr>
      `;
    });
  } catch (error) {
    console.error("Error loading questions:", error);
    if (questionTableBody) questionTableBody.innerHTML = `<tr><td colspan="8" class="text-center">Error loading questions</td><tr>`;
  }
}

if (searchBtn) searchBtn.addEventListener("click", () => {
  currentSearchTerm = questionSearch ? questionSearch.value.trim() : "";
  loadQuestions(false, currentSearchTerm);
});
if (questionSearch) questionSearch.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    currentSearchTerm = questionSearch.value.trim();
    loadQuestions(false, currentSearchTerm);
  }
});
if (loadMoreBtn) loadMoreBtn.addEventListener("click", () => {
  if (!currentSearchTerm) loadQuestions(true);
});

// ========== BULK UPLOAD (CSV) ==========
function initBulkUploadHandlers() {
  if (csvMethodBtn) csvMethodBtn.addEventListener("click", () => {
    csvMethodBtn.classList.add("active"); textMethodBtn.classList.remove("active");
    csvUploadSection.classList.add("active"); textUploadSection.classList.remove("active");
  });
  if (textMethodBtn) textMethodBtn.addEventListener("click", () => {
    textMethodBtn.classList.add("active"); csvMethodBtn.classList.remove("active");
    textUploadSection.classList.add("active"); csvUploadSection.classList.remove("active");
  });
  if (downloadTemplateBtn) downloadTemplateBtn.addEventListener("click", () => {
    const template = `questionText,optionA,optionB,optionC,optionD,correctAnswer,solution,subject,examType,timeLimit,topic
"What is 2+2?",4,5,6,7,A,"Basic addition",mathematics,WAEC/NECO,120,Arithmetic
"What is the capital of France?",Paris,London,Berlin,Madrid,A,"Paris is the capital",geography,JAMB,90,Geography
"Who wrote Romeo and Juliet?",William Shakespeare,Charles Dickens,Jane Austen,Mark Twain,A,"William Shakespeare wrote Romeo and Juliet",literature,WAEC/NECO,120,Literature
"What is H2O?",Water,Oxygen,Hydrogen,Carbon Dioxide,A,"H2O is the chemical formula for water",chemistry,JAMB,60,Chemistry`;
    const blob = new Blob([template], {type:"text/csv"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "question-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  });

  if (csvDropZone) {
    csvDropZone.addEventListener("dragover", (e) => { e.preventDefault(); csvDropZone.classList.add("drag-over"); });
    csvDropZone.addEventListener("dragleave", () => csvDropZone.classList.remove("drag-over"));
    csvDropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      csvDropZone.classList.remove("drag-over");
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        const file = files[0];
        if (file.type === "text/csv" || file.name.endsWith(".csv")) handleCSVFile(file);
        else showBulkUploadFeedback("Please upload a CSV file", "error");
      }
    });
  }
  if (browseCsvBtn) browseCsvBtn.addEventListener("click", () => csvFileInput.click());
  if (csvFileInput) csvFileInput.addEventListener("change", (e) => {
    if (e.target.files[0]) handleCSVFile(e.target.files[0]);
  });
  if (startUploadBtn) startUploadBtn.addEventListener("click", startCSVUpload);
  if (cancelUploadBtn) cancelUploadBtn.addEventListener("click", () => {
    if (uploadInProgress) {
      cancelUpload = true;
      cancelUploadBtn.disabled = true;
      cancelUploadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Cancelling...';
    }
  });
  if (parseTextBtn) parseTextBtn.addEventListener("click", parseTextFormatHandler);
  if (uploadTextBtn) uploadTextBtn.addEventListener("click", startTextUpload);
}

function handleCSVFile(file) {
  if (file.size > 5*1024*1024) {
    showBulkUploadFeedback("File size exceeds 5MB limit", "error");
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    try { parseCSVData(e.target.result); }
    catch (err) { showBulkUploadFeedback("Error parsing CSV: "+err.message, "error"); }
  };
  reader.onerror = () => showBulkUploadFeedback("Error reading file", "error");
  reader.readAsText(file);
}

function parseCSVData(csvText) {
  const lines = csvText.split("\n").filter(l => l.trim() !== "");
  if (lines.length < 2) {
    showBulkUploadFeedback("CSV must have header row and data rows", "error");
    return;
  }
  const headers = lines[0].split(",").map(h => h.trim().toLowerCase());
  const required = ["questiontext","optiona","optionb","optionc","optiond","correctanswer","subject"];
  for (const r of required) if (!headers.includes(r)) {
    showBulkUploadFeedback(`Missing required header: ${r}`, "error");
    return;
  }
  csvData = [];
  const errors = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length !== headers.length) {
      errors.push(`Row ${i}: column count mismatch`);
      continue;
    }
    const row = {};
    headers.forEach((h, idx) => { row[h] = values[idx] ? preserveMathFormatting(values[idx].trim()) : ""; });
    const err = validateQuestionRow(row, i);
    if (err) errors.push(err);
    else csvData.push(row);
  }
  if (errors.length) {
    showBulkUploadFeedback(`Found ${errors.length} errors. First: ${errors[0]}`, "error");
    csvData = null;
    if (startUploadBtn) startUploadBtn.disabled = true;
  } else {
    showBulkUploadFeedback(`Parsed ${csvData.length} questions`, "success");
    updateCSVPreview();
    if (startUploadBtn) startUploadBtn.disabled = false;
  }
}

function parseCSVLine(line) {
  const result = [];
  let inQuotes = false;
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "," && !inQuotes) { result.push(cur); cur = ""; }
    else cur += ch;
  }
  result.push(cur);
  return result;
}

function validateQuestionRow(row, rowNum) {
  if (!row.questiontext) return `Row ${rowNum}: Question text required`;
  if (!row.optiona || !row.optionb || !row.optionc || !row.optiond) return `Row ${rowNum}: All options required`;
  const ca = row.correctanswer?.toUpperCase();
  if (!["A","B","C","D"].includes(ca)) return `Row ${rowNum}: Correct answer must be A,B,C,D`;
  if (!row.subject) return `Row ${rowNum}: Subject required`;
  if (row.timelimit && isNaN(parseInt(row.timelimit))) return `Row ${rowNum}: Time limit must be number`;
  return null;
}

function updateCSVPreview() {
  if (!csvData || !csvData.length) { if (csvPreview) csvPreview.innerHTML = "<p>No data to preview</p>"; return; }
  let html = `<table class="csv-preview-table"><thead><tr><th>#</th><th>Question Preview</th><th>Subject</th><th>Topic</th><th>Exam</th><th>Correct</th></tr></thead><tbody>`;
  const showCount = Math.min(csvData.length, 10);
  for (let i = 0; i < showCount; i++) {
    const r = csvData[i];
    const preview = r.questiontext.length > 50 ? r.questiontext.substring(0,50)+"..." : r.questiontext;
    html += `<tr><td>${i+1}</td><td>${formatTextForDisplay(preview)}</td><td>${r.subject}</td><td>${r.topic||"-"}</td><td>${r.examtype||"WAEC/NECO"}</td><td>${(r.correctanswer||"A").toUpperCase()}</td><tr>`;
  }
  if (csvData.length > 10) html += `<tr><td colspan="6">... and ${csvData.length-10} more</td><tr>`;
  html += `</tbody></table><p>Total: ${csvData.length} questions</p>`;
  if (csvPreview) csvPreview.innerHTML = html;
}

async function startCSVUpload() {
  if (!csvData || !csvData.length) { showBulkUploadFeedback("No data to upload", "error"); return; }
  if (uploadInProgress) { showBulkUploadFeedback("Upload already in progress", "error"); return; }

  if (!startUploadBtn || !cancelUploadBtn || !uploadProgress || !progressFill || !processedCount || !totalCount || !progressPercent) {
    console.error("CSV upload DOM elements missing");
    showBulkUploadFeedback("UI error: missing progress elements. Please refresh.", "error");
    return;
  }

  uploadInProgress = true;
  cancelUpload = false;
  startUploadBtn.disabled = true;
  cancelUploadBtn.style.display = "inline-flex";
  uploadProgress.style.display = "block";
  const total = csvData.length;
  let success = 0;
  totalCount.textContent = total;
  processedCount.textContent = "0";
  progressPercent.textContent = "0%";
  progressFill.style.width = "0%";
  showBulkUploadFeedback(`Uploading ${total} questions...`, "info");

  try {
    const BATCH_SIZE = 500;
    const userId = auth.currentUser?.uid;
    const ts = serverTimestamp();
    for (let i = 0; i < total; i += BATCH_SIZE) {
      if (cancelUpload) break;
      const batch = writeBatch(db);
      const end = Math.min(i + BATCH_SIZE, total);
      for (let j = i; j < end; j++) {
        const row = csvData[j];
        const docRef = doc(collection(db, "questions"));
        batch.set(docRef, {
          examType: row.examtype || "WAEC/NECO",
          subject: row.subject,
          topic: row.topic || "",
          questionText: preserveMathFormatting(row.questiontext),
          options: {
            A: preserveMathFormatting(row.optiona),
            B: preserveMathFormatting(row.optionb),
            C: preserveMathFormatting(row.optionc),
            D: preserveMathFormatting(row.optiond)
          },
          correctAnswer: (row.correctanswer || "A").toUpperCase(),
          solution: preserveMathFormatting(row.solution || ""),
          timeLimit: row.timelimit ? parseInt(row.timelimit) : 120,
          questionType: "text",
          solutionType: row.solution ? "text" : "none",
          createdAt: ts, lastUpdated: ts, createdBy: userId
        });
      }
      await batch.commit();
      success += (end - i);
      const pct = Math.round((success / total) * 100);
      processedCount.textContent = success;
      progressPercent.textContent = `${pct}%`;
      progressFill.style.width = `${pct}%`;
      await new Promise(r => setTimeout(r, 100));
    }
    if (cancelUpload) {
      showBulkUploadFeedback("Upload cancelled", "error");
    } else {
      showBulkUploadFeedback(`✅ Uploaded ${success} questions!`, "success");
      csvData = null;
      if (csvPreview) csvPreview.innerHTML = "<p>No file selected</p>";
      startUploadBtn.disabled = true;
      loadQuestions(false);
    }
  } catch (err) {
    console.error("CSV upload error:", err);
    showBulkUploadFeedback(`Error: ${err.message}`, "error");
  } finally {
    uploadInProgress = false;
    startUploadBtn.disabled = false;
    if (cancelUploadBtn) cancelUploadBtn.style.display = "none";
    if (uploadProgress) uploadProgress.style.display = "none";
  }
}

// ========== TEXT FORMAT UPLOAD ==========
function parseTextFormatHandler() {
  const text = bulkTextInput.value.trim();
  if (!text) { showBulkUploadFeedback("Please enter questions", "error"); return; }
  try {
    const qs = parseTextFormat(text);
    textPreview.innerHTML = `<div class="feedback-message success">Found ${qs.length} valid questions</div><p>Ready to upload. Click "Upload Text Questions".</p>`;
    uploadTextBtn.disabled = false;
    uploadTextBtn.dataset.questions = JSON.stringify(qs);
  } catch (err) {
    showBulkUploadFeedback(`Parse error: ${err.message}`, "error");
    uploadTextBtn.disabled = true;
  }
}

function parseTextFormat(text) {
  const blocks = text.split(/\n\s*\n/).filter(b => b.trim());
  const questions = [];
  blocks.forEach((block, idx) => {
    const lines = block.split("\n");
    const q = { questionText: "", optionA: "", optionB: "", optionC: "", optionD: "", correctAnswer: "A", solution: "", subject: "mathematics", examType: "WAEC/NECO", timeLimit: 120 };
    let collecting = false, currentField = "";
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.match(/^[QABCD]:|^Correct:|^Solution:|^Subject:|^Exam Type:|^Time Limit:/)) {
        if (collecting && currentField && q[currentField]) q[currentField] += "\n" + line.substring(line.indexOf(":")+1).trim();
        else {
          collecting = false;
          if (line.startsWith("Q:")) { currentField = "questionText"; q.questionText = line.substring(2).trim(); if (i+1 < lines.length && !lines[i+1].match(/^[ABCD]:|^Correct:|^Solution:/)) collecting = true; }
          else if (line.startsWith("A:")) q.optionA = line.substring(2).trim();
          else if (line.startsWith("B:")) q.optionB = line.substring(2).trim();
          else if (line.startsWith("C:")) q.optionC = line.substring(2).trim();
          else if (line.startsWith("D:")) q.optionD = line.substring(2).trim();
          else if (line.startsWith("Correct:")) q.correctAnswer = line.substring(8).trim().toUpperCase();
          else if (line.startsWith("Solution:")) { currentField = "solution"; q.solution = line.substring(9).trim(); if (i+1 < lines.length && !lines[i+1].match(/^Subject:|^Exam Type:|^Time Limit:/)) collecting = true; }
          else if (line.startsWith("Subject:")) q.subject = line.substring(8).trim().toLowerCase();
          else if (line.startsWith("Exam Type:")) q.examType = line.substring(10).trim();
          else if (line.startsWith("Time Limit:")) q.timeLimit = parseInt(line.substring(11).trim()) || 120;
        }
      } else if (collecting && currentField) {
        q[currentField] += "\n" + line.trim();
      } else if (line.trim()) {
        throw new Error(`Block ${idx+1}, line ${i+1}: Unexpected format "${line}"`);
      }
    }
    q.questionText = preserveMathFormatting(q.questionText);
    q.optionA = preserveMathFormatting(q.optionA);
    q.optionB = preserveMathFormatting(q.optionB);
    q.optionC = preserveMathFormatting(q.optionC);
    q.optionD = preserveMathFormatting(q.optionD);
    q.solution = preserveMathFormatting(q.solution);
    if (!q.questionText || !q.optionA || !q.optionB || !q.optionC || !q.optionD) throw new Error(`Block ${idx+1}: Missing required fields`);
    if (!["A","B","C","D"].includes(q.correctAnswer)) throw new Error(`Block ${idx+1}: Correct answer must be A,B,C,D`);
    questions.push(q);
  });
  return questions;
}

async function startTextUpload() {
  const qsJson = uploadTextBtn.dataset.questions;
  if (!qsJson) { showBulkUploadFeedback("Please validate text format first", "error"); return; }
  const questions = JSON.parse(qsJson);
  await uploadQuestionsBatch(questions);
}

async function uploadQuestionsBatch(questions) {
  if (uploadInProgress) { showBulkUploadFeedback("Upload already in progress", "error"); return; }

  if (!uploadTextBtn || !textUploadProgress || !textProgressFill || !textProcessedCount || !textTotalCount || !textProgressPercent) {
    console.error("Text upload DOM elements missing");
    showBulkUploadFeedback("UI error: missing progress elements. Please refresh.", "error");
    return;
  }

  uploadInProgress = true;
  uploadTextBtn.disabled = true;
  textUploadProgress.style.display = "block";
  const total = questions.length;
  let success = 0;
  textTotalCount.textContent = total;
  textProcessedCount.textContent = "0";
  textProgressPercent.textContent = "0%";
  textProgressFill.style.width = "0%";
  showBulkUploadFeedback(`Uploading ${total} questions...`, "info");

  try {
    const BATCH_SIZE = 500;
    const userId = auth.currentUser?.uid;
    const ts = serverTimestamp();
    for (let i = 0; i < total; i += BATCH_SIZE) {
      if (cancelUpload) break;
      const batch = writeBatch(db);
      const end = Math.min(i + BATCH_SIZE, total);
      for (let j = i; j < end; j++) {
        const q = questions[j];
        const docRef = doc(collection(db, "questions"));
        batch.set(docRef, {
          examType: q.examType,
          subject: q.subject,
          topic: q.topic || "",
          questionText: q.questionText,
          options: { A: q.optionA, B: q.optionB, C: q.optionC, D: q.optionD },
          correctAnswer: q.correctAnswer,
          solution: q.solution,
          timeLimit: q.timeLimit,
          questionType: "text",
          solutionType: q.solution ? "text" : "none",
          createdAt: ts, lastUpdated: ts, createdBy: userId
        });
      }
      await batch.commit();
      success += (end - i);
      const pct = Math.round((success / total) * 100);
      textProcessedCount.textContent = success;
      textProgressPercent.textContent = `${pct}%`;
      textProgressFill.style.width = `${pct}%`;
      await new Promise(r => setTimeout(r, 100));
    }
    if (cancelUpload) {
      showBulkUploadFeedback("Upload cancelled", "error");
    } else {
      showBulkUploadFeedback(`✅ Uploaded ${success} questions!`, "success");
      bulkTextInput.value = "";
      textPreview.innerHTML = "";
      uploadTextBtn.disabled = true;
      loadQuestions(false);
    }
  } catch (err) {
    console.error("Text upload error:", err);
    showBulkUploadFeedback(`Error: ${err.message}`, "error");
  } finally {
    uploadInProgress = false;
    uploadTextBtn.disabled = false;
    if (textUploadProgress) textUploadProgress.style.display = "none";
  }
}

// ========== BULK DELETE BY SUBJECT ==========
function initBulkDelete() {
  if (bulkDeleteBtn) {
    bulkDeleteBtn.addEventListener("click", async () => {
      const subj = bulkDeleteSubject.value;
      if (!subj) { alert("Select subject"); return; }
      const subjName = bulkDeleteSubject.options[bulkDeleteSubject.selectedIndex].text;
      if (!confirm(`Delete ALL questions under "${subjName}"? This cannot be undone.`)) return;
      if (!confirm(`LAST WARNING: Type "DELETE" to confirm.`)) return;
      bulkDeleteBtn.disabled = true;
      if (bulkDeleteProgress) bulkDeleteProgress.style.display = "block";
      if (bulkDeleteProgressFill) bulkDeleteProgressFill.style.width = "0%";
      if (bulkDeleteStatus) bulkDeleteStatus.textContent = "Fetching...";
      try {
        const q = query(collection(db, "questions"), where("subject", "==", subj));
        const snap = await getDocs(q);
        const total = snap.size;
        if (total === 0) { if (bulkDeleteStatus) bulkDeleteStatus.textContent = `No questions for ${subjName}`; bulkDeleteBtn.disabled = false; return; }
        if (bulkDeleteStatus) bulkDeleteStatus.textContent = `Deleting ${total} questions...`;
        const refs = snap.docs.map(d => d.ref);
        const BATCH = 500;
        let deleted = 0;
        for (let i = 0; i < refs.length; i += BATCH) {
          const batch = writeBatch(db);
          const chunk = refs.slice(i, i+BATCH);
          chunk.forEach(ref => batch.delete(ref));
          await batch.commit();
          deleted += chunk.length;
          if (bulkDeleteProgressFill) bulkDeleteProgressFill.style.width = `${Math.round((deleted/total)*100)}%`;
          if (bulkDeleteStatus) bulkDeleteStatus.textContent = `Deleted ${deleted} of ${total}`;
        }
        if (bulkDeleteStatus) bulkDeleteStatus.textContent = `✅ Deleted ${total} questions from ${subjName}`;
        if (bulkDeleteProgressFill) bulkDeleteProgressFill.style.width = "100%";
        loadQuestions(false, currentSearchTerm);
        setTimeout(() => {
          bulkDeleteBtn.disabled = false;
          if (bulkDeleteProgress) bulkDeleteProgress.style.display = "none";
          if (bulkDeleteSubject) bulkDeleteSubject.value = "";
        }, 3000);
      } catch (err) {
        console.error(err);
        if (bulkDeleteStatus) bulkDeleteStatus.textContent = `❌ Error: ${err.message}`;
        bulkDeleteBtn.disabled = false;
      }
    });
  }
}

// ========== TAB SWITCHING ==========
function initTabs() {
  tabButtons = document.querySelectorAll(".tab-btn");
  tabContents = document.querySelectorAll(".tab-content");
  if (!tabButtons.length) { setTimeout(initTabs, 100); return; }
  tabButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      tabButtons.forEach(b => b.classList.remove("active"));
      tabContents.forEach(c => c.classList.remove("active"));
      btn.classList.add("active");
      const targetId = btn.dataset.tab;
      const targetEl = document.getElementById(targetId);
      if (targetEl) targetEl.classList.add("active");
    });
  });
  console.log("Tab switching initialized");
}

// ========== LOGOUT ==========
function initLogout() {
  if (logoutBtn) logoutBtn.addEventListener("click", async () => {
    await signOut(auth);
    window.location.href = "../../index.html";
  });
}

// ========== INITIAL DOM REFERENCES ==========
function initDOMReferences() {
  addQuestionForm = document.getElementById("addQuestionForm");
  questionIdField = document.getElementById("questionId");
  examType = document.getElementById("examType");
  subject = document.getElementById("subject");
  topicField = document.getElementById("topic");
  timeLimit = document.getElementById("timeLimit");
  questionText = document.getElementById("questionText");
  questionImage = document.getElementById("questionImage");
  questionImagePreview = document.getElementById("questionImagePreview");
  questionImagePreviewImg = document.getElementById("questionImagePreviewImg");
  optionA = document.getElementById("optionA");
  optionB = document.getElementById("optionB");
  optionC = document.getElementById("optionC");
  optionD = document.getElementById("optionD");
  correctAnswer = document.getElementById("correctAnswer");
  solution = document.getElementById("solution");
  solutionImage = document.getElementById("solutionImage");
  solutionImagePreview = document.getElementById("solutionImagePreview");
  solutionImagePreviewImg = document.getElementById("solutionImagePreviewImg");
  formFeedback = document.getElementById("formFeedback");
  validationMessage = document.getElementById("validationMessage");
  submitQuestionBtn = document.getElementById("submitQuestionBtn");
  cancelEditBtn = document.getElementById("cancelEditBtn");
  clearFormBtn = document.getElementById("clearFormBtn");
  questionTableBody = document.getElementById("questionTableBody");
  loadMoreBtn = document.getElementById("loadMoreQuestions");
  questionSearch = document.getElementById("questionSearch");
  searchBtn = document.getElementById("searchBtn");
  csvMethodBtn = document.getElementById("csvMethodBtn");
  textMethodBtn = document.getElementById("textMethodBtn");
  csvUploadSection = document.getElementById("csvUploadSection");
  textUploadSection = document.getElementById("textUploadSection");
  csvDropZone = document.getElementById("csvDropZone");
  csvFileInput = document.getElementById("csvFileInput");
  browseCsvBtn = document.getElementById("browseCsvBtn");
  csvPreview = document.getElementById("csvPreview");
  downloadTemplateBtn = document.getElementById("downloadTemplateBtn");
  startUploadBtn = document.getElementById("startUploadBtn");
  cancelUploadBtn = document.getElementById("cancelUploadBtn");
  uploadProgress = document.getElementById("uploadProgress");
  progressFill = document.getElementById("progressFill");
  processedCount = document.getElementById("processedCount");
  totalCount = document.getElementById("totalCount");
  progressPercent = document.getElementById("progressPercent");
  bulkTextInput = document.getElementById("bulkTextInput");
  parseTextBtn = document.getElementById("parseTextBtn");
  uploadTextBtn = document.getElementById("uploadTextBtn");
  textPreview = document.getElementById("textPreview");
  bulkUploadFeedback = document.getElementById("bulkUploadFeedback");
  textProgressFill = document.getElementById("textProgressFill");
  textProcessedCount = document.getElementById("textProcessedCount");
  textTotalCount = document.getElementById("textTotalCount");
  textProgressPercent = document.getElementById("textProgressPercent");
  textUploadProgress = document.getElementById("textUploadProgress");
  bulkDeleteBtn = document.getElementById("bulkDeleteBtn");
  bulkDeleteSubject = document.getElementById("bulkDeleteSubject");
  bulkDeleteProgress = document.getElementById("bulkDeleteProgress");
  bulkDeleteProgressFill = document.getElementById("bulkDeleteProgressFill");
  bulkDeleteStatus = document.getElementById("bulkDeleteStatus");
  logoutBtn = document.getElementById("logoutBtn");

  if (addQuestionForm) addQuestionForm.addEventListener("submit", handleFormSubmit);
}

// ========== INITIAL LOAD & AUTH GUARD ==========
document.addEventListener("DOMContentLoaded", () => {
  initDOMReferences();
  initImageHandlers();
  initBulkUploadHandlers();
  initBulkDelete();
  initLogout();
  initTabs();

  onAuthStateChanged(auth, async (user) => {
    if (!user) { window.location.href = "../../index.html"; return; }
    try {
      const userDoc = await getDoc(doc(db, "users", user.uid));
      const userData = userDoc.data();
      if (!userData || userData.role !== "super-admin") {
        alert("Access denied. Super Admin privileges required.");
        window.location.href = "../../index.html";
        return;
      }
      loadQuestions(false);
    } catch (err) {
      console.error(err);
      alert("Authentication error. Please log in again.");
    }
  });
});