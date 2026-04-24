---
name: tiktok_post
version: 1.0.0
description: >
  Publishes a video to a single TikTok Business account via the TikTok Studio
  web UI. Used as a fallback when the Content Posting API is not yet approved.
  Expects the session cookie to be seeded in the persistent browser profile.
inputs:
  - name: body
    type: string
    required: true
    description: Caption text (max 2200 chars, UTF-8, emoji allowed).
  - name: media
    type: array
    required: true
    description: Array of HTTP(S) URLs to the MP4 video(s). Only the first entry is published.
  - name: hashtags
    type: array
    required: false
  - name: draftId
    type: string
    required: true
    description: Used for logging + idempotency guard in Postgres.
outputs:
  - name: external_id
    type: string
    description: TikTok video ID once the UI confirms publish.
  - name: status
    type: string
    enum: [success, pending_review, failed]
  - name: error
    type: string
    nullable: true
requirements:
  tools:
    - browser.navigate
    - browser.upload_file
    - browser.type
    - browser.click
    - browser.wait_for_selector
    - browser.evaluate
    - http.download
    - fs.tmp
limits:
  concurrency: 1
  max_daily_runs: 3
  min_interval_seconds: 900   # 15 min jitter between posts
---

# Skill — `tiktok_post`

## Pre-conditions

1. `openclaw profile tiktok-business` exists with an already-authenticated
   session (manual login once, cookies + localStorage persisted).
2. The profile's TikTok account is **Business** (or Creator with publish
   permission) in the target region.
3. The MP4 at `media[0]` is ≤ 287 MB, ≤ 10 min, AAC audio, H.264/H.265 video.

## Steps

1. `http.download media[0]` → save to `fs.tmp(draftId + '.mp4')`.
2. `browser.navigate("https://www.tiktok.com/tiktokstudio/upload")` using the
   `tiktok-business` profile.
3. Wait for the drop-zone selector `input[type="file"][accept*="video"]` (60 s).
4. `browser.upload_file` with the temp path.
5. Poll every 2 s: either the caption textarea appears OR an error toast
   (selector `.Toast__error`). Timeout after 5 min → return `failed`.
6. `browser.type` into the caption editor. Append hashtags separated by spaces.
7. Click "Post" button (selector `button[data-e2e="post_video_button"]`).
8. Wait for the confirmation redirect to `/@<username>/video/<id>` — capture
   the ID from the URL. Timeout 3 min → return `pending_review`.
9. Delete the temp MP4. Return `{ external_id, status: "success" }`.

## Anti-detection guidance

- Random sleep 400–1200 ms between UI actions.
- Do not run more than 3 skills/day per account.
- Keep the browser window visible during working hours; hidden/headless mode
  triggers TikTok's bot guard more often.

## Observability

- Emit a structured log line per step (n8n receives via HTTP response).
- On `failed`, include the last visible toast message + a screenshot saved
  to `${OPENCLAW_LOG_DIR}/tiktok_post/${draftId}.png`.

## Failure modes & rollback

| Symptom                                  | Action                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| Selector missing / UI changed            | Return `failed` with `error=ui_changed`; page ops; re-record selectors |
| Captcha appears                          | Return `failed` with `error=captcha`; staff logs back in manually      |
| Upload progress stuck > 5 min            | Abort; return `failed` with `error=upload_timeout`                     |
| Video flagged by moderation (red toast)  | Return `failed` with `error=moderation`; route to editorial review     |
