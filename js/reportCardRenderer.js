// reportCardRenderer.js - Shared report card rendering engine
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
  const getGradeRemark = isPrimary ? getGradeRemarkPrimary : getGradeRemarkSecondary;

  function getTermSuffix(t) {
    return t === '1' ? 'st' : t === '2' ? 'nd' : 'rd';
  }
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
    if (isPrimary) {
      const primaryScale = [
        ['A+', '90-100', 'Exceptional'],
        ['A', '80-89', 'Excellent'],
        ['B+', '70-79', 'Very Good'],
        ['B', '60-69', 'Good'],
        ['C', '50-59', 'Fairly Good'],
        ['D', '40-49', 'Pass'],
        ['F', '0-39', 'Fail']
      ];
      return `<table class="grade-scale-table" style="width: 90%; margin-top: 20px;"><thead><tr><th>Grade</th><th>Score Range</th><th>Remark</th></tr></thead><tbody>${primaryScale.map(s=>`<tr><td>${s[0]}</td><td>${s[1]}</td><td>${s[2]}</td></tr>`).join('')}</tbody></table>`;
    } else {
      const secondaryScale = [
        ['A1','85-100','Excellent'], ['B2','75-84.9','Very Good'], ['B3','70-74.9','Good'],
        ['C4','65-69.9','Credit'], ['C5','60-64.9','Credit'], ['C6','50-59.9','Credit'],
        ['D7','45-49.9','Pass'], ['E8','40-44.9','Pass'], ['F9','0-39.9','Fail']
      ];
      return `<table class="grade-scale-table" style="width: 90%; margin-top: 20px;"><thead><tr><th>Grade</th><th>Score Range</th><th>Remark</th></tr></thead><tbody>${secondaryScale.map(s=>`<tr><td>${s[0]}</td><td>${s[1]}</td><td>${s[2]}</td></tr>`).join('')}</tbody></table>`;
    }
  }

  const psychomotorSkillsList = ['Handling of tools', 'Public Speaking', 'Speech Fluency', 'Handwriting', 'Sport and Game', 'Drawing/Painting'];
  const affectiveSkillsList = ['Attentiveness', 'Neatness', 'Honesty', 'Politeness', 'Punctuality', 'Self-control/Calmness', 'Obedience', 'Reliability', 'Relationship with others', 'Leadership'];
  function getSkillKey(skill) {
    return skill.toLowerCase().replace(/[^a-z]/g, '');
  }

  // Build subject table rows
  let tableRows = '';
  let totalScore = 0;
  let subjectCount = 0;
  if (scores && scores.length) {
    for (const score of scores) {
      const subjectName = score.subjectName || score.subjectId;
      const total = (score.ca || 0) + (score.exam || 0);
      totalScore += total;
      subjectCount++;
      const grade = calculateGrade(total);
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
        tableRows += `<tr><td style="text-align:left">${escapeHtml(subjectName)}</td>
                 <td>${score.ca}</td><td>${score.exam}</td><td>${total}</td>
                 <td>${grade}</td><td>${remark}</td></tr>`;
      } else {
        tableRows += `<tr><td style="text-align:left">${escapeHtml(subjectName)}</td>
                 <td>${score.ca}</td><td>${score.exam}</td><td>${total}</td>
                 <td>${grade}</td><td>${remark}</td><td>${positionHtml}</td><td>${classAvg}</td></tr>`;
      }
    }
  } else {
    const colSpan = isPrimary ? 6 : 8;
    tableRows = `<tr><td colspan="${colSpan}">No scores found</td></tr>`;
  }

  const average = subjectCount ? (totalScore / subjectCount).toFixed(1) : 0;
  const overallGrade = calculateGrade(parseFloat(average));
  const totalObtainable = subjectCount * 100;
  const percentageAvg = subjectCount ? ((totalScore / totalObtainable) * 100).toFixed(1) : 0;
  const overallRemark = getGradeRemark(overallGrade);

  // Skills tables – side by side
  // CHANGE 3: Reduced width by ~25% via max-width on wrapper and tighter table widths
  let psychomotorHtml = `<table class="skills-table psychomotor-table" style="flex:1; min-width:150px; max-width:100%;"><thead><tr><th>Psychomotor Skills</th><th>Rating (1-5)</th></tr></thead><tbody>`;
  for (const skill of psychomotorSkillsList) {
    const key = getSkillKey(skill);
    const val = psychomotor?.[key] ?? 3;
    psychomotorHtml += `<tr><td>${escapeHtml(skill)}</td>
      <td class="rating-container" data-skill-key="${key}"><span class="print-value">${val}</span></td></tr>`;
  }
  psychomotorHtml += `</tbody></table>`;

  let affectiveHtml = `<table class="skills-table affective-table" style="flex:1; min-width:150px; max-width:100%;"><thead><tr><th>Affective Domain</th><th>Rating (1-5)</th></tr></thead><tbody>`;
  for (const skill of affectiveSkillsList) {
    const key = getSkillKey(skill);
    const val = psychomotor?.[key] ?? 3;
    affectiveHtml += `<tr><td>${escapeHtml(skill)}</td>
      <td class="rating-container" data-skill-key="${key}"><span class="print-value">${val}</span></td></tr>`;
  }
  affectiveHtml += `</tbody></table>`;

  const ratingGuideHtml = `<div class="rating-guide" style="margin-top:12px; font-size:0.8rem; color:#000;">Rating Guide: 1 - Poor | 2 - Fair | 3 - Good | 4 - Very Good | 5 - Excellent</div>`;

  // Summary table
  const summaryHtml = `<div class="section-title">📊 Summary of Performance</div>
    <table class="summary-table">
      <tr><th>Total Obtained</th><td>${totalScore}</td></tr>
      <tr><th>Total Obtainable</th><td>${totalObtainable}</td></tr>
      <tr><th>Total Subjects</th><td>${subjectCount}</td></tr>
      <tr><th>% Average</th><td>${percentageAvg}%</td></tr>
      <tr><th>Grade</th><td>${overallGrade}</td></tr>
      <tr><th>Remark</th><td>${overallRemark}</td></tr>
    </table>`;

  // Attendance table
  // CHANGE 1: Attendance moved to RIGHT, Summary to LEFT.
  // Attendance label column width doubled via min-width on first col.
  const attendanceHtml = `
    <div class="attendance-section">
      <div class="section-title">📅 Attendance Record</div>
      <table class="attendance-table" style="width:100%;">
        <colgroup>
          <col style="min-width: 260px; white-space: nowrap;">
          <col>
        </colgroup>
        <tbody>
          <tr>
            <td class="attendance-label" style="white-space: nowrap; min-width: 260px;">No of times School opened</td>
            <td class="attendance-input-cell">
              <input type="number" class="attendance-input school-opened" value="${attendance.schoolOpened || 0}" min="0" step="1">
              <span class="print-value attendance-value school-opened-value">${attendance.schoolOpened || 0}</span>
            </td>
          </tr>
          <tr>
            <td class="attendance-label" style="white-space: nowrap; min-width: 260px;">No of times present</td>
            <td class="attendance-input-cell">
              <input type="number" class="attendance-input present" value="${attendance.present || 0}" min="0" step="1">
              <span class="print-value attendance-value present-value">${attendance.present || 0}</span>
            </td>
          </tr>
          <tr>
            <td class="attendance-label" style="white-space: nowrap; min-width: 260px;">No of times absent</td>
            <td class="attendance-input-cell">
              <input type="number" class="attendance-input absent" value="${attendance.absent || 0}" min="0" step="1">
              <span class="print-value attendance-value absent-value">${attendance.absent || 0}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>`;

  // Header with logo, school name, address, and student photo
  const headerHtml = `<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 15px;">
    <div style="flex: 0 0 auto;">${school.logo ? `<img src="${school.logo}" style="max-width: 100px; max-height: 100px; object-fit: contain;" alt="Logo">` : ''}</div>
    <div style="flex: 1; text-align: center;">
      <h1 style="font-size: 28px; margin: 0; color: #000;">${escapeHtml(school.name)}</h1>
      ${school.address ? `<div style="font-size: 16px; margin-top: 5px; color: #000;">${escapeHtml(school.address)}</div>` : ''}
    </div>
    <div style="flex: 0 0 auto;">${student.passport ? `<img src="${student.passport}" style="width: 80px; height: 80px; object-fit: cover; border-radius: 8px;" alt="Passport">` : ''}</div>
  </div>`;

  const age = student.dob ? calculateAge(student.dob) : '—';
  const studentDetailsHtml = `<div class="student-details-band" style="background-color:#D2B48C; padding:10px; line-height:1.2; border-radius:8px; margin-bottom:15px; color:#000; display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; overflow: auto; font-size: 1.3em; font-weight: bold;">
    <div><strong style="font-size: 1.2em;">Name:</strong> <span style="font-size: 1.3em; font-weight: 700;">${escapeHtml(student.name).toUpperCase()}</span></div>
    <div><strong>Admission No:</strong> ${escapeHtml(student.admissionNumber || '—')}</div>
    <div><strong>Gender:</strong> ${escapeHtml(student.gender || '—')}</div>
    <div><strong>DOB:</strong> ${student.dob || '—'} (Age ${age})</div>
    <div><strong>Class:</strong> ${escapeHtml(className)}</div>
    <div><strong>Term:</strong> ${term}${getTermSuffix(term)}</div>
    <div><strong>Session:</strong> ${session}</div>
    <div><strong>Club:</strong> ${escapeHtml(student.club || '—')}</div>
  </div>`;

  // CHANGE 2: Subject table width reduced ~30% — flex ratio changed and max-width applied
  let subjectTableHeader = '';
  if (isPrimary) {
    subjectTableHeader = `<thead><tr style="background-color:#ADD8E6;"><th>Subject</th><th>CA (${grading.ca})</th><th>Exam (${grading.exam})</th><th>Total (100)</th><th>Grade</th><th>Remark</th></tr></thead>`;
  } else {
    subjectTableHeader = `<thead><tr style="background-color:#ADD8E6;"><th>Subject</th><th>CA (${grading.ca})</th><th>Exam (${grading.exam})</th><th>Total (100)</th><th>Grade</th><th>Remark</th><th>Position</th><th>Class Ave.</th></tr></thead>`;
  }
  // Table itself is 100% of its container; container flex is reduced below
  const subjectTableHtml = `<table class="subject-table" style="border-collapse: collapse; width: 100%; border: 2px solid #000; background: white;">${subjectTableHeader}<tbody>${tableRows}</tbody></table>`;

  // Skills side-by-side: shifted right by 30% via margin-left on the inner wrapper.
  // The outer right column keeps its current flex sizing; only the tables inside move rightward.
  const skillsSideBySide = `<div style="display:flex; gap:12px; flex-wrap:wrap; justify-content:space-between; max-width:100%; margin-left:30%;">${psychomotorHtml}${affectiveHtml}</div>${ratingGuideHtml}`;

  // CHANGE 2+3: Left col flex reduced (was flex:2), right col (skills) flex kept at 1 but constrained
  // Left column: subject table + grade scale, flex:1.4 (was 2) to reduce subject table width ~30%
  const leftColumnContent = subjectTableHtml + `<div style="margin-top:20px;">${getGradeScaleHtml()}</div>`;
  const rightColumnHtml = `<div class="skills-stack-col" style="max-width: 75%;">${skillsSideBySide}</div>`;

  const mainGridHtml = `<div style="display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 20px;">
    <div style="flex: 1.4; min-width: 250px; max-width: 70%;">${leftColumnContent}</div>
    <div style="flex: 1; min-width: 200px; max-width: 30%;">${rightColumnHtml}</div>
  </div>`;

  // CHANGE 5: Comments bank prefill — ensure first option is selected if no saved comment
  const commentOptions = (() => {
    const generalComments = [
      'Keep up the great work!', 'Your effort is commendable.', 'Consistent practice will yield even better results.',
      'You have shown improvement this term.', 'Stay focused and keep pushing forward.', 'Your positive attitude is appreciated.'
    ];
    let allComments = [...generalComments];
    const extraComments = ['Your participation is valued.', 'You have shown growth.', 'Excellent punctuality.'];
    while (allComments.length < 30) allComments.push(extraComments[allComments.length % extraComments.length]);
    return [...new Set(allComments)];
  })();

  // Resolve effective teacher comment: use saved or fall back to first option
  const effectiveTeacherComment = comments.teacherComment || commentOptions[0] || '';
  const effectivePrincipalComment = comments.principalComment || commentOptions[0] || '';

  // CHANGE 4: "Teacher's Comment" → "Class Teacher's Comment"
  // CHANGE 6: Font sizes reduced by ~40% (was 1.2rem → ~0.72rem, h3 reduced proportionally)
  const principalLabel = isPrimary ? "Head Teacher's Comment:" : "Principal's Comment:";
  const commentsHtml = `<div class="comments-section" style="background-color:#f9f9f9; border:1px solid #ddd; border-radius:4px; padding:4px 10px; margin-top:4px; box-shadow:none; color:#000; line-height:1.2;">
    <h3 style="font-size: 0.65rem; margin: 0 0 3px 0; line-height:1.2;">Comments</h3>
    <div class="comment-group" style="margin-bottom: 3px;">
      <label style="font-size: 0.62rem; font-weight: bold; display: block; margin-bottom: 2px; line-height:1.2;">Class Teacher's Comment:</label>
      <div class="comment-controls">
        <select id="teacherCommentSelect" style="font-size: 0.62rem; padding: 1px; width: 100%; margin-bottom: 2px; height: 18px;">${commentOptions.map(opt => `<option value="${opt}" ${effectiveTeacherComment === opt ? 'selected' : ''}>${opt}</option>`).join('')}</select>
        <textarea id="teacherCommentText" rows="1" style="width:100%; font-size: 0.62rem; padding: 2px; height: 18px; resize:none; overflow:hidden;">${escapeHtml(effectiveTeacherComment)}</textarea>
      </div>
      <div class="print-comment-text" id="printTeacherComment" style="font-size: 0.62rem; margin-top: 1px; line-height:1.2;">${escapeHtml(effectiveTeacherComment)}</div>
    </div>
    <div class="comment-group" style="margin-bottom: 0;">
      <label style="font-size: 0.62rem; font-weight: bold; display: block; margin-bottom: 2px; line-height:1.2;">${principalLabel}</label>
      <div class="comment-controls">
        <select id="principalCommentSelect" style="font-size: 0.62rem; padding: 1px; width: 100%; margin-bottom: 2px; height: 18px;">${commentOptions.map(opt => `<option value="${opt}" ${effectivePrincipalComment === opt ? 'selected' : ''}>${opt}</option>`).join('')}</select>
        <textarea id="principalCommentText" rows="1" style="width:100%; font-size: 0.62rem; padding: 2px; height: 18px; resize:none; overflow:hidden;">${escapeHtml(effectivePrincipalComment)}</textarea>
      </div>
      <div class="print-comment-text" id="printPrincipalComment" style="font-size: 0.62rem; margin-top: 1px; line-height:1.2;">${escapeHtml(effectivePrincipalComment)}</div>
    </div>
  </div>`;

  const topRowHtml = `<div style="display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 20px; align-items: flex-start; justify-content: center;">
    <div style="flex: 0 0 auto; width: 35%;">${summaryHtml}</div>
    <div style="flex: 0 0 auto; width: 42%;">${attendanceHtml}</div>
  </div>`;

  // Global styles with the crucial print fix for overlapping tables
  const globalStyles = `
    <style>
      /*
       * ─── PRINT COLOR PRESERVATION ───────────────────────────────────────────────
       * Force Chrome, Edge, and all WebKit/Blink browsers to retain background
       * colors, gradients, and images when printing or exporting to PDF.
       * Must be declared at the top level (not inside @media print) so the
       * browser honours it before the print pipeline strips graphics.
       */
      *,
      *::before,
      *::after {
        -webkit-print-color-adjust: exact !important;
                print-color-adjust: exact !important;
        color-adjust: exact !important;
      }

      /* ─── BASE COLORS ─────────────────────────────────────────────────────────── */
      * { color: #000000 !important; }

      table, th, td {
        border: 2px solid #000 !important;
        border-collapse: collapse;
      }

      th, td { padding: 8px; text-align: left; }
      .section-title { font-weight: bold; margin-bottom: 8px; }
      select, textarea, input { color: #000 !important; background-color: #fff !important; }

      /* ─── TABLE HEADER BACKGROUND COLORS ─────────────────────────────────────── */
      /* Subject table, attendance table, and summary table headers — light blue */
      .subject-table thead tr,
      .subject-table th,
      .attendance-table thead tr,
      .attendance-table th,
      .summary-table thead tr,
      .summary-table th {
        background-color: #ADD8E6 !important;
      }

      /* Grade scale table headers — gold */
      .grade-scale-table thead tr,
      .grade-scale-table th {
        background-color: #FFD700 !important;
      }

      /* Skills tables (psychomotor + affective) headers */
      .skills-table thead tr,
      .skills-table th {
        background-color: #ADD8E6 !important;
        border: 2px solid #000 !important;
      }
      .skills-table td {
        border: 2px solid #000 !important;
      }

      /* ─── STUDENT DETAILS BAND — tan/brown ───────────────────────────────────── */
      .student-details-band {
        background-color: #D2B48C !important;
      }

      /* ─── COMMENTS SECTION ────────────────────────────────────────────────────── */
      .comments-section {
        background-color: #f9f9f9 !important;
      }

      /* ─── REPORT CARD OUTER WRAPPER ───────────────────────────────────────────── */
      .report-card-wrapper {
        background-color: #ffffff !important;
      }

      /* ─── @MEDIA PRINT ────────────────────────────────────────────────────────── */
      @media print {
        /* 1. Remove any absolute positioning – the main culprit for overlapping */
        .report-card,
        .report-card *,
        #report-card,
        #report-card * {
          position: static !important;
          float: none !important;
        }

        /* 2. Let containers grow naturally */
        html, body, .report-card, #report-card {
          height: auto !important;
          overflow: visible !important;
        }

        /* 3. Keep each table together, and add space to prevent crunching */
        .attendance-table,
        .summary-table,
        .subject-table,
        .skills-table,
        .records-table {
          break-inside: avoid;
          page-break-inside: avoid;
          margin-bottom: 1.5rem;
        }

        /* 4. Basic print-friendly table layout */
        table {
          border-collapse: collapse;
          width: 100%;
        }
        td, th {
          border: 1px solid #000 !important;
          padding: 4px;
        }

        /* 5. Re-assert all background colors inside @media print so no browser
              can override them when generating the print raster / PDF. */
        .subject-table thead tr,
        .subject-table th,
        .attendance-table thead tr,
        .attendance-table th,
        .summary-table thead tr,
        .summary-table th,
        .skills-table thead tr,
        .skills-table th {
          background-color: #ADD8E6 !important;
        }

        .grade-scale-table thead tr,
        .grade-scale-table th {
          background-color: #FFD700 !important;
        }

        .student-details-band {
          background-color: #D2B48C !important;
        }

        .comments-section {
          background-color: #f9f9f9 !important;
        }

        .report-card-wrapper {
          background-color: #ffffff !important;
        }

        /* 6. Hide interactive elements, show static values */
        .rating-tick, select, textarea, button, .comment-controls, .tick {
          display: none !important;
        }
        .print-value, .print-comment-text {
          display: block !important;
        }

        /* 7. Page background */
        body, .print-container {
          background: white !important;
        }

        /* 8. Constrain comments section height in print — slightly larger than before for readability */
        .comments-section {
          padding: 3px 8px !important;
          margin-top: 2px !important;
          border-width: 1px !important;
          line-height: 1.2 !important;
          break-inside: avoid !important;
          page-break-inside: avoid !important;
        }
        .comments-section h3 {
          font-size: 0.58rem !important;
          margin: 0 0 2px 0 !important;
          line-height: 1.2 !important;
        }
        .comments-section label {
          font-size: 0.55rem !important;
          margin-bottom: 1px !important;
          line-height: 1.2 !important;
        }
        .comment-group {
          margin-bottom: 2px !important;
        }
        .print-comment-text {
          font-size: 0.55rem !important;
          margin-top: 1px !important;
          line-height: 1.2 !important;
          padding: 0 !important;
        }
      }
    </style>
  `;

  const innerHtml = globalStyles + headerHtml + studentDetailsHtml + topRowHtml + mainGridHtml + commentsHtml;
  const finalHtml = `<div class="report-card-wrapper" style="border: 2px solid #000; padding: 15px; border-radius: 4px; background-color: white;">${innerHtml}</div>`;

  container.innerHTML = finalHtml;

  // Synchronize attendance spans
  const syncAttendanceSpans = () => {
    const openedInput = document.querySelector('.attendance-input.school-opened');
    const presentInput = document.querySelector('.attendance-input.present');
    const absentInput = document.querySelector('.attendance-input.absent');
    if (openedInput) {
      const openedSpan = document.querySelector('.school-opened-value');
      if (openedSpan) openedSpan.textContent = openedInput.value;
    }
    if (presentInput) {
      const presentSpan = document.querySelector('.present-value');
      if (presentSpan) presentSpan.textContent = presentInput.value;
    }
    if (absentInput) {
      const absentSpan = document.querySelector('.absent-value');
      if (absentSpan) absentSpan.textContent = absentInput.value;
    }
  };
  document.querySelectorAll('.attendance-input').forEach(input => {
    input.addEventListener('input', syncAttendanceSpans);
  });

  // Rating tick widgets
  function createTickRating(skillKey, currentValue) {
    const containerDiv = document.createElement('div');
    containerDiv.className = 'rating-tick';
    for (let i = 1; i <= 5; i++) {
      const tick = document.createElement('span');
      tick.className = 'tick' + (i === currentValue ? ' selected' : '');
      tick.textContent = i;
      tick.addEventListener('click', (e) => {
        e.stopPropagation();
        const parent = tick.parentNode;
        Array.from(parent.children).forEach(t => t.classList.remove('selected'));
        tick.classList.add('selected');
        if (onRatingChange) onRatingChange(skillKey, i);
        const ratingContainer = parent.closest('.rating-container');
        if (ratingContainer) {
          const printSpan = ratingContainer.querySelector('.print-value');
          if (printSpan) printSpan.textContent = i;
        }
      });
      containerDiv.appendChild(tick);
    }
    return containerDiv;
  }

  document.querySelectorAll('.rating-container').forEach(containerEl => {
    const skillKey = containerEl.dataset.skillKey;
    if (skillKey) {
      const currentVal = psychomotor?.[skillKey] ?? 3;
      const widget = createTickRating(skillKey, currentVal);
      containerEl.appendChild(widget);
    }
  });

  // Comment sync
  const teacherSelect = document.getElementById('teacherCommentSelect');
  const teacherText = document.getElementById('teacherCommentText');
  const principalSelect = document.getElementById('principalCommentSelect');
  const principalText = document.getElementById('principalCommentText');
  const printTeacher = document.getElementById('printTeacherComment');
  const printPrincipal = document.getElementById('printPrincipalComment');

  if (teacherSelect) {
    teacherSelect.onchange = () => {
      const val = teacherSelect.value;
      if (teacherText) teacherText.value = val;
      if (printTeacher) printTeacher.textContent = escapeHtml(val);
      if (onTeacherCommentChange) onTeacherCommentChange(val);
    };
  }
  if (teacherText) {
    teacherText.oninput = () => {
      const val = teacherText.value;
      if (printTeacher) printTeacher.textContent = escapeHtml(val);
      if (onTeacherCommentChange) onTeacherCommentChange(val);
    };
  }
  if (principalSelect) {
    principalSelect.onchange = () => {
      const val = principalSelect.value;
      if (principalText) principalText.value = val;
      if (printPrincipal) printPrincipal.textContent = escapeHtml(val);
      if (onPrincipalCommentChange) onPrincipalCommentChange(val);
    };
  }
  if (principalText) {
    principalText.oninput = () => {
      const val = principalText.value;
      if (printPrincipal) printPrincipal.textContent = escapeHtml(val);
      if (onPrincipalCommentChange) onPrincipalCommentChange(val);
    };
  }

  return { fullHtml: finalHtml, totalScore, totalObtainable, average, overallGrade };
}