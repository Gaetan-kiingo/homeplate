# ADR-011: Notification channel — email is the v1.0 delivery channel; push ships behind a disabled flag

- **Status:** Accepted
- **Date:** 2026-08-12
- **Deciders:** Gaetan Rieben (decided 2026-08-12; pending team ratification at the next stand-up)
- **Related requirements:** FR-13 (booking notifications), FR-07 (safety alerts), FR-14 (cancellation), NFR-09 (degradation), SRS §2.1.4

## Context
FR-13 requires that a booking creation, cancellation or status change enqueue "the configured notification" to affected users, without naming a channel. SRS §2.1.3/§2.1.4 name both Firebase Cloud Messaging for push and SendGrid for email as available outbound services. Web push through FCM needs a service worker, a VAPID key pair, and a browser permission prompt the team has not set up, and the SPMP's ≈8-week window (§5.1.1) has no slack for a delivery mechanism that no requirement names specifically. FR-07 already fixes email as the v1.0 channel for emergency-contact safety alerts, so an email path must exist regardless.

## Decision
**Email via SendGrid is the configured delivery channel for v1.0** — booking confirmations, cancellations and status changes (FR-13, FR-14) as well as safety-alert delivery (FR-07). The FCM push adapter is still implemented, behind a configuration flag (`notifications.push.enabled`) that **defaults to false**, so "configured notification" means a configuration value rather than a hardcoded choice, and enabling push later is a config change plus a key.

In development and in the entire automated test suite, both adapters resolve to a **mock transport that records delivery attempts** rather than sending. Every attempt, mock or live, writes a NOTIFICATION_ATTEMPT row (recipient, channel, status) per SRS §3.4, so the tests assert on persisted attempts rather than on a third party's behaviour. Both adapters remain worker-only per ADR-001 and ADR-003: a request handler never calls them, and a provider failure never rolls back or delays the booking transaction (FR-13).

## Alternatives considered
- **Implementing web push now** — rejected: VAPID keys, a service worker, and a permission flow are real work against a requirement that names no channel, and the SPMP window is the binding constraint. The adapter is written; only the flag is off.
- **In-app notifications only** — rejected: FR-13 requires notifying affected users, and a guest whose booking is cancelled while they are not on the site would never receive it.
- **Both channels live from the start** — rejected for v1.0: it doubles the delivery surface RT-02 must prove idempotent for no requirement-level gain, and duplicate delivery across two channels after a worker crash is exactly the defect ADR-003 flags as likely.

## Consequences
- **Positive:** FR-13 is satisfied with one delivery path to make reliable, and it is the same path FR-07 already requires — one adapter, one retry/backoff/dead-letter discipline, one set of RT-02 assertions.
- **Positive:** the mock transport makes the notification tests deterministic and free, and keeps CI from depending on a third party.
- **Negative:** the FCM adapter ships without ever running against the live service, so "push works" is not a claim this project can make. IT-01 exercises it against a mock and injected failures only; enabling the flag in future requires real integration testing first.
- **Negative:** SendGrid's free tier has a low daily send cap, so LT-01 and LT-02 must run against the mock transport rather than live sends, and a demo that sends real email should be rehearsed within the cap.
- **Negative:** email is slower and easier to miss than push, which is a product limitation the demo should acknowledge rather than hide.
- **Neutral / follow-ups:** turning push on is a configuration change plus a VAPID key, but a v2.0 decision should record the multi-channel delivery and de-duplication rules before both channels run at once.

## AI assistance & provenance
The unspecified FR-13 channel was surfaced by the AI-assisted build-planning run on 2026-08-11 (`docs/_generated/build-plan.md`, open question 4), which proposed email-first with push behind a flag. The team confirmed that reading on 2026-08-12, on the grounds that the demo is built against a mock and email is the simpler path. This record was drafted by Claude Code from that decision and is subject to team review.
