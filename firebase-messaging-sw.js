importScripts("https://www.gstatic.com/firebasejs/12.0.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.0.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyCbw3uRsDJroD8Z96aXXpduyIufZrwRhM0",
  authDomain: "iot-smart-irrigtion-system.firebaseapp.com",
  databaseURL: "https://iot-smart-irrigtion-system-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "iot-smart-irrigtion-system",
  storageBucket: "iot-smart-irrigtion-system.firebasestorage.app",
  messagingSenderId: "502244731514",
  appId: "1:502244731514:web:a59f541885fbdeee2629c3",
  measurementId: "G-338YFR1VFV"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log("Mesej diterima di latar belakang: ", payload);
  const notificationTitle = payload.notification?.title || "Smart Herbs";
  const notificationOptions = {
    body: payload.notification?.body || "Ada kemas kini baharu daripada sistem pengairan.",
    icon: "icon.png"
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});
