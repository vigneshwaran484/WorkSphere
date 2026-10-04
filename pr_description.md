## Description

Users often forget upcoming workspace reservations. A scheduled background check now dispatches Web Push notifications to subscribed devices 1 hour before their booking starts.

**Changes**
- **`src/lib/reminderCron.ts`:**
  - Added `processUpcomingPushAlerts` that queries bookings starting between 55 and 65 minutes in the future.
  - Sends a push notification using `sendPushNotification` (Title: "Upcoming Workspace Reservation", Body: "Your desk at {venueName} is ready in 1 hour.", Icon: "/icons/icon-192.png", Data: `{ url: "/reserve/{venueId}" }`).
  - Uses `markSent` with key `booking-push-reminder:${booking.id}` to prevent duplicate push notifications.
- **`src/app/api/cron/reminders/route.ts`:**
  - Invokes `processUpcomingPushAlerts` alongside existing reservation/session reminders.
  - Returns `pushRemindersSent` in the success payload.
- **Service Worker (`public/sw.js`):**
  - Verified existing `notificationclick` logic handles `data.url` for destination booking URL correctly.

**Acceptance criteria:**
- Bookings within the 1-hour window receive push notifications.
- Subscriptions that return 410 Gone are automatically pruned from the database (handled intrinsically by `sendPushNotification`).

## Related Issue

Fixes #3437

## Checklist

- [x] My code follows the style guidelines of this project
- [x] I have performed a self-review of my own code
- [x] I have commented my code, particularly in hard-to-understand areas
- [x] I have made corresponding changes to the documentation
- [x] My changes generate no new warnings
- [x] I have added tests that prove my fix is effective or that my feature works
- [x] New and existing unit tests pass locally with my changes
- [ ] Any dependent changes have been merged and published in downstream modules (N/A)

## Breaking Changes

- [ ] Yes (please describe below)
- [x] No

None.
