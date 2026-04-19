// reportCardRenderer.js - Shared report card rendering engine
// Provides 100% identical HTML structure and styling logic for both admin and teacher pages

export function renderReportCardUI({
  student,           // { id, name, admissionNumber, gender, dob, club, passport }
  scores,            // array of { subjectId, ca, exam }
  className,         // string
  school,            // { name, address, logo }
  grading,           // { ca, exam }
  psychomotor,       // object mapping skill keys to ratings (1-5)
  comments,          // { teacherComment, principalComment }
  term,              // '1', '2', '3'
  session,           // e.g., '2025/2026'
  subjectStats,      // Map: subjectId -> { rankMap, classAverage }
  container,         // DOM element to inject the HTML into
  onRatingChange,    // optional callback (skillKey, newValue)
  onTeacherCommentChange, // optional callback (newComment)
  onPrincipalCommentChange // optional callback (newComment)
}) {
  // Helper functions (should be pure and self-contained)
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
      ['A1','85-100','Excellent'],
      ['B2','75-84.9','Very Good'],
      ['B3','70-74.9','Good'],
      ['C4','65-69.9','Credit'],
      ['C5','60-64.9','Credit'],
      ['C6','50-59.9','Credit'],
      ['D7','45-49.9','Pass'],
      ['E8','40-44.9','Pass'],
      ['F9','0-39.9','Fail']
    ];
    return `<table class="grade-scale-table"><thead><tr><th>Grade</th><th>Score Range</th><th>Remark</th></tr></thead><tbody>${scale.map(s=>`<tr><td>${s[0]}</td><td>${s[1]}</td><td>${s[2]}</td></tr>`).join('')}</tbody></table>`;
  }

  // Psychomotor & Affective skills lists (shared)
  const psychomotorSkillsList = ['Handling of tools', 'Public Speaking', 'Speech Fluency', 'Handwriting', 'Sport and Game', 'Drawing/Painting'];
  const affectiveSkillsList = ['Attentiveness', 'Neatness', 'Honesty', 'Politeness', 'Punctuality', 'Self-control/Calmness', 'Obedience', 'Reliability', 'Relationship with others', 'Leadership'];

  function getSkillKey(skill) {
    return skill.toLowerCase().replace(/[^a-z]/g, '');
  }

  // Build subject table rows
  let tableRows = '';
  let totalScore = 0;
  let subjectCount = 0;

  for (const score of scores) {
    const subjectName = score.subjectName || score.subjectId; // subjectName must be resolved before calling
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
    tableRows += `<tr><td style="text-align:left">${escapeHtml(subjectName)}</td><td>${score.ca}</td><td>${score.exam}</td><td>${total}</td><td>${grade}</td><td>${remark}</td><td>${positionHtml}</td><td>${classAvg}</td></tr>`;
  }

  const average = subjectCount ? (totalScore / subjectCount).toFixed(1) : 0;
  const overallGrade = calculateGrade(parseFloat(average));
  const totalObtainable = subjectCount * 100;
  const percentageAvg = subjectCount ? ((totalScore / totalObtainable) * 100).toFixed(1) : 0;
  const overallRemark = getGradeRemark(overallGrade);

  // Generate skills tables
  let psychomotorHtml = `<table class="skills-table"><thead><tr><th>Psychomotor Skills</th><th>Rating (1-5)</th></tr></thead><tbody>`;
  for (const skill of psychomotorSkillsList) {
    const key = getSkillKey(skill);
    const val = psychomotor?.[key] ?? 3;
    psychomotorHtml += `<tr><td>${escapeHtml(skill)}</td><td class="rating-container" data-skill-key="${key}"><span class="print-value">${val}</span></td></tr>`;
  }
  psychomotorHtml += `</tbody></table>`;

  let affectiveHtml = `<table class="skills-table"><thead><tr><th>Affective Domain</th><th>Rating (1-5)</th></tr></thead><tbody>`;
  for (const skill of affectiveSkillsList) {
    const key = getSkillKey(skill);
    const val = psychomotor?.[key] ?? 3;
    affectiveHtml += `<tr><td>${escapeHtml(skill)}</td><td class="rating-container" data-skill-key="${key}"><span class="print-value">${val}</span></td></tr>`;
  }
  affectiveHtml += `</tbody></table>`;

  // Summary table
  const summaryHtml = `<div class="section-title">📊 Summary of Performance</div><table class="summary-table"><tr><th>Total Obtained</th><td>${totalScore}</td></tr><tr><th>Total Obtainable</th><td>${totalObtainable}</td></tr><tr><th>Total Subjects</th><td>${subjectCount}</td></tr><tr><th>% Average</th><td>${percentageAvg}%</td></tr><tr><th>Grade</th><td>${overallGrade}</td></tr><tr><th>Remark</th><td>${overallRemark}</td></tr></table>`;
  const gradeScaleHtml = `<div class="section-title">📈 Grade Distribution</div>${getGradeScaleHtml()}`;

  // Header with logo, school name, address, passport
  const headerHtml = `<div class="report-header">
    <div class="school-logo-area">${school.logo ? `<img src="${school.logo}" class="school-logo-small" alt="Logo">` : ''}</div>
    <div class="school-name-area">
      <h1 class="school-name-report">${escapeHtml(school.name)}</h1>
      ${school.address ? `<div class="school-address">${escapeHtml(school.address)}</div>` : ''}
    </div>
    <div class="passport-area">${student.passport ? `<img src="${student.passport}" class="student-passport-img" alt="Passport">` : ''}</div>
  </div>`;

  // Student details grid
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

  const tableHtml = `<table class="subject-table"><thead><tr><th>Subject</th><th>CA (${grading.ca})</th><th>Exam (${grading.exam})</th><th>Total (100)</th><th>Grade</th><th>Remark</th><th>Position</th><th>Class Ave.</th></tr></thead><tbody>${tableRows || '<tr><td colspan="8">No scores found</td></tr>'}</tbody></table>`;

  // Comments section
  const commentOptions = getCommentOptionsByGrade(overallGrade);
  function getCommentOptionsByGrade(grade) {
    const generalComments = [
      'Keep up the great work!', 'Your effort is commendable.', 'Consistent practice will yield even better results.',
      'You have shown improvement this term.', 'Stay focused and keep pushing forward.', 'Your positive attitude is appreciated.',
      'Continue to participate actively in class.', 'You are capable of achieving even more.', 'Great teamwork and collaboration skills.',
      'Your curiosity and willingness to learn are assets.'
    ];
    const gradeSpecific = {
      'A1': ['Excellent performance! Keep setting high standards.', 'Outstanding achievement across all subjects.', 'Your dedication is truly exceptional.', 'You are a role model for your peers.', 'Maintain this brilliant performance.', 'Your hard work has paid off remarkably.'],
      'B2': ['Very good performance. Aim for excellence next term.', 'You are doing well; a little more effort can push you to the top.', 'Consistent good work – keep it up!', 'You have strong understanding of the subjects.', 'Well done! Strive for even greater heights.'],
      'B3': ['Good performance. Continue to build on this foundation.', 'You have the potential to move up to a higher grade.', 'Keep working hard; you are on the right track.', 'Good understanding, but aim for deeper mastery.', 'Solid performance. Stay motivated.'],
      'C4': ['Credit level performance. Focus on areas needing improvement.', 'You are capable of better results with more revision.', 'Good effort, but consistency is key to moving up.', 'Identify weak topics and work on them diligently.', 'Keep practicing; you are making steady progress.'],
      'C5': ['Credit level. More attention to detail will help.', 'You have the ability; apply yourself more consistently.', 'Work on completing assignments on time.', 'Seek help when you find topics challenging.', 'Your effort is noted; increase revision time.'],
      'C6': ['Credit performance. A little more push will yield better grades.', 'You are capable of higher scores with extra practice.', 'Avoid distractions and stay focused on your studies.', 'Consistent hard work is needed to improve.', 'You can do better; believe in yourself.'],
      'D7': ['Pass grade. Significant improvement is required.', 'You need to dedicate more time to your studies.', 'Attend extra lessons if possible to catch up.', 'Do not be discouraged; work harder next term.', 'Focus on building your foundational knowledge.'],
      'E8': ['Pass, but serious effort is needed to progress.', 'You must prioritize your academic work.', 'Seek assistance from teachers and peers.', 'There is room for major improvement.', 'Commit to a regular study schedule.'],
      'F9': ['Fail grade. Urgent attention and effort are required.', 'This is a wake-up call to change your approach.', 'You need to attend remedial classes.', 'Do not give up; you can turn this around with hard work.', 'Please meet with your teacher for a study plan.']
    };
    const gradeComments = gradeSpecific[grade] || ['Keep working hard.', 'Your effort matters.', 'Stay positive and persistent.'];
    let allComments = [...generalComments, ...gradeComments];
    const extraComments = [
      'Your participation in class discussions is valued.', 'You have shown growth in problem-solving skills.', 'Excellent punctuality and attendance.',
      'You are a pleasure to have in class.', 'Continue to ask questions when in doubt.', 'Your homework assignments are improving.',
      'You have a bright future ahead.', 'Remember that learning is a journey.', 'Celebrate your small victories.', 'Stay curious and never stop learning.'
    ];
    while (allComments.length < 30) allComments.push(extraComments[allComments.length % extraComments.length]);
    return [...new Set(allComments)];
  }

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

  const fullHtml = headerHtml + studentDetailsHtml + tableHtml +
    `<div class="summary-grading-wrapper"><div class="summary-wrapper">${summaryHtml}</div><div class="grading-wrapper">${gradeScaleHtml}</div></div>` +
    `<div class="skills-wrapper"><div class="skills-half">${psychomotorHtml}</div><div class="skills-half">${affectiveHtml}</div></div>` +
    ratingGuideHtml + commentsHtml + signatureHtml;

  if (container) container.innerHTML = fullHtml;

  // Attach interactive components (rating ticks, comment sync)
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

  // Inject rating widgets
  document.querySelectorAll('.rating-container').forEach(containerEl => {
    const skillKey = containerEl.dataset.skillKey;
    if (skillKey) {
      const currentVal = psychomotor?.[skillKey] ?? 3;
      const widget = createTickRating(skillKey, currentVal);
      containerEl.appendChild(widget);
    }
  });

  // Setup comment sync
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

  // Return the generated HTML and the DOM elements for external use if needed
  return { fullHtml, totalScore, totalObtainable, average, overallGrade };
}