import { useEffect, useRef, useState, useCallback } from 'react';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

/**
 * Custom React hook for proximity-based WebRTC voice chat.
 * Manages peer connections, microphone access, and audio playback
 * based on proximity:peer-nearby / proximity:peer-left events from the server.
 *
 * @param {import('socket.io-client').Socket | null} socket - Socket.io client instance
 * @param {string | null} myId - Local user's socket ID
 * @returns {{ isMicEnabled, activePeers, micError, toggleMic, nearbyPeerIds }}
 */
export default function useProximityVoice(
  socket,
  myId,
  localPositionRef,
  remoteUsersRef,
  avatarSize,
  proximityRadius
) {
  const [isMicEnabled, setIsMicEnabled] = useState(false);
  const [activePeers, setActivePeers] = useState({}); // peerId -> { status: 'connecting' | 'connected' | 'failed' }
  const [nearbyPeerIds, setNearbyPeerIds] = useState(new Set());
  const [micError, setMicError] = useState(null);

  const localStreamRef = useRef(null);
  const peerConnectionsRef = useRef({}); // peerId -> RTCPeerConnection
  const pendingCandidatesRef = useRef({}); // peerId -> ICECandidate[]
  const audioContextRef = useRef(null);
  const remoteAudioNodesRef = useRef({}); // peerId -> { stream, source, gain, targetGain }

  const getAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      const AudioContextConstructor = window.AudioContext;
      if (!AudioContextConstructor) {
        console.error('[Voice] Web Audio API is not available in this browser.');
        return null;
      }
      try {
        audioContextRef.current = new AudioContextConstructor();
      } catch (err) {
        console.error('[Voice] Failed to create AudioContext:', err.message);
        return null;
      }
    }
    return audioContextRef.current;
  }, []);

  const resumeAudioContext = useCallback(async () => {
    const audioContext = getAudioContext();
    if (audioContext?.state === 'suspended') {
      try {
        await audioContext.resume();
      } catch (err) {
        console.error('[Voice] Failed to resume AudioContext:', err.message);
      }
    }
  }, [getAudioContext]);

  const closePeerAudio = useCallback((peerId) => {
    const audioNodes = remoteAudioNodesRef.current[peerId];
    if (!audioNodes) return;

    audioNodes.source.disconnect();
    audioNodes.gain.disconnect();
    delete remoteAudioNodesRef.current[peerId];
  }, []);

  const createPeerAudio = useCallback((peerId, stream) => {
    const existing = remoteAudioNodesRef.current[peerId];
    if (existing?.stream === stream) return;
    if (existing) closePeerAudio(peerId);

    const audioContext = getAudioContext();
    if (!audioContext) return;

    let source;
    let gain;
    try {
      source = audioContext.createMediaStreamSource(stream);
      gain = audioContext.createGain();
      gain.gain.setValueAtTime(0, audioContext.currentTime);
      source.connect(gain);
      gain.connect(audioContext.destination);

      remoteAudioNodesRef.current[peerId] = {
        stream,
        source,
        gain,
        targetGain: 0,
      };
    } catch (err) {
      source?.disconnect();
      gain?.disconnect();
      console.error(`[Voice] Failed to create remote audio path for ${peerId}:`, err.message);
    }
  }, [closePeerAudio, getAudioContext]);

  // ─── Microphone control ─────────────────────────────────────────────
  const acquireMic = useCallback(async () => {
    if (localStreamRef.current) return localStreamRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;
      setIsMicEnabled(true);
      setMicError(null);
      return stream;
    } catch (err) {
      console.error('[Voice] Microphone access denied:', err.message);
      setMicError(err.name === 'NotAllowedError'
        ? 'Microphone permission denied'
        : err.message);
      setIsMicEnabled(false);
      return null;
    }
  }, []);

  const releaseMic = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    setIsMicEnabled(false);
  }, []);

  const toggleMic = useCallback(async () => {
    void resumeAudioContext();
    if (isMicEnabled) {
      // Mute: disable tracks but keep connections alive
      if (localStreamRef.current) {
        localStreamRef.current.getAudioTracks().forEach((t) => {
          t.enabled = false;
        });
      }
      setIsMicEnabled(false);
    } else {
      if (localStreamRef.current) {
        // Re-enable existing tracks
        localStreamRef.current.getAudioTracks().forEach((t) => {
          t.enabled = true;
        });
        setIsMicEnabled(true);
      } else {
        await acquireMic();
      }
    }
  }, [isMicEnabled, acquireMic, resumeAudioContext]);

  // ─── Peer connection lifecycle ──────────────────────────────────────
  const createPeerConnection = useCallback(
    (peerId) => {
      // Close and clean up any existing connection to the same peer (but keep UI entry)
      if (peerConnectionsRef.current[peerId]) {
        // Dispose of resources without deleting the activePeers entry
        const oldPc = peerConnectionsRef.current[peerId];
        delete peerConnectionsRef.current[peerId];
        oldPc.close();
        closePeerAudio(peerId);
        delete pendingCandidatesRef.current[peerId];
      }

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      peerConnectionsRef.current[peerId] = pc;
      // Initialise the pending‑candidate queue only if it doesn't already exist.
      if (!pendingCandidatesRef.current[peerId]) {
        pendingCandidatesRef.current[peerId] = [];
      }

      // Attach local audio tracks to the connection
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          pc.addTrack(track, localStreamRef.current);
        });
      }

      // Forward ICE candidates to the remote peer via Socket.io
      pc.onicecandidate = (event) => {
        if (event.candidate && socket) {
          socket.emit('webrtc:ice-candidate', {
            to: peerId,
            candidate: event.candidate,
          });
        }
      };

      // Route only the remote stream through its peer-specific gain node.
      pc.ontrack = (event) => {
        // Ensure this event belongs to the current active connection for this peer
        if (peerConnectionsRef.current[peerId] !== pc) return;
        const remoteStream = event.streams[0];
        if (remoteStream) {
          createPeerAudio(peerId, remoteStream);
          setActivePeers((prev) => ({
            ...prev,
            [peerId]: { status: 'connected' },
          }));
        }
      };

      pc.onconnectionstatechange = () => {
        // Ensure this event belongs to the current active connection for this peer
        if (peerConnectionsRef.current[peerId] !== pc) return;
        const state = pc.connectionState;
        if (state === 'failed' || state === 'closed') {
          // Mark as failed and clean up resources, but keep the UI entry
          setActivePeers((prev) => ({
            ...prev,
            [peerId]: { status: 'failed' },
          }));
          closePeerAudio(peerId);
          delete pendingCandidatesRef.current[peerId];
          // Remove stale pc reference if it matches this instance
          if (peerConnectionsRef.current[peerId] === pc) {
            delete peerConnectionsRef.current[peerId];
          }
        }
        // "disconnected" is left as‑is – we keep the connection alive to allow recovery.
      };

      return pc;
    },
    [socket, closePeerAudio, createPeerAudio]
  );

  const closePeerConnection = useCallback((peerId) => {
    const pc = peerConnectionsRef.current[peerId];
    if (pc) {
      delete peerConnectionsRef.current[peerId];
      pc.close();
    }
    delete pendingCandidatesRef.current[peerId];
    closePeerAudio(peerId);

    setActivePeers((prev) => {
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
  }, [closePeerAudio]);

  // ─── Socket event handlers ─────────────────────────────────────────
  useEffect(() => {
    if (!socket) return;

    // When a peer enters proximity range
    const handlePeerNearby = async ({ peerId, shouldInitiate }) => {
      setNearbyPeerIds((prev) => new Set([...prev, peerId]));

      // Acquire microphone if not already active
      let stream = localStreamRef.current;
      if (!stream) {
        stream = await acquireMic();
        if (!stream) return; // mic access denied — can't do voice
      }

      if (shouldInitiate) {
        // This client creates and sends the WebRTC offer
        const pc = createPeerConnection(peerId);
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('webrtc:offer', { to: peerId, offer });

          setActivePeers((prev) => ({
            ...prev,
            [peerId]: { status: 'connecting' },
          }));
        } catch (err) {
          console.error('[WebRTC] Failed to create offer:', err);
        }
      } else {
        // Mark as pending — will connect when the offer arrives
        setActivePeers((prev) => ({
          ...prev,
          [peerId]: { status: 'connecting' },
        }));
      }
    };

    // When a peer leaves proximity range
    const handlePeerLeft = ({ peerId }) => {
      setNearbyPeerIds((prev) => {
        const next = new Set(prev);
        next.delete(peerId);
        return next;
      });
      closePeerConnection(peerId);
    };

    // Receive a WebRTC offer from a remote peer
    const handleOffer = async ({ from, offer }) => {
      let stream = localStreamRef.current;
      if (!stream) {
        stream = await acquireMic();
        if (!stream) return;
      }

      const pc = createPeerConnection(from);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));

        // Flush any ICE candidates that arrived before the offer
        const pending = pendingCandidatesRef.current[from] || [];
        for (const candidate of pending) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
        pendingCandidatesRef.current[from] = [];

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc:answer', { to: from, answer });
      } catch (err) {
        console.error('[WebRTC] Failed to handle offer:', err);
      }
    };

    // Receive a WebRTC answer from a remote peer
    const handleAnswer = async ({ from, answer }) => {
      const pc = peerConnectionsRef.current[from];
      if (!pc) return;
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));

        const pending = pendingCandidatesRef.current[from] || [];
        for (const candidate of pending) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
        pendingCandidatesRef.current[from] = [];
      } catch (err) {
        console.error('[WebRTC] Failed to handle answer:', err);
      }
    };

    // Receive an ICE candidate from a remote peer
    const handleIceCandidate = async ({ from, candidate }) => {
      const pc = peerConnectionsRef.current[from];
      if (pc && pc.remoteDescription) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error('[WebRTC] Failed to add ICE candidate:', err);
        }
      } else {
        // Queue until remote description is set
        if (!pendingCandidatesRef.current[from]) {
          pendingCandidatesRef.current[from] = [];
        }
        pendingCandidatesRef.current[from].push(candidate);
      }
    };

    socket.on('proximity:peer-nearby', handlePeerNearby);
    socket.on('proximity:peer-left', handlePeerLeft);
    socket.on('webrtc:offer', handleOffer);
    socket.on('webrtc:answer', handleAnswer);
    socket.on('webrtc:ice-candidate', handleIceCandidate);

    return () => {
      socket.off('proximity:peer-nearby', handlePeerNearby);
      socket.off('proximity:peer-left', handlePeerLeft);
      socket.off('webrtc:offer', handleOffer);
      socket.off('webrtc:answer', handleAnswer);
      socket.off('webrtc:ice-candidate', handleIceCandidate);

      // Tear down every active peer connection
      Object.keys(peerConnectionsRef.current).forEach(closePeerConnection);
      Object.keys(remoteAudioNodesRef.current).forEach(closePeerAudio);
      if (audioContextRef.current) {
        const audioContext = audioContextRef.current;
        audioContextRef.current = null;
        if (audioContext.state !== 'closed') {
          void audioContext.close().catch((err) => {
            console.error('[Voice] Failed to close AudioContext:', err.message);
          });
        }
      }
      releaseMic();
    };
  }, [
    socket,
    acquireMic,
    releaseMic,
    createPeerConnection,
    closePeerConnection,
    closePeerAudio,
  ]);

  useEffect(() => {
    let animationFrameId;

    const updatePeerVolumes = () => {
      const audioContext = audioContextRef.current;
      if (audioContext && audioContext.state !== 'closed') {
        const localPosition = localPositionRef?.current;

        Object.entries(remoteAudioNodesRef.current).forEach(([peerId, audioNodes]) => {
          const remotePosition = remoteUsersRef?.current?.[peerId];
          let targetGain = 0;

          if (
            localPosition &&
            remotePosition &&
            Number.isFinite(localPosition.x) &&
            Number.isFinite(localPosition.y) &&
            Number.isFinite(remotePosition.x) &&
            Number.isFinite(remotePosition.y)
          ) {
            const centerOffset = avatarSize / 2;
            const dx = (localPosition.x + centerOffset) - (remotePosition.x + centerOffset);
            const dy = (localPosition.y + centerOffset) - (remotePosition.y + centerOffset);
            const distance = Math.sqrt(dx * dx + dy * dy);
            const normalizedDistance = Math.min(distance / proximityRadius, 1);
            targetGain = 0.5 * (1 + Math.cos(Math.PI * normalizedDistance));
          }

          if (Math.abs(targetGain - audioNodes.targetGain) > 0.001) {
            audioNodes.targetGain = targetGain;
            audioNodes.gain.gain.setTargetAtTime(
              targetGain,
              audioContext.currentTime,
              0.08
            );
          }
        });
      }

      animationFrameId = requestAnimationFrame(updatePeerVolumes);
    };

    animationFrameId = requestAnimationFrame(updatePeerVolumes);
    return () => cancelAnimationFrame(animationFrameId);
  }, [localPositionRef, remoteUsersRef, avatarSize, proximityRadius]);

  return {
    isMicEnabled,
    activePeers,
    nearbyPeerIds,
    micError,
    toggleMic,
  };
}
