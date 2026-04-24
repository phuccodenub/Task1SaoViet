# TikTok publishing (Phase 2.2)

TikTok's official video publish endpoint (`/v2/post/publish/video/init/`) is
gated behind the **Content Posting API** product in their Developer Portal.
Approval takes 2–6 weeks and requires a Business account + verified domain.

## Preferred path: Content Posting API

1. **Apply** at <https://developers.tiktok.com> → Manage Apps → Add Product →
   "Content Posting API" → submit use-case doc. The doc must describe:
   - Business purpose ("schedule marketing videos for our brand page").
   - Who reviews content before publish (editorial team + `content_qa` guardrail).
   - Data retention & deletion flow.
2. **Scopes needed**: `video.upload`, `video.publish`, `user.info.basic`.
3. **Webhook events** (optional, useful for status tracking):
   `video.publish`, `video.publish.failed`.
4. **Publish flow** (after approval):
   ```
   POST /v2/post/publish/video/init/      # returns upload URL
   PUT  <upload_url>                      # multipart upload
   POST /v2/post/publish/status/fetch/    # poll until 'PUBLISH_COMPLETE'
   ```
5. Wire this into n8n workflow 02 under the `tiktok` branch in
   `Route by platform` (currently routed to OpenClaw fallback).

## Fallback: OpenClaw `tiktok_post` skill

Use when Content Posting API is unavailable. Drives the TikTok web studio in a
real browser session owned by the marketing team.

- Not scalable (1 video at a time, session-bound).
- Breaks when TikTok UI changes — re-record the skill each month.
- Only runs during business hours with a watchdog staff.

The n8n `tiktok` branch already calls `POST {{OPENCLAW_BASE_URL}}/skills/tiktok_post/execute`
with the draft payload. When Content Posting API is approved, just swap the
HTTP node body.

## Risk summary

| Risk                                              | Mitigation                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------- |
| App review rejection                              | Start both paths in parallel; OpenClaw handles interim publishing |
| Browser skill breaks when TikTok ships UI change  | Weekly smoke test + staff-in-the-loop alert                       |
| Video watermark / sound licensing                 | `content_qa` skill flags copyrighted audio before publish         |
| Account ban for bot-like behaviour                | Throttle to ≤3 posts/day via OpenClaw; add 15-min jitter          |
