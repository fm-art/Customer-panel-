import React, { useEffect, useState } from 'react';
import type { DeliveryPartner, InAppCallRecord } from '../types/bazar';
import { formatCallDuration } from '../utils/riderComm';
import { sanitizeSafeUrl } from '../utils/security';
import { triggerHaptic } from '../utils/haptics';

interface RiderVoiceCallModalProps {
  call: InAppCallRecord | null;
  rider?: DeliveryPartner | null;
  isMuted: boolean;
  isSpeakerOn: boolean;
  micPermissionError?: string | null;
  onAnswerIncoming: () => void;
  onDeclineIncoming: () => void;
  onEndCall: () => void;
  onToggleMute: () => void;
  onToggleSpeaker: () => void;
  onRetryMicrophone?: () => void;
}

export const RiderVoiceCallModal: React.FC<RiderVoiceCallModalProps> = ({
  call,
  rider,
  isMuted,
  isSpeakerOn,
  micPermissionError,
  onAnswerIncoming,
  onDeclineIncoming,
  onEndCall,
  onToggleMute,
  onToggleSpeaker,
  onRetryMicrophone,
}) => {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!call || call.status !== 'CONNECTED' || !call.connectedAt) {
      return undefined;
    }
    setNowMs(Date.now());
    const id = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, [call?.callId, call?.status, call?.connectedAt]);

  if (!call) return null;

  const isIncomingRinging =
    call.callerRole === 'RIDER' &&
    call.status === 'RINGING' &&
    !call.customerAnswered;

  const riderName = call.riderName || rider?.name || 'Delivery Rider';
  const rawPhoto = call.riderPhotoUrl || rider?.photoUrl || rider?.imageUrl || '';
  const safePhoto = sanitizeSafeUrl(rawPhoto, true);
  const shortOrderId = `#${(call.orderId || call.tripId || '').slice(-6).toUpperCase()}`;
  const initialLetter = riderName.trim().charAt(0).toUpperCase() || 'R';

  const getStatusLabel = (): string => {
    switch (call.status) {
      case 'CALLING':
        return 'Calling Rider...';
      case 'RINGING':
        return call.callerRole === 'RIDER' ? 'Incoming voice call...' : 'Ringing...';
      case 'CONNECTING':
        return 'Connecting WebRTC voice...';
      case 'CONNECTED':
        return formatCallDuration(call.connectedAt, nowMs);
      case 'DECLINED':
        return 'Call Declined';
      case 'BUSY':
        return 'Rider is busy on another call';
      case 'TIMEOUT':
        return 'No Answer (Timed Out)';
      case 'FAILED':
        return 'Call Connection Failed';
      case 'ENDED':
        return 'Call Ended';
      default:
        return call.status;
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex flex-col justify-between overflow-y-auto overscroll-none bg-gradient-to-b from-[#075e54] via-[#064e3b] to-[#022c22] text-white select-none"
      style={{
        height: '100dvh',
        minHeight: '100dvh',
        maxHeight: '100dvh',
        paddingTop: 'max(1rem, env(safe-area-inset-top, 16px))',
        paddingBottom: 'max(1.5rem, env(safe-area-inset-bottom, 24px))',
        paddingLeft: '1rem',
        paddingRight: '1rem',
      }}
      role="dialog"
      aria-modal="true"
      aria-label={isIncomingRinging ? 'Incoming voice call from rider' : 'In-app voice call with rider'}
      data-testid="rider-voice-call-modal"
    >
      <div className="w-full max-w-[440px] mx-auto flex flex-col justify-between h-full">
        {/* Top Header Card */}
        <div className="flex flex-col items-center text-center shrink-0">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-[11px] font-bold tracking-wide text-emerald-200 mb-2">
            <i className="fa-solid fa-lock text-[10px]" aria-hidden="true" />
            <span>IN-APP VOICE CALL • NUMBER HIDDEN</span>
          </div>

          <div className="text-[11px] font-extrabold uppercase tracking-widest text-emerald-300/90">
            Order {shortOrderId}
          </div>
          <h2
            className="text-2xl sm:text-3xl font-black tracking-tight text-white mt-1 max-w-[90%] truncate"
            data-testid="call-rider-name"
          >
            {riderName}
          </h2>
          <p
            className="mt-1 text-xs sm:text-sm font-bold text-emerald-100"
            data-testid="call-status-label"
          >
            {getStatusLabel()}
          </p>
        </div>

        {/* Center Visual Avatar & Status */}
        <div className="flex flex-col items-center justify-center my-auto py-2 shrink-0">
          <div className="relative flex items-center justify-center">
            {(call.status === 'RINGING' || call.status === 'CALLING') && (
              <span
                className="absolute inset-0 rounded-full bg-emerald-400/25 animate-ping"
                aria-hidden="true"
              />
            )}
            {safePhoto ? (
              <img
                src={safePhoto}
                alt={riderName}
                className="relative z-10 w-24 h-24 sm:w-28 sm:h-28 rounded-full object-cover border-4 border-emerald-300/40 shadow-2xl"
              />
            ) : (
              <div className="relative z-10 flex w-24 h-24 sm:w-28 sm:h-28 items-center justify-center rounded-full border-4 border-emerald-300/40 bg-emerald-700 text-3xl sm:text-4xl font-black text-white shadow-2xl">
                {initialLetter}
              </div>
            )}
          </div>

          <div className="mt-4 flex items-center gap-2 rounded-xl bg-black/25 px-3 py-1 text-[11px] font-bold text-emerald-100">
            <i className="fa-solid fa-motorcycle text-emerald-300" aria-hidden="true" />
            <span>Delivery Partner • Order {shortOrderId}</span>
          </div>

          {micPermissionError && (
            <div
              className="mt-3.5 max-w-xs rounded-xl border border-amber-300/40 bg-amber-950/85 p-3 text-center text-xs font-semibold text-amber-100 shadow-md"
              role="alert"
              data-testid="call-mic-error"
            >
              <div className="leading-snug">
                <i className="fa-solid fa-microphone-slash mr-1.5 text-amber-300" />
                {micPermissionError}
              </div>
              {onRetryMicrophone && (
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('tap');
                    onRetryMicrophone();
                  }}
                  data-testid="call-retry-mic-btn"
                  className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-extrabold text-white shadow hover:bg-emerald-400 active:scale-95 transition-transform"
                >
                  <i className="fa-solid fa-microphone" aria-hidden="true" />
                  <span>Enable Mic / Retry</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Bottom Call Controls (Fully Responsive across all screen sizes) */}
        {isIncomingRinging ? (
          <div className="w-full shrink-0 pt-2 pb-1">
            <p className="text-center text-xs font-semibold text-emerald-200 mb-4">
              Incoming voice call from Rider for {shortOrderId}
            </p>
            <div className="flex items-center justify-around max-w-xs mx-auto">
              <div className="flex flex-col items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('warning');
                    onDeclineIncoming();
                  }}
                  className="flex w-14 h-14 sm:w-16 sm:h-16 items-center justify-center rounded-full bg-red-600 text-white shadow-xl active:scale-95 transition-transform"
                  aria-label="Decline incoming call"
                  data-testid="decline-incoming-call-btn"
                >
                  <i className="fa-solid fa-phone-slash text-xl" aria-hidden="true" />
                </button>
                <span className="text-[11px] font-extrabold text-red-200">Decline</span>
              </div>

              <div className="flex flex-col items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('success');
                    onAnswerIncoming();
                  }}
                  className="flex w-14 h-14 sm:w-16 sm:h-16 items-center justify-center rounded-full bg-emerald-500 text-white shadow-xl active:scale-95 transition-transform"
                  aria-label="Answer incoming call"
                  data-testid="answer-incoming-call-btn"
                >
                  <i className="fa-solid fa-phone text-xl" aria-hidden="true" />
                </button>
                <span className="text-[11px] font-extrabold text-emerald-200">Answer</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="w-full shrink-0 pt-2 pb-1">
            <div className="mx-auto flex max-w-xs items-center justify-around rounded-3xl bg-black/35 px-4 py-3 backdrop-blur-md border border-white/10 shadow-lg">
              {/* Mute / Unmute */}
              <div className="flex flex-col items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('tap');
                    onToggleMute();
                  }}
                  aria-pressed={isMuted}
                  aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
                  data-testid="call-mute-toggle-btn"
                  className={`flex w-12 h-12 sm:w-14 sm:h-14 items-center justify-center rounded-full transition-colors ${
                    isMuted
                      ? 'bg-white text-slate-900 shadow-md'
                      : 'bg-white/15 text-white hover:bg-white/25 active:bg-white/30'
                  }`}
                >
                  <i
                    className={`fa-solid ${
                      isMuted ? 'fa-microphone-slash' : 'fa-microphone'
                    } text-lg`}
                    aria-hidden="true"
                  />
                </button>
                <span className="text-[11px] font-bold text-emerald-100">
                  {isMuted ? 'Muted' : 'Mute'}
                </span>
              </div>

              {/* End Call */}
              <div className="flex flex-col items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('warning');
                    onEndCall();
                  }}
                  aria-label="End voice call"
                  data-testid="call-end-btn"
                  className="flex w-14 h-14 sm:w-16 sm:h-16 items-center justify-center rounded-full bg-red-600 text-white shadow-xl active:scale-95 transition-transform"
                >
                  <i className="fa-solid fa-phone-slash text-xl" aria-hidden="true" />
                </button>
                <span className="text-[11px] font-bold text-red-200">End Call</span>
              </div>

              {/* Speaker ON / OFF */}
              <div className="flex flex-col items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('tap');
                    onToggleSpeaker();
                  }}
                  aria-pressed={isSpeakerOn}
                  aria-label={isSpeakerOn ? 'Turn speaker off' : 'Turn speaker on'}
                  data-testid="call-speaker-toggle-btn"
                  className={`flex w-12 h-12 sm:w-14 sm:h-14 items-center justify-center rounded-full transition-colors ${
                    isSpeakerOn
                      ? 'bg-white text-slate-900 shadow-md'
                      : 'bg-white/15 text-white hover:bg-white/25 active:bg-white/30'
                  }`}
                >
                  <i
                    className={`fa-solid ${
                      isSpeakerOn ? 'fa-volume-high' : 'fa-volume-low'
                    } text-lg`}
                    aria-hidden="true"
                  />
                </button>
                <span className="text-[11px] font-bold text-emerald-100">
                  {isSpeakerOn ? 'Speaker ON' : 'Speaker'}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
