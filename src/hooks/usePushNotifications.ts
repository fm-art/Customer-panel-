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
const ANDROID_CHANNEL_ID = 'chutki_alerts';

let nativeNotifIdCounter = Math.floor((Date.now() % 1_000_000) + 100);
function nextAndroidNotifId(): number {
  nativeNotifIdCounter = (nativeNotifIdCounter % 2_000_000_000) + 1;
  return nativeNotifIdCounter;
}

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

function mapCapacitorPerm(state?: string): PushPermissionState {
  if (state === 'granted') return 'granted';
  if (state === 'denied') return 'denied';
  return 'default';
}

export type PushPermissionState = NotificationPermission | 'unsupported';

export function usePushNotifications(
  userUid: string | null,
  isDemoMode: boolean,
  onNavigateTab?: (tab: TabKey) => void
) {
  const isNative = Capacitor.isNativePlatform();

  const [permission, setPermission] = useState<PushPermissionState>(() => {
    if (isNative) return 'default';
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
  const channelCreatedRef = useRef(false);

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

  const ensureNativeChannel = useCallback(async () => {
    if (!isNative || channelCreatedRef.current) return;
    channelCreatedRef.current = true;
    try {
      await LocalNotifications.createChannel({
        id: ANDROID_CHANNEL_ID,
        name: 'Order & Wallet Alerts',
        description: 'Live 15-minute order status, delivery PIN and wallet alerts',
        importance: 5,
        visibility: 1,
        vibration: true,
      });
    } catch {
      // Ignore if running on older Android API
    }
    try {
      await PushNotifications.createChannel({
        id: ANDROID_CHANNEL_ID,
        name: 'Order & Wallet Alerts',
        description: 'Live 15-minute order status, delivery PIN and wallet alerts',
        importance: 5,
        visibility: 1,
        vibration: true,
      });
    } catch {
      // Ignore
    }
  }, [isNative]);

  const showNativeNotification = useCallback(
    async (notif: AppNotification) => {
      if (isNative) {
        try {
          const perm = await LocalNotifications.checkPermissions();
          if (perm.display !== 'granted') return;
          await ensureNativeChannel();
          await LocalNotifications.schedule({
            notifications: [
              {
                id: nextAndroidNotifId(),
                title: notif.title,
                body: notif.body,
                channelId: ANDROID_CHANNEL_ID,
                smallIcon: 'ic_stat_notification',
                iconColor: '#0c831f',
                extra: {
                  targetTab: notif.targetTab || 'orders',
                  notifId: notif.id,
                },
              },
            ],
          });
        } catch {
          // Ignore native schedule errors
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
    [ensureNativeChannel, isNative]
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
        await ensureNativeChannel();
        const pushPerm = await PushNotifications.checkPermissions();
        if (pushPerm.receive === 'granted') {
          await PushNotifications.register();
        }
        await update(ref(db, `customers/${userUid}`), {
          pushEnabled: true,
        });
      } catch {
        // Ignore if FCM registration is unavailable
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
  }, [ensureNativeChannel, isDemoMode, isNative, userUid]);

  const enablePushNotifications = useCallback(async (): Promise<{
    granted: boolean;
    message: string;
  }> => {
    if (isNative) {
      try {
        await ensureNativeChannel();
        const localRes = await LocalNotifications.requestPermissions();
        let pushReceive = localRes.display;
        try {
          const pushRes = await PushNotifications.requestPermissions();
          pushReceive = pushRes.receive === 'granted' ? 'granted' : localRes.display;
        } catch {
          // Local notifications still work if remote push permission fails
        }

        const mapped = mapCapacitorPerm(
          localRes.display === 'granted' || pushReceive === 'granted'
            ? 'granted'
            : localRes.display
        );
        setPermission(mapped);

        if (mapped === 'granted') {
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
            message: '🔔 Notifications enabled! Check your Android status bar.',
          };
        }

        return {
          granted: false,
          message:
            mapped === 'denied'
              ? 'Please allow Notifications in Android Settings → Apps → Chutki.'
              : 'Notification permission dismissed.',
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
  }, [dismissPrompt, ensureNativeChannel, isNative, pushNotification, syncFcmToken]);

  const sendTestPush = useCallback(async () => {
    if (permission !== 'granted') {
      return enablePushNotifications();
    }
    const testNotif: AppNotification = {
      id: `test_${Date.now()}`,
      title: '⚡ 15-Min Express Order Alert',
      body: 'Notifications are working smoothly! Rider & offer updates will arrive here.',
      tag: `gb-test-${Date.now()}`,
      type: 'ORDER',
      targetTab: 'orders',
      createdAt: Date.now(),
      read: false,
    };
    pushNotification(testNotif, true);
    return { granted: true, message: '🔔 Test notification sent!' };
  }, [enablePushNotifications, permission, pushNotification]);

  // Native Android permission check + listeners (LocalNotifications & PushNotifications)
  useEffect(() => {
    if (!isNative) return;
    let mounted = true;
    const handles: PluginListenerHandle[] = [];

    void (async () => {
      try {
        await ensureNativeChannel();
        const localPerm = await LocalNotifications.checkPermissions();
        if (mounted) {
          setPermission(mapCapacitorPerm(localPerm.display));
        }

        handles.push(
          await LocalNotifications.addListener(
            'localNotificationActionPerformed',
            (action) => {
              const extra = (action.notification?.extra || {}) as {
                targetTab?: TabKey;
                notifId?: string;
              };
              if (extra.notifId) markNotificationRead(extra.notifId);
              if (extra.targetTab && onNavigateTab) {
                onNavigateTab(extra.targetTab);
              }
            }
          )
        );

        handles.push(
          await PushNotifications.addListener('registration', (token) => {
            if (!mounted) return;
            setFcmToken(token.value);
            if (userUid && !isDemoMode && token.value) {
              void update(ref(db, `customers/${userUid}`), {
                fcmToken: token.value,
                pushEnabled: true,
              }).catch(() => {});
            }
          })
        );

        handles.push(
          await PushNotifications.addListener('registrationError', () => {
            // Keep local notifications working even if remote FCM token fails
          })
        );

        handles.push(
          await PushNotifications.addListener('pushNotificationReceived', (notif) => {
            const data = (notif.data || {}) as { targetTab?: TabKey };
            pushNotification(
              {
                id: notif.id || `fcm_${Date.now()}`,
                title: notif.title || 'Chutki',
                body: notif.body || 'You have a new update.',
                tag: 'gb-fcm-msg',
                type: 'ORDER',
                targetTab: data.targetTab || 'orders',
                createdAt: Date.now(),
                read: false,
              },
              true
            );
          })
        );

        handles.push(
          await PushNotifications.addListener(
            'pushNotificationActionPerformed',
            (action) => {
              const data = (action.notification?.data || {}) as {
                targetTab?: TabKey;
              };
              if (data.targetTab && onNavigateTab) {
                onNavigateTab(data.targetTab);
              } else if (onNavigateTab) {
                onNavigateTab('orders');
              }
            }
          )
        );
      } catch {
        // Ignore plugin init issues on non-native environments
      }
    })();

    return () => {
      mounted = false;
      handles.forEach((h) => {
        void h.remove().catch(() => {});
      });
    };
  }, [ensureNativeChannel, isDemoMode, isNative, markNotificationRead, onNavigateTab, pushNotification, userUid]);

  // Listen for Web FCM foreground messages & SW notification clicks
  useEffect(() => {
    if (isNative) return;
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
