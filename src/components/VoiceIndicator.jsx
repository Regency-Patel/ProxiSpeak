import { useState } from 'react';

/**
 * VoiceIndicator — floating panel showing mic status, active voice peers,
 * and a toggle button. Collapses to a compact pill by default.
 */
export default function VoiceIndicator({ isMicEnabled, activePeers, micError, toggleMic }) {
  const [isExpanded, setIsExpanded] = useState(false);

  const peerEntries = Object.entries(activePeers);
  const connectedCount = peerEntries.filter(([, p]) => p.connected).length;

  return (
    <div className={`voice-indicator ${isExpanded ? 'expanded' : ''}`}>
      {/* ── Collapsed header / pill ──────────────────────────────────── */}
      <div
        className="voice-header"
        onClick={() => setIsExpanded((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && setIsExpanded((v) => !v)}
      >
        <button
          className={`mic-toggle ${isMicEnabled ? 'mic-on' : 'mic-off'}`}
          onClick={(e) => {
            e.stopPropagation();
            toggleMic();
          }}
          title={isMicEnabled ? 'Mute microphone' : 'Enable microphone'}
          aria-label={isMicEnabled ? 'Mute microphone' : 'Enable microphone'}
        >
          {isMicEnabled ? '🎙️' : '🔇'}
        </button>

        <div className="voice-status">
          <span className="voice-label">
            {connectedCount > 0
              ? `${connectedCount} voice${connectedCount > 1 ? ' peers' : ' peer'}`
              : isMicEnabled
                ? 'Mic ready'
                : 'Voice off'}
          </span>

          {peerEntries.length > 0 && (
            <span className="peer-count-badge">{peerEntries.length}</span>
          )}
        </div>

        <span className="expand-arrow">{isExpanded ? '▼' : '▲'}</span>
      </div>

      {/* ── Expanded details ─────────────────────────────────────────── */}
      {isExpanded && (
        <div className="voice-details">
          {micError && <div className="voice-error">⚠️ {micError}</div>}

          {peerEntries.length === 0 ? (
            <div className="voice-hint">
              Move close to another avatar to start voice chat
            </div>
          ) : (
            <ul className="peer-list">
              {peerEntries.map(([peerId, info]) => (
                <li
                  key={peerId}
                  className={`peer-item ${info.connected ? 'connected' : 'connecting'}`}
                >
                  <span
                    className={`peer-dot ${info.connected ? 'dot-connected' : 'dot-connecting'}`}
                  />
                  <span className="peer-id">User {peerId.slice(0, 5)}</span>
                  <span className="peer-status-label">
                    {info.connected ? 'Connected' : 'Connecting…'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
