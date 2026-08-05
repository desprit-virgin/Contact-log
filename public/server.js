// Call + Record + Transcribe app — single user
// Built on Twilio Voice + Twilio's built-in transcription
// Storage: Upstash Redis (free tier) — plain files don't survive restarts on Render's
// free plan, so all data lives in a small free cloud database instead.

const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const path = require('path');

require('dotenv').config();

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,     // the Twilio number that will do the calling
  TWILIO_SMS_NUMBER,       // a separate SMS-capable number (NZ local numbers can't text) — falls back to TWILIO_PHONE_NUMBER if not set
  MY_PHONE_NUMBER,         // your real mobile number — Twilio calls you first, then bridges
  PUBLIC_BASE_URL,         // e.g. https://your-app.onrender.com
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  PORT = 3000,
} = process.env;

const SMS_FROM_NUMBER = TWILIO_SMS_NUMBER || TWILIO_PHONE_NUMBER;

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const VoiceResponse = twilio.twiml.VoiceResponse;
const MessagingResponse = twilio.twiml.MessagingResponse;

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==================== STORAGE (Upstash Redis) ====================
// Each "table" is stored as one JSON string under a single key.
// Small-scale (hundreds of records) so this is simple and plenty fast.

async function redis(command) {
  if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
    throw new Error('Storage is not configured — add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.');
  }
  const res = await fetch(`${UPSTASH_REDIS_REST_URL}/${command.map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function loadTable(name) {
  const raw = await redis(['GET', name]);
  return raw ? JSON.parse(raw) : [];
}
async function saveTable(name, data) {
  await redis(['SET', name, JSON.stringify(data)]);
}

const loadCalls = () => loadTable('calls');
const saveCalls = (d) => saveTable('calls', d);
const loadContacts = () => loadTable('contacts');
const saveContacts = (d) => saveTable('contacts', d);
const loadMessages = () => loadTable('messages');
const saveMessages = (d) => saveTable('messages', d);
const loadEmails = () => loadTable('emails');
const saveEmails = (d) => saveTable('emails', d);
const loadPhotos = () => loadTable('photos');
const savePhotos = (d) => saveTable('photos', d);

// Match a phone/email to a saved contact, normalizing loosely
async function findContactByPhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '').slice(-9); // last 9 digits, NZ-safe
  const contacts = await loadContacts();
  return contacts.find((c) => c.phone && c.phone.replace(/\D/g, '').slice(-9) === digits) || null;
}
async function findContactByEmail(email) {
  if (!email) return null;
  const norm = email.toLowerCase().trim();
  const contacts = await loadContacts();
  return contacts.find((c) => c.email && c.email.toLowerCase().trim() === norm) || null;
}

// ---- Contacts CRUD ----
app.get('/api/contacts', async (req, res) => {
  try { res.json(await loadContacts()); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/contacts', async (req, res) => {
  const { name, phone, email } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  try {
    const contacts = await loadContacts();
    const contact = { id: 'c_' + Date.now(), name, phone: phone || '', email: email || '' };
    contacts.unshift(contact);
    await saveContacts(contacts);
    res.json(contact);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/contacts/:id', async (req, res) => {
  try {
    const contacts = (await loadContacts()).filter((c) => c.id !== req.params.id);
    await saveContacts(contacts);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Edit an existing contact ----
app.put('/api/contacts/:id', async (req, res) => {
  const { name, phone, email, location } = req.body;
  try {
    const contacts = await loadContacts();
    const idx = contacts.findIndex((c) => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });

    if (name !== undefined) contacts[idx].name = name;
    if (phone !== undefined) contacts[idx].phone = phone;
    if (email !== undefined) contacts[idx].email = email;
    if (location !== undefined) contacts[idx].location = location;

    await saveContacts(contacts);
    res.json(contacts[idx]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Photos: upload a photo to a contact's folder ----
// Photos are stored as compressed base64 images directly in the same free
// database as everything else — kept simple since there's no separate
// file-storage account in this setup.
app.post('/api/contacts/:id/photos', async (req, res) => {
  const { dataUrl, filename } = req.body;
  if (!dataUrl) return res.status(400).json({ error: 'Missing image data' });

  try {
    const contacts = await loadContacts();
    const contact = contacts.find((c) => c.id === req.params.id);
    if (!contact) return res.status(404).json({ error: 'contact not found' });

    const photos = await loadPhotos();
    const photo = {
      id: 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      contactId: contact.id,
      filename: filename || 'photo.jpg',
      dataUrl,
      at: new Date().toISOString(),
    };
    photos.unshift(photo);
    await savePhotos(photos);
    res.json(photo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/photos/:id', async (req, res) => {
  try {
    const photos = (await loadPhotos()).filter((p) => p.id !== req.params.id);
    await savePhotos(photos);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Bulk import contacts (e.g. from a franchise list) ----
app.post('/api/contacts/import', async (req, res) => {
  const incoming = req.body.contacts || [];
  try {
    const contacts = await loadContacts();
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

    await saveContacts(contacts);
    res.json({ ok: true, added, skipped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Unified folder view: everything for one contact ----
app.get('/api/contacts/:id/folder', async (req, res) => {
  try {
    const contact = (await loadContacts()).find((c) => c.id === req.params.id);
    if (!contact) return res.status(404).json({ error: 'not found' });

    const calls = (await loadCalls()).filter((c) => c.contactId === contact.id);
    const messages = (await loadMessages()).filter((m) => m.contactId === contact.id);
    const emails = (await loadEmails()).filter((e) => e.contactId === contact.id);
    const photos = (await loadPhotos()).filter((p) => p.contactId === contact.id);

    const timeline = [
      ...calls.map((c) => ({ type: 'call', at: c.startedAt, ...c })),
      ...messages.map((m) => ({ type: 'sms', at: m.at, ...m })),
      ...emails.map((e) => ({ type: 'email', at: e.at, ...e })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at));

    res.json({ contact, timeline, photos: photos.sort((a, b) => new Date(b.at) - new Date(a.at)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

    const contact = await findContactByPhone(to);
    const calls = await loadCalls();
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
    await saveCalls(calls);

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

// ---- Incoming calls: someone calls your Twilio number directly ----
// Twilio hits this the moment the call comes in. We log it, then forward
// it to your real phone, recording the whole thing the same way as outbound calls.
app.post('/twiml/incoming', async (req, res) => {
  const { CallSid, From } = req.body;

  try {
    const contact = await findContactByPhone(From);
    const calls = await loadCalls();
    calls.unshift({
      sid: CallSid,
      to: From, // the person who called you
      contactId: contact ? contact.id : null,
      label: '',
      startedAt: new Date().toISOString(),
      status: 'calling',
      recordingUrl: null,
      transcript: null,
      direction: 'inbound',
    });
    await saveCalls(calls);
  } catch (err) {
    console.error('Failed to log incoming call:', err.message);
  }

  const twiml = new VoiceResponse();
  const dial = twiml.dial({
    record: 'record-from-answer-dual',
    recordingStatusCallback: `${PUBLIC_BASE_URL}/recording-status`,
    recordingStatusCallbackEvent: ['completed'],
  });
  dial.number(MY_PHONE_NUMBER);

  res.type('text/xml').send(twiml.toString());
});

// ---- Transcribe a recording with OpenAI Whisper ----
// Twilio's own transcription feature was discontinued from the SDK, so we
// download the recorded audio ourselves and send it to Whisper instead.
async function transcribeRecording(recordingUrl) {
  const audioRes = await fetch(`${recordingUrl}.mp3`, {
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64'),
    },
  });
  if (!audioRes.ok) throw new Error(`Failed to download recording: ${audioRes.status}`);
  const audioBuffer = await audioRes.arrayBuffer();

  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: 'audio/mpeg' }), 'call.mp3');
  form.append('model', 'whisper-1');

  const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  const data = await whisperRes.json();
  if (!whisperRes.ok) throw new Error(data.error?.message || 'Whisper request failed');
  return data.text;
}

// ---- 3. Recording finished -> transcribe it ----
app.post('/recording-status', async (req, res) => {
  const { RecordingUrl, CallSid } = req.body;
  res.sendStatus(200);

  const calls = await loadCalls();
  const idx = calls.findIndex((c) => c.sid === CallSid);
  if (idx === -1) return;

  calls[idx].recordingUrl = `${RecordingUrl}.mp3`;
  calls[idx].status = 'transcribing';
  await saveCalls(calls);

  try {
    const text = await transcribeRecording(RecordingUrl);
    const freshCalls = await loadCalls();
    const freshIdx = freshCalls.findIndex((c) => c.sid === CallSid);
    if (freshIdx !== -1) {
      freshCalls[freshIdx].transcript = text;
      freshCalls[freshIdx].status = 'done';
      await saveCalls(freshCalls);
    }
  } catch (err) {
    console.error('Transcription failed:', err.message);
    const freshCalls = await loadCalls();
    const freshIdx = freshCalls.findIndex((c) => c.sid === CallSid);
    if (freshIdx !== -1) {
      freshCalls[freshIdx].status = 'transcription-failed';
      await saveCalls(freshCalls);
    }
  }
});

// ---- 5. Call status updates (e.g. completed/no-answer) ----
app.post('/status', async (req, res) => {
  res.sendStatus(200);
  const { CallSid, CallStatus } = req.body;
  const calls = await loadCalls();
  const idx = calls.findIndex((c) => c.sid === CallSid);
  if (idx !== -1 && calls[idx].status === 'calling') {
    calls[idx].status = CallStatus;
    await saveCalls(calls);
  }
});

// ---- 6. List calls for the frontend ----
app.get('/api/calls', async (req, res) => {
  try { res.json(await loadCalls()); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- 7. Manual retry: re-run Whisper on a call's recording if it failed or got stuck ----
app.post('/api/calls/:sid/refresh', async (req, res) => {
  const calls = await loadCalls();
  const idx = calls.findIndex((c) => c.sid === req.params.sid);
  if (idx === -1) return res.status(404).json({ error: 'not found' });

  if (!calls[idx].recordingUrl) return res.json(calls[idx]);

  try {
    const rawUrl = calls[idx].recordingUrl.replace(/\.mp3$/, '');
    const text = await transcribeRecording(rawUrl);
    calls[idx].transcript = text;
    calls[idx].status = 'done';
    await saveCalls(calls);
  } catch (err) {
    console.error('Refresh failed:', err.message);
  }

  res.json(calls[idx]);
});

// ==================== TEXT MESSAGES (Twilio SMS) ====================

app.post('/api/sms/send', async (req, res) => {
  const { to: rawTo, body, contactId } = req.body;
  if (!rawTo || !body) return res.status(400).json({ error: 'Missing "to" or "body"' });
  const to = toE164NZ(rawTo);

  try {
    const msg = await client.messages.create({ to, from: SMS_FROM_NUMBER, body });
    const contacts = await loadContacts();
    const contact = contactId ? contacts.find((c) => c.id === contactId) : await findContactByPhone(to);

    const messages = await loadMessages();
    messages.unshift({
      sid: msg.sid,
      direction: 'outbound',
      to,
      from: SMS_FROM_NUMBER,
      body,
      contactId: contact ? contact.id : null,
      at: new Date().toISOString(),
    });
    await saveMessages(messages);
    res.json({ ok: true, sid: msg.sid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Receive a text (Twilio webhook — set this URL on your Twilio number's "A Message Comes In") ----
app.post('/sms-incoming', async (req, res) => {
  const { From, Body, MessageSid } = req.body;
  const contact = await findContactByPhone(From);

  const messages = await loadMessages();
  messages.unshift({
    sid: MessageSid,
    direction: 'inbound',
    to: SMS_FROM_NUMBER,
    from: From,
    body: Body,
    contactId: contact ? contact.id : null,
    at: new Date().toISOString(),
  });
  await saveMessages(messages);

  const twiml = new MessagingResponse();
  res.type('text/xml').send(twiml.toString()); // empty response = no auto-reply
});

app.get('/api/sms', async (req, res) => {
  try { res.json(await loadMessages()); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- Mass text: send the same message to every contact with a phone number ----
app.post('/api/sms/broadcast', async (req, res) => {
  const { body } = req.body;
  if (!body) return res.status(400).json({ error: 'Missing message body' });

  const contacts = (await loadContacts()).filter((c) => c.phone);
  const messages = await loadMessages();
  let sent = 0, failed = [];

  for (const contact of contacts) {
    const to = toE164NZ(contact.phone);
    try {
      const msg = await client.messages.create({ to, from: SMS_FROM_NUMBER, body });
      messages.unshift({
        sid: msg.sid,
        direction: 'outbound',
        to,
        from: SMS_FROM_NUMBER,
        body,
        contactId: contact.id,
        at: new Date().toISOString(),
      });
      sent++;
    } catch (err) {
      failed.push({ name: contact.name, phone: contact.phone, error: err.message });
    }
  }

  await saveMessages(messages);
  res.json({ ok: true, sent, failed });
});

// ==================== EMAIL (Microsoft Graph / Outlook) ====================
// Full-inbox sync requires you to sign in once via Microsoft so the app can read
// your mail with Graph API. See README "Email setup" for the Azure app registration
// steps — MS_CLIENT_ID / MS_CLIENT_SECRET / MS_TENANT_ID come from that.

const msal = require('@azure/msal-node');
const { Client } = require('@microsoft/microsoft-graph-client');

const MS_SCOPES = ['Mail.Read', 'Mail.Send', 'offline_access', 'User.Read'];

// MSAL normally keeps your login token only in memory, which gets wiped every
// time Render restarts the app (deploys, free-tier sleep, etc.) — that's why
// email kept saying "please sign in" again. This plugin saves the real token
// cache to the same Redis database everything else uses, so it survives restarts.
const msCachePlugin = {
  beforeCacheAccess: async (cacheContext) => {
    const raw = await redis(['GET', 'ms-cache-raw']).catch(() => null);
    if (raw) cacheContext.tokenCache.deserialize(raw);
  },
  afterCacheAccess: async (cacheContext) => {
    if (cacheContext.cacheHasChanged) {
      await redis(['SET', 'ms-cache-raw', cacheContext.tokenCache.serialize()]);
    }
  },
};

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
      cache: { cachePlugin: msCachePlugin },
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
    await getMsalClient().acquireTokenByCode({
      code: req.query.code,
      scopes: MS_SCOPES,
      redirectUri: `${PUBLIC_BASE_URL}/auth/microsoft/callback`,
    });
    res.send('Microsoft 365 connected — you can close this tab and go back to the app.');
  } catch (err) {
    res.status(500).send('Auth failed: ' + err.message);
  }
});

async function getGraphClient() {
  const client = getMsalClient();
  const accounts = await client.getTokenCache().getAllAccounts();
  if (!accounts.length) throw new Error('Not connected to Microsoft 365 — visit /auth/microsoft first');

  const result = await client.acquireTokenSilent({
    account: accounts[0],
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

    const contacts = await loadContacts();
    const contact = contactId ? contacts.find((c) => c.id === contactId) : await findContactByEmail(to);
    const emails = await loadEmails();
    emails.unshift({
      direction: 'outbound',
      to,
      subject,
      body,
      contactId: contact ? contact.id : null,
      at: new Date().toISOString(),
    });
    await saveEmails(emails);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- Sync: pull recent inbox + sent mail, match to contacts by email address ----
app.post('/api/email/sync', async (req, res) => {
  try {
    const graph = await getGraphClient();
    const existing = await loadEmails();
    const existingIds = new Set(existing.map((e) => e.graphId));

    const [inbox, sent] = await Promise.all([
      graph.api('/me/mailFolders/inbox/messages').top(25).select('id,subject,bodyPreview,from,receivedDateTime').get(),
      graph.api('/me/mailFolders/sentitems/messages').top(25).select('id,subject,bodyPreview,toRecipients,sentDateTime').get(),
    ]);

    let added = 0;
    for (const m of inbox.value) {
      if (existingIds.has(m.id)) continue;
      const fromAddr = m.from?.emailAddress?.address;
      const contact = await findContactByEmail(fromAddr);
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
      const contact = await findContactByEmail(toAddr);
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

    await saveEmails(existing);
    res.json({ ok: true, added });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/email', async (req, res) => {
  try { res.json(await loadEmails()); } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- Mass email: send the same message to every contact with an email address ----
app.post('/api/email/broadcast', async (req, res) => {
  const { subject, body } = req.body;
  if (!body) return res.status(400).json({ error: 'Missing message body' });

  try {
    const graph = await getGraphClient();
    const contacts = (await loadContacts()).filter((c) => c.email);
    const emails = await loadEmails();
    let sent = 0, failed = [];

    for (const contact of contacts) {
      try {
        await graph.api('/me/sendMail').post({
          message: {
            subject,
            body: { contentType: 'Text', content: body },
            toRecipients: [{ emailAddress: { address: contact.email } }],
          },
        });
        emails.unshift({
          direction: 'outbound',
          to: contact.email,
          subject,
          body,
          contactId: contact.id,
          at: new Date().toISOString(),
        });
        sent++;
      } catch (err) {
        failed.push({ name: contact.name, email: contact.email, error: err.message });
      }
    }

    await saveEmails(emails);
    res.json({ ok: true, sent, failed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Simple health check — used by an external uptime pinger to keep the free
// Render instance from spinning down between calls.
app.get('/health', (req, res) => res.send('ok'));

app.listen(PORT, () => console.log(`Call app listening on port ${PORT}`));
