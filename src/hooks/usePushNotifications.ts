import { useCallback, useEffect, useRef, useState } from 'react';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { PushNotifications } from '@capacitor/push-notifications';
import { ref, update } from 'firebase/database';
import { getToken, onMessage } from 'firebase/messaging';
import { db, getFirebaseMessagingSafe } from '../firebase';
import type { AppNotification, TabKey } from '../types/bazar';

const INBOX_STORAGE_KEY = 'gb_push_inbox_v1';
const PROMPT_DISMISSED_KEY = 'gb_push_prompt_dismissed_v1';
const ANDROID_ALERT_CHANNEL_ID = 'chutki_alerts';

function loadSavedInbox(): AppNotification[] {
  try {
    const raw = localStorage.getItem(INBOX_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, 40) : [];
  } catch {
    return [];
  }
}

function mapCapPermToWeb(state: string | undefined): NotificationPermission {
  if (state === 'granted') return 'granted';
  if (state === 'denied') return 'denied';
  return 'default';
}

function makeAndroidNotifId(): number {
  return Math.floor(Math.random() * 1_000_000_000) + 1;
}

export type PushPermissionState = NotificationPermission | 'unsupported';

export function usePushNotifications(
  userUid: string | null,
  isDemoMode: boolean,
  onNavigateTab?: (tab: TabKey) => void
) {
  const isNative = Capacitor.isNativePlatform();

  const [permission, setPermission] = useState<PushPermissionState>(() => {
    if (Capacitor.isNativePlatform()) {
      return 'default';
    }
    if (typeof window === 'undefined' || !('Notification' in window)) {
      return 'unsupported';
    }
    return Notification.permission;
  });

  const [notifications, setNotifications] = useState<AppNotification[]>(loadSavedInbox);
  const [promptDismissed, setPromptDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(PROMPT_DISMISSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [fcmToken, setFcmToken] = useState<string>('');
  const [activeBanner, setActiveBanner] = useState<AppNotification | null>(null);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    };
  }, []);

  const persistInbox = useCallback((items: AppNotification[]) => {
    try {
      localStorage.setItem(INBOX_STORAGE_KEY, JSON.stringify(items.slice(0, 40)));
    } catch {
      // Ignore storage quota errors
    }
  }, []);

  const showNativeNotification = useCallback(
    async (notif: AppNotification) => {
      if (isNative) {
        try {
          const perm = await LocalNotifications.checkPermissions();
          if (perm.display !== 'granted') return;
          await LocalNotifications.schedule({
            notifications: [
              {
                id: makeAndroidNotifId(),
                title: notif.title,
                body: notif.body,
                channelId: ANDROID_ALERT_CHANNEL_ID,
                extra: {
                  targetTab: notif.targetTab || 'orders',
                },
              },
            ],
          });
        } catch {
          // Ignore local notification schedule errors
        }
        return;
      }

      if (typeof window === 'undefined' || !('Notification' in window)) return;
      if (Notification.permission !== 'granted') return;

      try {
        if ('serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.ready;
          if (reg && typeof reg.showNotification === 'function') {
            await reg.showNotification(notif.title, {
              body: notif.body,
              icon: '/pwa-192x192.png',
              badge: '/pwa-192x192.png',
              tag: notif.tag,
              data: {
                url: `/?tab=${notif.targetTab || 'orders'}`,
                targetTab: notif.targetTab || 'orders',
              },
            });
            return;
          }
        }
        new Notification(notif.title, {
          body: notif.body,
          icon: '/pwa-192x192.png',
          tag: notif.tag,
        });
      } catch {
        // Fallback silently if browser restricts notification constructor
      }
    },
    [isNative]
  );

  const dismissBanner = useCallback(() => {
    if (bannerTimerRef.current) {
      clearTimeout(bannerTimerRef.current);
      bannerTimerRef.current = null;
    }
    setActiveBanner(null);
  }, []);

  const pushNotification = useCallback(
    (notif: AppNotification, showSystemAlert = true) => {
      let wasAdded = false;
      setNotifications((prev) => {
        if (prev.some((n) => n.id === notif.id)) return prev;
        wasAdded = true;
        const next = [notif, ...prev].slice(0, 40);
        persistInbox(next);
        return next;
      });
      if (showSystemAlert) {
        if (wasAdded || notif.type === 'ORDER') {
          setActiveBanner(notif);
          if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
          bannerTimerRef.current = setTimeout(() => {
            setActiveBanner((cur) => (cur?.id === notif.id ? null : cur));
          }, 5500);
        }
        void showNativeNotification(notif);
      }
    },
    [persistInbox, showNativeNotification]
  );

  const markNotificationRead = useCallback(
    (notifId: string) => {
      setNotifications((prev) => {
        const next = prev.map((n) => (n.id === notifId ? { ...n, read: true } : n));
        persistInbox(next);
        return next;
      });
    },
    [persistInbox]
  );

  const markAllRead = useCallback(() => {
    setNotifications((prev) => {
      const next = prev.map((n) => ({ ...n, read: true }));
      persistInbox(next);
      return next;
    });
  }, [persistInbox]);

  const clearInbox = useCallback(() => {
    setNotifications([]);
    persistInbox([]);
    dismissBanner();
  }, [dismissBanner, persistInbox]);

  const dismissPrompt = useCallback(() => {
    setPromptDismissed(true);
    try {
      localStorage.setItem(PROMPT_DISMISSED_KEY, '1');
    } catch {
      // Ignore
    }
  }, []);

  const syncFcmToken = useCallback(async () => {
    if (!userUid || isDemoMode) return;
    if (isNative) {
      try {
        await PushNotifications.register();
      } catch {
        // Ignore register error if Google Play Services unavailable
      }
      return;
    }

    try {
      const messaging = await getFirebaseMessagingSafe();
      if (!messaging || !('serviceWorker' in navigator)) return;
      const reg = await navigator.serviceWorker.ready;
      const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY;
      const token = vapidKey
        ? await getToken(messaging, { vapidKey, serviceWorkerRegistration: reg })
        : await getToken(messaging, { serviceWorkerRegistration: reg }).catch(() => '');
      if (token) {
        setFcmToken(token);
        await update(ref(db, `customers/${userUid}`), {
          fcmToken: token,
          pushEnabled: true,
        });
      } else {
        await update(ref(db, `customers/${userUid}`), {
          pushEnabled: true,
        });
      }
    } catch {
      if (userUid && !isDemoMode) {
        void update(ref(db, `customers/${userUid}`), { pushEnabled: true }).catch(() => {});
      }
    }
  }, [userUid, isDemoMode, isNative]);

  const enablePushNotifications = useCallback(async (): Promise<{
    granted: boolean;
    message: string;
  }> => {
    if (isNative) {
      try {
        const pushPerm = await PushNotifications.requestPermissions();
        const localPerm = await LocalNotifications.requestPermissions();
        const granted =
          pushPerm.receive === 'granted' || localPerm.display === 'granted';
        setPermission(granted ? 'granted' : 'denied');

        if (granted) {
          dismissPrompt();
          await syncFcmToken();
          const welcomeNotif: AppNotification = {
            id: `welcome_${Date.now()}`,
            title: '🔔 Chutki Alerts Active!',
            body: 'You will now receive live order updates, rider arrival PIN & deal alerts.',
            tag: 'gb-welcome-push',
            type: 'SYSTEM',
            targetTab: 'home',
            createdAt: Date.now(),
            read: false,
          };
          pushNotification(welcomeNotif, true);
          return {
            granted: true,
            message: '🔔 Push notifications enabled! Check your notification tray.',
          };
        }
        return {
          granted: false,
          message: 'Please allow Notifications in Android App Settings.',
        };
      } catch (err) {
        return {
          granted: false,
          message: err instanceof Error ? err.message : 'Unable to enable notifications.',
        };
      }
    }

    if (typeof window === 'undefined' || !('Notification' in window)) {
      setPermission('unsupported');
      return {
        granted: false,
        message: 'Push notifications are not supported on this browser.',
      };
    }

    try {
      const result = await Notification.requestPermission();
      setPermission(result);
      if (result === 'granted') {
        dismissPrompt();
        await syncFcmToken();
        const welcomeNotif: AppNotification = {
          id: `welcome_${Date.now()}`,
          title: '🔔 Chutki Alerts Active!',
          body: 'You will now receive live order updates, rider arrival PIN & deal alerts.',
          tag: 'gb-welcome-push',
          type: 'SYSTEM',
          targetTab: 'home',
          createdAt: Date.now(),
          read: false,
        };
        pushNotification(welcomeNotif, true);
        return {
          granted: true,
          message: '🔔 Push notifications enabled! Check your notification tray.',
        };
      }
      return {
        granted: false,
        message:
          result === 'denied'
            ? 'Notification permission blocked in browser settings.'
            : 'Notification permission dismissed.',
      };
    } catch (err) {
      return {
        granted: false,
        message: err instanceof Error ? err.message : 'Unable to enable notifications.',
      };
    }
  }, [dismissPrompt, isNative, pushNotification, syncFcmToken]);

  const sendTestPush = useCallback(async () => {
    if (permission !== 'granted') {
      return enablePushNotifications();
    }
    const testNotif: AppNotification = {
      id: `test_${Date.now()}`,
      title: '⚡ 15-Min Express Order Alert',
      body: 'Push notifications are working smoothly! Rider & offer updates will arrive here.',
      tag: `gb-test-${Date.now()}`,
      type: 'ORDER',
      targetTab: 'orders',
      createdAt: Date.now(),
      read: false,
    };
    pushNotification(testNotif, true);
    return { granted: true, message: '🔔 Test push notification sent!' };
  }, [enablePushNotifications, permission, pushNotification]);

  // Native Android Capacitor Push + Local Notification Setup & Listeners
  useEffect(() => {
    if (!isNative) return undefined;
    let active = true;
    const handles: PluginListenerHandle[] = [];

    const setupNativePush = async () => {
      try {
        await LocalNotifications.createChannel({
          id: ANDROID_ALERT_CHANNEL_ID,
          name: 'Chutki Alerts',
          description: 'Order updates, rider arrival PIN & voice call alerts',
          importance: 5,
          visibility: 1,
          vibration: true,
        });
      } catch {
        // Ignore channel error on older Android
      }

      try {
        const pushPerm = await PushNotifications.checkPermissions();
        const localPerm = await LocalNotifications.checkPermissions();
        if (!active) return;
        const resolved =
          pushPerm.receive === 'granted' || localPerm.display === 'granted'
            ? 'granted'
            : mapCapPermToWeb(pushPerm.receive);
        setPermission(resolved);

        if (resolved === 'granted') {
          await PushNotifications.register();
        }
      } catch {
        // Ignore permission check failure
      }

      try {
        handles.push(
          await PushNotifications.addListener('registration', (token) => {
            if (!active || !token.value) return;
            setFcmToken(token.value);
            if (userUid && !isDemoMode) {
              void update(ref(db, `customers/${userUid}`), {
                fcmToken: token.value,
                pushEnabled: true,
              }).catch(() => {});
            }
          })
        );

        handles.push(
          await PushNotifications.addListener('pushNotificationReceived', (notif) => {
            if (!active) return;
            const targetTab =
              (notif.data?.targetTab as TabKey | undefined) || 'orders';
            pushNotification(
              {
                id: `fcm_${notif.id || Date.now()}`,
                title: notif.title || 'Chutki',
                body: notif.body || 'You have a new update.',
                tag: 'gb-native-fcm',
                type: 'ORDER',
                targetTab,
                createdAt: Date.now(),
                read: false,
              },
              true
            );
          })
        );

        handles.push(
          await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
            const targetTab =
              (action.notification.data?.targetTab as TabKey | undefined) || 'orders';
            onNavigateTab?.(targetTab);
          })
        );

        handles.push(
          await LocalNotifications.addListener(
            'localNotificationActionPerformed',
            (action) => {
              const targetTab =
                (action.notification.extra?.targetTab as TabKey | undefined) || 'orders';
              onNavigateTab?.(targetTab);
            }
          )
        );
      } catch {
        // Ignore listener registration errors
      }
    };

    void setupNativePush();

    return () => {
      active = false;
      handles.forEach((h) => {
        void h.remove().catch(() => {});
      });
    };
  }, [isDemoMode, isNative, onNavigateTab, pushNotification, userUid]);

  // Listen for Web FCM foreground messages & SW notification clicks
  useEffect(() => {
    if (isNative) return undefined;
    let unsubscribeFcm: (() => void) | undefined;
    let isMounted = true;

    void getFirebaseMessagingSafe().then((messaging) => {
      if (!messaging || !isMounted) return;
      unsubscribeFcm = onMessage(messaging, (payload) => {
        const title = payload.notification?.title || 'Chutki';
        const body = payload.notification?.body || 'You have a new update.';
        const targetTab =
          (payload.data?.targetTab as TabKey | undefined) || 'orders';
        pushNotification(
          {
            id: `fcm_${Date.now()}`,
            title,
            body,
            tag: 'gb-fcm-msg',
            type: 'ORDER',
            targetTab,
            createdAt: Date.now(),
            read: false,
          },
          true
        );
      });
    });

    const handleSwMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; tab?: TabKey } | undefined;
      if (data?.type === 'NAVIGATE_TAB' && data.tab && onNavigateTab) {
        onNavigateTab(data.tab);
      }
    };

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', handleSwMessage);
    }

    return () => {
      isMounted = false;
      if (unsubscribeFcm) unsubscribeFcm();
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.removeEventListener('message', handleSwMessage);
      }
    };
  }, [isNative, onNavigateTab, pushNotification]);

  useEffect(() => {
    if (permission === 'granted' && userUid && !isDemoMode) {
      void syncFcmToken();
    }
  }, [permission, userUid, isDemoMode, syncFcmToken]);

  const unreadCount = notifications.filter((n) => !n.read).length;

  return {
    permission,
    fcmToken,
    notifications,
    unreadCount,
    activeBanner,
    promptDismissed,
    enablePushNotifications,
    sendTestPush,
    pushNotification,
    markNotificationRead,
    markAllRead,
    clearInbox,
    dismissBanner,
    dismissPrompt,
  };
}
