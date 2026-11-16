import { Capacitor } from '@capacitor/core';
import { getApps, initializeApp } from 'firebase/app';
import {
  getAuth,
  indexedDBLocalPersistence,
  initializeAuth,
  type Auth,
} from 'firebase/auth';
import { getDatabase } from 'firebase/database';
import { getMessaging, isSupported, type Messaging } from 'firebase/messaging';

export const firebaseConfig = {
  apiKey: 'AIzaSyCuJLxRCdhAVZoN81-5weEFnSU4nDr98lo',
  authDomain: 'test-2a0d0.firebaseapp.com',
  databaseURL: 'https://test-2a0d0-default-rtdb.firebaseio.com',
  projectId: 'test-2a0d0',
  storageBucket: 'test-2a0d0.firebasestorage.app',
  messagingSenderId: '396740286096',
  appId: '1:396740286096:web:430751766ca9c384946a15',
  measurementId: 'G-W05VPQX3V2',
};

const app = getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);

let authInstance: Auth;
if (Capacitor.isNativePlatform()) {
  try {
    authInstance = initializeAuth(app, {
      persistence: indexedDBLocalPersistence,
    });
  } catch {
    authInstance = getAuth(app);
  }
} else {
  authInstance = getAuth(app);
}

export const auth = authInstance;
export const db = getDatabase(app);

let messagingPromise: Promise<Messaging | null> | null = null;

export function getFirebaseMessagingSafe(): Promise<Messaging | null> {
  if (!messagingPromise) {
    messagingPromise = isSupported()
      .then((supported) => (supported ? getMessaging(app) : null))
      .catch(() => null);
  }
  return messagingPromise;
}
