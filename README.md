# Call Log — record & transcribe your own calls

A simple, single-user web app: enter a number, tap Call, Twilio rings your
phone, bridges you to the other person, records the whole thing, and
transcribes it automatically. Built for use from your phone's browser
(add it to your home screen so it feels like an app).

## How it works

You add each person as a **contact** (name, phone, email) once. Tap into
their folder and you get three tabs — Call, Text, Email — plus a combined
history of everything that's happened with them, newest first.

- **Call**: tap "Call & record" → Twilio rings your phone → you answer →
  it dials the contact and bridges both legs → records → transcribes →
  shows up in their folder.
- **Text**: send an SMS from the app (via your Twilio number); replies they
  send back are logged automatically too.
- **Email**: send from the app, and — since you use Outlook — the app
  also syncs your real inbox/sent folder so replies and emails you sent
  from Outlook directly show up in the same folder, matched by email address.

## 1. Set up Twilio (~10 minutes)

1. Sign up at [twilio.com](https://www.twilio.com/try-twilio) (free trial gives you credit).
2. Buy a phone number: Console → Phone Numbers → Buy a Number (pick one with **Voice** capability, ideally a NZ number or one that can dial NZ numbers affordably).
3. Grab your **Account SID** and **Auth Token** from the Console dashboard.

## 2. Deploy the app

You need the app reachable at a public URL so Twilio can call back into it
(for the recording/transcription webhooks). Easiest options:

- **Render.com / Railway.app** — free tier, connect this folder as a repo, deploy, you get a public URL automatically.
- **Fly.io** — similar, a bit more setup.
- **Local + ngrok** (for testing) — run the app on your laptop, then run `ngrok http 3000` to get a temporary public URL.

## 3. Set up texting

On your Twilio number's config page (Console → Phone Numbers → your number):
- Under **"A Message Comes In"**, set the webhook to `PUBLIC_BASE_URL/sms-incoming`.

That's it — sending texts uses your existing Twilio credentials, and this
webhook logs replies into the right contact folder automatically.

## 4. Set up email (Microsoft 365 / Outlook)

Full inbox sync needs your app registered with Microsoft so it can read
your mail via Graph API. One-time setup:

1. Go to [portal.azure.com](https://portal.azure.com) → **App registrations** → **New registration**.
2. Name it anything (e.g. "Contact Log"). Leave account type as default.
3. Under **Redirect URI**, add: `PUBLIC_BASE_URL/auth/microsoft/callback` (type: Web).
4. After creating it, copy the **Application (client) ID** → this is `MS_CLIENT_ID`.
5. Go to **Certificates & secrets** → **New client secret** → copy the value → this is `MS_CLIENT_SECRET`.
6. Go to **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions** → add `Mail.Read`, `Mail.Send`, `offline_access`, `User.Read`.
7. Leave `MS_TENANT_ID=common` unless your work account requires a specific tenant.

Once the app is running, visit `PUBLIC_BASE_URL/auth/microsoft` once in
your browser and sign in with your Outlook account — the app stores your
access token locally and refreshes it automatically after that.

## 5. Configure

```
cp .env.example .env
```

Fill in `.env` with:
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` — from the Twilio console
- `TWILIO_PHONE_NUMBER` — the number you bought
- `MY_PHONE_NUMBER` — your actual mobile number, in `+64...` format
- `PUBLIC_BASE_URL` — the public URL from step 2 (no trailing slash)

## 6. Install & run

```
npm install
npm start
```

Visit the app's URL on your phone, add it to your home screen (Safari:
Share → Add to Home Screen), and you're set.

## Costs

Twilio charges per-minute for calls (roughly NZ$0.02–0.05/min depending on
destination) plus a small recording/transcription fee. There's no other
subscription — you only pay for what you use.

## Legal note (New Zealand)

Recording a call is legal in NZ as long as one participant (you) knows it's
happening — you don't legally need the other person's consent. It's still
good practice to mention it up front, especially for calls that touch on
performance or employment matters.

## Troubleshooting

- **No transcript appears**: tap "Check for transcript" under the call —
  Twilio's transcription webhook can be slow or occasionally doesn't fire;
  the button polls Twilio directly instead.
- **Call doesn't bridge**: double check `MY_PHONE_NUMBER` and
  `TWILIO_PHONE_NUMBER` are in full international format (`+64...`).
- **Twilio can't reach your webhooks**: confirm `PUBLIC_BASE_URL` is
  actually publicly reachable (not `localhost`) — test by opening
  `PUBLIC_BASE_URL` in a browser.
