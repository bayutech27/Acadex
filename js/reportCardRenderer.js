// reportCardRenderer.js - Shared report card rendering engine
// Layout: subjects table extreme left, skills tables extreme right
// Fully fluid – scales with zoom, stacks gracefully on mobile, A4-aware
import { showNotification } from './error-handler.js';

export function renderReportCardUI({
  student, scores, className, school, grading, psychomotor, comments,
  term, session, subjectStats, container, attendance = {},
  isPrimary = false,
  onRatingChange, onTeacherCommentChange, onPrincipalCommentChange
}) {
  if (!container) {
    console.error("renderReportCardUI: container element is required");
    showNotification("Failed to render report card: container missing.", "error");
    return;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;');
  }

  // ----- Grading scales -----
  function calculateGradePrimary(total) {
    if (total >= 90) return 'A+';
    if (total >= 80) return 'A';
    if (total >= 70) return 'B+';
    if (total >= 60) return 'B';
    if (total >= 50) return 'C';
    if (total >= 40) return 'D';
    return 'F';
  }
  function getGradeRemarkPrimary(grade) {
    const remarks = { 'A+':'Exceptional', 'A':'Excellent', 'B+':'Very Good', 'B':'Good', 'C':'Fairly Good', 'D':'Pass', 'F':'Fail' };
    return remarks[grade] || '';
  }

  function calculateGradeSecondary(total) {
    if (total >= 85) return 'A1';
    if (total >= 75) return 'B2';
    if (total >= 70) return 'B3';
    if (total >= 65) return 'C4';
    if (total >= 60) return 'C5';
    if (total >= 50) return 'C6';
    if (total >= 45) return 'D7';
    if (total >= 40) return 'E8';
    return 'F9';
  }
  function getGradeRemarkSecondary(grade) {
    const remarks = { A1:'Excellent', B2:'Very Good', B3:'Good', C4:'Credit', C5:'Credit', C6:'Credit', D7:'Pass', E8:'Pass', F9:'Fail' };
    return remarks[grade] || '';
  }

  const calculateGrade = isPrimary ? calculateGradePrimary : calculateGradeSecondary;
  const getGradeRemark  = isPrimary ? getGradeRemarkPrimary  : getGradeRemarkSecondary;

  function getTermSuffix(t) { return t === '1' ? 'st' : t === '2' ? 'nd' : 'rd'; }

  function calculateAge(dobString) {
    if (!dobString) return null;
    const birthDate = new Date(dobString);
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const m = today.getMonth() - birthDate.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) age--;
    return age;
  }

  function getGradeScaleHtml() {
    const primaryScale = [
      ['A+','90-100','Exceptional'],['A','80-89','Excellent'],['B+','70-79','Very Good'],
      ['B','60-69','Good'],['C','50-59','Fairly Good'],['D','40-49','Pass'],['F','0-39','Fail']
    ];
    const secondaryScale = [
      ['A1','85-100','Excellent'],['B2','75-84.9','Very Good'],['B3','70-74.9','Good'],
      ['C4','65-69.9','Credit'],['C5','60-64.9','Credit'],['C6','50-59.9','Credit'],
      ['D7','45-49.9','Pass'],['E8','40-44.9','Pass'],['F9','0-39.9','Fail']
    ];
    const scale = isPrimary ? primaryScale : secondaryScale;
    return `<table class="rc-grade-scale">
      <thead><tr><th>Grade</th><th>Range</th><th>Remark</th></tr></thead>
      <tbody>${scale.map(s => `<tr><td>${s[0]}</td><td>${s[1]}</td><td>${s[2]}</td></tr>`).join('')}</tbody>
    </table>`;
  }

  const psychomotorSkillsList = ['Handling of tools','Public Speaking','Speech Fluency','Handwriting','Sport and Game','Drawing/Painting'];
  const affectiveSkillsList   = ['Attentiveness','Neatness','Honesty','Politeness','Punctuality','Self-control/Calmness','Obedience','Reliability','Relationship with others','Leadership'];
  function getSkillKey(skill) { return skill.toLowerCase().replace(/[^a-z]/g, ''); }

  // ── Subject table rows ───────────────────────────────────────────────────────
  let tableRows = '';
  let totalScore = 0;
  let subjectCount = 0;
  if (scores && scores.length) {
    for (const score of scores) {
      const subjectName = score.subjectName || score.subjectId;
      const total = (score.ca || 0) + (score.exam || 0);
      totalScore += total;
      subjectCount++;
      const grade  = calculateGrade(total);
      const remark = getGradeRemark(grade);
      let positionHtml = '—';
      let classAvg = '—';
      const stat = subjectStats?.get(score.subjectId);
      if (stat && !isPrimary) {
        const rank = stat.rankMap?.get(student.id);
        if (rank) {
          const suffix = rank === 1 ? 'st' : rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th';
          positionHtml = `${rank}<sup>${suffix}</sup>`;
        }
        classAvg = stat.classAverage ?? '—';
      }
      if (isPrimary) {
        tableRows += `<tr>
          <td class="rc-subj-name">${escapeHtml(subjectName)}</td>
          <td>${score.ca}</td><td>${score.exam}</td><td>${total}</td>
          <td>${grade}</td><td>${remark}</td>
        </tr>`;
      } else {
        tableRows += `<tr>
          <td class="rc-subj-name">${escapeHtml(subjectName)}</td>
          <td>${score.ca}</td><td>${score.exam}</td><td>${total}</td>
          <td>${grade}</td><td>${remark}</td>
          <td>${positionHtml}</td><td>${classAvg}</td>
        </tr>`;
      }
    }
  } else {
    const colSpan = isPrimary ? 6 : 8;
    tableRows = `<tr><td colspan="${colSpan}">No scores found</td></tr>`;
  }

  const totalObtainable = subjectCount * 100;
  const percentageAvg   = subjectCount ? ((totalScore / totalObtainable) * 100).toFixed(1) : 0;
  const overallGrade    = calculateGrade(parseFloat(percentageAvg));
  const overallRemark   = getGradeRemark(overallGrade);

  // ── Subject table ────────────────────────────────────────────────────────────
  const subjectTableHeader = isPrimary
    ? `<thead><tr><th>Subject</th><th>CA (${grading.ca})</th><th>Exam (${grading.exam})</th><th>Total</th><th>Grade</th><th>Remark</th></tr></thead>`
    : `<thead><tr><th>Subject</th><th>CA (${grading.ca})</th><th>Exam (${grading.exam})</th><th>Total</th><th>Grade</th><th>Remark</th><th>Pos.</th><th>Cls Avg</th></tr></thead>`;
  const subjectTableHtml = `<table class="rc-subject-table">${subjectTableHeader}<tbody>${tableRows}</tbody></table>`;

  // ── Summary table ────────────────────────────────────────────────────────────
  const summaryHtml = `
    <div class="rc-section-title">📊 Summary of Performance</div>
    <table class="rc-summary-table">
      <tr><th>Total Obtained</th><td>${totalScore}</td></tr>
      <tr><th>Total Obtainable</th><td>${totalObtainable}</td></tr>
      <tr><th>Total Subjects</th><td>${subjectCount}</td></tr>
      <tr><th>% Average</th><td>${percentageAvg}%</td></tr>
      <tr><th>Grade</th><td>${overallGrade}</td></tr>
      <tr><th>Remark</th><td>${overallRemark}</td></tr>
    </table>`;

  // ── Attendance table ─────────────────────────────────────────────────────────
  const attendanceHtml = `
    <div class="rc-section-title">📅 Attendance Record</div>
    <table class="rc-attendance-table">
      <tbody>
        <tr>
          <td class="rc-att-label">No of times School opened</td>
          <td class="rc-att-cell">
            <input type="number" class="rc-att-input school-opened" value="${attendance.schoolOpened || 0}" min="0" step="1">
            <span class="rc-print-val school-opened-value">${attendance.schoolOpened || 0}</span>
          </td>
        </tr>
        <tr>
          <td class="rc-att-label">No of times present</td>
          <td class="rc-att-cell">
            <input type="number" class="rc-att-input present" value="${attendance.present || 0}" min="0" step="1">
            <span class="rc-print-val present-value">${attendance.present || 0}</span>
          </td>
        </tr>
        <tr>
          <td class="rc-att-label">No of times absent</td>
          <td class="rc-att-cell">
            <input type="number" class="rc-att-input absent" value="${attendance.absent || 0}" min="0" step="1">
            <span class="rc-print-val absent-value">${attendance.absent || 0}</span>
          </td>
        </tr>
      </tbody>
    </table>`;

  // ── Skills tables ────────────────────────────────────────────────────────────
  let psychomotorRows = '';
  for (const skill of psychomotorSkillsList) {
    const key = getSkillKey(skill);
    const val = psychomotor?.[key] ?? 3;
    psychomotorRows += `<tr>
      <td class="rc-skill-name">${escapeHtml(skill)}</td>
      <td class="rc-rating-cell" data-skill-key="${key}"><span class="rc-print-val">${val}</span></td>
    </tr>`;
  }
  let affectiveRows = '';
  for (const skill of affectiveSkillsList) {
    const key = getSkillKey(skill);
    const val = psychomotor?.[key] ?? 3;
    affectiveRows += `<tr>
      <td class="rc-skill-name">${escapeHtml(skill)}</td>
      <td class="rc-rating-cell" data-skill-key="${key}"><span class="rc-print-val">${val}</span></td>
    </tr>`;
  }
  const skillsStack = `
    <table class="rc-skills-table">
      <thead><tr><th>Psychomotor Skills</th><th>Rating (1–5)</th></tr></thead>
      <tbody>${psychomotorRows}</tbody>
    </table>
    <table class="rc-skills-table rc-skills-table--lower">
      <thead><tr><th>Affective Domain</th><th>Rating (1–5)</th></tr></thead>
      <tbody>${affectiveRows}</tbody>
    </table>
    <div class="rc-rating-guide">1: Poor &nbsp; 2: Fair &nbsp; 3: Good &nbsp; 4: Very Good &nbsp; 5: Excellent</div>`;

  // ── Header — school name enlarged; email + phone (from Firestore school data) shown under address ──
  const headerHtml = `
    <div class="rc-header">
      <div class="rc-header-logo">${school.logo ? `<img src="${school.logo}" alt="Logo">` : ''}</div>
      <div class="rc-header-text">
        <h1 class="rc-school-name">${escapeHtml(school.name)}</h1>
        ${school.address ? `<div class="rc-school-address">${escapeHtml(school.address)}</div>` : ''}
        ${school.phone   ? `<div class="rc-school-contact">📞 ${escapeHtml(school.phone)}</div>`   : ''}
        ${school.email   ? `<div class="rc-school-contact">✉️ ${escapeHtml(school.email)}</div>`   : ''}
      </div>
      <div class="rc-header-passport">${student.passport ? `<img src="${student.passport}" alt="Passport">` : ''}</div>
    </div>`;

  // ── Student details band ─────────────────────────────────────────────────────
  const age = student.dob ? calculateAge(student.dob) : '—';
  const detailsBand = `
    <div class="rc-details-band">
      <div class="rc-details-cell"><strong>Name:</strong> <span class="rc-student-name">${escapeHtml(student.name).toUpperCase()}</span></div>
      <div class="rc-details-cell"><strong>Admission No:</strong> ${escapeHtml(student.admissionNumber || '—')}</div>
      <div class="rc-details-cell"><strong>Gender:</strong> ${escapeHtml(student.gender || '—')}</div>
      <div class="rc-details-cell"><strong>DOB:</strong> ${student.dob || '—'} (Age ${age})</div>
      <div class="rc-details-cell"><strong>Class:</strong> ${escapeHtml(className)}</div>
      <div class="rc-details-cell"><strong>Term:</strong> ${term}${getTermSuffix(term)}</div>
      <div class="rc-details-cell"><strong>Session:</strong> ${session}</div>
      <div class="rc-details-cell"><strong>Club:</strong> ${escapeHtml(student.club || '—')}</div>
    </div>`;

  // ── Comments ─────────────────────────────────────────────────────────────────
  const commentOptions = (() => {
    const general = [
      'Keep up the great work!','Your effort is commendable.','Consistent practice will yield even better results.',
      'You have shown improvement this term.','Stay focused and keep pushing forward.','Your positive attitude is appreciated.',
      'Continue to participate actively in class.','You are capable of achieving even more.','Great teamwork and collaboration skills.',
      'Your curiosity and willingness to learn are assets.'
    ];
    const extra = ['Your participation in class discussions is valued.','You have shown growth in problem-solving skills.','Excellent punctuality and attendance.'];
    let all = [...general];
    while (all.length < 30) all.push(extra[all.length % extra.length]);
    return [...new Set(all)];
  })();

  const effectiveTeacherComment   = comments.teacherComment   || commentOptions[0] || '';
  const effectivePrincipalComment = comments.principalComment || commentOptions[0] || '';
  const principalLabel = isPrimary ? "Head Teacher's Comment:" : "Principal's Comment:";

  const commentsHtml = `
    <div class="rc-comments">
      <strong>Comments</strong>
      <div class="rc-comment-row">
        <label>Class Teacher's Comment:</label>
        <div class="rc-comment-controls">
          <select id="teacherCommentSelect">${commentOptions.map(o => `<option value="${o}" ${effectiveTeacherComment === o ? 'selected' : ''}>${o}</option>`).join('')}</select>
          <textarea id="teacherCommentText" rows="1">${escapeHtml(effectiveTeacherComment)}</textarea>
        </div>
        <div id="printTeacherComment" class="rc-print-comment">${escapeHtml(effectiveTeacherComment)}</div>
      </div>
      <div class="rc-comment-row">
        <label>${principalLabel}</label>
        <div class="rc-comment-controls">
          <select id="principalCommentSelect">${commentOptions.map(o => `<option value="${o}" ${effectivePrincipalComment === o ? 'selected' : ''}>${o}</option>`).join('')}</select>
          <textarea id="principalCommentText" rows="1">${escapeHtml(effectivePrincipalComment)}</textarea>
        </div>
        <div id="printPrincipalComment" class="rc-print-comment">${escapeHtml(effectivePrincipalComment)}</div>
      </div>
    </div>`;

  // ── STYLES ───────────────────────────────────────────────────────────────────
  const styles = `
    <style>
      /* Force colours for print engines */
      *, *::before, *::after {
        -webkit-print-color-adjust: exact !important;
                print-color-adjust: exact !important;
        color-adjust: exact !important;
        color: #000 !important;
      }

      /* ── Wrapper — warm cream paper background ── */
      .rc-wrapper {
        width: 100%;
        max-width: 210mm;
        margin: 0 auto;
        background: #fdf8f2 !important;
        border: 2px solid #000;
        padding: clamp(8px, 2%, 20px);
        box-sizing: border-box;
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        font-size: clamp(9px, 1.2vw, 13px);
      }

      /* ── Header ── */
      .rc-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 10px;
      }
      .rc-header-logo img {
        max-width: clamp(60px, 8vw, 100px);
        max-height: clamp(60px, 8vw, 100px);
        object-fit: contain;
        border-radius: 4px;
      }
      /* ── Passport — slightly bigger + framed ── */
      .rc-header-passport img {
        width:  clamp(80px, 11vw, 125px);
        height: clamp(80px, 11vw, 125px);
        object-fit: cover;
        border-radius: 6px;
        border: 2px solid #1a3a5c;
      }
      .rc-header-text {
        flex: 1;
        text-align: center;
      }
      /* ── School name — notably larger and bold ── */
      .rc-school-name {
        margin: 0 0 4px 0;
        font-size: clamp(22px, 4vw, 42px) !important;
        font-weight: 800;
        letter-spacing: 0.02em;
        line-height: 1.15;
        text-transform: uppercase;
      }
      .rc-school-address { font-size: 0.88em; margin-top: 2px; }
      .rc-school-contact { font-size: 0.82em; color: #333; margin-top: 1px; }

      /* ── Details band — deep navy, white text, clean cell dividers ── */
      .rc-details-band {
        background: #1a3a5c !important;
        padding: 0;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(clamp(140px, 22%, 220px), 1fr));
        gap: 0;
        font-weight: bold;
        font-size: 0.92em;
        border-radius: 6px;
        margin-bottom: 12px;
        overflow: hidden;
        border: 1px solid #0f2740;
      }
      .rc-details-cell {
        padding: clamp(5px, 1.2%, 10px) clamp(6px, 1.5%, 12px);
        border-right: 1px solid rgba(255, 255, 255, 0.18) !important;
        border-bottom: 1px solid rgba(255, 255, 255, 0.18) !important;
        color: #fff !important;
      }
      .rc-details-cell strong { color: #a8d8f0 !important; margin-right: 3px; }
      .rc-student-name { font-size: 1.05em; font-weight: 700; color: #fff !important; }

      /* ── Summary + Attendance row (top) ── */
      .rc-top-row {
        display: flex;
        flex-wrap: wrap;
        gap: clamp(8px, 2%, 20px);
        margin-bottom: clamp(10px, 2%, 18px);
        justify-content: center;
        align-items: flex-start;
      }
      .rc-top-row > div { flex: 1 1 clamp(160px, 38%, 300px); }

      /* ── Section title ── */
      .rc-section-title { font-weight: bold; margin-bottom: 5px; font-size: 0.95em; }

      /* ── Shared table base ── */
      .rc-subject-table,
      .rc-summary-table,
      .rc-attendance-table,
      .rc-skills-table,
      .rc-grade-scale {
        width: 100%;
        border-collapse: collapse;
        border: 2px solid #000;
        background: #fff !important;
      }
      .rc-subject-table th, .rc-subject-table td,
      .rc-summary-table th, .rc-summary-table td,
      .rc-attendance-table th, .rc-attendance-table td,
      .rc-skills-table th,   .rc-skills-table td,
      .rc-grade-scale th,    .rc-grade-scale td {
        border: 1px solid #000 !important;
        padding: clamp(2px, 0.6%, 6px);
        text-align: center;
        vertical-align: middle;
      }
      .rc-subject-table th,
      .rc-summary-table th,
      .rc-attendance-table th,
      .rc-skills-table th { background: #ADD8E6 !important; }
      .rc-grade-scale th { background: #FFD700 !important; }

      .rc-subj-name,
      .rc-att-label { text-align: left !important; white-space: normal; word-break: break-word; }

      .rc-skill-name {
        text-align: left !important;
        writing-mode: horizontal-tb !important;
        text-orientation: mixed !important;
        white-space: normal !important;
        word-break: break-word;
      }

      /* ── MAIN TWO-COLUMN GRID ── */
      .rc-main-row {
        display: grid;
        grid-template-columns: 62fr 35fr;
        gap: clamp(12px, 3%, 28px);
        align-items: start;
        width: 100%;
        box-sizing: border-box;
      }
      .rc-col-left,
      .rc-col-right {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: clamp(6px, 1.5%, 14px);
      }

      .rc-rating-guide { font-size: 0.78em; color: #444; margin-top: 2px; }

      /* ── Rating ticks ── */
      .rc-tick-row { display: flex; gap: 3px; justify-content: center; flex-wrap: wrap; }
      .rc-tick {
        width: clamp(14px, 2vw, 20px);
        height: clamp(14px, 2vw, 20px);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid #999;
        border-radius: 50%;
        cursor: pointer;
        font-size: 0.75em;
        user-select: none;
      }
      .rc-tick.selected { background: #3b82f6 !important; color: #fff !important; border-color: #3b82f6; }

      /* ── Attendance input ── */
      .rc-att-input { width: 100%; max-width: 80px; padding: 2px 4px; box-sizing: border-box; font-size: inherit; }

      /* ── Comments ── */
      .rc-comments {
        background: #f9f9f9 !important;
        border: 1px solid #ddd;
        border-radius: 4px;
        padding: clamp(4px, 1%, 10px);
        margin-top: 10px;
        font-size: 0.9em;
      }
      .rc-comment-row { margin-top: 6px; display: flex; flex-direction: column; gap: 2px; }
      .rc-comment-controls { display: flex; flex-direction: column; gap: 2px; }
      .rc-comment-controls select,
      .rc-comment-controls textarea { width: 100%; box-sizing: border-box; font-size: inherit; background: #fff !important; }

      .rc-print-val,
      .rc-print-comment { display: none; }

      /* ── Mobile ── */
      @media (max-width: 600px) {
        .rc-wrapper { padding: 8px; font-size: 11px; }
        .rc-school-name { font-size: clamp(18px, 6vw, 26px) !important; }
        .rc-main-row { grid-template-columns: 1fr; gap: 16px; }
        .rc-top-row { flex-direction: column; }
        .rc-details-band { grid-template-columns: 1fr 1fr; }
        .rc-header-logo img { max-width: 55px; max-height: 55px; }
        .rc-header-passport img { width: 65px; height: 65px; }
      }

      /* ── Print ── */
      @media print {
        .rc-wrapper { max-width: 100%; border: none; padding: 0; font-size: 8pt; background: #fdf8f2 !important; }
        .rc-school-name { font-size: 22pt !important; }
        .rc-main-row { grid-template-columns: 62fr 35fr; gap: 14px; }
        .rc-att-input, .rc-tick-row, .rc-comment-controls, select, textarea, button { display: none !important; }
        .rc-print-val    { display: inline !important; }
        .rc-print-comment { display: block !important; }
        .rc-details-band { background: #1a3a5c !important; }
        .rc-details-cell { color: #fff !important; border-right: 1px solid rgba(255,255,255,0.18) !important; border-bottom: 1px solid rgba(255,255,255,0.18) !important; }
        .rc-details-cell strong { color: #a8d8f0 !important; }
        .rc-subject-table, .rc-summary-table, .rc-attendance-table, .rc-skills-table, .rc-grade-scale { break-inside: avoid; page-break-inside: avoid; }
        html, body { height: auto !important; overflow: visible !important; }
        .rc-scroll-outer { overflow: visible !important; }
        @page { size: A4; margin: 8mm; }
      }
    </style>`;

  // ── Final HTML assembly ───────────────────────────────────────────────────────
  const cardHtml = `
    ${styles}
    <div class="rc-wrapper">
      ${headerHtml}
      ${detailsBand}
      <div class="rc-top-row">
        <div>${summaryHtml}</div>
        <div>${attendanceHtml}</div>
      </div>
      <div class="rc-main-row">
        <div class="rc-col-left">
          ${subjectTableHtml}
          ${getGradeScaleHtml()}
        </div>
        <div class="rc-col-right">
          ${skillsStack}
        </div>
      </div>
      ${commentsHtml}
    </div>`;

  const finalHtml = `<div class="rc-scroll-outer" style="overflow-x:auto;">${cardHtml}</div>`;
  container.innerHTML = finalHtml;

  // ── Attach interactive rating ticks ──────────────────────────────────────────
  container.querySelectorAll('.rc-rating-cell').forEach(el => {
    const key = el.dataset.skillKey;
    if (!key) return;
    const val = psychomotor?.[key] ?? 3;
    const tickRow = document.createElement('div');
    tickRow.className = 'rc-tick-row';
    for (let i = 1; i <= 5; i++) {
      const tick = document.createElement('span');
      tick.className = 'rc-tick' + (i === val ? ' selected' : '');
      tick.textContent = i;
      tick.addEventListener('click', (e) => {
        e.stopPropagation();
        tickRow.querySelectorAll('.rc-tick').forEach(t => t.classList.remove('selected'));
        tick.classList.add('selected');
        if (onRatingChange) onRatingChange(key, i);
        const printSpan = el.querySelector('.rc-print-val');
        if (printSpan) printSpan.textContent = i;
      });
      tickRow.appendChild(tick);
    }
    el.appendChild(tickRow);
  });

  // ── Attendance live sync ──────────────────────────────────────────────────────
  container.querySelectorAll('.rc-att-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const spanClass = '.' + inp.classList[1] + '-value';
      const span = container.querySelector(spanClass);
      if (span) span.textContent = inp.value;
    });
  });

  // ── Comment selects / textareas ───────────────────────────────────────────────
  const teacherSelect   = document.getElementById('teacherCommentSelect');
  const teacherText     = document.getElementById('teacherCommentText');
  const principalSelect = document.getElementById('principalCommentSelect');
  const principalText   = document.getElementById('principalCommentText');
  const printTeacher    = document.getElementById('printTeacherComment');
  const printPrincipal  = document.getElementById('printPrincipalComment');

  if (teacherSelect) teacherSelect.onchange = () => {
    const val = teacherSelect.value;
    if (teacherText)  teacherText.value = val;
    if (printTeacher) printTeacher.textContent = escapeHtml(val);
    if (onTeacherCommentChange) onTeacherCommentChange(val);
  };
  if (teacherText) teacherText.oninput = () => {
    const val = teacherText.value;
    if (printTeacher) printTeacher.textContent = escapeHtml(val);
    if (onTeacherCommentChange) onTeacherCommentChange(val);
  };
  if (principalSelect) principalSelect.onchange = () => {
    const val = principalSelect.value;
    if (principalText)  principalText.value = val;
    if (printPrincipal) printPrincipal.textContent = escapeHtml(val);
    if (onPrincipalCommentChange) onPrincipalCommentChange(val);
  };
  if (principalText) principalText.oninput = () => {
    const val = principalText.value;
    if (printPrincipal) printPrincipal.textContent = escapeHtml(val);
    if (onPrincipalCommentChange) onPrincipalCommentChange(val);
  };

  return { fullHtml: finalHtml, totalScore, totalObtainable, average: percentageAvg, overallGrade };
}