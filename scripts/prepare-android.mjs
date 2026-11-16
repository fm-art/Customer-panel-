import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const androidDir = path.join(rootDir, 'android');
const mainDir = path.join(androidDir, 'app', 'src', 'main');
const manifestPath = path.join(mainDir, 'AndroidManifest.xml');
const resDir = path.join(mainDir, 'res');
const drawableDir = path.join(resDir, 'drawable');
const valuesDir = path.join(resDir, 'values');

const sourceGoogleServices = path.join(
  rootDir,
  'public',
  'assets',
  'aistudio',
  'google-services_5c61c5de.json'
);
const targetGoogleServices = path.join(androidDir, 'app', 'google-services.json');

if (!fs.existsSync(androidDir)) {
  console.log('android/ folder not found, skipping prepare-android.');
  process.exit(0);
}

// 1. Copy Firebase google-services.json (contains com.gossaigaon.bazar)
if (fs.existsSync(sourceGoogleServices)) {
  fs.copyFileSync(sourceGoogleServices, targetGoogleServices);
  console.log('Copied google-services.json to android/app/google-services.json');
}

// 2. Create transparent-background white monochrome notification icon (Android requirement)
fs.mkdirSync(drawableDir, { recursive: true });
const notifIconXml = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path
        android:fillColor="#FFFFFFFF"
        android:pathData="M7,18c-1.1,0 -1.99,0.9 -1.99,2S5.9,22 7,22s2,-0.9 2,-2 -0.9,-2 -2,-2zM1,2v2h2l3.6,7.59 -1.35,2.45c-0.16,0.28 -0.25,0.61 -0.25,0.96 0,1.1 0.9,2 2,2h12v-2H7.42c-0.14,0 -0.25,-0.11 -0.25,-0.25l0.03,-0.12 0.9,-1.63h7.45c0.75,0 1.41,-0.41 1.75,-1.03l3.58,-6.49c0.08,-0.14 0.12,-0.31 0.12,-0.48 0,-0.55 -0.45,-1 -1,-1H5.21l-0.94,-2H1zm16,16c-1.1,0 -1.99,0.9 -1.99,2s0.89,2 1.99,2 2,-0.9 2,-2 -0.9,-2 -2,-2z" />
</vector>
`;
fs.writeFileSync(path.join(drawableDir, 'ic_stat_notification.xml'), notifIconXml, 'utf8');
console.log('Created res/drawable/ic_stat_notification.xml');

// 3. Create notification accent color (#0c831f)
fs.mkdirSync(valuesDir, { recursive: true });
const notifColorsXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="notification_accent">#0c831f</color>
</resources>
`;
fs.writeFileSync(path.join(valuesDir, 'notification_colors.xml'), notifColorsXml, 'utf8');
console.log('Created res/values/notification_colors.xml');

// 4. Patch AndroidManifest.xml with permissions, queries & notification metadata
if (!fs.existsSync(manifestPath)) {
  console.warn('AndroidManifest.xml not found at:', manifestPath);
  process.exit(0);
}

let manifest = fs.readFileSync(manifestPath, 'utf8');

const requiredPermissions = [
  'android.permission.INTERNET',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.VIBRATE',
  'android.permission.POST_NOTIFICATIONS',
];

const missingPermissions = requiredPermissions.filter(
  (perm) => !manifest.includes(`android:name="${perm}"`)
);

if (missingPermissions.length > 0) {
  const permLines = missingPermissions
    .map((perm) => `    <uses-permission android:name="${perm}" />`)
    .join('\n');

  manifest = manifest.replace('</manifest>', `\n${permLines}\n</manifest>`);
  console.log('Added Android permissions:', missingPermissions.join(', '));
}

if (!manifest.includes('com.google.firebase.messaging.default_notification_icon')) {
  const notifMetaData = `
        <meta-data
            android:name="com.google.firebase.messaging.default_notification_icon"
            android:resource="@drawable/ic_stat_notification" />
        <meta-data
            android:name="com.google.firebase.messaging.default_notification_color"
            android:resource="@color/notification_accent" />
        <meta-data
            android:name="com.google.firebase.messaging.default_notification_channel_id"
            android:value="chutki_alerts" />`;

  manifest = manifest.replace('</application>', `${notifMetaData}\n    </application>`);
  console.log('Added notification icon & channel metadata to AndroidManifest.xml');
}

if (!manifest.includes('<queries>')) {
  const queriesBlock = `
    <queries>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="upi" />
        </intent>
        <intent>
            <action android:name="android.intent.action.VIEW" />
            <data android:scheme="https" />
        </intent>
        <intent>
            <action android:name="android.intent.action.DIAL" />
        </intent>
    </queries>`;

  manifest = manifest.replace('</manifest>', `${queriesBlock}\n</manifest>`);
  console.log('Added <queries> for UPI, HTTPS, and Dial intents');
}

fs.writeFileSync(manifestPath, manifest, 'utf8');
console.log('AndroidManifest.xml prepared successfully for com.gossaigaon.bazar.');
