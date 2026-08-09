import { auth, db } from './firebase-config.js';
import { doc, getDoc, updateDoc } from 'https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js';
import { toast } from './error-handler.js';

export async function enforcePasswordChange(redirectBackUrl) {
  const user = auth.currentUser;
  if (!user) return;
  const snap = await getDoc(doc(db, 'users', user.uid));
  if (snap.exists() && snap.data().mustChangePassword) {
    window.location.href = `change-password.html?redirect=${encodeURIComponent(redirectBackUrl)}`;
    throw new Error('Password change required');
  }
}