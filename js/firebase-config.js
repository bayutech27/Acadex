
  // Import the functions you need from the SDKs you need
  import { initializeApp } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-app.js";
  import { getAuth } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-auth.js";
  import { getFirestore } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js";

  import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.11.0/firebase-analytics.js";

  // TODO: Add SDKs for Firebase products that you want to use
  // https://firebase.google.com/docs/web/setup#available-libraries

  // Your web app's Firebase configuration
  // For Firebase JS SDK v7.20.0 and later, measurementId is optional
  const firebaseConfig = {
    apiKey: "AIzaSyCwKJ3QVXw8H22M0m0nF1-6-2tICiH3AQI",
    authDomain: "acadex-75d68.firebaseapp.com",
    projectId: "acadex-75d68",
    storageBucket: "acadex-75d68.firebasestorage.app",
    messagingSenderId: "955436032860",
    appId: "1:955436032860:web:e7cece43b33514b3805799",
    measurementId: "G-VJT28GDQ97"
  };

  // Initialize Firebase
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const analytics = getAnalytics(app);

// Export ONLY the initialized services
export { auth, db, analytics };