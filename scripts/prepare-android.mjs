import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const androidDir = path.join(rootDir, 'android');
const manifestPath = path.join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml');
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

// 2. Patch AndroidManifest.xml with permissions & UPI/WhatsApp/Dial queries
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
