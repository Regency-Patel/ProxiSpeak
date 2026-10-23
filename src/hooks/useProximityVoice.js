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
export default function useProximityVoice(socket, myId) {
  const [isMicEnabled, setIsMicEnabled] = useState(false);
  const [activePeers, setActivePeers] = useState({}); // peerId -> { connected: bool }
  const [nearbyPeerIds, setNearbyPeerIds] = useState(new Set());
  const [micError, setMicError] = useState(null);

  const localStreamRef = useRef(null);
  const peerConnectionsRef = useRef({}); // peerId -> RTCPeerConnection
  const pendingCandidatesRef = useRef({}); // peerId -> ICECandidate[]
  const audioElementsRef = useRef({}); // peerId -> HTMLAudioElement

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
  }, [isMicEnabled, acquireMic]);

  // ─── Peer connection lifecycle ──────────────────────────────────────
  const createPeerConnection = useCallback(
    (peerId) => {
      // Close existing connection to the same peer if any
      if (peerConnectionsRef.current[peerId]) {
        peerConnectionsRef.current[peerId].close();
      }

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      peerConnectionsRef.current[peerId] = pc;
      pendingCandidatesRef.current[peerId] = [];

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

      // Play remote audio when track arrives
      pc.ontrack = (event) => {
        const remoteStream = event.streams[0];
        if (remoteStream) {
          let audioEl = audioElementsRef.current[peerId];
          if (!audioEl) {
            audioEl = new Audio();
            audioEl.autoplay = true;
            audioElementsRef.current[peerId] = audioEl;
          }
          audioEl.srcObject = remoteStream;

          setActivePeers((prev) => ({
            ...prev,
            [peerId]: { connected: true },
          }));
        }
      };

      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        if (state === 'disconnected' || state === 'failed' || state === 'closed') {
          setActivePeers((prev) => {
            const next = { ...prev };
            delete next[peerId];
            return next;
          });
        }
      };

      return pc;
    },
    [socket]
  );

  const closePeerConnection = useCallback((peerId) => {
    const pc = peerConnectionsRef.current[peerId];
    if (pc) {
      pc.close();
      delete peerConnectionsRef.current[peerId];
    }
    delete pendingCandidatesRef.current[peerId];

    const audioEl = audioElementsRef.current[peerId];
    if (audioEl) {
      audioEl.pause();
      audioEl.srcObject = null;
      delete audioElementsRef.current[peerId];
    }

    setActivePeers((prev) => {
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
  }, []);

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
            [peerId]: { connected: false },
          }));
        } catch (err) {
          console.error('[WebRTC] Failed to create offer:', err);
        }
      } else {
        // Mark as pending — will connect when the offer arrives
        setActivePeers((prev) => ({
          ...prev,
          [peerId]: { connected: false },
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
      releaseMic();
    };
  }, [socket, acquireMic, releaseMic, createPeerConnection, closePeerConnection]);

  return {
    isMicEnabled,
    activePeers,
    nearbyPeerIds,
    micError,
    toggleMic,
  };
}
