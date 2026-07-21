/* Service worker for VRChat feedback search push notifications. */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "VRChat feedback", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "VRChat feedback";
  const url = data.url || "https://feedback.vrchat.com";
  const type = data.type || "post";
  const options = {
    body: data.body || "",
    // Include the event type so e.g. a status change and a vote change on the
    // same post don't collapse into a single notification.
    tag: url + "#" + type + "#" + (data.created || ""),
    data: { url },
    icon: "/favicon.ico",
    badge: "/favicon.ico",
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url === targetUrl && "focus" in client) {
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
        return undefined;
      }),
  );
});
