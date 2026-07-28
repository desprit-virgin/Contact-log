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

## 1. Set up storage (Upstash Redis — free)

Render's free hosting doesn't keep saved files between restarts, so contacts,
calls, texts, and emails are stored in a free cloud database instead
(Upstash Redis — a simple key-value store with a generous free tier).

1. Go to [upstash.com](https://upstash.com), sign up (free, no card needed)
2. Tap **Create Database** — name it anything, pick a region close to you
3. On the database page, find **REST API** section — copy the **UPSTASH_REDIS_REST_URL** and **UPSTASH_REDIS_REST_TOKEN** values

You'll paste these into Render's environment variables in step 5.

## 2. Set up transcription (OpenAI Whisper)

Twilio's own call-transcription feature has been discontinued, so recordings
are transcribed using OpenAI's Whisper model instead — a few cents per call.

1. Go to [platform.openai.com](https://platform.openai.com), sign up
2. Add a small amount of billing credit (Settings → Billing) — Whisper costs
   about US$0.006/minute, so even heavy use is a few dollars a month
3. Go to **API keys** → **Create new secret key** → copy it

You'll add this as `OPENAI_API_KEY` in step 6.

## 3. Set up Twilio (~10 minutes)

1. Sign up at [twilio.com](https://www.twilio.com/try-twilio) (free trial gives you credit).
2. Buy a phone number: Console → Phone Numbers → Buy a Number (pick one with **Voice** capability, ideally a NZ number or one that can dial NZ numbers affordably).
3. Grab your **Account SID** and **Auth Token** from the Console dashboard.

## 4. Deploy the app

You need the app reachable at a public URL so Twilio can call back into it
(for the recording/transcription webhooks). Easiest options:

- **Render.com / Railway.app** — free tier, connect this folder as a repo, deploy, you get a public URL automatically.
- **Fly.io** — similar, a bit more setup.
- **Local + ngrok** (for testing) — run the app on your laptop, then run `ngrok http 3000` to get a temporary public URL.

## 5. Set up texting

New Zealand local numbers can't send SMS through Twilio at all — this is a
carrier restriction, not something Twilio or this app can work around. So
texting needs a second Twilio number:

1. Buy a second number — Twilio Console → **Phone Numbers** → **Buy a Number**
   → change country to something like **United States** or **United Kingdom**
   → make sure **SMS** is checked in the capability filters
2. On that new number's config page (Console → Phone Numbers → the SMS-capable number), under **"A Message Comes In"**, set the webhook to `PUBLIC_BASE_URL/sms-incoming`
3. Add this number as `TWILIO_SMS_NUMBER` in your environment variables (step 6) — your original NZ number stays as `TWILIO_PHONE_NUMBER` and keeps handling calls

## 6. Set up email (Microsoft 365 / Outlook)

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

## 7. Configure

```
cp .env.example .env
```

Fill in `.env` with:
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` — from Upstash (step 1)
- `OPENAI_API_KEY` — from OpenAI (step 2)
- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` — from the Twilio console
- `TWILIO_PHONE_NUMBER` — the number you bought
- `MY_PHONE_NUMBER` — your actual mobile number, in `+64...` format
- `PUBLIC_BASE_URL` — the public URL from step 4 (no trailing slash)

## 8. Install & run

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
