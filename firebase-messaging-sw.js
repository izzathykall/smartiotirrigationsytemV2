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
  console.log("Background message received: ", payload);
  const notificationTitle = payload.data?.title || payload.notification?.title || "Smart Irrigation";
  const notificationOptions = {
    body: payload.data?.body || payload.notification?.body || "A new irrigation system alert is available.",
    icon: "icon.png",
    badge: "icon.png",
    tag: payload.data?.type || "smart-irrigation-alert",
    renotify: false,
    data: {
      url: "./"
    }
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url || "./"));
});
