// reportCardRenderer.js - Shared report card rendering engine (UPDATED)
import { showNotification } from './error-handler.js';

export function renderReportCardUI({
  student, scores, className, school, grading, psychomotor, comments,
  term, session, subjectStats, container, attendance = {},
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

  function calculateGrade(total) {
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

  function getGradeRemark(grade) {
    const remarks = { A1:'Excellent', B2:'Very Good', B3:'Good', C4:'Credit', C5:'Credit', C6:'Credit', D7:'Pass', E8:'Pass', F9:'Fail' };
    return remarks[grade] || '';
  }

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
    const scale = [
      ['A1','85-100','Excellent'], ['B2','75-84.9','Very Good'], ['B3','70-74.9','Good'],
      ['C4','65-69.9','Credit'], ['C5','60-64.9','Credit'], ['C6','50-59.9','Credit'],
      ['D7','45-49.9','Pass'], ['E8','40-44.9','Pass'], ['F9','0-39.9','Fail']
    ];
    return `<table class="grade-scale-table"><thead><tr><th>Grade</th><th>Score Range</th><th>Remark</th></tr></thead><tbody>${scale.map(s=>`<tr><td>${s[0]}</td><td>${s[1]}</td><td>${s[2]}</td>`).join('')}</tbody></table>`;
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
      if (stat) {
        const rank = stat.rankMap?.get(student.id);
        if (rank) {
          const suffix = rank === 1 ? 'st' : rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th';
          positionHtml = `${rank}<sup>${suffix}</sup>`;
        }
        classAvg = stat.classAverage ?? '—';
      }
      tableRows += `<tr><td style="text-align:left">${escapeHtml(subjectName)}</td>
        <td>${score.ca}</td><td>${score.exam}</td><td>${total}</td>
        <td>${grade}</td><td>${remark}</td><td>${positionHtml}</td><td>${classAvg}</td></tr>`;
    }
  } else {
    tableRows = '<tr><td colspan="8">No scores found</td></tr>';
  }

  const average = subjectCount ? (totalScore / subjectCount).toFixed(1) : 0;
  const overallGrade = calculateGrade(parseFloat(average));
  const totalObtainable = subjectCount * 100;
  const percentageAvg = subjectCount ? ((totalScore / totalObtainable) * 100).toFixed(1) : 0;
  const overallRemark = getGradeRemark(overallGrade);

  // Generate skills tables
  let psychomotorHtml = `<table class="skills-table psychomotor-table"><thead><tr><th>Psychomotor Skills</th><th>Rating (1-5)</th></tr></thead><tbody>`;
  for (const skill of psychomotorSkillsList) {
    const key = getSkillKey(skill);
    const val = psychomotor?.[key] ?? 3;
    psychomotorHtml += `<tr><td>${escapeHtml(skill)}</td>
      <td class="rating-container" data-skill-key="${key}"><span class="print-value">${val}</span></td></tr>`;
  }
  psychomotorHtml += `</tbody></table>`;

  let affectiveHtml = `<table class="skills-table affective-table"><thead><tr><th>Affective Domain</th><th>Rating (1-5)</th></tr></thead><tbody>`;
  for (const skill of affectiveSkillsList) {
    const key = getSkillKey(skill);
    const val = psychomotor?.[key] ?? 3;
    affectiveHtml += `<tr><td>${escapeHtml(skill)}</td>
      <td class="rating-container" data-skill-key="${key}"><span class="print-value">${val}</span></td></tr>`;
  }
  affectiveHtml += `</tbody></table>`;

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
  const gradeScaleHtml = `<div class="section-title">📈 Grade Distribution</div>${getGradeScaleHtml()}`;

  // Header
  const headerHtml = `<div class="report-header">
    <div class="school-logo-area">${school.logo ? `<img src="${school.logo}" class="school-logo-small" alt="Logo">` : ''}</div>
    <div class="school-name-area">
      <h1 class="school-name-report">${escapeHtml(school.name)}</h1>
      ${school.address ? `<div class="school-address">${escapeHtml(school.address)}</div>` : ''}
    </div>
    <div class="passport-area">${student.passport ? `<img src="${student.passport}" class="student-passport-img" alt="Passport">` : ''}</div>
  </div>`;

  const age = student.dob ? calculateAge(student.dob) : '—';
  const studentDetailsHtml = `<div class="student-details-grid">
    <div><strong>Name:</strong> <span class="student-name-caps">${escapeHtml(student.name).toUpperCase()}</span></div>
    <div><strong>Admission No:</strong> ${escapeHtml(student.admissionNumber || '—')}</div>
    <div><strong>Gender:</strong> ${escapeHtml(student.gender || '—')}</div>
    <div><strong>DOB:</strong> ${student.dob || '—'} (Age ${age})</div>
    <div><strong>Class:</strong> ${escapeHtml(className)}</div>
    <div><strong>Term:</strong> ${term}${getTermSuffix(term)}</div>
    <div><strong>Session:</strong> ${session}</div>
    <div><strong>Club:</strong> ${escapeHtml(student.club || '—')}</div>
  </div>`;

  // Attendance table
  const attendanceHtml = `
    <div class="attendance-section">
      <div class="section-title">📅 Attendance Record</div>
      <table class="attendance-table">
        <tbody>
          <tr><td class="attendance-label">No of times School opened</td>
            <td class="attendance-input-cell">
              <input type="number" class="attendance-input school-opened" value="${attendance.schoolOpened || 0}" min="0" step="1">
              <span class="print-value attendance-value school-opened-value">${attendance.schoolOpened || 0}</span>
            </td>
          </tr>
          <tr><td class="attendance-label">No of times present</td>
            <td class="attendance-input-cell">
              <input type="number" class="attendance-input present" value="${attendance.present || 0}" min="0" step="1">
              <span class="print-value attendance-value present-value">${attendance.present || 0}</span>
            </td>
          </tr>
          <tr><td class="attendance-label">No of times absent</td>
            <td class="attendance-input-cell">
              <input type="number" class="attendance-input absent" value="${attendance.absent || 0}" min="0" step="1">
              <span class="print-value attendance-value absent-value">${attendance.absent || 0}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  `;

  const subjectTableHtml = `<table class="subject-table"><thead>
    <tr><th>Subject</th><th>CA (${grading.ca})</th><th>Exam (${grading.exam})</th><th>Total (100)</th><th>Grade</th><th>Remark</th><th>Position</th><th>Class Ave.</th></tr>
    </thead><tbody>${tableRows}</tbody></table>`;

  const mainGridHtml = `
    <div class="report-main-grid">
      <div class="subject-table-col">${subjectTableHtml}</div>
      <div class="skills-stack-col">
        <div class="psychomotor-wrapper">${psychomotorHtml}</div>
        <div class="affective-wrapper">${affectiveHtml}</div>
      </div>
    </div>
  `;

  // Comments section
  function getCommentOptionsByGrade(grade) {
    const generalComments = [
      'Keep up the great work!', 'Your effort is commendable.', 'Consistent practice will yield even better results.',
      'You have shown improvement this term.', 'Stay focused and keep pushing forward.', 'Your positive attitude is appreciated.'
    ];
    const gradeSpecific = {
      'A1': ['Excellent performance! Keep setting high standards.'], 'B2': ['Very good performance. Aim for excellence next term.'],
      'B3': ['Good performance. Continue to build on this foundation.'], 'C4': ['Credit level performance. Focus on areas needing improvement.'],
      'C5': ['Credit level. More attention to detail will help.'], 'C6': ['Credit performance. A little more push will yield better grades.'],
      'D7': ['Pass grade. Significant improvement is required.'], 'E8': ['Pass, but serious effort is needed to progress.'],
      'F9': ['Fail grade. Urgent attention and effort are required.']
    };
    const gradeComments = gradeSpecific[grade] || ['Keep working hard.'];
    let allComments = [...generalComments, ...gradeComments];
    const extraComments = ['Your participation is valued.', 'You have shown growth.', 'Excellent punctuality.'];
    while (allComments.length < 30) allComments.push(extraComments[allComments.length % extraComments.length]);
    return [...new Set(allComments)];
  }

  const commentOptions = getCommentOptionsByGrade(overallGrade);
  const commentsHtml = `<div class="comments-section"><h3>Comments</h3>
    <div class="comment-group">
      <label>Teacher's Comment:</label>
      <div class="comment-controls">
        <select id="teacherCommentSelect">${commentOptions.map(opt => `<option value="${opt}" ${comments.teacherComment === opt ? 'selected' : ''}>${opt}</option>`).join('')}</select>
        <textarea id="teacherCommentText" rows="2" style="width:100%">${escapeHtml(comments.teacherComment || '')}</textarea>
      </div>
      <div class="print-comment-text" id="printTeacherComment">${escapeHtml(comments.teacherComment || '')}</div>
    </div>
    <div class="comment-group">
      <label>Principal's Comment:</label>
      <div class="comment-controls">
        <select id="principalCommentSelect">${commentOptions.map(opt => `<option value="${opt}" ${comments.principalComment === opt ? 'selected' : ''}>${opt}</option>`).join('')}</select>
        <textarea id="principalCommentText" rows="2" style="width:100%">${escapeHtml(comments.principalComment || '')}</textarea>
      </div>
      <div class="print-comment-text" id="printPrincipalComment">${escapeHtml(comments.principalComment || '')}</div>
    </div>
  </div>`;

  const signatureHtml = `<div class="signature-stamp">
    <div class="signature-item"><strong>Principal's Signature:</strong><div class="signature-line"></div></div>
    <div class="signature-item"><strong>School Stamp:</strong><div class="stamp-placeholder">(Official Stamp)</div></div>
    <div class="signature-item"><strong>Date:</strong><div class="signature-line"></div></div>
  </div>`;
  const ratingGuideHtml = `<div class="rating-guide">Rating Guide: 1 - Poor | 2 - Fair | 3 - Good | 4 - Very Good | 5 - Excellent</div>`;

  const fullHtml = headerHtml + studentDetailsHtml + attendanceHtml + mainGridHtml +
    `<div class="summary-grading-wrapper"><div class="summary-wrapper">${summaryHtml}</div><div class="grading-wrapper">${gradeScaleHtml}</div></div>` +
    ratingGuideHtml + commentsHtml + signatureHtml;

  container.innerHTML = fullHtml;

  // Sync attendance inputs to print spans
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

  // Rating ticks
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

  return { fullHtml, totalScore, totalObtainable, average, overallGrade };
}