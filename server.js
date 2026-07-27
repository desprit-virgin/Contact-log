// Call + Record + Transcribe app — single user
// Built on Twilio Voice + Twilio's built-in transcription (no extra API keys needed)

const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const fs = require('fs');
const path = require('path');

require('dotenv').config();

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER, // the Twilio number that will do the calling
  MY_PHONE_NUMBER,     // your real mobile number — Twilio calls you first, then bridges
  PUBLIC_BASE_URL,     // e.g. https://your-app.ngrok.io or your deployed URL
  PORT = 3000,
} = process.env;

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const VoiceResponse = twilio.twiml.VoiceResponse;
const MessagingResponse = twilio.twiml.MessagingResponse;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Flat-file "database" — fine for single-user use ----
const DB_PATH = path.join(__dirname, 'calls.json');
const CONTACTS_PATH = path.join(__dirname, 'contacts.json');
const MESSAGES_PATH = path.join(__dirname, 'messages.json');
const EMAILS_PATH = path.join(__dirname, 'emails.json');

function loadJSON(p) {
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function saveJSON(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}
const loadCalls = () => loadJSON(DB_PATH);
const saveCalls = (d) => saveJSON(DB_PATH, d);
const loadContacts = () => loadJSON(CONTACTS_PATH);
const saveContacts = (d) => saveJSON(CONTACTS_PATH, d);
const loadMessages = () => loadJSON(MESSAGES_PATH);
const saveMessages = (d) => saveJSON(MESSAGES_PATH, d);
const loadEmails = () => loadJSON(EMAILS_PATH);
const saveEmails = (d) => saveJSON(EMAILS_PATH, d);

// Match a phone/email to a saved contact, normalizing loosely
function findContactByPhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '').slice(-9); // last 9 digits, NZ-safe
  return loadContacts().find((c) => c.phone && c.phone.replace(/\D/g, '').slice(-9) === digits) || null;
}
function findContactByEmail(email) {
  if (!email) return null;
  const norm = email.toLowerCase().trim();
  return loadContacts().find((c) => c.email && c.email.toLowerCase().trim() === norm) || null;
}

// ---- Contacts CRUD ----
app.get('/api/contacts', (req, res) => res.json(loadContacts()));

app.post('/api/contacts', (req, res) => {
  const { name, phone, email } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const contacts = loadContacts();
  const contact = { id: 'c_' + Date.now(), name, phone: phone || '', email: email || '' };
  contacts.unshift(contact);
  saveContacts(contacts);
  res.json(contact);
});

app.delete('/api/contacts/:id', (req, res) => {
  const contacts = loadContacts().filter((c) => c.id !== req.params.id);
  saveContacts(contacts);
  res.json({ ok: true });
});

// ---- Bulk import contacts (e.g. from a franchise list) ----
// Body: { contacts: [{ name, phone, email, location }] }
// Skips any row that matches an existing contact by phone or email.
app.post('/api/contacts/import', (req, res) => {
  const incoming = req.body.contacts || [];
  const contacts = loadContacts();
  let added = 0, skipped = 0;

  for (const row of incoming) {
    if (!row.name) { skipped++; continue; }
    const dupe = contacts.find(
      (c) => (row.phone && c.phone && c.phone.replace(/\D/g, '') === row.phone.replace(/\D/g, '')) ||
             (row.email && c.email && c.email.toLowerCase() === row.email.toLowerCase())
    );
    if (dupe) { skipped++; continue; }

    contacts.push({
      id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      name: row.name,
      phone: row.phone || '',
      email: row.email || '',
      location: row.location || '',
    });
    added++;
  }

  saveContacts(contacts);
  res.json({ ok: true, added, skipped });
});

// ---- Unified folder view: everything for one contact ----
app.get('/api/contacts/:id/folder', (req, res) => {
  const contact = loadContacts().find((c) => c.id === req.params.id);
  if (!contact) return res.status(404).json({ error: 'not found' });

  const calls = loadCalls().filter((c) => c.contactId === contact.id);
  const messages = loadMessages().filter((m) => m.contactId === contact.id);
  const emails = loadEmails().filter((e) => e.contactId === contact.id);

  const timeline = [
    ...calls.map((c) => ({ type: 'call', at: c.startedAt, ...c })),
    ...messages.map((m) => ({ type: 'sms', at: m.at, ...m })),
    ...emails.map((e) => ({ type: 'email', at: e.at, ...e })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));

  res.json({ contact, timeline });
});

// ---- 1. Kick off a call ----
// Twilio calls YOUR phone first. When you pick up, it dials the target number
// and bridges the two legs together — recording starts automatically.
// Normalize a loosely-formatted NZ number (e.g. "027 333 3351") into
// international format Twilio requires (e.g. "+64273333351").
function toE164NZ(raw) {
  if (!raw) return raw;
  let digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits; // already international
  if (digits.startsWith('0')) digits = digits.slice(1); // drop leading 0
  if (digits.startsWith('64')) return '+' + digits;
  return '+64' + digits;
}

app.post('/api/call', async (req, res) => {
  const { to: rawTo, label } = req.body;
  if (!rawTo) return res.status(400).json({ error: 'Missing "to" number' });
  const to = toE164NZ(rawTo);

  try {
    const call = await client.calls.create({
      to: MY_PHONE_NUMBER,
      from: TWILIO_PHONE_NUMBER,
      url: `${PUBLIC_BASE_URL}/twiml/bridge?target=${encodeURIComponent(to)}`,
      record: false, // we record at the <Dial> level instead, see /twiml/bridge
      statusCallback: `${PUBLIC_BASE_URL}/status`,
      statusCallbackEvent: ['completed'],
    });

    const contact = findContactByPhone(to);
    const calls = loadCalls();
    calls.unshift({
      sid: call.sid,
      to,
      contactId: contact ? contact.id : null,
      label: label || '',
      startedAt: new Date().toISOString(),
      status: 'calling',
      recordingUrl: null,
      transcript: null,
    });
    saveCalls(calls);

    res.json({ ok: true, sid: call.sid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- 2. TwiML: once you answer, dial the target and record the bridged call ----
app.post('/twiml/bridge', (req, res) => {
  const target = req.query.target;
  const twiml = new VoiceResponse();

  const dial = twiml.dial({
    record: 'record-from-answer-dual',
    recordingStatusCallback: `${PUBLIC_BASE_URL}/recording-status`,
    recordingStatusCallbackEvent: ['completed'],
  });
  dial.number(target);

  res.type('text/xml').send(twiml.toString());
});

// ---- 3. Recording finished -> kick off transcription ----
app.post('/recording-status', async (req, res) => {
  const { RecordingSid, RecordingUrl, CallSid } = req.body;
  res.sendStatus(200);

  try {
    // Twilio's built-in transcription (async)
    const transcription = await client.recordings(RecordingSid).transcriptions.create();
    console.log('Transcription requested:', transcription.sid);

    const calls = loadCalls();
    const idx = calls.findIndex((c) => c.sid === CallSid);
    if (idx !== -1) {
      calls[idx].recordingUrl = `${RecordingUrl}.mp3`;
      calls[idx].status = 'transcribing';
      saveCalls(calls);
    }
  } catch (err) {
    console.error('Transcription request failed:', err.message);
  }
});

// ---- 4. Transcription complete webhook ----
app.post('/transcription-status', (req, res) => {
  res.sendStatus(200);
  const { TranscriptionText, CallSid, TranscriptionStatus } = req.body;

  const calls = loadCalls();
  // Twilio doesn't always pass CallSid here reliably across all setups,
  // so also match on most recent "transcribing" entry as a fallback.
  let idx = calls.findIndex((c) => c.sid === CallSid);
  if (idx === -1) idx = calls.findIndex((c) => c.status === 'transcribing');

  if (idx !== -1) {
    calls[idx].transcript = TranscriptionText || '(transcription failed)';
    calls[idx].status = TranscriptionStatus === 'completed' ? 'done' : 'transcription-failed';
    saveCalls(calls);
  }
});

// ---- 5. Call status updates (e.g. completed/no-answer) ----
app.post('/status', (req, res) => {
  res.sendStatus(200);
  const { CallSid, CallStatus } = req.body;
  const calls = loadCalls();
  const idx = calls.findIndex((c) => c.sid === CallSid);
  if (idx !== -1 && calls[idx].status === 'calling') {
    calls[idx].status = CallStatus;
    saveCalls(calls);
  }
});

// ---- 6. List calls for the frontend ----
app.get('/api/calls', (req, res) => {
  res.json(loadCalls());
});

// ---- 7. Manual refresh: poll Twilio for a transcript if the webhook didn't fire ----
// Twilio's transcription webhook setup is fiddly for a small app, so this endpoint
// lets the frontend check directly — the most reliable path for single-user use.
app.post('/api/calls/:sid/refresh', async (req, res) => {
  const calls = loadCalls();
  const idx = calls.findIndex((c) => c.sid === req.params.sid);
  if (idx === -1) return res.status(404).json({ error: 'not found' });

  try {
    const recordings = await client.recordings.list({ callSid: req.params.sid, limit: 1 });
    if (!recordings.length) return res.json(calls[idx]);

    const transcriptions = await client.recordings(recordings[0].sid).transcriptions.list();
    if (transcriptions.length && transcriptions[0].status === 'completed') {
      const full = await client.transcriptions(transcriptions[0].sid).fetch();
      calls[idx].transcript = full.transcriptionText;
      calls[idx].status = 'done';
      saveCalls(calls);
    }
  } catch (err) {
    console.error('Refresh failed:', err.message);
  }

  res.json(calls[idx]);
});

// ==================== TEXT MESSAGES (Twilio SMS) ====================

// ---- Send a text ----
app.post('/api/sms/send', async (req, res) => {
  const { to: rawTo, body, contactId } = req.body;
  if (!rawTo || !body) return res.status(400).json({ error: 'Missing "to" or "body"' });
  const to = toE164NZ(rawTo);

  try {
    const msg = await client.messages.create({ to, from: TWILIO_PHONE_NUMBER, body });
    const contact = contactId ? loadContacts().find((c) => c.id === contactId) : findContactByPhone(to);

    const messages = loadMessages();
    messages.unshift({
      sid: msg.sid,
      direction: 'outbound',
      to,
      from: TWILIO_PHONE_NUMBER,
      body,
      contactId: contact ? contact.id : null,
      at: new Date().toISOString(),
    });
    saveMessages(messages);
    res.json({ ok: true, sid: msg.sid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Receive a text (Twilio webhook — set this URL on your Twilio number's "A Message Comes In") ----
app.post('/sms-incoming', (req, res) => {
  const { From, Body, MessageSid } = req.body;
  const contact = findContactByPhone(From);

  const messages = loadMessages();
  messages.unshift({
    sid: MessageSid,
    direction: 'inbound',
    to: TWILIO_PHONE_NUMBER,
    from: From,
    body: Body,
    contactId: contact ? contact.id : null,
    at: new Date().toISOString(),
  });
  saveMessages(messages);

  const twiml = new MessagingResponse();
  res.type('text/xml').send(twiml.toString()); // empty response = no auto-reply
});

app.get('/api/sms', (req, res) => res.json(loadMessages()));

// ==================== EMAIL (Microsoft Graph / Outlook) ====================
// Full-inbox sync requires you to sign in once via Microsoft so the app can read
// your mail with Graph API. See README "Email setup" for the Azure app registration
// steps — MS_CLIENT_ID / MS_CLIENT_SECRET / MS_TENANT_ID come from that.

const msal = require('@azure/msal-node');
const { Client } = require('@microsoft/microsoft-graph-client');

const MS_SCOPES = ['Mail.Read', 'Mail.Send', 'offline_access', 'User.Read'];
const TOKEN_PATH = path.join(__dirname, 'ms-token.json');

// Built lazily — only when an email route is actually hit — so the app can run
// fine with just Twilio configured, before Outlook is set up.
let msalClient = null;
function getMsalClient() {
  if (!process.env.MS_CLIENT_ID || !process.env.MS_CLIENT_SECRET) {
    throw new Error('Microsoft 365 is not configured yet — add MS_CLIENT_ID and MS_CLIENT_SECRET to enable email.');
  }
  if (!msalClient) {
    msalClient = new msal.ConfidentialClientApplication({
      auth: {
        clientId: process.env.MS_CLIENT_ID,
        authority: `https://login.microsoftonline.com/${process.env.MS_TENANT_ID || 'common'}`,
        clientSecret: process.env.MS_CLIENT_SECRET,
      },
    });
  }
  return msalClient;
}

app.get('/auth/microsoft', async (req, res) => {
  try {
    const url = await getMsalClient().getAuthCodeUrl({
      scopes: MS_SCOPES,
      redirectUri: `${PUBLIC_BASE_URL}/auth/microsoft/callback`,
    });
    res.redirect(url);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

app.get('/auth/microsoft/callback', async (req, res) => {
  try {
    const tokenResponse = await getMsalClient().acquireTokenByCode({
      code: req.query.code,
      scopes: MS_SCOPES,
      redirectUri: `${PUBLIC_BASE_URL}/auth/microsoft/callback`,
    });
    saveJSON(TOKEN_PATH, tokenResponse);
    res.send('Microsoft 365 connected — you can close this tab and go back to the app.');
  } catch (err) {
    res.status(500).send('Auth failed: ' + err.message);
  }
});

async function getGraphClient() {
  const cached = loadJSON(TOKEN_PATH);
  if (!cached || !cached.account) throw new Error('Not connected to Microsoft 365 — visit /auth/microsoft first');

  const result = await getMsalClient().acquireTokenSilent({
    account: cached.account,
    scopes: MS_SCOPES,
  });
  return Client.init({
    authProvider: (done) => done(null, result.accessToken),
  });
}

// ---- Send an email, logged to the contact's folder ----
app.post('/api/email/send', async (req, res) => {
  const { to, subject, body, contactId } = req.body;
  try {
    const graph = await getGraphClient();
    await graph.api('/me/sendMail').post({
      message: {
        subject,
        body: { contentType: 'Text', content: body },
        toRecipients: [{ emailAddress: { address: to } }],
      },
    });

    const contact = contactId ? loadContacts().find((c) => c.id === contactId) : findContactByEmail(to);
    const emails = loadEmails();
    emails.unshift({
      direction: 'outbound',
      to,
      subject,
      body,
      contactId: contact ? contact.id : null,
      at: new Date().toISOString(),
    });
    saveEmails(emails);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Sync: pull recent inbox + sent mail, match to contacts by email address ----
// Call this periodically (e.g. a cron hitting this endpoint every few minutes) to
// keep contact folders up to date with real replies from your inbox.
app.post('/api/email/sync', async (req, res) => {
  try {
    const graph = await getGraphClient();
    const contacts = loadContacts();
    const existing = loadEmails();
    const existingIds = new Set(existing.map((e) => e.graphId));

    const [inbox, sent] = await Promise.all([
      graph.api('/me/mailFolders/inbox/messages').top(25).select('id,subject,bodyPreview,from,receivedDateTime').get(),
      graph.api('/me/mailFolders/sentitems/messages').top(25).select('id,subject,bodyPreview,toRecipients,sentDateTime').get(),
    ]);

    let added = 0;
    for (const m of inbox.value) {
      if (existingIds.has(m.id)) continue;
      const fromAddr = m.from?.emailAddress?.address;
      const contact = findContactByEmail(fromAddr);
      existing.unshift({
        graphId: m.id,
        direction: 'inbound',
        from: fromAddr,
        subject: m.subject,
        body: m.bodyPreview,
        contactId: contact ? contact.id : null,
        at: m.receivedDateTime,
      });
      added++;
    }
    for (const m of sent.value) {
      if (existingIds.has(m.id)) continue;
      const toAddr = m.toRecipients?.[0]?.emailAddress?.address;
      const contact = findContactByEmail(toAddr);
      existing.unshift({
        graphId: m.id,
        direction: 'outbound',
        to: toAddr,
        subject: m.subject,
        body: m.bodyPreview,
        contactId: contact ? contact.id : null,
        at: m.sentDateTime,
      });
      added++;
    }

    saveEmails(existing);
    res.json({ ok: true, added });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/email', (req, res) => res.json(loadEmails()));

app.listen(PORT, () => console.log(`Call app listening on port ${PORT}`));
