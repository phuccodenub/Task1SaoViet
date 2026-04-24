# Meta / Facebook App review & Messenger webhook (Phase 2.1)

## Permissions we need

| Permission                 | Why                                                                 |
| -------------------------- | ------------------------------------------------------------------- |
| `pages_show_list`          | List pages the admin manages                                        |
| `pages_read_engagement`    | Read comments on posts (engagement metrics)                         |
| `pages_manage_posts`       | Create / delete posts (content workflow publish path)               |
| `pages_messaging`          | Receive & send messages via Messenger webhook                       |
| `pages_read_user_content`  | Read UGC on the Page (comments, feed)                               |
| `business_management`      | Manage the app under a Business Manager account                     |

All of these are "Advanced access" — require **App Review** with recorded
screencast + privacy policy + terms of service.

## Before you apply

1. Business Manager must own the Page and the App.
2. Privacy policy URL + data-deletion endpoint URL must exist and be reachable
   without auth (n8n workflow `90-fb-data-deletion.json` handles the callback
   cleanly — see stub below).
3. Record a **single** screencast per permission showing the end-to-end use:
   - Log into the dashboard → connect Page → show auto-publish creating a post.
   - Show the Messenger inbox receiving a message and the agent replying.
4. Keep the screencast ≤ 3 min each, English voiceover preferred.

## Webhook configuration

- **Callback URL**: `${N8N_WEBHOOK_URL}webhook/meta/messenger`
- **Verify Token**: set to `${FB_VERIFY_TOKEN}` (same in automation/.env and
  Meta App Dashboard → Messenger → Settings → Callback URL).
- **Subscribed fields**: `messages`, `messaging_postbacks`, `message_deliveries`,
  `messaging_referrals`.

The n8n workflow `05-cskh-fb-messenger.json` (below) handles both the GET
verification handshake and POST events on the same path.

## Token lifecycle

- Page access token issued during setup is short-lived (60 days in practice).
- Run `scripts/rotate-fb-token.ps1` (and its `.sh` sibling) weekly from cron to
  exchange for a fresh long-lived token and persist it back into
  `automation/.env`. Docker compose restart of n8n picks it up.

## Fallback if review is delayed

- Keep using the existing `integrations/facebook.ts` lead import in ZaloCRM
  (which currently uses an ad-hoc page token from the account owner).
- Publishing via workflow 02 continues to work with a manually-generated Page
  access token (Graph API Explorer) while under development — Meta allows
  unreviewed tokens for the app's own admins/testers.
