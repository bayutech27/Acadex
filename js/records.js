import { db } from './firebase-config.js';
import { collection, getDocs, query, where } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { getCurrentSchoolId } from './app.js';

let currentSchoolId = null;
let classesMap = new Map(); // id -> name
let archivesList = [];

export async function initRecordsPage() {
  currentSchoolId = await getCurrentSchoolId();
  await loadClasses();
  await loadArchives();
  setupEventListeners();
  
  // Show initial message
  showNoSelectionMessage();
}

async function loadClasses() {
  const classesRef = collection(db, 'classes');
  const q = query(classesRef, where('schoolId', '==', currentSchoolId));
  const snapshot = await getDocs(q);
  classesMap.clear();
  snapshot.forEach(doc => {
    classesMap.set(doc.id, doc.data().name);
  });

  const classSelect = document.getElementById('classSelect');
  classSelect.innerHTML = '<option value="">Select Class</option>';
  for (let [id, name] of classesMap) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = name;
    classSelect.appendChild(option);
  }
}

async function loadArchives() {
  const archivesRef = collection(db, 'archives');
  const q = query(archivesRef, where('schoolId', '==', currentSchoolId));
  const snapshot = await getDocs(q);
  archivesList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  
  populateSessionTermDropdowns();
}

function populateSessionTermDropdowns() {
  const sessions = [...new Set(archivesList.map(a => a.session))].sort().reverse();
  const terms = [...new Set(archivesList.map(a => a.term))].sort();
  const termNames = { 1: 'First Term', 2: 'Second Term', 3: 'Third Term' };

  const sessionSelect = document.getElementById('sessionSelect');
  sessionSelect.innerHTML = '<option value="">Select Session</option>';
  sessions.forEach(session => {
    const option = document.createElement('option');
    option.value = session;
    option.textContent = session;
    sessionSelect.appendChild(option);
  });

  const termSelect = document.getElementById('termSelect');
  termSelect.innerHTML = '<option value="">Select Term</option>';
  terms.forEach(term => {
    const option = document.createElement('option');
    option.value = term;
    option.textContent = termNames[term];
    termSelect.appendChild(option);
  });
}

function setupEventListeners() {
  const classSelect = document.getElementById('classSelect');
  const sessionSelect = document.getElementById('sessionSelect');
  const termSelect = document.getElementById('termSelect');
  
  classSelect.addEventListener('change', () => checkFiltersAndDisplay());
  sessionSelect.addEventListener('change', () => checkFiltersAndDisplay());
  termSelect.addEventListener('change', () => checkFiltersAndDisplay());
}

function checkFiltersAndDisplay() {
  const classId = document.getElementById('classSelect').value;
  const session = document.getElementById('sessionSelect').value;
  const term = document.getElementById('termSelect').value;
  
  // If any filter is empty, show message
  if (!classId || !session || !term) {
    showNoSelectionMessage();
    return;
  }
  
  // All filters selected – filter archives
  const filtered = archivesList.filter(archive => 
    archive.classId === classId &&
    archive.session === session &&
    archive.term === parseInt(term)
  );
  
  displayRecords(filtered);
}

function showNoSelectionMessage() {
  const container = document.getElementById('recordsList');
  container.innerHTML = `
    <div class="no-data">
      <p>Please select <strong>Class, Session, and Term</strong> to view archived records.</p>
    </div>
  `;
}

function displayRecords(archives) {
  const container = document.getElementById('recordsList');
  if (archives.length === 0) {
    container.innerHTML = `
      <div class="no-data">
        <p>No archived records found for the selected Class, Session, and Term.</p>
      </div>
    `;
    return;
  }
  
  container.innerHTML = '';
  for (const archive of archives) {
    const termNames = { 1: 'First Term', 2: 'Second Term', 3: 'Third Term' };
    const className = classesMap.get(archive.classId) || archive.className || 'Unknown Class';
    const dateStr = archive.archivedAt?.toDate().toLocaleDateString() || 'Unknown date';
    
    const recordDiv = document.createElement('div');
    recordDiv.className = 'record-card';
    recordDiv.innerHTML = `
      <div class="record-header">
        <div class="record-title">${escapeHtml(className)} (${archive.session} - ${termNames[archive.term]})</div>
        <div class="record-meta">Archived on ${dateStr}</div>
      </div>
      <table class="students-table">
        <thead>
          <tr><th>Name</th><th>Email</th><th>Subjects</th><th>Action</th></tr>
        </thead>
        <tbody>
          ${archive.students.map(student => `
            <tr>
              <td><a href="#" class="clickable-student" data-student='${JSON.stringify(student)}' data-archive='${JSON.stringify({ classId: archive.classId, className, session: archive.session, term: archive.term })}'>${escapeHtml(student.name)}</a></td>
              <td>${escapeHtml(student.email)}</td>
              <td>${escapeHtml((student.subjects || []).join(', '))}</td>
              <td><button class="view-report-btn" data-student='${JSON.stringify(student)}' data-archive='${JSON.stringify({ classId: archive.classId, className, session: archive.session, term: archive.term })}'>View Report</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    container.appendChild(recordDiv);
  }
  
  // Attach event listeners for report card placeholders
  document.querySelectorAll('.clickable-student, .view-report-btn').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const studentData = JSON.parse(el.getAttribute('data-student'));
      const archiveInfo = JSON.parse(el.getAttribute('data-archive'));
      alert(`Report card for ${studentData.name}\nClass: ${archiveInfo.className}\nSession: ${archiveInfo.session}\nTerm: ${archiveInfo.term}\n\n(Report card page coming soon!)`);
      console.log('Student:', studentData, 'Archive:', archiveInfo);
    });
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>]/g, function(m) {
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    return m;
  });
}