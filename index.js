import express from 'express';
import fetch from 'node-fetch';
import cors from 'cors';
import dotenv from 'dotenv';
import admin from 'firebase-admin';

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
app.use(cors());
app.use(express.json());

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const FRONTEND_URI = process.env.FRONTEND_URI || 'https://throbbers-host.web.app/';

function getBasicAuthHeader() {
  const creds = `${CLIENT_ID}:${CLIENT_SECRET}`;
  return 'Basic ' + Buffer.from(creds).toString('base64');
}

app.get('/', (req, res) => {
  res.send('✅ Spotify Auth Server is running');
});

// ✅ PING route to wake the server
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

    // ✅ Save to Firebase
    await db.ref('spotifyAccessToken').set(access_token);
    await db.ref('spotifyRefreshToken').set(refresh_token);
    console.log('✅ Tokens saved to Firebase');

    // ✅ Redirect to frontend with tokens as hash
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});