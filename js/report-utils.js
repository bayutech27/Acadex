// report-utils.js – Shared grading and helper functions for report cards

export const psychomotorSkillsList = [
  'Handling of tools', 'Public Speaking', 'Speech Fluency', 'Handwriting',
  'Sport and Game', 'Drawing/Painting'
];

export const affectiveSkillsList = [
  'Attentiveness', 'Neatness', 'Honesty', 'Politeness', 'Punctuality',
  'Self-control/Calmness', 'Obedience', 'Reliability', 'Relationship with others', 'Leadership'
];

export function getSkillKey(skill) {
  return skill.toLowerCase().replace(/[^a-z]/g, '');
}

export function calculateGrade(total, isPrimary = false) {
  if (isPrimary) {
    if (total >= 90) return 'A+';
    else if (total >= 80) return 'A';
    else if (total >= 70) return 'B+';
    else if (total >= 60) return 'B';
    else if (total >= 50) return 'C';
    else if (total >= 40) return 'D';
    else return 'F';
  } else {
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
}

export function getGradeRemark(grade) {
  const remarks = {
    'A1': 'Excellent', 'B2': 'Very Good', 'B3': 'Good',
    'C4': 'Credit', 'C5': 'Credit', 'C6': 'Credit',
    'D7': 'Pass', 'E8': 'Pass', 'F9': 'Fail',
    'A+': 'Exceptional', 'A': 'Excellent', 'B+': 'Very Good',
    'B': 'Good', 'C': 'Fairly Good', 'D': 'Pass', 'F': 'Fail'
  };
  return remarks[grade] || '';
}

export function getDefaultRatings() {
  const defaults = {};
  [...psychomotorSkillsList, ...affectiveSkillsList].forEach(skill => {
    defaults[getSkillKey(skill)] = 3;
  });
  return defaults;
}

export function getGradeScaleHtml(isPrimary = false) {
  if (isPrimary) {
    const scale = [
      ['A+', '90-100', 'Exceptional'],
      ['A', '80-89', 'Excellent'],
      ['B+', '70-79', 'Very Good'],
      ['B', '60-69', 'Good'],
      ['C', '50-59', 'Fairly Good'],
      ['D', '40-49', 'Pass'],
      ['F', '0-39', 'Fail']
    ];
    return `<table class="rc-grade-scale"><thead><tr><th>Grade</th><th>Score Range</th><th>Remark</th></tr></thead><tbody>${scale.map(s => `<tr><td>${s[0]}</td><td>${s[1]}</td><td>${s[2]}</td></tr>`).join('')}</tbody></table>`;
  } else {
    const scale = [
      ['A1', '85-100', 'Excellent'],
      ['B2', '75-84.9', 'Very Good'],
      ['B3', '70-74.9', 'Good'],
      ['C4', '65-69.9', 'Credit'],
      ['C5', '60-64.9', 'Credit'],
      ['C6', '50-59.9', 'Credit'],
      ['D7', '45-49.9', 'Pass'],
      ['E8', '40-44.9', 'Pass'],
      ['F9', '0-39.9', 'Fail']
    ];
    return `<table class="rc-grade-scale"><thead><tr><th>Grade</th><th>Score Range</th><th>Remark</th></tr></thead><tbody>${scale.map(s => `<tr><td>${s[0]}</td><td>${s[1]}</td><td>${s[2]}</td></tr>`).join('')}</tbody></table>`;
  }
}

export function getCommentOptionsByGrade(grade) {
  const generalComments = [
    'Keep up the great work!', 'Your effort is commendable.', 'Consistent practice will yield even better results.',
    'You have shown improvement this term.', 'Stay focused and keep pushing forward.', 'Your positive attitude is appreciated.'
  ];
  const gradeSpecific = {
    'A1': ['Excellent performance! Keep setting high standards.'],
    'B2': ['Very good performance. Aim for excellence next term.'],
    'B3': ['Good performance. Continue to build on this foundation.'],
    'C4': ['Credit level performance. Focus on areas needing improvement.'],
    'C5': ['Credit level. More attention to detail will help.'],
    'C6': ['Credit performance. A little more push will yield better grades.'],
    'D7': ['Pass grade. Significant improvement is required.'],
    'E8': ['Pass, but serious effort is needed to progress.'],
    'F9': ['Fail grade. Urgent attention and effort are required.'],
    'A+': ['Outstanding! Keep setting the standard.'],
    'A':  ['Excellent performance!'],
    'B+': ['Very good work, keep it up.'],
    'B':  ['Good effort, continue to push.'],
    'C':  ['Fairly good, more revision needed.'],
    'D':  ['Pass, work harder next term.'],
    'F':  ['Fail, please seek help.']
  };
  const gradeComments = gradeSpecific[grade] || ['Keep working hard.'];

  let allComments = [...generalComments, ...gradeComments];
  const extraComments = [
    'Your participation is valued.', 'You have shown growth.', 'Excellent punctuality.'
  ];
  while (allComments.length < 30) {
    allComments.push(extraComments[allComments.length % extraComments.length]);
  }
  return [...new Set(allComments)];
}

export function getTermSuffix(term) {
  return term === '1' ? 'st' : term === '2' ? 'nd' : 'rd';
}

export function calculateAge(dobString) {
  if (!dobString) return null;
  const birth = new Date(dobString);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

export function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}