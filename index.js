import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { google } from 'googleapis';

dotenv.config();

if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  console.error('Missing FIREBASE_SERVICE_ACCOUNT_JSON environment variable!');
  process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DB_URL
});

const app = express();

// ✅ Fix CORS for your frontend
app.use(cors({
  origin: 'https://throbbers-2025.web.app'
}));

app.use(express.json());

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const FRONTEND_URI = process.env.FRONTEND_URI || 'https://throbbers-host.web.app/';

function getBasicAuthHeader() {
  const creds = `${CLIENT_ID}:${CLIENT_SECRET}`;
  return 'Basic ' + Buffer.from(creds).toString('base64');
}

function getOriginalArtistName(safeKeyName, artistOrder = []) {
  const found = artistOrder.find(entry =>
    typeof entry === 'object' && entry.safe === safeKeyName
  );
  return found?.original || safeKeyName;
}

app.get('/', (req, res) => {
  res.send('✅ Spotify Auth Server is running');
});

app.get('/ping', (req, res) => {
  res.send('pong');
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  const db = admin.database();

  if (!code) return res.status(400).send('Missing code');

  try {
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Authorization': getBasicAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: REDIRECT_URI,
      }),
    });

    const data = await tokenRes.json();
    console.log('🎧 Token response from Spotify:', data);

    if (data.error || !data.access_token || !data.refresh_token) {
      console.error('❌ Error during token exchange:', data);
      return res.status(400).json(data);
    }

    const { access_token, refresh_token } = data;

    await db.ref('spotifyAccessToken').set(access_token);
    await db.ref('spotifyRefreshToken').set(refresh_token);
    console.log('✅ Tokens saved to Firebase');

    const redirectUrl = `${FRONTEND_URI}#access_token=${access_token}&refresh_token=${refresh_token}`;
    res.redirect(redirectUrl);
  } catch (err) {
    console.error('❌ Error during token exchange:', err);
    res.status(500).send('Token exchange failed');
  }
});

app.get('/refresh', async (req, res) => {
  const refresh_token = req.query.refresh_token;
  if (!refresh_token) return res.status(400).send('Missing refresh_token');

  try {
    const refreshRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Authorization': getBasicAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh_token,
      }),
    });

    const data = await refreshRes.json();
    if (data.error) {
      return res.status(400).json(data);
    }

    res.json(data);
  } catch (err) {
    console.error('Error refreshing token:', err);
    res.status(500).send('Refresh failed');
  }
});

app.get('/test-firebase', async (req, res) => {
  try {
    const db = admin.database();
    await db.ref('test').set({ message: 'It works!' });
    res.send('✅ Firebase write successful');
  } catch (err) {
    console.error(err);
    res.status(500).send('❌ Firebase write failed');
  }
});

// === Google Sheets setup ===

if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  console.error('Missing GOOGLE_SERVICE_ACCOUNT_JSON environment variable!');
  process.exit(1);
}

if (!process.env.GOOGLE_SHEET_ID) {
  console.error('Missing GOOGLE_SHEET_ID environment variable!');
  process.exit(1);
}

const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const sheets = google.sheets({ version: 'v4', auth });
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID;

// ✅ Utility to safely encode Firebase keys
function safeKey(name) {
  return name.replace(/[.#$/\[\]]/g, '_');
}

app.post('/record-votes', async (req, res) => {
  try {
    const { artist: safeArtist, votes } = req.body;

    if (!safeArtist || !votes || typeof votes !== 'object') {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const timestamp = new Date().toISOString();
    const db = admin.database();

    // ✅ Fetch original artist name from artistOrder
    const artistOrderSnap = await db.ref('artistOrder').once('value');
    const artistOrder = artistOrderSnap.val() || [];

    const originalArtist = getOriginalArtistName(safeArtist, artistOrder);

    // 🔄 Get all participants (guests + host)
    const [guestsSnap, hostSnap] = await Promise.all([
      db.ref('guests').once('value'),
      db.ref('host').once('value')
    ]);

    const guestList = guestsSnap.val() || {};
    const hostList = hostSnap.val() || {};
    const allUsers = Object.keys({ ...guestList, ...hostList }).sort();

    // ✅ Save votes in Firebase with original name preserved
    await db.ref(`votes/${safeArtist}`).set({
      originalName: originalArtist,
      votes: votes,
      timestamp
    });

    // ✅ Build headers and row
    const headers = ['TIMESTAMP', 'ARTIST', ...allUsers];
    const row = [timestamp, originalArtist, ...allUsers.map(name => votes[name] || '')];

    // ✅ Overwrite header row (A1)
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: 'VOTES!A1',
      valueInputOption: 'RAW',
      requestBody: {
        values: [headers],
      },
    });

    // ✅ Append the new vote row
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'VOTES!A2',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [row],
      },
    });

    console.log('✅ Vote recorded to sheet:', row);
    res.status(200).json({ success: true });

  } catch (err) {
    console.error('❌ Failed to record votes:', err.response?.data || err.message || err);
    res.status(500).json({ error: 'Failed to record votes' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});

app.get('/artist-info', async (req, res) => {
  try {
    const db = admin.database();
    const [orderSnap, namesSnap] = await Promise.all([
      db.ref('artistOrder').once('value'),
      db.ref('artistNames').once('value')
    ]);

    const order = orderSnap.val() || [];
    const names = namesSnap.val() || {};

    res.json({ order, names });
  } catch (err) {
    console.error('❌ Failed to fetch artist info:', err);
    res.status(500).json({ error: 'Failed to fetch artist info' });
  }
});